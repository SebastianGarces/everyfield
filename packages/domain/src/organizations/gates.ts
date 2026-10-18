import type { PoolClient } from "pg";
import { z } from "zod";
import { recordId, revision, type Owner, type sessionId } from "@everyfield/contracts/common";
import { sharingCategory } from "@everyfield/contracts/organizations";
import { active, choices, currentActor, loadAffiliation, sameOwner } from "./core.ts";
// Original source witnesses are rechecked for reads, saved results, jobs and model
// context. A saved body or organization preference never grants access by itself.
export async function canReadSharedSources(
	tx: PoolClient,
	session: z.infer<typeof sessionId>,
	selected: Owner,
	raw: unknown,
): Promise<boolean> {
	const q = z
		.strictObject({
			relationshipId: recordId,
			relationshipRevision: revision,
			consentRevision: revision,
			categories: z.array(sharingCategory).min(1).max(7),
			publishedResult: z.boolean(),
		})
		.parse(raw);
	const actor = await currentActor(tx, session, selected),
		a = await loadAffiliation(tx, q.relationshipId);
	if (
		actor.status !== "active" ||
		!a ||
		a.plant_id === null ||
		selected.kind !== "organization" ||
		a.organization_id !== selected.id ||
		!(await active(tx, a)) ||
		a.revision !== q.relationshipRevision ||
		a.consent_revision !== q.consentRevision
	)
		return false;
	const c = choices(a);
	return (
		(!q.publishedResult || c.shared_findings) &&
		q.categories.every((category) => category !== "activity" && c[category])
	);
}
export async function canDispatchActivity(
	tx: PoolClient,
	session: z.infer<typeof sessionId>,
	selected: Owner,
	raw: unknown,
): Promise<boolean> {
	const q = z
		.strictObject({ relationshipId: recordId, relationshipRevision: revision, consentRevision: revision })
		.parse(raw);
	const actor = await currentActor(tx, session, selected),
		a = await loadAffiliation(tx, q.relationshipId);
	return (
		actor.status === "active" &&
		a !== null &&
		sameOwner(selected, { kind: "organization", id: a.organization_id, organizationKind: a.organization_kind }) &&
		a.plant_id !== null &&
		(await active(tx, a)) &&
		a.revision === q.relationshipRevision &&
		a.consent_revision === q.consentRevision &&
		a.share_activity
	);
}
