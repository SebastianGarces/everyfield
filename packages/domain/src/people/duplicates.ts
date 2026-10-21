import { sql } from "@everyfield/db/query";
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
		const { email, phone } = contactSignals(input);
		const name = nameSignal(input.displayName);
		const r =
			await tx.execute(sql`SELECT g.allowed,coalesce((SELECT jsonb_agg(jsonb_build_object('id',m.id,'displayName',m.display_name,
 'email',m.e,'phone',m.ph,'name',m.n) ORDER BY m.exact DESC,m.created_at,m.id) FROM (
  SELECT p.id,p.display_name,p.created_at,coalesce(${personEmail}=${email}::text,false) e,coalesce(${personPhone}=${phone}::text,false) ph,
   coalesce(${personName}=${name}::text,false) n,coalesce(${personEmail}=${email}::text OR ${personPhone}=${phone}::text,false) exact
  FROM person p WHERE g.allowed AND p.tenant_id=${plant}::uuid AND p.plant_id=${plant}::uuid AND p.state='live'
   AND p.id IS DISTINCT FROM ${input.excludePersonId ?? null}::uuid
   AND (${personEmail}=${email}::text OR ${personPhone}=${phone}::text OR ${personName}=${name}::text)
  ORDER BY exact DESC,p.created_at,p.id LIMIT ${LIMIT + 1}) m),'[]'::jsonb) AS people
 FROM (SELECT ${gate} AS allowed) g`);
		const row = found.parse(r.rows[0]);
		if (!row.allowed) deny();
		const items = row.people.slice(0, LIMIT).map((p) => ({
			personId: p.id,
			displayName: p.displayName,
			match: p.email || p.phone ? ("exact" as const) : ("potential" as const),
			signals: (["email", "phone", "name"] as const).filter((s) => p[s]),
		}));
		return c.duplicateHints.parse({ items, completeness: row.people.length > LIMIT ? "partial" : "complete" });
	});
}
