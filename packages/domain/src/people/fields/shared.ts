import { revision } from "@everyfield/contracts/common";
import type { Owner } from "@everyfield/contracts/common";
import { and, eq, sql, type SQL } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import "server-only";
import { z } from "zod";
import { deny, type Tx } from "../core.ts";

/** Households, tags, skills and photos belong to plant people only. */
export function plantId(ctx: { selected: Owner }): string {
	if (ctx.selected.kind !== "plant") deny();
	return ctx.selected.id;
}

export const address = {
	street: z.string().nullable(),
	city: z.string().nullable(),
	state_province: z.string().nullable(),
	postal_code: z.string().nullable(),
	country: z.string().nullable(),
};
export type Address = { [K in keyof typeof address]: string | null };
export const addressOf = (row: Address): Address => ({
	street: row.street,
	city: row.city,
	state_province: row.state_province,
	postal_code: row.postal_code,
	country: row.country,
});
/** REQ-PPL-009: an address is meaningful when any part has text. */
export const hasAddress = (row: Address) => Object.values(addressOf(row)).some((v) => v !== null && v.trim() !== "");
export const addressView = (row: Address) => ({
	street: row.street,
	city: row.city,
	stateProvince: row.state_province,
	postalCode: row.postal_code,
	country: row.country,
});

const factRow = z.object({
	id: z.uuid(),
	display_name: z.string(),
	state: z.enum(["live", "retired", "merged"]),
	revision,
	household_id: z.uuid().nullable(),
	household_role: z.enum(["head", "spouse", "child", "other"]).nullable(),
	photo_object_id: z.uuid().nullable(),
	...address,
});
export type PersonFacts = z.infer<typeof factRow>;
/**
 * The Person columns these fields read and write. A missing or foreign Person is unavailable. A write passes the related
 * row it also needs (a household, tags, an upload) as `extra`, a scalar subquery that may name the outer `person`, so
 * both come back in one round trip.
 */
export async function personFacts(
	tx: Tx,
	plant: string,
	id: string,
	extra?: SQL,
): Promise<PersonFacts & { extra: unknown }> {
	const [row] = await tx
		.select({
			id: tables.person.id,
			display_name: tables.person.display_name,
			state: tables.person.state,
			revision: tables.person.revision,
			household_id: tables.person.household_id,
			household_role: tables.person.household_role,
			photo_object_id: tables.person.photo_object_id,
			street: tables.person.street,
			city: tables.person.city,
			state_province: tables.person.state_province,
			postal_code: tables.person.postal_code,
			country: tables.person.country,
			extra: extra ? sql<unknown>`${extra}` : sql<unknown>`NULL`,
		})
		.from(tables.person)
		.where(and(eq(tables.person.id, id), eq(tables.person.tenant_id, plant), eq(tables.person.plant_id, plant)));
	if (!row) deny();
	return { ...factRow.parse(row), extra: row.extra };
}
/** New current facts name only a live Person (REQ-PPL-024). */
export function livePerson(p: PersonFacts) {
	if (p.state !== "live") deny();
}
export function expectRevision(actual: string, expected: string) {
	if (actual !== expected) deny("conflict");
}
export const next = (rev: string) => String(BigInt(rev) + 1n);

/**
 * One object cleanup job queued in the write's own statement. The worker deletes only unreferenced objects. An upload
 * queues its orphan check at expiry and a replaced or removed photo queues its release now, so each has its own key.
 */
export function queueObjectCleanup(
	tx: Tx,
	plant: string,
	fileId: string,
	cause: "upload" | "release",
	eligibleAt = sql`clock_timestamp()`,
) {
	return tx
		.insert(tables.job)
		.values({
			tenant_id: plant,
			kind: "object_cleanup",
			subject_record_id: fileId,
			producer_key: `person-photo-${cause}/${fileId}`,
			source_revision: null,
			state: "ready",
			eligible_at: eligibleAt,
			attempt_count: 0,
			max_attempts: 4,
			claim_generation: "0",
		})
		.onConflictDoNothing();
}
