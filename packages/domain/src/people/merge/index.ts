import * as c from "@everyfield/contracts/people";
import { sql, type SQL, type SQLWrapper } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import {
	authorizeRead,
	deny,
	hash,
	mutation,
	parse,
	readReply,
	reply,
	type Context,
	type Tx,
	type WriteContext,
} from "../core.ts";
import { matchPeople } from "../duplicates.ts";
import { columnsChanged, freshPosition, sameColumn } from "../people.ts";
import {
	lockPair,
	parseReferences,
	referencesOf,
	registrationOf,
	treatmentOf,
	type Reference,
} from "../person-reference-registry/index.ts";
import { adminRead } from "../assessments/shared.ts";
import {
	commitmentInputs,
	commitmentInputsJson,
	commitmentOf,
	type CommitmentInputs,
} from "../commitments/lifecycle.ts";

type Field = z.infer<typeof c.mergeField>;
type Kind = z.infer<typeof c.referenceKind>;
/** The Person columns each reviewable field covers. */
const columns: Record<Field, readonly string[]> = {
	displayName: ["display_name"],
	firstName: ["first_name"],
	lastName: ["last_name"],
	email: ["email"],
	phone: ["phone"],
	address: ["street", "city", "state_province", "postal_code", "country"],
	source: ["source", "source_details"],
	summaryNotes: ["notes"],
	birthDate: ["birth_date"],
	adultClassification: ["adult_classification"],
	household: ["household_id", "household_role"],
	photo: ["photo_object_id"],
};
const factsRow = z.object({
	id: z.uuid(),
	state: z.enum(["live", "retired", "merged"]),
	revision: z.coerce.string(),
	display_name: z.string(),
	linked_account_id: z.uuid().nullable(),
	merged_into_person_id: z.uuid().nullable(),
	stage: c.stage.nullable(),
	pipeline_position: z.coerce.string().nullable(),
	commitment_state: z.enum(["active", "withdrawn", "unknown"]).nullable(),
	commitment_effective_on: z.string().nullable(),
	household_id: z.uuid().nullable(),
	commitment_inputs: commitmentInputs,
	refs: z.unknown(),
});
export type Facts = Omit<z.infer<typeof factsRow>, "refs" | "commitment_inputs"> & {
	refs: Reference[];
	values: Record<string, unknown>;
	commitment: CommitmentInputs;
};
export function parseFacts(raw: unknown): Facts | null {
	if (raw === null) return null;
	const { commitment_inputs, ...row } = factsRow.parse(raw);
	const values = z.record(z.string(), z.unknown()).parse(raw);
	delete values.commitment_inputs;
	return { ...row, refs: parseReferences(row.refs), values, commitment: commitment_inputs };
}
/**
 * One Person with every tracked reference, read in the statement that holds `gate`. Removed organization people are
 * missing, like every other People read.
 */
export const factsOf = (id: SQL, owner: string | SQL) =>
	sql`(SELECT to_jsonb(p)||jsonb_build_object('revision',p.revision::text,'pipeline_position',p.pipeline_position::text,
 'refs',${referencesOf(sql`p.id`, owner)},'commitment_inputs',${commitmentInputsJson(sql`p.id`, sql`${owner}::uuid`)}) FROM person p WHERE p.id=${id} AND p.tenant_id=${owner}::uuid
 AND NOT EXISTS(SELECT FROM organization_person_removal w WHERE w.person_record_id=p.id AND w.organization_id=p.tenant_id))`;

/** The hash of an exact set of references, independent of read order. */
export const referencesDigest = (refs: readonly Reference[]) =>
	hash([...refs].map((x) => [x.kind, x.id, x.revision]).sort((a, b) => (a.join() < b.join() ? -1 : 1)));

const order = c.stage.options;

/**
 * The whole merge decision as one pure function of the two Persons and the reviewer's choices, shared by the review and
 * the merge so both say the same thing (REQ-PPL-025): differing fields, the survivor's new values and the prior values
 * Unmerge restores, the stage and commitment the survivor keeps, the references that move and any blockers.
 */
export function plan(
	kind: "plant" | "organization",
	source: Facts,
	survivor: Facts,
	choices: Partial<Record<Field, "source" | "survivor">>,
) {
	const fields = c.mergeField.options.filter(
		(f) => kind === "plant" || !(c.plantOnlyMergeFields as readonly string[]).includes(f),
	);
	if (Object.keys(choices).some((f) => !fields.includes(f as Field))) deny("invalid_input");
	const differing = fields.filter((f) =>
		columns[f].some((col) => JSON.stringify(source.values[col]) !== JSON.stringify(survivor.values[col])),
	);
	const set: Record<string, unknown> = {};
	for (const f of differing) if (choices[f] === "source") for (const col of columns[f]) set[col] = source.values[col];
	let stage = null,
		commitment = null;
	if (kind === "plant") {
		const result = order[Math.max(order.indexOf(source.stage!), order.indexOf(survivor.stage!))]!;
		stage = { source: source.stage!, survivor: survivor.stage!, result };
		if (result !== survivor.stage) {
			set.stage = result;
			if (!sameColumn(survivor.stage!, result)) set.pipeline_position = freshPosition(survivor.id);
		}
		// REQ-PPL-026 (C100): all the source's history shows on the survivor, so its commitment is the one function over
		// both Persons' valid cards and dated changes.
		commitment = commitmentOf({
			cards: [...survivor.commitment.cards, ...source.commitment.cards],
			changes: [...survivor.commitment.changes, ...source.commitment.changes],
		});
		if (commitment.state !== survivor.commitment_state || commitment.effectiveOn !== survivor.commitment_effective_on) {
			set.commitment_state = commitment.state;
			set.commitment_effective_on = commitment.effectiveOn;
		}
	}
	const prior = Object.fromEntries(Object.keys(set).map((col) => [col, survivor.values[col]]));
	const byKind = new Map<Kind, Reference[]>();
	for (const ref of source.refs) byKind.set(ref.kind, [...(byKind.get(ref.kind) ?? []), ref]);
	const held = new Set(survivor.refs.filter((x) => x.kind === "tag").map((x) => x.id));
	const blocked = [...byKind.keys()].filter((k) => treatmentOf(k) === "block");
	const causes: z.infer<typeof c.mergeBlocker>[] = [];
	if (source.linked_account_id && survivor.linked_account_id) causes.push("linked_account_collision");
	else if (source.linked_account_id) causes.push("linked_source");
	if (blocked.length) causes.push("unregistered_reference");
	const references = [...byKind].map(([k, refs]) => ({ kind: k, count: refs.length, treatment: treatmentOf(k) }));
	return {
		fields: differing.map((f) => ({
			field: f,
			source: Object.fromEntries(columns[f].map((col) => [col, source.values[col]])),
			survivor: Object.fromEntries(columns[f].map((col) => [col, survivor.values[col]])),
		})),
		set,
		prior,
		stage,
		commitment,
		byKind,
		// Tags the survivor already holds are dropped from the source instead of duplicated.
		droppedTags: (byKind.get("tag") ?? []).filter((x) => held.has(x.id)).map((x) => x.id),
		references,
		blockers: { causes, references: blocked },
		reviewDigest: hash({
			source: [source.id, source.revision, referencesDigest(source.refs)],
			survivor: [survivor.id, survivor.revision, referencesDigest(survivor.refs)],
		}),
	};
}

async function readPair(tx: Tx, owner: string, input: { sourceId: string; survivorId: string }, gate: SQL) {
	const result =
		await tx.execute(sql`SELECT ${gate} AS allowed,${factsOf(sql`${input.sourceId}::uuid`, owner)} AS source,
 ${factsOf(sql`${input.survivorId}::uuid`, owner)} AS survivor`);
	const row = z.object({ allowed: z.boolean(), source: z.unknown(), survivor: z.unknown() }).parse(result.rows[0]);
	const source = parseFacts(row.source),
		survivor = parseFacts(row.survivor);
	// A missing, foreign or not-live Person reads like any inaccessible one.
	if (!row.allowed || !source || !survivor || source.state !== "live" || survivor.state !== "live") deny();
	return { source, survivor };
}
const ownerKind = (ctx: Pick<Context, "selected">) => {
	if (ctx.selected.kind !== "plant" && ctx.selected.kind !== "organization") deny();
	return ctx.selected.kind;
};

/**
 * The SQL that moves one kind of reference from `from` to `to`; Unmerge passes the rows the merge moved. A moved row
 * gets a new revision, so a form reviewed against its old owner is refused.
 */
export function moveRefs(owner: string, k: Kind, ids: string[], from: string, to: string): SQLWrapper {
	const e = registrationOf(k);
	return sql`UPDATE ${sql.identifier(e.table)} SET ${sql.identifier(e.column)}=${to}::uuid${e.revision ? sql`,revision=revision+1` : sql``}
 WHERE ${sql.identifier(e.column)}=${from}::uuid AND ${sql.identifier(e.owner)}=${owner}::uuid
 AND ${sql.identifier(e.key)}=ANY(${sql.param(ids)}::uuid[])`;
}
export function updatePerson(owner: string, id: string, set: Record<string, unknown>): SQLWrapper {
	const assignments = Object.entries(set).map(([col, v]) =>
		v instanceof Object && "getSQL" in v
			? sql`${sql.identifier(col)}=${v as SQL}`
			: sql`${sql.identifier(col)}=${sql.param(v)}`,
	);
	return sql`UPDATE person SET ${sql.join([...assignments, sql`revision=revision+1`], sql`,`)}
 WHERE id=${id}::uuid AND tenant_id=${owner}::uuid`;
}
export const peopleMerge = {
	/** people.getMergeReview: everything a merge would change, its blockers and the digest of the reviewed state. */
	async getMergeReview(tx: Tx, ctx: Context, raw: unknown) {
		return readReply(async () => {
			const kind = ownerKind(ctx);
			const input = parse(c.mergeReviewRequest, raw);
			const { source, survivor } = await readPair(tx, ctx.selected.id, input, adminRead(ctx));
			const p = plan(kind, source, survivor, {});
			const side = (f: Facts) => ({
				personId: f.id,
				revision: f.revision,
				displayName: f.display_name,
				linkedAccount: f.linked_account_id !== null,
			});
			return c.mergeReview.parse({
				source: side(source),
				survivor: side(survivor),
				fields: p.fields,
				stage: p.stage,
				commitment: p.commitment && { result: p.commitment.state, effectiveOn: p.commitment.effectiveOn },
				references: p.references,
				blockers: p.blockers,
				reviewDigest: p.reviewDigest,
			});
		});
	},
	/**
	 * people.mergePeople and orgPeople.merge (REQ-PPL-017, 025, MUL-017): with both Persons locked in UUID order, the
	 * reviewed state must be exactly the current one. Then one statement moves every registered reference, retires the
	 * source into the survivor, applies the chosen fields, records the merge for Unmerge and appends one audit row.
	 */
	async mergePeople(tx: Tx, ctx: WriteContext, raw: unknown) {
		return reply(tx, async () => {
			const kind = ownerKind(ctx);
			const owner = ctx.selected.id;
			const input = parse(c.mergePeopleRequest, raw);
			const name = kind === "plant" ? "people.mergePeople" : "orgPeople.merge";
			return c.mergeResult.parse(
				await mutation<unknown>(tx, ctx, name, input, async (_actor, receiptId, audit) => {
					const m = input.input;
					await lockPair(tx, owner, sql`${m.sourceId}::uuid,${m.survivorId}::uuid`);
					const { source, survivor } = await readPair(tx, owner, m, sql`true`);
					const p = plan(kind, source, survivor, m.fieldChoices);
					if (p.reviewDigest !== m.reviewDigest) deny("conflict");
					if (p.blockers.causes.length) deny("merge_blocked", p.blockers);
					const mergeId = randomUUID();
					const moved: Record<string, string[]> = {};
					for (const [k, refs] of p.byKind) {
						const ids = refs.map((x) => x.id).filter((id) => !(k === "tag" && p.droppedTags.includes(id)));
						moved[k] = ids;
						if (ids.length) audit.writes.push(moveRefs(owner, k, ids, source.id, survivor.id));
					}
					if (p.droppedTags.length) {
						moved.tag_dropped = p.droppedTags;
						audit.writes.push(
							sql`DELETE FROM person_tag WHERE person_id=${source.id}::uuid AND plant_id=${owner}::uuid
 AND tag_id=ANY(${sql.param(p.droppedTags)}::uuid[])`,
						);
					}
					const sourceSet: Record<string, unknown> = {
						state: "merged",
						merged_into_person_id: survivor.id,
						retired_at: sql`clock_timestamp()`,
					};
					const sourcePrior: Record<string, unknown> = {};
					if (kind === "plant" && source.household_id) {
						Object.assign(sourceSet, { household_id: null, household_role: null });
						Object.assign(sourcePrior, {
							household_id: source.household_id,
							household_role: source.values.household_role,
						});
					}
					audit.writes.push(updatePerson(owner, source.id, sourceSet));
					// The survivor's revision always moves on, so any later merge or edit is visible to Unmerge.
					audit.writes.push(updatePerson(owner, survivor.id, p.set));
					if (kind === "plant")
						audit.writes.push(
							columnsChanged(owner, [source.stage, ...(p.set.stage ? [survivor.stage, p.set.stage as string] : [])]),
						);
					const sourceRevision = String(BigInt(source.revision) + 1n),
						survivorRevision = String(BigInt(survivor.revision) + 1n);
					// What the survivor holds after the merge; Unmerge proceeds only while it is unchanged.
					const after = [
						...survivor.refs,
						...source.refs
							.filter((x) => !(x.kind === "tag" && p.droppedTags.includes(x.id)))
							.map((x) => (x.revision === null ? x : { ...x, revision: String(BigInt(x.revision) + 1n) })),
						{ kind: "merged_person" as const, id: source.id, revision: sourceRevision },
					];
					audit.writes.push(
						sql`INSERT INTO person_merge(id,tenant_id,source_id,survivor_id,prior,moved,source_revision,survivor_revision,references_digest)
 VALUES (${mergeId}::uuid,${owner}::uuid,${source.id}::uuid,${survivor.id}::uuid,${JSON.stringify({ source: sourcePrior, survivor: p.prior })}::jsonb,
 ${JSON.stringify(moved)}::jsonb,${sourceRevision}::bigint,${survivorRevision}::bigint,${referencesDigest(after)})`,
					);
					return {
						value: {
							mergeId,
							sourceId: source.id,
							survivorId: survivor.id,
							survivorRevision,
							moved: p.references.map(({ kind, count }) => ({ kind, count })),
							outcome: "changed",
							receiptId,
						},
						subject: survivor.id,
						action: "people.merged",
						before: { revision: survivor.revision },
						after: { revision: survivorRevision },
						// Audit names the merge and both Persons; the field values stay in person_merge (audit.md).
						metadata: {
							event: "person_merged",
							recordId: mergeId,
							sourceId: source.id,
							fields: Object.keys(p.prior).join(","),
						},
					};
				}),
			);
		});
	},
	/** people.mergedPersonDestination: where a merged Person's links lead. Any reader of the church may follow it. */
	async mergedPersonDestination(tx: Tx, ctx: Context, raw: unknown) {
		return readReply(async () => {
			const kind = ownerKind(ctx);
			const input = parse(c.mergedPersonDestinationRequest, raw);
			// Any reader of the church may follow a merged Person. In an organization only Owners and Admins read every
			// Person, so only they follow one; a Member's per-Person pipeline access does not reach merged identities.
			const gate = kind === "plant" ? (await authorizeRead(tx, ctx)).gate : adminRead(ctx);
			const result = await tx.execute(sql`SELECT p.state,coalesce(p.merged_into_person_id,p.id) AS destination,
 (SELECT m.id FROM person_merge m WHERE m.source_id=p.id AND m.tenant_id=p.tenant_id AND m.unmerged_at IS NULL) AS merge_id
 FROM person p WHERE ${gate} AND p.id=${input.personId}::uuid AND p.tenant_id=${ctx.selected.id}::uuid
 AND NOT EXISTS(SELECT FROM organization_person_removal w WHERE w.person_record_id=p.id AND w.organization_id=p.tenant_id)`);
			const row = z
				.object({ state: z.enum(["live", "retired", "merged"]), destination: z.uuid(), merge_id: z.uuid().nullable() })
				.safeParse(result.rows[0]);
			if (!row.success) deny();
			return c.mergedPersonDestination.parse({
				personId: input.personId,
				status: row.data.state,
				destinationId: row.data.destination,
				mergeId: row.data.merge_id,
			});
		});
	},
	/**
	 * orgPeople.findDuplicates (MUL-017): live people of the organization that share a normalized email, phone or name
	 * with one Person. Hints for a human to review; never an identity decision or a chosen survivor.
	 */
	async findDuplicates(tx: Tx, ctx: Context, raw: unknown) {
		return readReply(async () => {
			if (ctx.selected.kind !== "organization") deny();
			const input = parse(c.organizationDuplicatesRequest, raw);
			// The live session, seat, Owner or Admin role and lifecycle check is inside both statements (C13), so no
			// separate actor lookup runs.
			const gate = adminRead(ctx);
			const result = await tx.execute(sql`SELECT p.display_name,p.email,p.phone FROM person p WHERE ${gate}
 AND p.id=${input.personId}::uuid AND p.tenant_id=${ctx.selected.id}::uuid AND p.state='live'
 AND NOT EXISTS(SELECT FROM organization_person_removal w WHERE w.person_record_id=p.id AND w.organization_id=p.tenant_id)`);
			const p = z
				.object({ display_name: z.string(), email: z.string().nullable(), phone: z.string().nullable() })
				.safeParse(result.rows[0]);
			if (!p.success) deny();
			return matchPeople(
				tx,
				ctx.selected.id,
				gate,
				{ displayName: p.data.display_name, email: p.data.email, phone: p.data.phone },
				input.personId,
			);
		});
	},
};
