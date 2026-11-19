import { requestWrite, type WriteTx } from "../access/session.ts";
import { writeActor } from "./core.ts";
import { revision } from "@everyfield/contracts/common";
import type { OrganizationAdapter } from "@everyfield/contracts/organizations";
import * as Q from "@everyfield/contracts/organizations";
import { desc, eq, sql, type SQL } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { z } from "zod";
import { auditSavepoint } from "../operations/writes.ts";
import {
	administrator,
	appendEvent,
	beginCommand,
	checkRevision,
	currentActor,
	finishCommand,
	refuse,
	sameOwner,
	unavailable,
	type OrganizationEffects,
} from "./core.ts";
const GLOBAL = "00000000-0000-0000-0000-000000000000";
const profileRow = z.object({
	name: z.string(),
	city: z.string().nullable(),
	state_province: z.string().nullable(),
	country: z.string().nullable(),
	description: z.string().nullable(),
	contact_email: z.string().nullable(),
	contact_phone: z.string().nullable(),
	statement_of_faith: z.string().nullable(),
	gathering_milestone_offered: z.boolean(),
	gathering_milestone_name: z.string().nullable(),
	gathering_milestone_description: z.string().nullable(),
	timezone: z.string(),
	revision,
});
export interface GeographyReference {
	candidates(input: {
		referenceVersionId: string;
		locality: { city: string | null; stateProvince: string | null; country: string | null };
	}): SQL;
}
const referenceHeld = z.object({ official: z.number().int(), region: z.number().int() });
export function profileOperations(
	effects: OrganizationEffects,
	geography: GeographyReference,
): Pick<
	OrganizationAdapter<WriteTx>,
	"organizations.getProfile" | "organizations.updateProfile" | "organizations.correctReportingLocation"
> {
	return {
		async "organizations.getProfile"(tx, session, selected, raw) {
			const q = Q.organizationProfileRequest.parse(raw),
				actor = await currentActor(tx, session, selected);
			if (actor.status !== "active" || !sameOwner(selected, q.organization)) return unavailable();
			const row = profileRow.parse(
				(await tx.select().from(tables.organization).where(eq(tables.organization.id, selected.id)).for("share"))[0],
			);
			return profileValue(row, q.organization);
		},
		async "organizations.updateProfile"(tx, session, selected, raw) {
			return auditSavepoint(tx, async () => {
				const q = Q.updateOrganizationProfileRequest.parse(raw),
					actor = await writeActor(tx, session, selected);
				if (actor.status !== "active" || !administrator(actor) || !sameOwner(selected, q.input.organization)) refuse();
				const c = await beginCommand(tx, actor, selected, "organizations.updateProfile", q);
				if (c.kind === "replay") return Q.mutationResult.parse(c.result);
				await applyOrganizationProfile(tx, c, selected.id, q.input.patch, q.expectedRevision);
				return finishCommand(tx, c, () => Q.mutationResult.parse({ status: "committed" }));
			});
		},
		async "organizations.correctReportingLocation"(tx, session, selected, raw) {
			return auditSavepoint(tx, async () => {
				const q = Q.correctReportingLocationRequest.parse(raw),
					actor = await writeActor(tx, session, selected);
				if (actor.status !== "active" || !administrator(actor) || !sameOwner(selected, q.input.plant)) refuse();
				const c = await beginCommand(tx, actor, selected, "organizations.correctReportingLocation", q);
				if (c.kind === "replay") return Q.mutationResult.parse(c.result);
				const plant = await tx
					.select({ revision: tables.plant.revision })
					.from(tables.plant)
					.where(eq(tables.plant.id, selected.id))
					.for("update");
				checkRevision(q.expectedRevision, revision.parse(plant[0]?.revision));
				const official = sql`SELECT v.id FROM reference_version v JOIN reference_item i ON i.id=v.item_id
 JOIN reference_release r ON r.id=v.release_id WHERE v.id=${q.input.referenceVersionId}::uuid AND i.kind='geography_dataset'
 AND i.tenant_id=${GLOBAL}::uuid AND r.state='validated' AND r.validated_at IS NOT NULL FOR SHARE OF v, i, r`;
				const candidates = geography.candidates({
					referenceVersionId: q.input.referenceVersionId,
					locality: q.input.locality,
				});
				const held = referenceHeld.parse(
					(
						await tx.execute(sql`WITH official AS MATERIALIZED (${official}),
 region AS MATERIALIZED (SELECT x.id FROM reference_item x WHERE x.id=${q.input.regionItemId}::uuid
  AND x.kind='geography_region' AND x.tenant_id=${GLOBAL}::uuid AND EXISTS(SELECT FROM official)
  AND x.id IN (${candidates}) FOR SHARE)
 SELECT (SELECT count(*) FROM official)::int AS official, (SELECT count(*) FROM region)::int AS region`)
					).rows[0],
				);
				if (held.official !== 1) refuse("reference_unavailable");
				if (q.input.regionItemId !== null && held.region !== 1) refuse("region_unavailable");
				const prior = await tx
					.select({ id: tables.plant_geography.id })
					.from(tables.plant_geography)
					.where(eq(tables.plant_geography.plant_id, selected.id))
					.orderBy(desc(tables.plant_geography.effective_at), desc(tables.plant_geography.id))
					.limit(1)
					.for("update");
				await tx.insert(tables.plant_geography).values({
					plant_id: selected.id,
					city: q.input.locality.city,
					state_province: q.input.locality.stateProvince,
					country: q.input.locality.country,
					region_item_id: q.input.regionItemId,
					reference_version_id: q.input.referenceVersionId,
					committed_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
					effective_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
					supersedes_id: prior[0]?.id ?? null,
				});
				await tx
					.update(tables.plant)
					.set({
						revision: sql<unknown>`(${tables.plant.revision} + 1)`,
						material_revision: sql<unknown>`(${tables.plant.material_revision} + 1)`,
					})
					.where(eq(tables.plant.id, selected.id));
				const next = String(BigInt(q.expectedRevision) + 1n);
				await appendEvent(tx, c, selected.id, "correct", "plant.profile_changed", q.expectedRevision, next);
				const orgs = await tx.execute<{ organization_id: string; kind: string }>(
					sql`UPDATE organization o SET material_revision=o.material_revision+1 FROM affiliation a WHERE a.organization_id=o.id AND a.plant_id=${sql.param(selected.id)} AND a.ended_at IS NULL RETURNING o.id AS organization_id,o.kind`,
				);
				if (orgs.rows.length)
					c.writes.push(
						effects.invalidate(tx, {
							owners: orgs.rows.map((row) =>
								Q.organizationOwner.parse({
									kind: "organization",
									id: row.organization_id,
									organizationKind: row.kind,
								}),
							),
							sourceId: selected.id,
							revision: next,
						}),
					);
				return finishCommand(tx, c, () => Q.mutationResult.parse({ status: "committed" }));
			});
		},
	};
}

export async function applyOrganizationProfile(
	tx: WriteTx,
	c: Extract<Awaited<ReturnType<typeof beginCommand>>, { kind: "new" }>,
	id: string,
	input: z.infer<typeof Q.updateOrganizationProfileRequest>["input"]["patch"],
	expected: string,
	locked?: typeof tables.organization.$inferSelect,
) {
	const stored =
		locked ??
		(requestWrite(tx)?.organization?.id === id ? requestWrite(tx)?.organization : undefined) ??
		(await tx.select().from(tables.organization).where(eq(tables.organization.id, id)).for("update"))[0];
	if (!stored) refuse();
	const organization = Q.organizationOwner.parse({ kind: "organization", id, organizationKind: stored.kind });
	const row = profileRow.parse(stored);
	checkRevision(expected, row.revision);
	const fields = {
		name: "name",
		city: "city",
		stateProvince: "state_province",
		country: "country",
		description: "description",
		contactEmail: "contact_email",
		contactPhone: "contact_phone",
		statementOfFaith: "statement_of_faith",
	} as const;
	const patch: Partial<typeof tables.organization.$inferInsert> = {};
	const { gatheringMilestone: milestone, ...plain } = input;
	if (milestone) {
		const now = {
			gathering_milestone_offered: milestone.offered,
			gathering_milestone_name: milestone.name,
			gathering_milestone_description: milestone.description,
		} as const;
		for (const [field, value] of Object.entries(now) as [keyof typeof now, never][])
			if (row[field] !== value) patch[field] = value;
	}
	for (const [raw, value] of Object.entries(plain)) {
		const key = z
			.enum([
				"name",
				"city",
				"stateProvince",
				"country",
				"description",
				"contactEmail",
				"contactPhone",
				"statementOfFaith",
			])
			.parse(raw);
		const field = fields[key];
		if (row[field] === value) continue;
		if (field === "statement_of_faith" && stored.kind !== "sending_network") refuse();
		if (field === "name") patch.name = z.string().parse(value);
		else patch[field] = value;
	}
	if (!Object.keys(patch).length)
		return { changed: false, events: [] as string[], current: profileValue(row, organization) };
	c.writes.push(
		tx
			.update(tables.organization)
			.set({ ...patch, revision: sql`${tables.organization.revision}+1` })
			.where(eq(tables.organization.id, id)),
	);
	const event = await appendEvent(
		tx,
		c,
		id,
		"edit",
		"organization.profile_changed",
		row.revision,
		String(BigInt(row.revision) + 1n),
	);
	const audit = c.events.find((e) => e.id === event);
	if (!audit) throw Error("missing_audit_entry");
	audit.before_value = Object.fromEntries(Object.keys(patch).map((field) => [field, row[field as keyof typeof row]]));
	audit.after_value = patch;

	return {
		changed: true,
		events: [event],
		current: profileValue(
			profileRow.parse({ ...row, ...patch, revision: String(BigInt(row.revision) + 1n) }),
			organization,
		),
	};
}

export function profileValue(row: z.infer<typeof profileRow>, organization: z.infer<typeof Q.organizationOwner>) {
	return Q.organizationProfileResult.parse({
		status: "available",
		organization: organization,
		revision: row.revision,
		timeZone: row.timezone,
		profile: {
			name: row.name,
			city: row.city,
			stateProvince: row.state_province,
			country: row.country,
			description: row.description,
			contactEmail: row.contact_email,
			contactPhone: row.contact_phone,
			statementOfFaith: row.statement_of_faith,
			gatheringMilestone: {
				offered: row.gathering_milestone_offered,
				name: row.gathering_milestone_name,
				description: row.gathering_milestone_description,
			},
		},
	});
}
