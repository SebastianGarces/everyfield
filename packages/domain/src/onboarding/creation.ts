import { currentActor, liveOwner } from "../access/session.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, asc, eq, isNull, sql } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import * as c from "@everyfield/contracts/onboarding";
import { accountId, tenantId, owner } from "@everyfield/contracts/common";
import { sharingChoices, organizationOwner, plantOwner } from "@everyfield/contracts/organizations";
import { accountPersonProducer } from "../people/index.ts";
import { active, choices, loadAffiliation, pairOf, type OrganizationEffects } from "../organizations/core.ts";
import { recordCreationEntry } from "../phases/creation-entry/index.ts";
import {
	actor,
	begin,
	deny,
	event,
	finish,
	now,
	parse,
	reply,
	revision,
	seatless,
	type Tx,
	type WriteContext,
	type NewCommand,
} from "./core.ts";
import { ownReading } from "./reading.ts";

export interface OnboardingEffects extends Pick<OrganizationEffects, "notice" | "invalidate"> {
	// Required durable mail/notice writers share Tx. They enqueue only; providers
	// run after commit. No default noop can silently drop a required consequence.
	enqueue(
		tx: Tx,
		input: {
			accountId: string;
			operationId: string;
			kind: "plant_created" | "discovery_created";
			plantId: string | null;
		},
	): Promise<void>;
}
async function notifyRelationship(
	tx: Tx,
	effects: OnboardingEffects,
	input: Parameters<OrganizationEffects["notice"]>[1],
) {
	await tx
		.update(t.organization)
		.set({ material_revision: sql`${t.organization.material_revision}+1` })
		.where(eq(t.organization.id, input.pair.organization.id));
	await effects.invalidate(tx, {
		owner: input.pair.organization,
		sourceId: input.relationshipId,
		revision: input.revision,
	});
	await effects.notice(tx, input);
}
export const off = sharingChoices.parse({
	people: false,
	meetings: false,
	tasks: false,
	ministry_teams: false,
	wiki: false,
	activity: false,
	shared_findings: false,
});
export const pending = { status: "pending" } as const;
export async function profile(tx: Tx, accountId: string, d: typeof t.discovery.$inferSelect) {
	const links = await tx
		.select({ id: t.affiliation.id })
		.from(t.affiliation)
		.where(and(eq(t.affiliation.account_id, accountId), isNull(t.affiliation.ended_at)))
		.orderBy(asc(t.affiliation.id));
	const relationships = [];
	for (const link of links) {
		const a = await loadAffiliation(tx, link.id);
		if (a && (await active(tx, a)))
			relationships.push(
				c.conversionRelationship.parse({
					relationshipId: a.id,
					organization: organizationOwner.parse(pairOf(a).organization),
					revision: a.revision,
					consentRevision: a.consent_revision,
					choices: choices(a),
				}),
			);
	}
	// Documents stay private. Creation never copies bodies or selects all drafts.
	return {
		discoveryId: d.id,
		revision: d.revision,
		relationships,
		reading: await ownReading(tx, accountId),
		documentProposals: [],
	};
}
async function eligible(tx: Tx, ctx: WriteContext, kind: "planter" | "discovery") {
	if (ctx.selected.kind !== "account") deny();
	const a = await actor(tx, ctx, true);
	if (a.account.registration_state === "pending_domain" && a.account.registration_kind !== kind) deny();
	if (!a.principal.verified) deny();
	return a;
}
async function provision(
	tx: Tx,
	cx: NewCommand,
	account: typeof t.account.$inferSelect,
	input: z.infer<typeof c.plantBasics>,
	displayName: string,
) {
	const plantId = randomUUID();
	await tx.insert(t.plant).values({
		id: plantId,
		name: input.name,
		timezone: account.personal_timezone ?? "UTC",
		warning_days: 7,
		alert_days: 14,
		digest_weekday: 1,
		digest_hour: 8,
		phase: 1,
		material_revision: "1",
		city: input.locality?.city ?? null,
		state_province: input.locality?.stateProvince ?? null,
		country: input.locality?.country ?? null,
	});
	const [seat] = await tx
		.insert(t.seat)
		.values({ account_id: account.id, plant_id: plantId, role: "owner", accepted_at: now })
		.returning();
	const linked = await accountPersonProducer.ensureAccountPerson(tx, {
		accountId: accountId.parse(account.id),
		owner: { kind: "plant", id: tenantId.parse(plantId) },
		selection: { kind: "create", displayName },
	});
	if (linked.status !== "ok" || linked.value.status !== "linked") deny();
	await tx.insert(t.onboarding_setup).values({
		plant_id: plantId,
		account_id: account.id,
		creation_operation_id: cx.id,
		lead: { answer: "pending" },
		journey: pending,
		launch: pending,
		people_step: "pending",
	});
	const creation = await recordCreationEntry(tx, cx, plantId);
	await tx
		.update(t.account)
		.set({ registration_state: "active", revision: sql`${t.account.revision}+1` })
		.where(eq(t.account.id, account.id));
	const [plant] = await tx.select().from(t.plant).where(eq(t.plant.id, plantId));
	const events = [
		creation.eventId,
		await event(tx, cx, plantId, "plant.created", "create"),
		await event(tx, cx, seat!.id, "membership.created", "create"),
	];
	return {
		plant: plantOwner.parse({ kind: "plant", id: plantId }),
		revision: plant!.revision,
		materialRevision: plant!.material_revision,
		currentPhase: 1,
		ownerSeat: { seatId: seat!.id, role: "owner", personId: linked.value.personId },
		creation,
		events,
	};
}
async function currentCreation<
	T extends { plant: { id: string }; currentPhase: number; revision: string; materialRevision: string },
>(tx: Tx, ctx: WriteContext, value: T) {
	if (!(await liveOwner(tx, owner.parse({ kind: "plant", id: value.plant.id })))) deny();
	const [plant] = await tx.select().from(t.plant).where(eq(t.plant.id, value.plant.id));
	if (!plant) deny();
	const current = await currentActor(tx, ctx.session, { kind: "plant", id: tenantId.parse(plant.id) });
	if (current.status !== "active" || current.context.kind !== "seat" || current.context.role !== "owner") deny();
	return {
		...value,
		status: "existing",
		currentPhase: plant.phase,
		revision: plant.revision,
		materialRevision: plant.material_revision,
	};
}
export function creation(effects: OnboardingEffects) {
	return {
		async createPlant(tx: Tx, ctx: WriteContext, raw: z.infer<typeof c.createPlantRequest>) {
			return reply(tx, async () => {
				const q = parse(c.createPlantRequest, raw),
					a = await eligible(tx, ctx, "planter");
				const cx = await begin(tx, ctx, a.account.id, "onboarding.createPlant", q);
				if (cx.kind === "replay")
					return c.createPlantResult.parse(await currentCreation(tx, ctx, c.createPlantResult.parse(cx.value)));
				await seatless(tx, a.account.id);
				const [prior] = await tx
					.select()
					.from(t.onboarding_setup)
					.where(eq(t.onboarding_setup.account_id, a.account.id));
				if (prior) deny("active_seat_conflict");
				const associated = await tx
					.select({ id: t.discovery.id })
					.from(t.discovery)
					.where(eq(t.discovery.account_id, a.account.id));
				if (associated.length) deny("association_resolution_required");
				revision(q.expectedRevision, a.account.revision);
				const result = await provision(tx, cx, a.account, q.input, a.principal.display_name);
				await effects.enqueue(tx, {
					accountId: a.account.id,
					operationId: cx.id,
					kind: "plant_created",
					plantId: result.plant.id,
				});
				const { events, ...facts } = result;
				return finish(tx, cx, events, c.createPlantResult, (receipt) => ({
					status: "created",
					...facts,
					initialSharing: off,
					receipt,
				}));
			});
		},
		async createDiscovery(tx: Tx, ctx: WriteContext, raw: z.infer<typeof c.createDiscoveryRequest>) {
			return reply(tx, async () => {
				const q = parse(c.createDiscoveryRequest, raw),
					a = await eligible(tx, ctx, "discovery");
				const cx = await begin(tx, ctx, a.account.id, "discovery.create", q);
				if (cx.kind === "replay") {
					const [current] = await tx.select().from(t.discovery).where(eq(t.discovery.account_id, a.account.id));
					if (!current || current.converted_at) deny();
					await seatless(tx, a.account.id);
					return c.createDiscoveryResult.parse(cx.value);
				}
				await seatless(tx, a.account.id);
				revision(q.expectedRevision, a.account.revision);
				const [existing] = await tx
					.select()
					.from(t.discovery)
					.where(eq(t.discovery.account_id, a.account.id))
					.for("update");
				if (existing) deny("conflict");
				const [d] = await tx.insert(t.discovery).values({ account_id: a.account.id }).returning();
				await tx
					.update(t.account)
					.set({ registration_state: "active", revision: sql`${t.account.revision}+1` })
					.where(eq(t.account.id, a.account.id));
				const id = await event(tx, cx, d!.id, "identity.domain_accepted", "create");
				await effects.enqueue(tx, {
					accountId: a.account.id,
					operationId: cx.id,
					kind: "discovery_created",
					plantId: null,
				});
				const savedProfile = await profile(tx, a.account.id, d!);
				return finish(tx, cx, [id], c.createDiscoveryResult, (receipt) => ({
					status: "active",
					profile: savedProfile,
					receipt,
				}));
			});
		},
		async convertDiscovery(tx: Tx, ctx: WriteContext, raw: z.infer<typeof c.convertDiscoveryRequest>) {
			return reply(tx, async () => {
				const q = parse(c.convertDiscoveryRequest, raw),
					a = await eligible(tx, ctx, "discovery");
				const cx = await begin(tx, ctx, a.account.id, "discovery.convertToPlant", q);
				if (cx.kind === "replay")
					return c.convertDiscoveryResult.parse(
						await currentCreation(tx, ctx, c.convertDiscoveryResult.parse(cx.value)),
					);
				await seatless(tx, a.account.id);
				const [d] = await tx
					.select()
					.from(t.discovery)
					.where(and(eq(t.discovery.id, q.input.discoveryId), eq(t.discovery.account_id, a.account.id)))
					.for("update");
				if (!d || d.converted_at) deny();
				revision(q.expectedRevision, d.revision);
				const links = await tx
					.select()
					.from(t.affiliation)
					.where(and(eq(t.affiliation.account_id, a.account.id), isNull(t.affiliation.ended_at)))
					.orderBy(asc(t.affiliation.id))
					.for("update");
				const selected = [];
				for (const selection of [...q.input.relationships].sort((a, b) =>
					a.relationshipId.localeCompare(b.relationshipId),
				)) {
					const old = await loadAffiliation(tx, selection.relationshipId, true);
					if (
						!old ||
						old.account_id !== a.account.id ||
						!links.some((l) => l.id === old.id) ||
						!(await active(tx, old)) ||
						old.organization_id !== selection.organization.id ||
						old.organization_kind !== selection.organization.organizationKind
					)
						deny();
					revision(selection.expectedRelationshipRevision, old.revision);
					revision(selection.expectedConsentRevision, old.consent_revision);
					selected.push({ old, selection });
				}
				const result = await provision(tx, cx, a.account, q.input, a.principal.display_name),
					relationships: z.infer<typeof c.conversionRelationship>[] = [],
					events = [...result.events];
				for (const { old, selection } of selected) {
					const [link] = await tx
						.insert(t.affiliation)
						.values({
							plant_id: result.plant.id,
							organization_id: old.organization_id,
							accepted_at: now,
							recognition_operation_id: cx.id,
							share_people: selection.choices.people,
							share_meetings: selection.choices.meetings,
							share_tasks: selection.choices.tasks,
							share_ministry_teams: selection.choices.ministry_teams,
							share_wiki: selection.choices.wiki,
							share_activity: selection.choices.activity,
							shared_findings: selection.choices.shared_findings,
						})
						.returning();
					const id = await event(tx, cx, link!.id, "affiliation.approved", "accept");
					events.push(id);
					await tx.insert(t.relationship_history).values({
						id,
						relationship_id: link!.id,
						pair: { kind: "plant", subject: result.plant, organization: selection.organization },
					});
					await notifyRelationship(tx, effects, {
						eventId: id,
						relationshipId: link!.id,
						pair: { kind: "plant", subject: result.plant, organization: selection.organization },
						kind: "relationship_approved",
						revision: link!.revision,
						operationId: cx.id,
					});
					relationships.push(
						c.conversionRelationship.parse({
							relationshipId: link!.id,
							organization: selection.organization,
							revision: link!.revision,
							consentRevision: link!.consent_revision,
							choices: selection.choices,
						}),
					);
				}
				for (const old of links) {
					await tx
						.update(t.affiliation)
						.set({
							ended_at: now,
							revision: sql`${t.affiliation.revision}+1`,
							consent_revision: sql`${t.affiliation.consent_revision}+1`,
						})
						.where(eq(t.affiliation.id, old.id));
					const id = await event(tx, cx, old.id, "affiliation.ended", "remove");
					events.push(id);
					const original = await loadAffiliation(tx, old.id);
					if (!original) deny();
					await tx.insert(t.relationship_history).values({ id, relationship_id: old.id, pair: pairOf(original) });
					await notifyRelationship(tx, effects, {
						eventId: id,
						relationshipId: old.id,
						pair: pairOf(original),
						kind: "relationship_ended",
						revision: original.revision,
						operationId: cx.id,
					});
				}
				const [converted] = await tx
					.update(t.discovery)
					.set({
						converted_at: now,
						converted_plant_id: result.plant.id,
						conversion_operation_id: cx.id,
						revision: sql`${t.discovery.revision}+1`,
					})
					.where(eq(t.discovery.id, d.id))
					.returning();
				events.push(await event(tx, cx, d.id, "identity.domain_accepted", "retire"));
				await effects.enqueue(tx, {
					accountId: a.account.id,
					operationId: cx.id,
					kind: "plant_created",
					plantId: result.plant.id,
				});
				const { events: _, ...facts } = result;
				void _;
				return finish(tx, cx, events, c.convertDiscoveryResult, (receipt) => ({
					status: "converted",
					...facts,
					discoveryId: d.id,
					convertedAt: converted!.converted_at!.toISOString(),
					relationships,
					documentProposals: [],
					receipt,
				}));
			});
		},
	};
}
