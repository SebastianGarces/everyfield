import { sql, type SQL } from "@everyfield/db/query";
import * as c from "@everyfield/contracts/people";
import "server-only";
import { z } from "zod";
import { authorizeRead, deny, parse, readReply, type Context, type Tx } from "./core.ts";

/**
 * The normalized contact signals that duplicate hints and the CSV import both match on: a lowercased email and the
 * digits of a phone. An empty or short signal is ignored, so it never matches everyone.
 */
export function contactSignals(v: { email?: string | null; phone?: string | null }) {
	const email = v.email?.trim().toLowerCase() ?? "";
	const phone = v.phone?.replace(/\D/g, "") ?? "";
	return { email: email.includes("@") ? email : null, phone: phone.length >= 7 ? phone : null };
}
/** The same normalization applied to a stored Person `p`, for set-based equality lookups. */
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
/**
 * The duplicate hints for one set of contact facts among the live people of one church or organization, in one
 * statement with the caller's live access check (`gate`) inside it. Shared by people.checkForDuplicates and
 * orgPeople.findDuplicates, so both match the same way.
 */
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
	if (!row.allowed) deny();
	return duplicateHints(row.people);
}
/**
 * The matching live people as one JSON array, a scalar subquery inside the caller's statement and its live access check.
 * The signals are SQL text values; a null signal matches nothing.
 */
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
/**
 * The duplicate hints for the outer `person` row itself, among the other live people of its church, as one JSON array:
 * the person page reads them in its own statement. Its contact signals are normalized in SQL as `contactSignals` and
 * `nameSignal` normalize them in TypeScript.
 */
export const personDuplicatesJson = (owner: string) => {
	const trim = (v: SQL) => sql`regexp_replace(${v},'^\s+|\s+$','','g')`;
	const email = sql`lower(${trim(sql`person.email`)})`;
	const phone = sql`regexp_replace(coalesce(person.phone,''),'\D','','g')`;
	const name = sql`lower(regexp_replace(${trim(sql`person.display_name`)},'\s+',' ','g'))`;
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
/**
 * people.checkForDuplicates (REQ-PPL-016): live people of this church who share a normalized email or phone (an exact
 * hint) or the same name (a potential hint). Hints only: they never prove identity or merge anyone. Equality lookups,
 * so wildcard characters match only themselves. One statement, with the lock-free live access check inside it.
 */
export async function checkForDuplicates(tx: Tx, ctx: Context, raw: unknown) {
	return readReply(async () => {
		if (ctx.selected.kind !== "plant") deny();
		const plant = ctx.selected.id;
		const input = parse(c.duplicateCheckRequest, raw);
		const { gate } = await authorizeRead(tx, ctx);
		return matchPeople(tx, plant, gate, input, input.excludePersonId);
	});
}
