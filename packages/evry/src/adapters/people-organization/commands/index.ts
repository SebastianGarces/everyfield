import type { Transaction } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { PeopleReadContext, peopleCsv, peopleWriter, personFields } from "@everyfield/domain/people";
import {
	householdName,
	householdRole,
	importChoice,
	importLimits,
	longText,
	proficiency,
	skillCategory,
	skillName,
	skillNotes,
	tagColor,
	tagName,
	type PeopleContext,
	type importPreview,
} from "@everyfield/contracts/people";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import type { EffectResult, ReviewedWrite } from "../../../proposals/types.ts";
import { ownerOrAdmin } from "../../people/commands/index.ts";
import { problemText } from "../reads/index.ts";

// The reviewed writes for households, tags, skills, notes and imports (WP-064). Each review is one SELECT under the
// proposal's statement that reads the targets live in the actor's church and saves the native commands' exact
// arguments, with the revisions the review showed. On approval the executor runs the owning native People commands in
// its one transaction, each with a request key derived from the effect key, so every change and its audit row commit
// together or not at all; a record that changed since the review refuses the whole effect. A change that reaches
// several people (a household's address, a tag) lists each of them in the review and reports each one's result.

type Reply<T> = { status: "ok"; value: T } | { status: "refused"; error: { code: string } };
type Run<A> = (tx: Transaction, context: PeopleContext, args: A, key: string) => Promise<EffectResult>;

/** One reviewed write over native People commands, for the church's Owner or Admin. */
function reviewed<I, A>(spec: {
	operation: string;
	description: string;
	input: z.ZodType<I>;
	review: ReviewedWrite<I>["review"];
	run: Run<A>;
	current?: ReviewedWrite<I>["current"];
}): ReviewedWrite<I> {
	return {
		operation: spec.operation,
		description: spec.description,
		input: spec.input,
		allowed: ownerOrAdmin,
		review: spec.review,
		execute: (tx, context, args, key) => spec.run(tx, context, args as A, key),
		...(spec.current && { current: spec.current }),
	};
}
/** The native reply as the effect's result. */
function done<T extends { receiptId: string }>(reply: Reply<T>, revision: (value: T) => string): EffectResult {
	return reply.status === "ok"
		? { receiptId: reply.value.receiptId, revision: revision(reply.value) }
		: { refused: reply.error.code };
}

const json = (value: unknown) => sql`${JSON.stringify(value ?? null)}::jsonb`;
const change = (field: string, before: SQL, after: SQL) =>
	sql`jsonb_build_object('field',${field}::text,'before',${before},'after',${after})`;
/** The live person `p` in the actor's church. */
const livePerson = (actor: EvryActor, id: SQL) =>
	sql`p.id=${id} AND p.tenant_id=${actor.owner.id}::uuid AND p.plant_id=${actor.owner.id}::uuid AND p.state='live'`;
const personTarget = sql`jsonb_build_object('kind','person','id',p.id,'label',p.display_name)`;
const householdTarget = sql`jsonb_build_object('kind','household','id',h.id,'label',h.name)`;
const tagTarget = sql`jsonb_build_object('kind','tag','id',t.id,'label',t.name)`;
/** A plain reason the review cannot be approved, merged into the review when `when` holds. */
const refusal = (when: SQL, text: SQL) => sql`CASE WHEN ${when} THEN jsonb_build_object('refusal',${text}) ELSE '{}'::jsonb END`;

const ADDRESS = [
	["street", "street"],
	["city", "city"],
	["stateProvince", "state_province"],
	["postalCode", "postal_code"],
	["country", "country"],
] as const;
/** A row's address as one line, or null when it has none. */
const addressLine = (a: string) =>
	sql.raw(
		`nullif(concat_ws(', ',${ADDRESS.map(([, col]) => `nullif(btrim(${a}.${col}),'')`).join(",")}),'')`,
	);
const hasAddress = (a: string) => sql.raw(`(${ADDRESS.map(([, col]) => `nullif(btrim(${a}.${col}),'')`).join(" IS NOT NULL OR ")} IS NOT NULL)`);
const sameAddress = (a: string, b: string) =>
	sql.raw(
		`(${ADDRESS.map(([, col]) => `${a}.${col}`).join(",")}) IS NOT DISTINCT FROM (${ADDRESS.map(([, col]) => `${b}.${col}`).join(",")})`,
	);
const roleOrder = (a: string) =>
	sql.raw(
		`CASE ${a}.household_role WHEN 'head' THEN 1 WHEN 'spouse' THEN 2 WHEN 'child' THEN 3 ELSE 4 END,${a}.display_name,${a}.id`,
	);
const address = z.strictObject({
	street: z.string().trim().max(255).nullable().optional(),
	city: z.string().trim().max(255).nullable().optional(),
	stateProvince: z.string().trim().max(255).nullable().optional(),
	postalCode: z.string().trim().max(255).nullable().optional(),
	country: z.string().trim().max(255).nullable().optional(),
});
type Address = z.infer<typeof address>;
/**
 * The before and after of each patched field of row `a` whose value changes. `keys` maps each patch key to its column.
 */
function fieldChanges(a: string, patch: Record<string, unknown>, keys: Record<string, string>) {
	const rows = Object.entries(patch)
		.filter(([, after]) => after !== undefined)
		.map(([field, after], n) => ({ n, field, col: keys[field]!, after }));
	return sql`(SELECT coalesce(jsonb_agg(jsonb_build_object('field',k.field,'before',to_jsonb(${sql.raw(a)})->k.col,'after',k.after) ORDER BY k.n)
		FILTER (WHERE (to_jsonb(${sql.raw(a)})->k.col) IS DISTINCT FROM k.after),'[]'::jsonb)
		FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) k(n int,field text,col text,after jsonb))`;
}
const HOUSEHOLD_COLUMNS: Record<string, string> = { name: "name", ...Object.fromEntries(ADDRESS) };
const nonEmpty = <T extends Record<string, unknown>>(patch: z.ZodType<T>) =>
	patch.refine((p) => Object.values(p).some((v) => v !== undefined), "nothing to change");
const personIds = z
	.array(z.uuid())
	.min(1)
	.max(50)
	.refine((ids) => new Set(ids).size === ids.length, "each person once");

// ---------------------------------------------------------------------------------------------------------------
// Households (REQ-PPL-009). One current household per person; the household's address reaches its members only
// through an explicit propagation.

const createHouseholdWithHead = reviewed({
	operation: "people.createHouseholdWithHead",
	description:
		"Propose a new household with one person as its head, and the household's name and address. A person is in one household at a time. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ headPersonId: z.uuid(), name: householdName }).extend(address.shape),
	review(actor, value) {
		const { headPersonId, name, ...home } = value;
		const line = ADDRESS.map(([key]) => home[key]?.trim()).filter(Boolean).join(", ") || null;
		return sql`SELECT jsonb_build_object('target',${personTarget},'changes',jsonb_build_array(
				${change("household", sql`to_jsonb(cur.name)`, json(name))},
				${change("householdRole", sql`to_jsonb(p.household_role)`, json("head"))},
				${change("householdAddress", sql`NULL::jsonb`, json(line))}))
				|| ${refusal(sql`cur.id IS NOT NULL`, sql`p.display_name||' is in the '||cur.name||'. Remove them from it first: a person is in one household at a time.'`)} AS review,
			jsonb_build_object('expectedRevision',p.revision::text,'input',${json({ headPersonId, name, ...home })}) AS args
			FROM person p LEFT JOIN household cur ON cur.id=p.household_id AND cur.plant_id=p.plant_id
			WHERE ${livePerson(actor, sql`${headPersonId}::uuid`)}`;
	},
	run: async (tx, context, args: object, key) =>
		done(await personFields.createHouseholdWithHead(tx, context, { ...args, requestKey: key }), revisionOf),
});
const revisionOf = (v: { result: { status: string; household?: { revision: string } } }) =>
	v.result.household?.revision ?? "0";

const updateHousehold = reviewed({
	operation: "people.updateHousehold",
	description:
		"Propose a change to one household's name or its own address. Members keep their own addresses; use people.propagateAddress to update them. Nothing changes until the user approves the exact review.",
	input: z.strictObject({
		householdId: z.uuid(),
		patch: nonEmpty(address.extend({ name: householdName.optional() })),
	}),
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',${householdTarget},'changes',${fieldChanges("h", value.patch, HOUSEHOLD_COLUMNS)}) AS review,
			jsonb_build_object('expectedRevision',h.revision::text,'input',jsonb_build_object('householdId',h.id,'patch',${json(value.patch)})) AS args
			FROM household h WHERE h.id=${value.householdId}::uuid AND h.plant_id=${actor.owner.id}::uuid`;
	},
	run: async (tx, context, args: object, key) =>
		done(await personFields.updateHousehold(tx, context, { ...args, requestKey: key }), revisionOf),
});

const liveMembers = sql`(SELECT count(*) FROM person m WHERE m.household_id=h.id AND m.tenant_id=h.plant_id AND m.state='live')`;
const deleteHousehold = reviewed({
	operation: "people.deleteHousehold",
	description:
		"Propose deleting one household that has nobody left in it. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ householdId: z.uuid() }),
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',${householdTarget},'changes',jsonb_build_array(${change("household", sql`to_jsonb(h.name)`, sql`NULL::jsonb`)}))
				|| ${refusal(sql`${liveMembers}>0`, sql`h.name||' still has '||${liveMembers}||' '||CASE WHEN ${liveMembers}=1 THEN 'person' ELSE 'people' END||' in it. Remove them from it first.'`)} AS review,
			jsonb_build_object('expectedRevision',h.revision::text,'input',jsonb_build_object('householdId',h.id)) AS args
			FROM household h WHERE h.id=${value.householdId}::uuid AND h.plant_id=${actor.owner.id}::uuid`;
	},
	run: async (tx, context, args: object, key) =>
		done(await personFields.deleteHousehold(tx, context, { ...args, requestKey: key }), revisionOf),
});

/** When a person without an address joins, they take the household's (REQ-PPL-009): each field they gain. */
const joinedAddress = sql`CASE WHEN NOT ${hasAddress("p")} AND ${hasAddress("h")} THEN (SELECT coalesce(jsonb_agg(
		jsonb_build_object('field',x.k,'before',NULL,'after',x.v) ORDER BY x.n) FILTER (WHERE nullif(btrim(x.v),'') IS NOT NULL),'[]'::jsonb)
	FROM (VALUES (1,'street',h.street),(2,'city',h.city),(3,'stateProvince',h.state_province),(4,'postalCode',h.postal_code),(5,'country',h.country)) x(n,k,v))
	ELSE '[]'::jsonb END`;
const addToHousehold = reviewed({
	operation: "people.addToHousehold",
	description:
		"Propose adding one person to an existing household with their role: head, spouse, child or other. Only ids from earlier results; never infer a role from a name. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ householdId: z.uuid(), personId: z.uuid(), role: householdRole }),
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',${personTarget},'changes',jsonb_build_array(
				${change("household", sql`to_jsonb(cur.name)`, sql`to_jsonb(h.name)`)},
				${change("householdRole", sql`to_jsonb(p.household_role)`, json(value.role))})||${joinedAddress})
				|| ${refusal(sql`cur.id=h.id`, sql`p.display_name||' is already in the '||h.name||'.'`)}
				|| ${refusal(sql`cur.id<>h.id`, sql`p.display_name||' is in the '||cur.name||'. Remove them from it first: a person is in one household at a time.'`)} AS review,
			jsonb_build_object('expectedRevision',p.revision::text,'input',jsonb_build_object('householdId',h.id,'personId',p.id,'role',${value.role}::text)) AS args
			FROM person p JOIN household h ON h.id=${value.householdId}::uuid AND h.plant_id=p.plant_id
				LEFT JOIN household cur ON cur.id=p.household_id AND cur.plant_id=p.plant_id
			WHERE ${livePerson(actor, sql`${value.personId}::uuid`)}`;
	},
	run: async (tx, context, args: object, key) =>
		done(await personFields.addToHousehold(tx, context, { ...args, requestKey: key }), revisionOf),
});

const removeFromHousehold = reviewed({
	operation: "people.removeFromHousehold",
	description:
		"Propose taking one person out of their household. They keep their own address. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ personId: z.uuid() }),
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',${personTarget},'changes',jsonb_build_array(
				${change("household", sql`to_jsonb(cur.name)`, sql`NULL::jsonb`)},
				${change("householdRole", sql`to_jsonb(p.household_role)`, sql`NULL::jsonb`)}))
				|| ${refusal(sql`cur.id IS NULL`, sql`p.display_name||' is not in a household.'`)} AS review,
			jsonb_build_object('expectedRevision',p.revision::text,'input',jsonb_build_object('personId',p.id)) AS args
			FROM person p LEFT JOIN household cur ON cur.id=p.household_id AND cur.plant_id=p.plant_id
			WHERE ${livePerson(actor, sql`${value.personId}::uuid`)}`;
	},
	run: async (tx, context, args: object, key) =>
		done(await personFields.removeFromHousehold(tx, context, { ...args, requestKey: key }), revisionOf),
});

const setHouseholdRole = reviewed({
	operation: "people.setHouseholdRole",
	description:
		"Propose a person's role in their household: head, spouse, child or other. Never infer a role from a name. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ personId: z.uuid(), role: householdRole }),
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',${personTarget},'changes',jsonb_build_array(
				${change("householdRole", sql`to_jsonb(p.household_role)`, json(value.role))}))
				|| ${refusal(sql`cur.id IS NULL`, sql`p.display_name||' is not in a household.'`)} AS review,
			jsonb_build_object('expectedRevision',p.revision::text,'input',jsonb_build_object('personId',p.id,'role',${value.role}::text)) AS args
			FROM person p LEFT JOIN household cur ON cur.id=p.household_id AND cur.plant_id=p.plant_id
			WHERE ${livePerson(actor, sql`${value.personId}::uuid`)}`;
	},
	run: async (tx, context, args: object, key) =>
		done(await personFields.setHouseholdRole(tx, context, { ...args, requestKey: key }), revisionOf),
});

type Propagation = {
	householdId: string;
	expectedRevision: string;
	patch: Address;
	members: { personId: string; revision: string }[];
	people: { id: string; label: string; changed: boolean }[];
};
const UNCHANGED_ADDRESS = "Already at this address";
const propagateAddress = reviewed({
	operation: "people.propagateAddress",
	description:
		"Propose giving every current member of one household the household's address, optionally changing that address first (for example after a move). The review lists each member's address before and after; nothing changes for anyone until the user approves it, and a member changed since the review stops the whole change.",
	input: z.strictObject({ householdId: z.uuid(), address: address.optional() }),
	review(actor, value) {
		const patch = Object.fromEntries(Object.entries(value.address ?? {}).filter(([, v]) => v !== undefined));
		const after = ADDRESS.map(
			([key, col]) => sql`CASE WHEN ${json(patch)} ? ${key}::text THEN ${json(patch)}->>${key}::text ELSE h.${sql.raw(col)} END AS ${sql.raw(col)}`,
		);
		const members = sql`FROM person m WHERE m.household_id=h.id AND m.tenant_id=h.plant_id AND m.state='live'`;
		return sql`SELECT jsonb_build_object('target',${householdTarget},'changes',${fieldChanges("h", patch, Object.fromEntries(ADDRESS))},
				'people',coalesce((SELECT jsonb_agg(jsonb_build_object('id',m.id,'label',m.display_name,
					'changes',CASE WHEN ${sameAddress("m", "n")} THEN '[]'::jsonb
						ELSE jsonb_build_array(${change("address", sql`to_jsonb(${addressLine("m")})`, sql`to_jsonb(${addressLine("n")})`)}) END)
					|| CASE WHEN ${sameAddress("m", "n")} THEN jsonb_build_object('unchanged',${UNCHANGED_ADDRESS}::text) ELSE '{}'::jsonb END
					ORDER BY ${roleOrder("m")}) ${members}),'[]'::jsonb))
				|| ${refusal(sql`NOT EXISTS(SELECT 1 ${members})`, sql`h.name||' has nobody in it to update.'`)} AS review,
			jsonb_build_object('householdId',h.id,'expectedRevision',h.revision::text,'patch',${json(patch)},
				'members',coalesce((SELECT jsonb_agg(jsonb_build_object('personId',m.id,'revision',m.revision::text) ORDER BY m.id) ${members}),'[]'::jsonb),
				'people',coalesce((SELECT jsonb_agg(jsonb_build_object('id',m.id,'label',m.display_name,'changed',NOT ${sameAddress("m", "n")})
					ORDER BY ${roleOrder("m")}) ${members}),'[]'::jsonb)) AS args
			FROM household h CROSS JOIN LATERAL (SELECT ${sql.join(after, sql`,`)}) n
			WHERE h.id=${value.householdId}::uuid AND h.plant_id=${actor.owner.id}::uuid`;
	},
	async run(tx, context, args: Propagation, key) {
		let revision = args.expectedRevision;
		// A move changes the household's own address first, then copies it to every member, in the one transaction.
		if (Object.keys(args.patch).length) {
			const moved = await personFields.updateHousehold(tx, context, {
				requestKey: `${key}:household`,
				expectedRevision: revision,
				input: { householdId: args.householdId, patch: args.patch },
			});
			if (moved.status !== "ok") return { refused: moved.error.code };
			revision = revisionOf(moved.value);
		}
		const copied = await personFields.propagateAddress(tx, context, {
			requestKey: key,
			expectedRevision: revision,
			input: { householdId: args.householdId, members: args.members },
		});
		if (copied.status !== "ok") return { refused: copied.error.code };
		return {
			receiptId: copied.value.receiptId,
			revision,
			people: args.people.map((p) => ({
				id: p.id,
				label: p.label,
				...(p.changed ? { outcome: "changed" as const } : { outcome: "unchanged" as const, reason: UNCHANGED_ADDRESS }),
			})),
		};
	},
	// The household's members as they are now, each with their address.
	current: (p) => sql`(SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id,'label',m.display_name,'value',${addressLine("m")})
		ORDER BY ${roleOrder("m")}),'[]'::jsonb) FROM person m
		WHERE m.household_id=(${p}.input->>'householdId')::uuid AND m.tenant_id=${p}.tenant_id AND m.state='live')`,
});

// ---------------------------------------------------------------------------------------------------------------
// Tags (REQ-PPL-010). Names that differ only by case or surrounding spaces are the same tag.

const createTag = reviewed({
	operation: "people.createTag",
	description:
		"Propose a new tag in this church's tag list, without putting it on anyone. To tag people, use people.assignTag. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ name: tagName, color: tagColor.nullable().optional() }),
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target','null'::jsonb,'changes',jsonb_build_array(${change("tag", sql`NULL::jsonb`, json(value.name))})
				||CASE WHEN ${value.color ?? null}::text IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(${change("color", sql`NULL::jsonb`, json(value.color))}) END)
				|| ${refusal(sql`e.name IS NOT NULL`, sql`'A tag named '||e.name||' already exists.'`)} AS review,
			jsonb_build_object('input',${json({ name: value.name, color: value.color ?? null })}) AS args
			FROM (SELECT (SELECT t.name FROM tag t WHERE t.plant_id=${actor.owner.id}::uuid AND t.normalized_name=lower(btrim(${value.name}::text))) AS name) e`;
	},
	run: async (tx, context, args: object, key) =>
		done(await personFields.createTag(tx, context, { ...args, requestKey: key }), (v) => v.tag.revision),
});

const updateTag = reviewed({
	operation: "people.updateTag",
	description:
		"Propose renaming a tag or changing its color, for everyone who has it. Nothing changes until the user approves the exact review.",
	input: z
		.strictObject({ tagId: z.uuid(), name: tagName.optional(), color: tagColor.nullable().optional() })
		.refine((v) => v.name !== undefined || v.color !== undefined, "nothing to change"),
	review(actor, value) {
		const { tagId, ...patch } = value;
		return sql`SELECT jsonb_build_object('target',${tagTarget},'changes',${fieldChanges("t", patch, { name: "name", color: "color" })})
				|| ${refusal(sql`EXISTS(SELECT FROM tag o WHERE o.plant_id=t.plant_id AND o.id<>t.id AND o.normalized_name=lower(btrim(${value.name ?? null}::text)))`, sql`'A tag named '||btrim(${value.name ?? null}::text)||' already exists.'`)} AS review,
			jsonb_build_object('expectedRevision',t.revision::text,'input',${json(value)}) AS args
			FROM tag t WHERE t.id=${tagId}::uuid AND t.plant_id=${actor.owner.id}::uuid`;
	},
	run: async (tx, context, args: object, key) =>
		done(await personFields.updateTag(tx, context, { ...args, requestKey: key }), (v) => v.tag.revision),
});

/** The live people in this church who have tag `t`. */
const tagged = sql`(SELECT count(*) FROM person_tag pt JOIN person q ON q.id=pt.person_id AND q.state='live'
	WHERE pt.tag_id=t.id AND pt.plant_id=t.plant_id)`;
const deleteTag = reviewed({
	operation: "people.deleteTag",
	description:
		"Propose deleting a tag, which takes it off everyone who has it. Their history keeps it. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ tagId: z.uuid() }),
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',${tagTarget},'changes',jsonb_build_array(
				${change("tag", sql`to_jsonb(t.name)`, sql`NULL::jsonb`)},${change("taggedPeople", sql`to_jsonb(${tagged})`, json(0))})) AS review,
			jsonb_build_object('expectedRevision',t.revision::text,'input',jsonb_build_object('tagId',t.id)) AS args
			FROM tag t WHERE t.id=${value.tagId}::uuid AND t.plant_id=${actor.owner.id}::uuid`;
	},
	run: async (tx, context, args: object, key) =>
		done(await personFields.deleteTag(tx, context, { ...args, requestKey: key }), () => "0"),
});

type Tagging = { tag: { id: string } | { create: string }; people: { personId: string; label: string }[] };
/**
 * One review that puts a tag on, or takes it off, each named live person in this church; no row unless every id is one.
 * The tag is named by id, or by name when assigning: a name no tag has yet is created first.
 */
function tagReview(actor: EvryActor, ids: string[], tag: SQL, assign: boolean, tagName: string | null) {
	const name = sql`coalesce((SELECT t.name FROM t),btrim(${tagName}::text))`;
	const has = sql`EXISTS(SELECT FROM person_tag pt WHERE pt.person_id=ps.id AND pt.plant_id=${actor.owner.id}::uuid AND pt.tag_id=(SELECT t.id FROM t))`;
	const changes = assign ? sql`NOT ${has}` : has;
	return sql`WITH t AS (SELECT t.id,t.name FROM tag t WHERE t.plant_id=${actor.owner.id}::uuid AND ${tag}),
		ps AS (SELECT p.id,p.display_name,x.n FROM unnest(${sql.param(ids)}::uuid[]) WITH ORDINALITY x(id,n)
			JOIN person p ON p.id=x.id AND p.tenant_id=${actor.owner.id}::uuid AND p.plant_id=${actor.owner.id}::uuid AND p.state='live')
		SELECT jsonb_build_object('target',coalesce((SELECT ${tagTarget} FROM t),'null'::jsonb),
				'changes',jsonb_build_array(${change("tag", assign ? sql`NULL::jsonb` : sql`to_jsonb(${name})`, assign ? sql`to_jsonb(${name})` : sql`NULL::jsonb`)})
					||CASE WHEN EXISTS(SELECT FROM t) THEN '[]'::jsonb ELSE jsonb_build_array(${change("createTag", sql`NULL::jsonb`, sql`to_jsonb(${name})`)}) END,
				'people',(SELECT jsonb_agg(jsonb_build_object('id',ps.id,'label',ps.display_name,'changes',CASE WHEN ${changes}
					THEN jsonb_build_array(${change("tag", assign ? sql`NULL::jsonb` : sql`to_jsonb(${name})`, assign ? sql`to_jsonb(${name})` : sql`NULL::jsonb`)}) ELSE '[]'::jsonb END)
					||CASE WHEN ${changes} THEN '{}'::jsonb ELSE jsonb_build_object('unchanged',${assign ? "Already has this tag" : "Doesn't have this tag"}::text) END ORDER BY ps.n) FROM ps)) AS review,
			jsonb_build_object('tag',coalesce((SELECT jsonb_build_object('id',t.id) FROM t),jsonb_build_object('create',btrim(${tagName}::text))),
				'people',(SELECT jsonb_agg(jsonb_build_object('personId',ps.id,'label',ps.display_name) ORDER BY ps.n) FROM ps)) AS args
		WHERE (SELECT count(*) FROM ps)=${ids.length} AND (EXISTS(SELECT FROM t) OR ${assign && tagName !== null}::boolean)`;
}
/** Each person's native tag change in turn; any refusal refuses the whole effect. */
async function eachPerson(
	tx: Transaction,
	context: PeopleContext,
	args: Tagging,
	tagId: string,
	key: string,
	change: typeof personFields.assignTag,
	unchanged: string,
	first: string | null,
): Promise<EffectResult> {
	let receiptId = first;
	const people = [];
	for (const p of args.people) {
		const r = (await change(tx, context, {
			requestKey: `${key}:${p.personId}`,
			input: { personId: p.personId, tagId },
		})) as Reply<{ receiptId: string; outcome: "changed" | "noop" }>;
		if (r.status !== "ok") return { refused: r.error.code };
		receiptId ??= r.value.receiptId;
		people.push({
			id: p.personId,
			label: p.label,
			...(r.value.outcome === "changed" ? { outcome: "changed" as const } : { outcome: "unchanged" as const, reason: unchanged }),
		});
	}
	return { receiptId: receiptId!, revision: "1", people };
}
const assignTag = reviewed({
	operation: "people.assignTag",
	description:
		"Propose putting one tag on each named person (up to 50), by tag id or by name; a name no tag has yet is created as part of the same review. Only person ids from earlier results. Never record a tag as a note. Nothing changes until the user approves the exact review.",
	input: z
		.strictObject({ personIds, tagId: z.uuid().optional(), tagName: tagName.optional() })
		.refine((v) => (v.tagId === undefined) !== (v.tagName === undefined), "name the tag by id or by name"),
	review(actor, value) {
		const tag = value.tagId
			? sql`t.id=${value.tagId}::uuid`
			: sql`t.normalized_name=lower(btrim(${value.tagName!}::text))`;
		return tagReview(actor, value.personIds, tag, true, value.tagName ?? null);
	},
	async run(tx, context, args: Tagging, key) {
		let tagId: string, first: string | null = null;
		if ("create" in args.tag) {
			const created = await personFields.createTag(tx, context, {
				requestKey: `${key}:tag`,
				input: { name: args.tag.create, color: null },
			});
			if (created.status !== "ok") return { refused: created.error.code };
			tagId = created.value.tag.id;
			first = created.value.receiptId;
		} else tagId = args.tag.id;
		return eachPerson(tx, context, args, tagId, key, personFields.assignTag, "Already had this tag", first);
	},
});
const removeTag = reviewed({
	operation: "people.removeTag",
	description:
		"Propose taking one tag off each named person (up to 50). The tag stays in the tag list. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ personIds, tagId: z.uuid() }),
	review: (actor, value) => tagReview(actor, value.personIds, sql`t.id=${value.tagId}::uuid`, false, null),
	run: async (tx, context, args: Tagging, key) =>
		eachPerson(tx, context, args, (args.tag as { id: string }).id, key, personFields.removeTag, "Didn't have this tag", null),
});

// ---------------------------------------------------------------------------------------------------------------
// Skills (REQ-PPL-011).

const SKILL_COLUMNS = { name: "name", category: "category", proficiency: "proficiency", notes: "notes" };
const skillReceipt = (v: { receiptId: string; skills: { revision: string }[] }) => String(v.skills.length);
const addSkill = reviewed({
	operation: "people.addSkill",
	description:
		"Propose adding a skill to one person: its name, its category (worship, tech, admin, teaching, hospitality, leadership or other) and the level when said (beginner, intermediate, advanced or expert). Nothing changes until the user approves the exact review.",
	input: z.strictObject({
		personId: z.uuid(),
		name: skillName,
		category: skillCategory,
		proficiency: proficiency.nullable().optional(),
		notes: skillNotes.nullable().optional(),
	}),
	review(actor, value) {
		const input = { ...value, proficiency: value.proficiency ?? null, notes: value.notes ?? null };
		const changes = Object.entries(SKILL_COLUMNS).flatMap(([key]) => {
			const after = input[key as keyof typeof input];
			return after === null ? [] : [{ field: key === "name" ? "skill" : key, before: null, after }];
		});
		return sql`SELECT jsonb_build_object('target',${personTarget},'changes',${json(changes)}) AS review,
			jsonb_build_object('input',${json(input)}) AS args
			FROM person p WHERE ${livePerson(actor, sql`${value.personId}::uuid`)}`;
	},
	run: async (tx, context, args: object, key) =>
		done(await personFields.addSkill(tx, context, { ...args, requestKey: key }), skillReceipt),
});

/** The skill `s` with its live person `p` in the actor's church. */
const liveSkill = (actor: EvryActor, skillId: string) =>
	sql`FROM person_skill s JOIN person p ON p.id=s.person_id AND p.tenant_id=s.plant_id AND p.state='live'
	WHERE s.id=${skillId}::uuid AND s.plant_id=${actor.owner.id}::uuid`;
const updateSkill = reviewed({
	operation: "people.updateSkill",
	description:
		"Propose a change to one of a person's skills: its name, category, level or notes, by the skill's id from people.getPersonSkills. Nothing changes until the user approves the exact review.",
	input: z.strictObject({
		skillId: z.uuid(),
		patch: nonEmpty(
			z.strictObject({
				name: skillName.optional(),
				category: skillCategory.optional(),
				proficiency: proficiency.nullable().optional(),
				notes: skillNotes.nullable().optional(),
			}),
		),
	}),
	review(actor, value) {
		const { name, ...rest } = value.patch;
		// The skill's name leads, so the card always says which skill changes.
		return sql`SELECT jsonb_build_object('target',${personTarget},'changes',
				jsonb_build_array(${change("skill", sql`to_jsonb(s.name)`, name === undefined ? sql`to_jsonb(s.name)` : json(name))})
				||${fieldChanges("s", rest, SKILL_COLUMNS)}) AS review,
			jsonb_build_object('expectedRevision',s.revision::text,'input',jsonb_build_object('skillId',s.id,'patch',${json(value.patch)})) AS args
			${liveSkill(actor, value.skillId)}`;
	},
	run: async (tx, context, args: object, key) =>
		done(await personFields.updateSkill(tx, context, { ...args, requestKey: key }), skillReceipt),
});
const removeSkill = reviewed({
	operation: "people.removeSkill",
	description:
		"Propose removing one of a person's skills, by the skill's id from people.getPersonSkills. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ skillId: z.uuid() }),
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',${personTarget},'changes',jsonb_build_array(
				${change("skill", sql`to_jsonb(s.name)`, sql`NULL::jsonb`)},${change("category", sql`to_jsonb(s.category)`, sql`NULL::jsonb`)},
				${change("proficiency", sql`to_jsonb(s.proficiency)`, sql`NULL::jsonb`)})) AS review,
			jsonb_build_object('expectedRevision',s.revision::text,'input',jsonb_build_object('skillId',s.id)) AS args
			${liveSkill(actor, value.skillId)}`;
	},
	run: async (tx, context, args: object, key) =>
		done(await personFields.removeSkill(tx, context, { ...args, requestKey: key }), skillReceipt),
});

// ---------------------------------------------------------------------------------------------------------------
// Notes (REQ-PPL-008). Only a note's author may edit or delete it; the review says so instead of offering approval.

const noteReceipt = (v: { personRevision: string }) => v.personRevision;
const addNote = reviewed({
	operation: "people.addNote",
	description:
		"Propose adding a note to one person's history, with the exact text the user gave. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ personId: z.uuid(), body: longText }),
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',${personTarget},'changes',jsonb_build_array(${change("note", sql`NULL::jsonb`, json(value.body))})) AS review,
			jsonb_build_object('expectedRevision',p.revision::text,'input',jsonb_build_object('personId',p.id,'body',${value.body}::text)) AS args
			FROM person p WHERE ${livePerson(actor, sql`${value.personId}::uuid`)}`;
	},
	run: async (tx, context, args: object, key) =>
		done(await peopleWriter.addNote(tx, context, { ...args, requestKey: key } as never), noteReceipt),
});

/** The current note `n` with its live person `p`, and whether the actor wrote it. */
const liveNote = (actor: EvryActor, noteId: string) =>
	sql`FROM person_note n JOIN person p ON p.id=n.person_id AND p.tenant_id=n.tenant_id AND p.plant_id=${actor.owner.id}::uuid AND p.state='live'
	WHERE n.id=${noteId}::uuid AND n.tenant_id=${actor.owner.id}::uuid AND n.removed_at IS NULL`;
const notAuthor = (actor: EvryActor) =>
	refusal(sql`n.author_id IS DISTINCT FROM ${actor.accountId}::uuid`, sql`'Only the person who wrote this note can change it.'`);
const editNote = reviewed({
	operation: "people.editNote",
	description:
		"Propose new text for one of a person's notes, by the note's id from people.getActivities, with the reason. Only the note's author may change it. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ noteId: z.uuid(), body: longText, reason: longText }),
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',${personTarget},'changes',jsonb_build_array(
				${change("note", sql`to_jsonb(n.body)`, json(value.body))},${change("reason", sql`NULL::jsonb`, json(value.reason))}))
				|| ${notAuthor(actor)} AS review,
			jsonb_build_object('expectedRevision',n.revision::text,'input',jsonb_build_object('personId',p.id,'noteId',n.id,'body',${value.body}::text,'reason',${value.reason}::text)) AS args
			${liveNote(actor, value.noteId)}`;
	},
	run: async (tx, context, args: object, key) =>
		done(await peopleWriter.editNote(tx, context, { ...args, requestKey: key } as never), noteReceipt),
});
const deleteNote = reviewed({
	operation: "people.deleteNote",
	description:
		"Propose deleting one of a person's notes, by the note's id from people.getActivities, with the reason. Only the note's author may delete it. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ noteId: z.uuid(), reason: longText }),
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',${personTarget},'changes',jsonb_build_array(
				${change("note", sql`to_jsonb(n.body)`, sql`NULL::jsonb`)},${change("reason", sql`NULL::jsonb`, json(value.reason))}))
				|| ${notAuthor(actor)} AS review,
			jsonb_build_object('expectedRevision',n.revision::text,'input',jsonb_build_object('personId',p.id,'noteId',n.id,'reason',${value.reason}::text)) AS args
			${liveNote(actor, value.noteId)}`;
	},
	run: async (tx, context, args: object, key) =>
		done(await peopleWriter.deleteNote(tx, context, { ...args, requestKey: key } as never), noteReceipt),
});

// ---------------------------------------------------------------------------------------------------------------
// Import (REQ-PPL-018). The review is the preview: every row's planned outcome against today's people. Approval saves
// the reviewed rows and queues the job that writes them, in the effect's transaction; a church whose people changed
// since the preview refuses (review_stale) and nothing is saved.

type Preview = z.infer<typeof importPreview>;
type Choice = z.infer<typeof importChoice>;
type ImportArgs = { file: string; fileDigest: string; reviewDigest: string; choices: { row: number; choice: Choice }[] };
/** Each row's planned outcome, and the native choices: the user's where given, otherwise the preview's suggestion. */
function plan(preview: Preview, chosen: Map<number, Choice>) {
	const rows = [];
	const choices: ImportArgs["choices"] = [];
	let refusal: string | null = null;
	for (const r of preview.rows) {
		if (r.status === "invalid") {
			rows.push({ row: r.row, outcome: "fail" as const, label: null, reason: problemText(r.problems) });
			continue;
		}
		const choice = chosen.get(r.row) ?? r.suggested;
		const like = r.existingDuplicates.map((d) => d.displayName);
		const reason = like.length
			? `Matches ${like.join(", ")}`
			: r.withinFileDuplicateOf !== null
				? `Same as row ${r.withinFileDuplicateOf}`
				: null;
		if (choice === "create_and_review" && reason === null)
			refusal ??= `Row ${r.row} matches nobody, so there is nothing to review it against.`;
		choices.push({ row: r.row, choice });
		rows.push({ row: r.row, outcome: choice, label: r.values.displayName, reason });
	}
	return { rows, choices, refusal };
}
const executeBulkImport = reviewed({
	operation: "people.executeBulkImport",
	description:
		"Propose importing a people CSV (the same text people.previewImport takes): the review shows each row's planned outcome, and rows that match someone are skipped unless the user chose otherwise. Nothing is imported until the user approves the exact review.",
	input: z.strictObject({
		file: z.string().min(1).max(importLimits.bytes).describe("CSV text that uses the import template columns"),
		choices: z
			.array(z.strictObject({ row: z.int().min(1), choice: importChoice }))
			.max(importLimits.rows)
			.optional()
			.describe("Only rows the user decided differently from the preview's suggestion"),
	}),
	async review(actor, value, context) {
		const bytes = new TextEncoder().encode(value.file);
		const preview = (await context.db.transaction((tx) =>
			peopleCsv.previewImport(tx, new PeopleReadContext(actor.authority), { file: bytes }),
		)) as Reply<Preview>;
		if (preview.status !== "ok") {
			if (preview.error.code === "source_unavailable") throw new EvryRefusal("source_unavailable");
			if (preview.error.code === "unavailable") return null;
			throw new EvryRefusal("invalid_input");
		}
		const { rows, choices, refusal } = plan(preview.value, new Map(value.choices?.map((c) => [c.row, c.choice])));
		const args: ImportArgs = {
			file: value.file,
			fileDigest: preview.value.fileDigest,
			reviewDigest: preview.value.reviewDigest,
			choices,
		};
		const review = { target: null, changes: [], rows, ...(refusal && { refusal }) };
		return sql`SELECT ${json(review)} AS review, ${json(args)} AS args`;
	},
	async run(tx, context, args: ImportArgs, key) {
		const saved = (await peopleCsv.saveBulkImport(tx, context, {
			requestKey: key,
			file: new TextEncoder().encode(args.file),
			fileDigest: args.fileDigest,
			reviewDigest: args.reviewDigest,
			choices: args.choices,
		})) as Reply<{
			importId: string;
			status: "in_progress" | "complete" | "partial";
			counts: { created: number; skipped: number; failed: number; remaining: number };
			rows: ({ row: number; status: string } & { problems?: { column: string | null; code: string }[]; reason?: string })[];
		}>;
		if (saved.status !== "ok") return { refused: saved.error.code };
		const receipt = saved.value;
		return {
			receiptId: receipt.importId,
			revision: "1",
			import: {
				status: receipt.status,
				counts: receipt.counts,
				failed: receipt.rows.flatMap((r) =>
					r.status === "failed"
						? [{ row: r.row, reason: r.reason === "row_write_failed" ? "the import could not write this row" : problemText(r.problems ?? []) }]
						: [],
				),
			},
		};
	},
});

/** The installed household, tag, skill, note and import reviewed writes, keyed by operation. */
export const ORGANIZATION_COMMANDS = {
	"people.addToHousehold": addToHousehold,
	"people.createHouseholdWithHead": createHouseholdWithHead,
	"people.updateHousehold": updateHousehold,
	"people.deleteHousehold": deleteHousehold,
	"people.removeFromHousehold": removeFromHousehold,
	"people.setHouseholdRole": setHouseholdRole,
	"people.propagateAddress": propagateAddress,
	"people.createTag": createTag,
	"people.updateTag": updateTag,
	"people.deleteTag": deleteTag,
	"people.assignTag": assignTag,
	"people.removeTag": removeTag,
	"people.addSkill": addSkill,
	"people.updateSkill": updateSkill,
	"people.removeSkill": removeSkill,
	"people.addNote": addNote,
	"people.editNote": editNote,
	"people.deleteNote": deleteNote,
	"people.executeBulkImport": executeBulkImport,
} as const;
