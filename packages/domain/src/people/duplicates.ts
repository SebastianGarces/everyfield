import { sql, type SQL } from "@everyfield/db/query";
import * as c from "@everyfield/contracts/people";
import "server-only";
import { z } from "zod";
import { adminRead } from "./assessments/shared.ts";
import { declareWrite } from "../operations/writes.ts";
import {
	authorize,
	authorizeRead,
	deny,
	hash,
	lockOwner,
	parse,
	readReply,
	reply,
	type Context,
	type Tx,
	type WriteContext,
} from "./core.ts";

export function contactSignals(v: { email?: string | null; phone?: string | null }) {
	const email = v.email?.trim().toLowerCase() ?? "";
	const phone = v.phone?.replace(/\D/g, "") ?? "";
	return { email: email.includes("@") ? email : null, phone: phone.length >= 7 ? phone : null };
}
export const personEmail = sql`lower(btrim(p.email))`;
export const personPhone = sql`regexp_replace(coalesce(p.phone,''),'\\D','','g')`;
const personName = sql`lower(regexp_replace(btrim(p.display_name),'\\s+',' ','g'))`;
const nameSignal = (name?: string) => {
	const n = name?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
	return n.length >= 2 ? n : null;
};

const LIMIT = 25;
const found = z.object({
	allowed: z.boolean(),
	people: z.array(
		z.object({ id: z.uuid(), displayName: z.string(), email: z.boolean(), phone: z.boolean(), name: z.boolean() }),
	),
});
export async function matchPeople(
	tx: Tx,
	owner: string,
	gate: SQL,
	input: { displayName?: string | null; email?: string | null; phone?: string | null },
	exclude?: string,
) {
	const { email, phone } = contactSignals(input);
	const name = nameSignal(input.displayName ?? undefined);
	const r = await tx.execute(
		sql`SELECT g.allowed,${matchJson(owner, { email: sql`${email}::text`, phone: sql`${phone}::text`, name: sql`${name}::text` }, sql`${exclude ?? null}::uuid`)} AS people FROM (SELECT ${gate} AS allowed) g`,
	);
	const row = found.parse(r.rows[0]);
	if (!row.allowed) deny("unavailable");
	return duplicateHints(row.people);
}
function matchJson(owner: string, signal: { email: SQL; phone: SQL; name: SQL }, exclude: SQL) {
	return sql`coalesce((SELECT jsonb_agg(jsonb_build_object('id',m.id,'displayName',m.display_name,
 'email',m.e,'phone',m.ph,'name',m.n) ORDER BY m.exact DESC,m.created_at,m.id) FROM (
  SELECT p.id,p.display_name,p.created_at,coalesce(${personEmail}=${signal.email},false) e,coalesce(${personPhone}=${signal.phone},false) ph,
   coalesce(${personName}=${signal.name},false) n,coalesce(${personEmail}=${signal.email} OR ${personPhone}=${signal.phone},false) exact
  FROM person p WHERE p.tenant_id=${owner}::uuid AND p.state='live'
   AND p.id IS DISTINCT FROM ${exclude}
   AND NOT EXISTS(SELECT FROM organization_person_removal w WHERE w.person_record_id=p.id AND w.organization_id=p.tenant_id)
   AND (${personEmail}=${signal.email} OR ${personPhone}=${signal.phone} OR ${personName}=${signal.name})
  ORDER BY exact DESC,p.created_at,p.id LIMIT ${LIMIT + 1}) m),'[]'::jsonb)`;
}
function duplicateHints(people: z.infer<typeof found>["people"]) {
	const items = people.slice(0, LIMIT).map((p) => ({
		personId: p.id,
		displayName: p.displayName,
		match: p.email || p.phone ? ("exact" as const) : ("potential" as const),
		signals: (["email", "phone", "name"] as const).filter((s) => p[s]),
	}));
	return c.duplicateHints.parse({ items, completeness: people.length > LIMIT ? "partial" : "complete" });
}
export const personDuplicatesJson = (owner: string) => {
	const trim = (v: SQL) => sql`regexp_replace(${v},'^\\s+|\\s+$','','g')`;
	const email = sql`lower(${trim(sql`person.email`)})`;
	const phone = sql`regexp_replace(coalesce(person.phone,''),'\\D','','g')`;
	const name = sql`lower(regexp_replace(${trim(sql`person.display_name`)},'\\s+',' ','g'))`;
	return matchJson(
		owner,
		{
			email: sql`(CASE WHEN strpos(${email},'@')>0 THEN ${email} END)`,
			phone: sql`(CASE WHEN length(${phone})>=7 THEN ${phone} END)`,
			name: sql`(CASE WHEN char_length(${name})>=2 THEN ${name} END)`,
		},
		sql`person.id`,
	);
};
export const personDuplicates = (raw: unknown) => duplicateHints(found.shape.people.parse(raw));
export async function checkForDuplicates(tx: Tx, ctx: Context, raw: unknown) {
	return readReply(async () => {
		if (ctx.selected.kind !== "plant") deny("unavailable");
		const plant = ctx.selected.id;
		const input = parse(c.duplicateCheckRequest, raw);
		const { gate } = await authorizeRead(tx, ctx);
		return matchPeople(tx, plant, gate, input, input.excludePersonId);
	});
}

const PAIRS = 100;
const pairRows = z.object({
	allowed: z.boolean(),
	pairs: z.array(
		z.object({
			person: z.object({ id: z.uuid(), displayName: z.string() }),
			with: z.object({ id: z.uuid(), displayName: z.string() }),
		}),
	),
});
const flagged = sql`EXISTS(SELECT FROM audit_event e WHERE e.tenant_id=p.tenant_id AND e.subject_id=p.id
 AND e.action='people.created' AND jsonb_typeof(e.metadata->'import'->'reviewWith')='string'
 AND lower(e.metadata->'import'->>'reviewWith')=m.id::text)`;
const dismissed = sql`EXISTS(SELECT FROM person_duplicate_dismissal d WHERE d.plant_id=p.tenant_id AND d.person_id=p.id
 AND d.with_person_id=m.id)`;
export async function listDuplicatePairs(tx: Tx, ctx: Context) {
	return readReply(async () => {
		if (ctx.selected.kind !== "plant") deny("unavailable");
		const plant = ctx.selected.id;
		const r = await tx.execute(sql`SELECT g.allowed,coalesce((SELECT jsonb_agg(jsonb_build_object(
  'person',jsonb_build_object('id',x.id,'displayName',x.display_name),
  'with',jsonb_build_object('id',x.with_id,'displayName',x.with_name)) ORDER BY x.created_at,x.id) FROM (
  SELECT p.id,p.display_name,p.created_at,m.id with_id,m.display_name with_name
  FROM person p
  JOIN audit_event e ON e.tenant_id=p.tenant_id AND e.subject_id=p.id AND e.action='people.created'
  JOIN person m ON m.id=(e.metadata->'import'->>'reviewWith')::uuid AND m.tenant_id=p.tenant_id AND m.state='live'
  WHERE g.allowed AND p.tenant_id=${plant}::uuid AND p.state='live' AND jsonb_typeof(e.metadata->'import'->'reviewWith')='string'
   AND NOT ${dismissed}
  ORDER BY p.created_at,p.id LIMIT ${PAIRS + 1}) x),'[]'::jsonb) AS pairs
 FROM (SELECT ${adminRead(ctx)} AS allowed) g`);
		const row = pairRows.parse(r.rows[0]);
		if (!row.allowed) deny("unavailable");
		return c.duplicatePairs.parse({
			items: row.pairs.slice(0, PAIRS),
			completeness: row.pairs.length > PAIRS ? "partial" : "complete",
		});
	});
}

const organizationPairRows = pairRows.extend({
	pairs: z.array(pairRows.shape.pairs.element.extend({ shared: z.array(z.enum(["email", "phone"])) })),
});
export async function listOrganizationDuplicatePairs(tx: Tx, ctx: Context) {
	return readReply(async () => {
		if (ctx.selected.kind !== "organization") deny("unavailable");
		const org = ctx.selected.id;
		const r = await tx.execute(sql`WITH g AS (SELECT ${adminRead(ctx)} AS allowed),
live AS (SELECT p.id,p.display_name,p.created_at,
  CASE WHEN strpos(${personEmail},'@')>0 THEN ${personEmail} END AS email,
  CASE WHEN length(${personPhone})>=7 THEN ${personPhone} END AS phone
 FROM person p JOIN g ON g.allowed WHERE p.tenant_id=${org}::uuid AND p.state='live'
  AND NOT EXISTS(SELECT FROM organization_person_removal w WHERE w.person_record_id=p.id AND w.organization_id=p.tenant_id)),
x AS (SELECT a.id,a.display_name,b.id AS with_id,b.display_name AS with_name,
  array_remove(ARRAY[CASE WHEN a.email=b.email THEN 'email' END,CASE WHEN a.phone=b.phone THEN 'phone' END],NULL) AS shared,
  least(a.created_at,b.created_at) AS at
 FROM live a JOIN live b ON (a.email=b.email OR a.phone=b.phone)
  AND (a.created_at,a.id)<(b.created_at,b.id)
 ORDER BY at,a.id,b.id LIMIT ${PAIRS + 1})
SELECT g.allowed,coalesce((SELECT jsonb_agg(jsonb_build_object(
  'person',jsonb_build_object('id',x.id,'displayName',x.display_name),
  'with',jsonb_build_object('id',x.with_id,'displayName',x.with_name),'shared',to_jsonb(x.shared))
  ORDER BY x.at,x.id,x.with_id) FROM x),'[]'::jsonb) AS pairs FROM g`);
		const row = organizationPairRows.parse(r.rows[0]);
		if (!row.allowed) deny("unavailable");
		return c.organizationDuplicatePairs.parse({
			items: row.pairs.slice(0, PAIRS),
			completeness: row.pairs.length > PAIRS ? "partial" : "complete",
		});
	});
}

const listedRow = z.object({
	allowed: z.boolean(),
	listed: z.object({ personId: z.uuid(), withPersonId: z.uuid() }).nullable(),
});
export async function listedDuplicatePair(tx: Tx, ctx: Context, pair: { a: string; b: string }) {
	return readReply(async () => {
		if (ctx.selected.kind !== "plant") deny("unavailable");
		const plant = ctx.selected.id;
		const r = await tx.execute(sql`SELECT g.allowed,(SELECT jsonb_build_object('personId',p.id,'withPersonId',m.id)
  FROM person p JOIN person m ON m.tenant_id=p.tenant_id AND m.state='live'
  WHERE g.allowed AND p.tenant_id=${plant}::uuid AND p.state='live'
   AND ((p.id=${pair.a}::uuid AND m.id=${pair.b}::uuid) OR (p.id=${pair.b}::uuid AND m.id=${pair.a}::uuid))
   AND ${flagged} AND NOT ${dismissed}
  ORDER BY p.created_at,p.id LIMIT 1) AS listed
 FROM (SELECT ${adminRead(ctx)} AS allowed) g`);
		const row = listedRow.parse(r.rows[0]);
		if (!row.allowed) deny("unavailable");
		return row.listed;
	});
}

const dismissedRows = z.object({
	allowed: z.boolean(),
	zone: z.string().nullable(),
	pairs: z.array(
		z.object({
			person: z.object({ id: z.uuid(), displayName: z.string() }),
			with: z.object({ id: z.uuid(), displayName: z.string() }),
			dismissedBy: z.string().nullable(),
			dismissedAt: z.string(),
		}),
	),
});
export async function listDismissedDuplicatePairs(tx: Tx, ctx: Context) {
	return readReply(async () => {
		if (ctx.selected.kind !== "plant") deny("unavailable");
		const plant = ctx.selected.id;
		const r = await tx.execute(sql`SELECT g.allowed,coalesce((SELECT jsonb_agg(jsonb_build_object(
  'person',jsonb_build_object('id',x.person_id,'displayName',x.person_name),
  'with',jsonb_build_object('id',x.with_id,'displayName',x.with_name),
  'dismissedBy',(SELECT i.display_name FROM audit_event a CROSS JOIN LATERAL seat_identity(a.actor_id) i
   WHERE a.tenant_id=${plant}::uuid AND a.subject_id=x.person_id AND a.action='people.duplicate_dismissed'
   ORDER BY a.occurred_at DESC,a.id LIMIT 1),
  'dismissedAt',to_char(x.dismissed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY x.dismissed_at DESC,x.id) FROM (
  SELECT d.id,d.dismissed_at,p.id person_id,p.display_name person_name,m.id with_id,m.display_name with_name
  FROM person_duplicate_dismissal d
  JOIN person p ON p.id=d.person_id AND p.tenant_id=d.plant_id AND p.state='live'
  JOIN person m ON m.id=d.with_person_id AND m.tenant_id=d.plant_id AND m.state='live'
  WHERE g.allowed AND d.plant_id=${plant}::uuid
  ORDER BY d.dismissed_at DESC,d.id LIMIT ${PAIRS + 1}) x),'[]'::jsonb) AS pairs,
 (SELECT pl.timezone FROM plant pl WHERE g.allowed AND pl.id=${plant}::uuid) AS zone
 FROM (SELECT ${adminRead(ctx)} AS allowed) g`);
		const row = dismissedRows.parse(r.rows[0]);
		if (!row.allowed || !row.zone) deny("unavailable");
		return c.dismissedDuplicatePairs.parse({
			zone: row.zone,
			items: row.pairs.slice(0, PAIRS),
			completeness: row.pairs.length > PAIRS ? "partial" : "complete",
		});
	});
}

const changeRow = z.object({ found: z.boolean(), changed: z.boolean() });
function pairWrite(change: "dismiss" | "restore", tx: Tx, ctx: WriteContext, raw: unknown) {
	return reply(tx, async () => {
		if (ctx.selected.kind !== "plant") deny("unavailable");
		const plant = ctx.selected.id;
		const input = parse(c.duplicatePairRequest, raw);
		await declareWrite(tx, "established");
		await lockOwner(tx, ctx);
		const actor = (await authorize(tx, ctx, true)).accountId;
		const write =
			change === "dismiss"
				? sql`INSERT INTO person_duplicate_dismissal (plant_id,person_id,with_person_id)
 SELECT ${plant}::uuid,id,with_id FROM pair ON CONFLICT (plant_id,person_id,with_person_id) DO NOTHING
 RETURNING person_id,with_person_id`
				: sql`DELETE FROM person_duplicate_dismissal d USING pair
 WHERE d.plant_id=${plant}::uuid AND d.person_id=pair.id AND d.with_person_id=pair.with_id
 RETURNING d.person_id,d.with_person_id`;
		const action = change === "dismiss" ? "people.duplicate_dismissed" : "people.duplicate_restored";
		const r = await tx.execute(sql`WITH pair AS (
  SELECT p.id,m.id with_id FROM person p JOIN person m ON m.id=${input.withPersonId}::uuid AND m.tenant_id=p.tenant_id
  WHERE p.id=${input.personId}::uuid AND p.tenant_id=${plant}::uuid AND p.state='live' AND m.state='live' AND ${flagged}
  FOR SHARE OF p,m
), changed AS (${write}), audit AS (
  INSERT INTO audit_event (tenant_id,actor_id,actor_token,action,kind,subject_type,subject_id,metadata)
  SELECT ${plant}::uuid,${actor}::uuid,${hash([plant, actor])},${action},${change === "dismiss" ? "hide" : "restore"},
   'person',person_id,jsonb_build_object('withPersonId',with_person_id) FROM changed RETURNING 1
) SELECT EXISTS(SELECT FROM pair) AS found,EXISTS(SELECT FROM audit) AS changed`);
		const row = changeRow.parse(r.rows[0]);
		if (!row.found) deny("pair_unavailable");
		return c.duplicatePairChange.parse({ outcome: row.changed ? "changed" : "noop" });
	});
}
export async function dismissDuplicatePair(tx: Tx, ctx: WriteContext, raw: unknown) {
	return pairWrite("dismiss", tx, ctx, raw);
}
export async function restoreDuplicatePair(tx: Tx, ctx: WriteContext, raw: unknown) {
	return pairWrite("restore", tx, ctx, raw);
}
