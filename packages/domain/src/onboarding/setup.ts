import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, eq, isNull, sql } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import * as c from "@everyfield/contracts/onboarding";
import type { OnboardingProducer } from "@everyfield/contracts/onboarding/server";
import { plantReading } from "./reading.ts";
import { pending } from "./creation.ts";
import { begin, bump, deny, event, finish, now, plantOwner, parse, reply, revision, type Tx } from "./core.ts";

const savedLead = c.leadAnswerResult.shape.lead;
const savedJourney = c.journeyResult.shape.journey;
const savedLaunch = c.journeyResult.shape.launch;
export const declarationReason = "Declared at setup — where this plant already was when it joined EveryField.";
async function stamp(tx: Tx, plantId: string) {
	const [clock] = await tx.select({ at: now }).from(t.plant).where(eq(t.plant.id, plantId));
	return clock!.at.toISOString();
}
async function assignLead(
	tx: Tx,
	plantId: string,
	personId: string,
	selection: z.infer<typeof c.leadAssignmentSelection>,
) {
	let team, role;
	if (selection.kind === "existing_role") {
		[team] = await tx
			.select()
			.from(t.team)
			.where(and(eq(t.team.id, selection.teamId), eq(t.team.plant_id, plantId), isNull(t.team.archived_at)))
			.for("update");
		if (!team) deny();
		revision(selection.expectedTeamRevision, team.revision);
		[role] = await tx
			.select()
			.from(t.team_role)
			.where(
				and(
					eq(t.team_role.id, selection.roleId),
					eq(t.team_role.team_id, team.id),
					eq(t.team_role.plant_id, plantId),
					isNull(t.team_role.retired_at),
				),
			)
			.for("update");
		if (!role || !role.leadership) deny();
		revision(selection.expectedRoleRevision, role.revision);
	} else {
		if (selection.container.kind === "existing") {
			[team] = await tx
				.select()
				.from(t.team)
				.where(and(eq(t.team.id, selection.container.teamId), eq(t.team.plant_id, plantId), isNull(t.team.archived_at)))
				.for("update");
			if (!team) deny();
			revision(selection.container.expectedRevision, team.revision);
		} else
			[team] = await tx
				.insert(t.team)
				.values({ plant_id: plantId, name: selection.container.name, state: "forming", sort_order: 0 })
				.returning();
		[role] = await tx
			.insert(t.team_role)
			.values({ plant_id: plantId, team_id: team!.id, name: selection.roleName, leadership: true, sort_order: 0 })
			.returning();
	}
	if (team!.leader_person_id && team!.leader_person_id !== personId) deny("conflict");
	const tenures = await tx
		.select()
		.from(t.team_tenure)
		.where(
			and(eq(t.team_tenure.plant_id, plantId), eq(t.team_tenure.role_id, role!.id), isNull(t.team_tenure.ended_on)),
		)
		.for("update");
	if (tenures.some((r) => r.person_id !== personId)) deny("conflict");
	if (!tenures.length)
		await tx.insert(t.team_tenure).values({
			plant_id: plantId,
			role_id: role!.id,
			person_id: personId,
			started_on: sql`(clock_timestamp() AT TIME ZONE (SELECT timezone FROM plant WHERE id=${plantId}))::date`,
		});
	if (!team!.leader_person_id)
		await tx
			.update(t.team)
			.set({
				leader_person_id: personId,
				leader_source: "role_derived",
				leader_role_id: role!.id,
				revision: sql`${t.team.revision}+1`,
			})
			.where(eq(t.team.id, team!.id));
	return { teamId: team!.id, roleId: role!.id, personId };
}
export const setup: Pick<OnboardingProducer<Tx>, "answerLead" | "declareJourney" | "complete" | "getResume"> = {
	async answerLead(tx, ctx, raw) {
		return reply(tx, async () => {
			const q = parse(c.answerLeadRequest, raw),
				a = await plantOwner(tx, ctx),
				cx = await begin(tx, ctx, a.account.id, "identity.answerLeadOnboarding", q);
			if (cx.kind === "replay") return c.leadAnswerResult.parse(cx.value);
			revision(q.expectedRevision, a.plant.revision);
			const at = await stamp(tx, a.plant.id);
			const lead = savedLead.parse(
				q.input.answer === "yes"
					? {
							answer: "yes",
							assignment: await assignLead(tx, a.plant.id, a.person.id, q.input.assignment),
							savedAt: at,
						}
					: { answer: q.input.answer, savedAt: at },
			);
			await tx.update(t.onboarding_setup).set({ lead }).where(eq(t.onboarding_setup.plant_id, a.plant.id));
			await tx.update(t.plant).set({ lead_answer: q.input.answer }).where(eq(t.plant.id, a.plant.id));
			const plant = await bump(tx, a.plant.id),
				ids = [await event(tx, cx, a.plant.id, "attestation.recorded")];
			if (lead.answer === "yes") ids.push(await event(tx, cx, lead.assignment.roleId, "roles.changed", "assign"));
			return finish(tx, cx, ids, c.leadAnswerResult, (receipt) => ({
				plant: ctx.selected,
				revision: plant.revision,
				lead,
				receipt,
			}));
		});
	},
	async declareJourney(tx, ctx, raw) {
		return reply(tx, async () => {
			const q = parse(c.declareJourneyRequest, raw),
				a = await plantOwner(tx, ctx),
				cx = await begin(tx, ctx, a.account.id, "onboarding.declareJourney", q);
			if (cx.kind === "replay") return c.journeyResult.parse(cx.value);
			revision(q.expectedRevision, a.plant.revision);
			const ids = [],
				at = await stamp(tx, a.plant.id);
			const journey = savedJourney.parse({ status: "saved", value: q.input.journey, savedAt: at }),
				launch = savedLaunch.parse({ status: "saved", value: q.input.launch, savedAt: at });
			if (q.input.journey.answer === "existing") {
				const previous = await tx
					.select({ id: t.phase_transition.id })
					.from(t.phase_transition)
					.where(and(eq(t.phase_transition.plant_id, a.plant.id), eq(t.phase_transition.kind, "initial_declaration")));
				if (previous.length) deny("already_declared");
				const id = randomUUID();
				await tx.insert(t.phase_transition).values({
					id,
					plant_id: a.plant.id,
					kind: "initial_declaration",
					from_phase: a.plant.phase,
					to_phase: q.input.journey.phase,
					reason: declarationReason,
					occurred_at: now,
					recorded_at: now,
					operation_id: cx.id,
				});
				await tx.update(t.plant).set({ phase: q.input.journey.phase }).where(eq(t.plant.id, a.plant.id));
				ids.push(await event(tx, cx, id, "phase.declared", "declaration"));
			}
			const [schedule] = await tx.select().from(t.launch).where(eq(t.launch.plant_id, a.plant.id)).for("update");
			if (q.input.launch.answer === "planned") {
				revision(q.input.launch.expectedScheduleRevision, schedule?.revision ?? "1");
				if (schedule?.status === "completed") deny("conflict");
				await tx
					.insert(t.launch)
					.values({ plant_id: a.plant.id, target_date: q.input.launch.date, status: "scheduled" })
					.onConflictDoUpdate({
						target: t.launch.plant_id,
						set: { target_date: q.input.launch.date, status: "scheduled", revision: sql`${t.launch.revision}+1` },
					});
				ids.push(await event(tx, cx, a.plant.id, "launch.changed"));
			}
			await tx.update(t.onboarding_setup).set({ journey, launch }).where(eq(t.onboarding_setup.plant_id, a.plant.id));
			await tx
				.update(t.plant)
				.set({ journey_answer: q.input.journey.answer, launch_answer: q.input.launch.answer })
				.where(eq(t.plant.id, a.plant.id));
			const plant = await bump(tx, a.plant.id);
			ids.push(await event(tx, cx, a.plant.id, "attestation.recorded"));
			return finish(tx, cx, ids, c.journeyResult, (receipt) => ({
				plant: ctx.selected,
				revision: plant.revision,
				currentPhase: plant.phase,
				journey,
				launch,
				scheduledLaunchDate:
					q.input.launch.answer === "planned" ? q.input.launch.date : (schedule?.target_date ?? null),
				receipt,
			}));
		});
	},
	async complete(tx, ctx, raw) {
		return reply(tx, async () => {
			const q = parse(c.completeOnboardingRequest, raw),
				a = await plantOwner(tx, ctx),
				cx = await begin(tx, ctx, a.account.id, "onboarding.complete", q);
			if (cx.kind === "replay") return c.completeOnboardingResult.parse(cx.value);
			revision(q.expectedRevision, a.plant.revision);
			let plant = a.plant;
			if (!plant.onboarding_completed_at) {
				await tx.update(t.plant).set({ onboarding_completed_at: now }).where(eq(t.plant.id, plant.id));
				plant = await bump(tx, plant.id);
				await tx
					.update(t.onboarding_setup)
					.set({ completed_material_revision: plant.material_revision })
					.where(eq(t.onboarding_setup.plant_id, plant.id));
			}
			const completion = {
				status: "completed",
				completedAt: plant.onboarding_completed_at!.toISOString(),
				materialRevision: a.setup.completed_material_revision ?? plant.material_revision,
			};
			const id = await event(
				tx,
				cx,
				plant.id,
				"attestation.recorded",
				a.plant.onboarding_completed_at ? "noop" : "complete",
			);
			return finish(
				tx,
				cx,
				[id],
				c.completeOnboardingResult,
				(receipt) => ({ plant: ctx.selected, revision: plant.revision, completion, receipt }),
				!a.plant.onboarding_completed_at,
			);
		});
	},
	async getResume(tx, ctx, raw) {
		return reply(tx, async () => {
			parse(c.getResumeRequest, raw);
			if (ctx.selected.kind !== "plant") return c.resumeResult.parse({ status: "unavailable" });
			const a = await plantOwner(tx, ctx);
			const [schedule] = await tx.select().from(t.launch).where(eq(t.launch.plant_id, a.plant.id));
			const values = await tx
				.select({ id: t.document.id })
				.from(t.document)
				.innerJoin(
					t.document_revision,
					and(
						eq(t.document_revision.id, t.document.current_revision_id),
						eq(t.document_revision.tenant_id, t.document.tenant_id),
					),
				)
				.where(
					and(
						eq(t.document.tenant_id, a.plant.id),
						eq(t.document.kind, "core_values"),
						isNull(t.document.archived_at),
						sql`length(btrim(${t.document_revision.body})) > 0`,
						sql`${t.document_revision.import_state} IS DISTINCT FROM 'failed'`,
					),
				);
			return c.resumeResult.parse({
				status: "available",
				basics: "created",
				plant: ctx.selected,
				revision: a.plant.revision,
				materialRevision: a.plant.material_revision,
				currentPhase: a.plant.phase,
				lead: c.leadSetup.parse(a.setup.lead),
				journey: a.setup.journey ?? pending,
				launch: a.setup.launch ?? pending,
				scheduledLaunchDate: schedule?.target_date ?? null,
				peopleStep: a.setup.people_step,
				completion: a.plant.onboarding_completed_at
					? {
							status: "completed",
							completedAt: a.plant.onboarding_completed_at.toISOString(),
							materialRevision: a.setup.completed_material_revision,
						}
					: { status: "unfinished" },
				reading: await plantReading(tx, a.plant.id),
				values: values.length ? "recorded" : "missing",
			});
		});
	},
};
