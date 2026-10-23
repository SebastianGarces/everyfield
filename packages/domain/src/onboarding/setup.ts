import * as c from "@everyfield/contracts/onboarding";
import type { OnboardingProducer } from "@everyfield/contracts/onboarding/server";
import { and, eq, isNull, ne, sql } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
	begin,
	bump,
	deny,
	event,
	finish,
	now,
	parse,
	OnboardingReadContext,
	plantOwner,
	readReply,
	reply,
	revision,
	type Tx,
} from "./core.ts";
import { requestWrite } from "../access/session.ts";
import { pending } from "./creation.ts";
import { plantReading, readingFrom, foundationArticles, type ReadingRow } from "./reading.ts";

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
				a = await plantOwner(tx, ctx);
			const [person] = await tx
				.select()
				.from(t.person)
				.where(
					and(
						eq(t.person.plant_id, a.plant.id),
						eq(t.person.linked_account_id, a.account.id),
						eq(t.person.state, "live"),
					),
				)
				.for("update");
			if (!person) deny();
			const cx = await begin(tx, ctx, a.account.id, "identity.answerLeadOnboarding", q);
			if (cx.kind === "replay") return c.leadAnswerResult.parse(cx.value);
			revision(q.expectedRevision, a.plant.revision);
			const at = await stamp(tx, a.plant.id);
			const lead = savedLead.parse(
				q.input.answer === "yes"
					? {
							answer: "yes",
							assignment: await assignLead(tx, a.plant.id, person.id, q.input.assignment),
							savedAt: at,
						}
					: { answer: q.input.answer, savedAt: at },
			);
			await tx.update(t.onboarding_setup).set({ lead }).where(eq(t.onboarding_setup.plant_id, a.plant.id));
			await tx.update(t.plant).set({ lead_answer: q.input.answer }).where(eq(t.plant.id, a.plant.id));
			const plant = await bump(tx, a.plant.id),
				ids = [await event(tx, cx, a.plant.id, "attestation.recorded")];
			if (lead.answer === "yes") ids.push(await event(tx, cx, lead.assignment.roleId, "roles.changed", "assign"));
			return finish(tx, cx, c.leadAnswerResult, () => ({
				plant: ctx.selected,
				revision: plant.revision,
				lead,
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
			return finish(tx, cx, c.journeyResult, () => ({
				plant: ctx.selected,
				revision: plant.revision,
				currentPhase: plant.phase,
				journey,
				launch,
				scheduledLaunchDate:
					q.input.launch.answer === "planned" ? q.input.launch.date : (schedule?.target_date ?? null),
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
			await event(tx, cx, plant.id, "attestation.recorded", a.plant.onboarding_completed_at ? "noop" : "complete");
			return finish(tx, cx, c.completeOnboardingResult, () => ({
				plant: ctx.selected,
				revision: plant.revision,
				completion,
			}));
		});
	},
	async getResume(tx, ctx, raw) {
		return readReply(async () => {
			parse(c.getResumeRequest, raw);
			if (ctx.selected.kind !== "plant") return c.resumeResult.parse({ status: "unavailable" });
			// A request read (no bound write) reads every fact in one statement.
			if (ctx instanceof OnboardingReadContext && !requestWrite(tx)) return (await plantEntry(tx, ctx)).resume;
			const a = await plantOwner(tx, ctx, false);
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
			const [creation] = await tx
				.select({ value: t.audit_event.result })
				.from(t.audit_event)
				.where(eq(t.audit_event.id, a.setup.creation_operation_id));
			const original = z.object({ ownerSeat: z.object({ personId: z.string().uuid() }) }).parse(creation?.value);
			const extraPeople = await tx
				.select({ id: t.person.id })
				.from(t.person)
				.where(
					and(
						eq(t.person.plant_id, a.plant.id),
						eq(t.person.state, "live"),
						ne(t.person.id, original.ownerSeat.personId),
					),
				)
				.limit(1);
			return resumeFrom({
				plant: ctx.selected,
				revision: a.plant.revision,
				materialRevision: a.plant.material_revision,
				phase: a.plant.phase,
				completedAt: a.plant.onboarding_completed_at,
				setup: a.setup,
				scheduledLaunchDate: schedule?.target_date ?? null,
				extraPeople: extraPeople.length > 0,
				reading: await plantReading(tx, a.plant.id),
				values: values.length > 0,
			});
		});
	},
};

/** The resume reply from its facts. */
function resumeFrom(f: {
	plant: { kind: "plant"; id: string };
	revision: string;
	materialRevision: string;
	phase: number;
	completedAt: Date | null;
	setup: Pick<
		typeof t.onboarding_setup.$inferSelect,
		"lead" | "journey" | "launch" | "people_step" | "completed_material_revision"
	>;
	scheduledLaunchDate: string | null;
	extraPeople: boolean;
	reading: z.infer<typeof c.foundationReading>;
	values: boolean;
}) {
	return c.resumeResult.parse({
		status: "available",
		basics: "created",
		plant: f.plant,
		revision: f.revision,
		materialRevision: f.materialRevision,
		currentPhase: f.phase,
		lead: c.leadSetup.parse(f.setup.lead),
		journey: f.setup.journey ?? pending,
		launch: f.setup.launch ?? pending,
		scheduledLaunchDate: f.scheduledLaunchDate,
		peopleStep: f.extraPeople ? "saved" : f.setup.people_step,
		completion: f.completedAt
			? {
					status: "completed",
					completedAt: f.completedAt.toISOString(),
					materialRevision: f.setup.completed_material_revision,
				}
			: { status: "unfinished" },
		reading: f.reading,
		values: f.values ? "recorded" : "missing",
	});
}
const entryRow = z.object({
	account: z.boolean(),
	plant_id: z.string().nullable(),
	plant_name: z.string().nullable(),
	revision: z.string().nullable(),
	material_revision: z.string().nullable(),
	phase: z.number().nullable(),
	completed_at: z.number().nullable(),
	setup_account_id: z.string().nullable(),
	lead: z.unknown(),
	journey: z.unknown(),
	launch: z.unknown(),
	people_step: z.string().nullable(),
	completed_material_revision: z.string().nullable(),
	target_date: z.string().nullable(),
	values: z.boolean(),
	creation: z.unknown(),
	extra_people: z.boolean(),
	candidates: z.array(
		z.object({ accountId: z.string(), role: z.string(), personId: z.string().nullable(), lead: z.boolean() }),
	),
	readings: z.array(
		z.object({
			account_id: z.string(),
			article_id: z.string(),
			completed_fraction: z.string().nullable(),
			completed_at: z.number().nullable(),
			source_id: z.string(),
			tenant_id: z.string(),
			revision_number: z.union([z.number(), z.string()]),
			kind: z.string(),
			organization_kind: z.string().nullable(),
		}),
	),
});
/**
 * A plant Owner's onboarding entry as one statement, no transaction: the same facts the separate reads give (the
 * account, plant and setup rows, the launch date, recorded core values, the creation result, other People and the
 * foundation reading of the current Owner and Admin lead) and the plant's name for the heading.
 */
export async function plantEntry(tx: Pick<Tx, "execute">, ctx: OnboardingReadContext) {
	const a = ctx.authority.actor;
	if (a.status !== "active" || a.context.kind !== "seat" || a.context.role !== "owner" || ctx.selected.kind !== "plant")
		deny();
	const plantId = ctx.selected.id;
	const none = "00000000-0000-0000-0000-000000000000";
	const result = await tx.execute(sql`WITH acct AS (SELECT id FROM account WHERE id=${a.accountId}::uuid),
 pl AS (SELECT * FROM plant WHERE id=${plantId}::uuid),
 st AS (SELECT * FROM onboarding_setup WHERE plant_id=(SELECT id FROM pl)),
 cr AS (SELECT result FROM audit_event WHERE id=(SELECT creation_operation_id FROM st)),
 cand AS (SELECT s.account_id, s.role, p.id AS person_id,
  EXISTS(SELECT FROM team_tenure tt JOIN team_role r ON r.id=tt.role_id AND r.plant_id=tt.plant_id JOIN team tm ON tm.id=r.team_id
   AND tm.plant_id=r.plant_id WHERE tt.person_id=p.id AND tt.plant_id=${plantId}::uuid AND tt.ended_on IS NULL AND r.leadership
   AND r.id=coalesce(CASE WHEN (SELECT lead->>'answer' FROM st)='yes' THEN (SELECT lead->'assignment'->>'roleId' FROM st) END, ${none})::uuid
   AND r.retired_at IS NULL AND tm.archived_at IS NULL) AS lead
  FROM seat s JOIN account ac ON ac.id=s.account_id AND ac.registration_state='active'
  LEFT JOIN person p ON p.linked_account_id=s.account_id AND p.plant_id=${plantId}::uuid AND p.state='live'
  WHERE s.plant_id=${plantId}::uuid AND s.ended_at IS NULL AND s.accepted_at<=clock_timestamp()
  AND NOT EXISTS(SELECT FROM lifecycle_witness w LEFT JOIN seat ws ON ws.id=w.seat_id
   WHERE (w.opaque_subject_id=s.account_id OR ws.account_id=s.account_id) AND w.state NOT IN ('active','cancelled'))),
 rd AS (SELECT r.account_id, r.article_id, r.completed_fraction::text AS completed_fraction,
  (extract(epoch FROM r.completed_at)*1000)::float8 AS completed_at, ar.id AS source_id, ar.tenant_id, ar.revision_number,
  tn.kind, o.kind AS organization_kind
  FROM reading r JOIN article_revision ar ON ar.id=r.completed_revision_id AND ar.article_id=r.article_id
  JOIN tenant tn ON tn.id=ar.tenant_id LEFT JOIN organization o ON o.id=tn.id
  WHERE r.account_id IN (SELECT account_id FROM cand) AND r.article_id=ANY(${sql.param(foundationArticles)}::uuid[])
  AND ar.published_at IS NOT NULL AND r.completed_at IS NOT NULL)
 SELECT EXISTS(SELECT FROM acct) AS account, (SELECT id FROM pl) AS plant_id, (SELECT name FROM pl) AS plant_name,
  (SELECT revision::text FROM pl) AS revision, (SELECT material_revision::text FROM pl) AS material_revision,
  (SELECT phase FROM pl) AS phase, (SELECT (extract(epoch FROM onboarding_completed_at)*1000)::float8 FROM pl) AS completed_at,
  (SELECT account_id FROM st) AS setup_account_id, (SELECT lead FROM st) AS lead, (SELECT journey FROM st) AS journey,
  (SELECT launch FROM st) AS launch, (SELECT people_step FROM st) AS people_step,
  (SELECT completed_material_revision::text FROM st) AS completed_material_revision,
  (SELECT target_date::text FROM launch WHERE plant_id=${plantId}::uuid) AS target_date,
  EXISTS(SELECT FROM document d JOIN document_revision dr ON dr.id=d.current_revision_id AND dr.tenant_id=d.tenant_id
   WHERE d.tenant_id=${plantId}::uuid AND d.kind='core_values' AND d.archived_at IS NULL AND length(btrim(dr.body))>0
   AND dr.import_state IS DISTINCT FROM 'failed') AS values,
  (SELECT result FROM cr) AS creation,
  EXISTS(SELECT FROM person WHERE plant_id=${plantId}::uuid AND state='live'
   AND id::text IS DISTINCT FROM (SELECT result->'ownerSeat'->>'personId' FROM cr)) AS extra_people,
  coalesce((SELECT jsonb_agg(jsonb_build_object('accountId',account_id,'role',role,'personId',person_id,'lead',lead)) FROM cand),'[]') AS candidates,
  coalesce((SELECT jsonb_agg(to_jsonb(rd)) FROM rd),'[]') AS readings`);
	const r = entryRow.parse(result.rows[0]);
	if (!r.account) deny();
	if (!r.plant_id || !r.setup_account_id || r.setup_account_id !== a.accountId) deny();
	z.object({ ownerSeat: z.object({ personId: z.string().uuid() }) }).parse(r.creation);
	const rows: ReadingRow[] = r.readings.map((x) => ({
		reading: {
			account_id: x.account_id,
			article_id: x.article_id,
			completed_fraction: x.completed_fraction,
			completed_at: x.completed_at === null ? null : new Date(x.completed_at),
		},
		source: { id: x.source_id, tenant_id: x.tenant_id, revision_number: x.revision_number },
		kind: x.kind,
		organizationKind: x.organization_kind,
	}));
	return {
		plantName: r.plant_name,
		resume: resumeFrom({
			plant: ctx.selected,
			revision: r.revision!,
			materialRevision: r.material_revision!,
			phase: r.phase!,
			completedAt: r.completed_at === null ? null : new Date(r.completed_at),
			setup: {
				lead: r.lead as typeof t.onboarding_setup.$inferSelect.lead,
				journey: r.journey as typeof t.onboarding_setup.$inferSelect.journey,
				launch: r.launch as typeof t.onboarding_setup.$inferSelect.launch,
				people_step: r.people_step as typeof t.onboarding_setup.$inferSelect.people_step,
				completed_material_revision: r.completed_material_revision,
			},
			scheduledLaunchDate: r.target_date,
			extraPeople: r.extra_people,
			reading: readingFrom(plantId, r.candidates, rows),
			values: r.values,
		}),
	};
}
