import { sql, type SQL } from "@everyfield/db/query";
import { mailingAddress } from "@everyfield/contracts/communication";
import { z } from "zod";

const filled = (column: SQL) => sql`coalesce(${column}, '') ~ '[^[:space:]]'`;

export function churchAddressSql(plantId: SQL) {
	return sql`(SELECT jsonb_build_object('street', pl.street, 'city', pl.city, 'stateProvince', pl.state_province,
		'country', pl.country) FROM plant pl WHERE pl.id = ${plantId})`;
}

export function hasMailingAddressSql(plantId: SQL) {
	return sql`EXISTS (SELECT 1 FROM plant pl WHERE pl.id = ${plantId}
		AND ${filled(sql`pl.street`)} AND ${filled(sql`pl.city`)} AND ${filled(sql`pl.country`)})`;
}

const stored = z
	.object({
		street: z.string().nullable(),
		city: z.string().nullable(),
		stateProvince: z.string().nullable(),
		country: z.string().nullable(),
	})
	.nullable();

export function churchMailingAddress(raw: unknown): string | null {
	const value = stored.parse(typeof raw === "string" ? JSON.parse(raw) : (raw ?? null));
	return value ? mailingAddress(value) : null;
}
