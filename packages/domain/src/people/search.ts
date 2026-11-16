import { sql } from "@everyfield/db/query";
import type { SQL } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { z } from "zod";
import { authorizeRead, deny, readReply, type Context, type Tx } from "./core.ts";

const FOLD: readonly [string, string][] = [
	["àáâãäåāăą", "a"],
	["çćč", "c"],
	["ď", "d"],
	["èéêëēėęě", "e"],
	["ìíîïīį", "i"],
	["ł", "l"],
	["ñńň", "n"],
	["òóôõöøōő", "o"],
	["ř", "r"],
	["śšş", "s"],
	["ť", "t"],
	["ùúûüūůűų", "u"],
	["ýÿ", "y"],
	["źżž", "z"],
];
const FROM = FOLD.map(([from]) => from).join("");
const TO = FOLD.map(([from, to]) => to.repeat(from.length)).join("");
const fold = (value: SQL | string) => sql`translate(lower(${value}),${FROM},${TO})`;

const SEARCH_WORDS = 8;
const NAME_SEPARATORS = "-'\u2019";
const nameWords = (value: SQL) =>
	sql`' ' || translate(${value},${NAME_SEPARATORS}::text,${" ".repeat(NAME_SEPARATORS.length)}::text)`;
const PHONE_QUERY = /^[\d\s+\-().]+$/;

export function personSearchMatch(query: string): SQL {
	const words = query.trim().split(/\s+/).filter(Boolean).slice(0, SEARCH_WORDS);
	if (!words.length) return sql`false`;
	const name = nameWords(fold(sql`${tables.person.display_name}`));
	const local = sql`' ' || translate(${fold(sql`split_part(coalesce(${tables.person.email},''),'@',1)`)},'._+-','    ')`;
	const byWords = sql.join(
		words.map((word) => {
			const start = nameWords(fold(word));
			const address = sql`starts_with(${fold(sql`coalesce(${tables.person.email},'')`)},${fold(word)})`;
			return sql`(strpos(${name},${start})>0 OR strpos(${local},${start})>0 OR ${address})`;
		}),
		sql` AND `,
	);
	const digits = PHONE_QUERY.test(query.trim()) ? query.replace(/\D/g, "") : "";
	if (digits.length < 3) return sql`(${byWords})`;
	return sql`((${byWords}) OR strpos(regexp_replace(coalesce(${tables.person.phone},''),'\\D','','g'),${digits})>0)`;
}

const row = z.object({
	allowed: z.boolean(),
	id: z.uuid().nullable(),
	display_name: z.string().nullable(),
	email: z.string().nullable(),
	phone: z.string().nullable(),
});
export type PersonHit = { id: string; name: string; detail: string };

export async function searchPeople(tx: Tx, ctx: Context, query: string, limit = 8) {
	return readReply(async (): Promise<PersonHit[]> => {
		if (ctx.selected.kind !== "plant") deny();
		const { gate } = await authorizeRead(tx, ctx);
		const result = await tx.execute(sql`SELECT g.allowed,p.id,p.display_name,p.email,p.phone
 FROM (SELECT ${gate} AS allowed) g
 LEFT JOIN LATERAL (SELECT ${tables.person.id} AS id,${tables.person.display_name} AS display_name,${tables.person.email} AS email,${tables.person.phone} AS phone
   FROM ${tables.person}
   WHERE g.allowed AND ${tables.person.plant_id}=${ctx.selected.id}::uuid AND ${tables.person.state}='live' AND ${personSearchMatch(query)}
   ORDER BY ${tables.person.created_at},${tables.person.id} LIMIT ${limit}) p ON true`);
		const rows = result.rows.map((r) => row.parse(r));
		if (!rows[0]?.allowed) deny();
		return rows.flatMap((r) =>
			r.id ? [{ id: r.id, name: r.display_name ?? "", detail: r.email ?? r.phone ?? "" }] : [],
		);
	});
}
