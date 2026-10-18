import type { PoolClient } from "pg";
import { z } from "zod";
import { revision } from "@everyfield/contracts/common";
import * as Q from "@everyfield/contracts/organizations";
import type { OrganizationAdapter } from "@everyfield/contracts/organizations";
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
const profileRow = z.object({
	name: z.string(),
	city: z.string().nullable(),
	state_province: z.string().nullable(),
	country: z.string().nullable(),
	description: z.string().nullable(),
	contact_email: z.string().nullable(),
	contact_phone: z.string().nullable(),
	timezone: z.string(),
	revision,
});
export interface GeographyReference {
	// Producer resolves a checksum-pinned official dataset, never a guessed location.
	candidates(
		tx: PoolClient,
		input: {
			referenceVersionId: string;
			locality: { city: string | null; stateProvince: string | null; country: string | null };
		},
	): Promise<readonly string[]>;
}
export function profileOperations(
	effects: OrganizationEffects,
	geography: GeographyReference,
): Pick<
	OrganizationAdapter<PoolClient>,
	"organizations.getProfile" | "organizations.updateProfile" | "organizations.correctReportingLocation"
> {
	return {
		async "organizations.getProfile"(tx, session, selected, raw) {
			const q = Q.organizationProfileRequest.parse(raw),
				actor = await currentActor(tx, session, selected);
			if (actor.status !== "active" || !sameOwner(selected, q.organization)) return unavailable();
			const row = profileRow.parse(
				(await tx.query("SELECT * FROM organization WHERE id=$1 FOR SHARE", [selected.id])).rows[0],
			);
			return Q.organizationProfileResult.parse({
				status: "available",
				organization: q.organization,
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
				},
			});
		},
		async "organizations.updateProfile"(tx, session, selected, raw) {
			const q = Q.updateOrganizationProfileRequest.parse(raw),
				actor = await currentActor(tx, session, selected);
			if (actor.status !== "active" || !administrator(actor) || !sameOwner(selected, q.input.organization)) refuse();
			const c = await beginCommand(tx, actor, selected, "organizations.updateProfile", q);
			if (c.kind === "replay") return Q.mutationResult.parse(c.result);
			const row = profileRow.parse(
				(await tx.query("SELECT * FROM organization WHERE id=$1 FOR UPDATE", [selected.id])).rows[0],
			);
			checkRevision(q.expectedRevision, row.revision);
			const fields = {
				name: "name",
				city: "city",
				stateProvince: "state_province",
				country: "country",
				description: "description",
				contactEmail: "contact_email",
				contactPhone: "contact_phone",
			} as const;
			const entries = Object.entries(q.input.patch),
				assignments = entries.map(
					([key], i) =>
						`${fields[z.enum(["name", "city", "stateProvince", "country", "description", "contactEmail", "contactPhone"]).parse(key)]}=$${i + 2}`,
				);
			await tx.query(`UPDATE organization SET ${assignments.join(",")},revision=revision+1 WHERE id=$1`, [
				selected.id,
				...entries.map(([, v]) => v),
			]);
			const next = String(BigInt(row.revision) + 1n),
				event = await appendEvent(tx, c, selected.id, "edit", "organization.profile_changed", row.revision, next);
			return finishCommand(tx, c, (r) => Q.mutationResult.parse({ status: "committed", receipt: r }), [event]);
		},
		async "organizations.correctReportingLocation"(tx, session, selected, raw) {
			const q = Q.correctReportingLocationRequest.parse(raw),
				actor = await currentActor(tx, session, selected);
			if (actor.status !== "active" || !administrator(actor) || !sameOwner(selected, q.input.plant)) refuse();
			const c = await beginCommand(tx, actor, selected, "organizations.correctReportingLocation", q);
			if (c.kind === "replay") return Q.mutationResult.parse(c.result);
			const plant = await tx.query<{ revision: string }>("SELECT revision FROM plant WHERE id=$1 FOR UPDATE", [
				selected.id,
			]);
			checkRevision(q.expectedRevision, revision.parse(plant.rows[0]?.revision));
			const official = await tx.query(
				`SELECT v.id FROM reference_version v JOIN reference_item i ON i.id=v.item_id JOIN reference_release r ON r.id=v.release_id
        WHERE v.id=$1 AND i.kind='geography_dataset' AND i.tenant_id='00000000-0000-0000-0000-000000000000' AND r.state='validated' AND r.validated_at IS NOT NULL FOR SHARE OF v,i,r`,
				[q.input.referenceVersionId],
			);
			if (official.rowCount !== 1) refuse("reference_unavailable");
			if (q.input.regionItemId !== null) {
				const candidates = await geography.candidates(tx, {
					referenceVersionId: q.input.referenceVersionId,
					locality: q.input.locality,
				});
				const region = await tx.query(
					"SELECT id FROM reference_item WHERE id=$1 AND kind='geography_region' AND tenant_id='00000000-0000-0000-0000-000000000000' FOR SHARE",
					[q.input.regionItemId],
				);
				if (region.rowCount !== 1 || !candidates.includes(q.input.regionItemId)) refuse("region_unavailable");
			}
			const prior = await tx.query<{ id: string }>(
				"SELECT id FROM plant_geography WHERE plant_id=$1 ORDER BY effective_at DESC,id DESC LIMIT 1 FOR UPDATE",
				[selected.id],
			);
			await tx.query(
				`INSERT INTO plant_geography(plant_id,city,state_province,country,region_item_id,reference_version_id,committed_at,effective_at,supersedes_id)
        VALUES($1,$2,$3,$4,$5,$6,clock_timestamp(),clock_timestamp(),$7)`,
				[
					selected.id,
					q.input.locality.city,
					q.input.locality.stateProvince,
					q.input.locality.country,
					q.input.regionItemId,
					q.input.referenceVersionId,
					prior.rows[0]?.id ?? null,
				],
			);
			await tx.query("UPDATE plant SET revision=revision+1,material_revision=material_revision+1 WHERE id=$1", [
				selected.id,
			]);
			const next = String(BigInt(q.expectedRevision) + 1n),
				event = await appendEvent(tx, c, selected.id, "correct", "plant.profile_changed", q.expectedRevision, next);
			const orgs = await tx.query<{ organization_id: string; kind: string }>(
				`UPDATE organization o SET material_revision=o.material_revision+1 FROM affiliation a WHERE a.organization_id=o.id AND a.plant_id=$1 AND a.ended_at IS NULL RETURNING o.id AS organization_id,o.kind`,
				[selected.id],
			);
			for (const row of orgs.rows)
				await effects.invalidate(tx, {
					owner: Q.organizationOwner.parse({
						kind: "organization",
						id: row.organization_id,
						organizationKind: row.kind,
					}),
					sourceId: selected.id,
					revision: next,
				});
			return finishCommand(tx, c, (r) => Q.mutationResult.parse({ status: "committed", receipt: r }), [event]);
		},
	};
}
