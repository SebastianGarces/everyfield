import { counted, dayText } from "@everyfield/contracts/common";
import { sql } from "@everyfield/db/query";
import {
	ENROLLMENT_END_NOTES,
	ENROLLMENT_STATUS,
	enrollmentOutcome,
	enrollRequest,
	goalCount,
	goalHeadline,
	pipelineStageKind,
	programKind,
	programPlan,
	programRhythm,
	saveGoalRequest,
	type EnrollmentDetail,
	type ProgramDetail,
} from "@everyfield/contracts/organizations";
import {
	pipelineWriter,
	programWriter,
	readEnrollment,
	readPipelineBoard,
	readPipelineGoals,
	readProgram,
	readVersionReview,
} from "@everyfield/domain/organizations";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { EvryRefusal } from "../../../context/errors.ts";
import { localWhenText } from "../../../catalog/labels.ts";
import {
	approvedNow,
	change,
	organizationSeat,
	reviewed,
	target,
	dayInput,
	rowId,
	localTimeInput,
} from "../../native.ts";
import { STAGE_KIND } from "../reads/index.ts";

const settled = (reply: { status: "ok"; value: object } | { status: "refused"; refusal: { code: string } }) =>
	reply.status === "ok"
		? { revision: "revision" in reply.value ? String(reply.value.revision) : "1" }
		: { refused: reply.refusal.code };

export const proposeStageMove = approvedNow({
	operation: "pipeline.proposeStageMove",
	description:
		"Propose moving one person in this organization's pipeline to another stage: only the person (personId) and the destination stage (stageId), both from pipeline.listPeople. It takes no reason, note or other text: the user types the reason on the review card, and Evry never sees it. Nothing changes until the user approves",
	input: z.strictObject({ personId: z.uuid(), stageId: z.uuid() }),
	review(actor, value) {
		const refusal = sql`CASE WHEN fs.id=ds.id THEN jsonb_build_object('refusal',p.display_name||' is already in '||ds.label||'.')
			ELSE '{}'::jsonb END`;
		return sql`SELECT jsonb_build_object('target',${target("person", sql`p.id`, sql`p.display_name`)},
				'changes',jsonb_build_array(jsonb_build_object('field','pipelineStage','before',fs.label,'after',ds.label)))||${refusal} AS review,
			jsonb_build_object('personId',p.id,'stageId',ds.id,'expectedRevision',pp.revision::text) AS args
			FROM pipeline_person pp JOIN person p ON p.id=pp.person_id AND p.tenant_id=pp.organization_id AND p.state='live'
			JOIN pipeline_stage fs ON fs.id=pp.stage_id AND fs.organization_id=pp.organization_id
			JOIN pipeline_stage ds ON ds.id=${value.stageId}::uuid AND ds.organization_id=pp.organization_id AND ds.removed_at IS NULL
			WHERE pp.organization_id=${actor.owner.id}::uuid AND pp.person_id=${value.personId}::uuid`;
	},
	reason: true,
	run: async (db, authority, args, reason) =>
		settled(await pipelineWriter.movePerson(db, authority, { ...args, reason: reason ?? "" })),
	current: (p) => sql`(SELECT jsonb_agg(jsonb_build_object('id',x.id,'label',x.display_name,'value',s.label))
		FROM person x JOIN pipeline_person pp ON pp.person_id=x.id AND pp.organization_id=x.tenant_id
		JOIN pipeline_stage s ON s.id=pp.stage_id AND s.organization_id=pp.organization_id
		WHERE x.id=(${p}.input->>'personId')::uuid AND x.tenant_id=${p}.tenant_id)`,
});

const RHYTHM_TEXT = { weekly: "Weekly", every_two_weeks: "Every two weeks", monthly: "Monthly" } as const;
const KIND_TEXT = { apprenticeship: "Apprenticeship", residency: "Residency" } as const;
const months = z.int().min(0).max(120);
const planInput = z.strictObject({
	kind: programKind,
	name: z.string().trim().min(1).max(120),
	directorSeatId: z.uuid(),
	expectedMonths: z.int().min(1).max(120),
	rhythm: programRhythm,
	stages: z
		.array(z.strictObject({ label: z.string().trim().min(1).max(80), minMonths: months, maxMonths: months }))
		.max(20),
	milestones: z
		.array(
			z.strictObject({
				title: z.string().trim().min(1).max(200),
				description: z.string().trim().min(1).max(2000).nullable().optional(),
				handsOn: z.boolean().optional(),
			}),
		)
		.max(100),
});
const rangeText = (min: number, max: number) =>
	min === max ? counted(min, "month") : `${min}–${counted(max, "month")}`;

export const saveProgram = approvedNow({
	operation: "development.saveProgram",
	description:
		"Propose creating one program from a drafted plan: kind, name, director (a seat id from development.draftPlan), expected length, rhythm, stages and milestones. It is saved as an unpublished draft: nothing is published and no one is enrolled, and only the director publishes it from Programs. Nothing changes until the user approves",
	input: planInput,
	review(actor, value) {
		const plan = programPlan.safeParse({
			rhythm: value.rhythm,
			expectedMonths: value.expectedMonths,
			stages: value.stages,
			milestones: value.milestones.map((m) => ({
				lineage: randomUUID(),
				title: m.title,
				description: m.description ?? null,
				handsOn: m.handsOn ?? false,
			})),
			readings: [],
		});
		if (!plan.success) throw new EvryRefusal("invalid_input");
		const request = {
			programId: randomUUID(),
			kind: value.kind,
			name: value.name,
			directorSeatId: value.directorSeatId,
			plan: plan.data,
		};
		const after = (field: string, v: unknown) => change(field, sql`'null'::jsonb`, v);
		return sql`SELECT jsonb_build_object('target',${target("organization", sql`o.id`, sql`${value.name}::text`)},
				'changes',jsonb_build_array(${after("programKind", KIND_TEXT[value.kind])},${after("name", value.name)},
					jsonb_build_object('field','director','before',NULL,'after',coalesce(i.display_name,'Staff')),
					${after("expectedLength", counted(value.expectedMonths, "month"))},${after("rhythm", RHYTHM_TEXT[value.rhythm])},
					${after(
						"stages",
						value.stages.map((s) => `${s.label}, ${rangeText(s.minMonths, s.maxMonths)}`),
					)},${after(
						"milestones",
						value.milestones.map((m) => m.title),
					)}),
				'notes',jsonb_build_array('This saves an unpublished draft in Programs. Nothing is published and no one is enrolled.',
					'Only '||coalesce(i.display_name,'the director')||', the director, can publish it.')) AS review,
			${JSON.stringify(request)}::jsonb AS args
			FROM organization o JOIN seat s ON s.id=${value.directorSeatId}::uuid AND s.organization_id=o.id AND s.ended_at IS NULL
				AND s.accepted_at<=clock_timestamp()
			LEFT JOIN LATERAL seat_identity(s.account_id) i ON true
			WHERE o.id=${actor.owner.id}::uuid`;
	},
	reason: false,
	run: async (db, authority, args) => settled(await programWriter.createProgram(db, authority, args)),
});

const nextPlanInput = z.strictObject({
	programId: z.uuid(),
	plan: z.strictObject({
		rhythm: programRhythm,
		expectedMonths: z.int().min(1).max(120),
		stages: planInput.shape.stages,
		milestones: z
			.array(
				z.strictObject({
					lineage: z.uuid().optional(),
					title: z.string().trim().min(1).max(200),
					description: z.string().trim().min(1).max(2000).nullable().optional(),
					handsOn: z.boolean().optional(),
				}),
			)
			.max(100),
	}),
});
type NextPlan = z.infer<typeof nextPlanInput>;
type Version = NonNullable<ProgramDetail["published"]>;
const stageText = (s: { label: string; minMonths: number; maxMonths: number }) =>
	`${s.label}, ${rangeText(s.minMonths, s.maxMonths)}`;
const list = (items: string[]) => (items.length ? items.join("; ") : "none");

export function nextVersionReview(program: ProgramDetail, value: NextPlan) {
	const base = (program.draft ?? program.published) as Version;
	const number = program.draft ? program.draft.number : base.number + 1;
	const from = program.draft ? `the Draft of Version ${number}` : `Version ${base.number}`;
	const byLineage = new Map(base.milestones.map((m) => [m.lineage, m]));
	const milestones = value.plan.milestones.map((m) => {
		const was = m.lineage ? byLineage.get(m.lineage) : undefined;
		if (m.lineage && !was) throw new EvryRefusal("invalid_input");
		return {
			lineage: was?.lineage ?? randomUUID(),
			title: m.title,
			description: m.description === undefined ? (was?.description ?? null) : m.description,
			handsOn: m.handsOn ?? was?.handsOn ?? false,
		};
	});
	const plan = programPlan.safeParse({
		rhythm: value.plan.rhythm,
		expectedMonths: value.plan.expectedMonths,
		stages: value.plan.stages,
		milestones,
		readings: base.readings.map((r) => ({ revisionId: r.revisionId })),
	});
	if (!plan.success) throw new EvryRefusal("invalid_input");
	const baseOf = (lineage: string) => {
		const was = byLineage.get(lineage);
		if (!was) throw new Error("A kept milestone has no base milestone");
		return was;
	};
	const kept = milestones.filter((m) => byLineage.has(m.lineage));
	const edited = kept.filter((m) => {
		const was = baseOf(m.lineage);
		return was.title !== m.title || was.description !== m.description || was.handsOn !== m.handsOn;
	});
	const added = milestones.filter((m) => !byLineage.has(m.lineage));
	const removed = base.milestones.filter((m) => !milestones.some((x) => x.lineage === m.lineage));
	const sameStages = JSON.stringify(base.stages.map(stageText)) === JSON.stringify(value.plan.stages.map(stageText));
	const keptOrder = base.milestones.filter((m) => kept.some((k) => k.lineage === m.lineage)).map((m) => m.lineage);
	const reordered = JSON.stringify(keptOrder) !== JSON.stringify(kept.map((m) => m.lineage));
	const changes = [
		...(base.rhythm !== value.plan.rhythm
			? [{ field: "rhythm", before: RHYTHM_TEXT[base.rhythm], after: RHYTHM_TEXT[value.plan.rhythm] }]
			: []),
		...(base.expectedMonths !== value.plan.expectedMonths
			? [
					{
						field: "expectedLength",
						before: counted(base.expectedMonths, "month"),
						after: counted(value.plan.expectedMonths, "month"),
					},
				]
			: []),
		...(sameStages
			? []
			: [{ field: "stages", before: base.stages.map(stageText), after: value.plan.stages.map(stageText) }]),
		...(added.length ? [{ field: "addedMilestones", before: null, after: added.map((m) => m.title) }] : []),
		...(edited.length
			? [
					{
						field: "changedMilestones",
						before: edited.map((m) => baseOf(m.lineage).title),
						after: edited.map((m) => m.title),
					},
				]
			: []),
		...(removed.length ? [{ field: "removedMilestones", before: removed.map((m) => m.title), after: null }] : []),
		...(reordered
			? [
					{
						field: "milestoneOrder",
						before: keptOrder.map((l) => baseOf(l).title),
						after: kept.map((m) => m.title),
					},
				]
			: []),
	];
	const same = kept.filter((m) => !edited.includes(m)).map((m) => m.title);
	const stays = [
		...(base.rhythm === value.plan.rhythm ? [`Meets: ${RHYTHM_TEXT[base.rhythm]}`] : []),
		...(base.expectedMonths === value.plan.expectedMonths
			? [`Expected length: ${counted(base.expectedMonths, "month")}`]
			: []),
		...(sameStages ? [`Stages: ${list(base.stages.map(stageText))}`] : []),
		...(same.length
			? [`${added.length || edited.length || removed.length ? "Other milestones" : "Milestones"}: ${list(same)}`]
			: []),
		`Reading list: ${list(base.readings.map((r) => r.title))}`,
	];
	const director = program.director.name;
	const closing = [
		...(program.draft ? [`Approving replaces the current Draft of Version ${number}.`] : []),
		...(program.published
			? [
					`Version ${program.published.number} stays as it is, and people enrolled keep Version ${program.published.number}.`,
				]
			: ["Nothing is published."]),
		`Only ${director}, the director, publishes Version ${number}, from Programs.`,
	].join(" ");
	return {
		label: `Draft of Version ${number}`,
		from,
		changes,
		notes: [`What stays the same as ${from}:`, ...stays, closing],
		refusal: changes.length ? undefined : `This plan is the same as ${from}, so there is nothing to save.`,
		args: { programId: program.id, expectedRevision: program.revision, plan: plan.data },
	};
}

export const draftNextVersion = approvedNow({
	operation: "development.draftNextVersion",
	description:
		"Propose the next version's draft of one program the user directs: only the program (programId from development.readProgram) and the whole changed plan, starting from the draft in progress or else the published version. Keep each kept or renamed milestone's lineage from development.readProgram, and leave lineage out for a new milestone. The reading list stays as it is. It saves the draft only: nothing is published, no one enrolled changes version, and only the director publishes it from Programs. Nothing changes until the user approves",
	input: nextPlanInput,
	allowed: organizationSeat,
	async review(actor, value, { db }) {
		const read = await readProgram(db, actor.authority, { programId: value.programId });
		if (read.status !== "ok") throw new EvryRefusal("not_found");
		if (!read.value.viewer.director) throw new EvryRefusal("access_denied");
		const r = nextVersionReview(read.value, value);
		return sql`SELECT jsonb_build_object('target',${target("program", sql`${value.programId}::uuid`, sql`${r.label}::text`)},
				'changes',${JSON.stringify(r.changes)}::jsonb,'notes',${JSON.stringify(r.notes)}::jsonb)
				||${r.refusal ? sql`jsonb_build_object('refusal',${r.refusal}::text)` : sql`'{}'::jsonb`} AS review,
			${JSON.stringify(r.args)}::jsonb AS args`;
	},
	reason: false,
	run: async (db, authority, args) => settled(await programWriter.savePlan(db, authority, args)),
});

type Card = {
	target: { kind: "person" | "program" | "organization"; id: string; label: string; href?: string };
	changes: { field: string; before: unknown; after: unknown }[];
	notes?: string[];
	refusal?: string | null;
};
const changed = (field: string, before: unknown, after: unknown) =>
	JSON.stringify(before) === JSON.stringify(after) ? [] : [{ field, before, after }];
const card = ({ refusal, ...review }: Card, args: object) => reviewed({ ...review, ...(refusal && { refusal }) }, args);
const found = <T>(reply: { status: "ok"; value: T } | { status: "refused" }): T => {
	if (reply.status !== "ok") throw new EvryRefusal("not_found");
	return reply.value;
};

const goalInput = z
	.strictObject({
		goalId: rowId.optional(),
		leaderTarget: saveGoalRequest.shape.leaderTarget.optional(),
		plantTarget: saveGoalRequest.shape.plantTarget.optional(),
		targetYear: saveGoalRequest.shape.targetYear.optional(),
		rationale: saveGoalRequest.shape.rationale.optional(),
		countingFrom: dayInput.optional(),
		counts: saveGoalRequest.shape.counts.optional(),
	})
	.refine((g) => Object.keys(g).some((k) => k !== "goalId"), "empty goal");
const countText = (counts: readonly z.infer<typeof goalCount>[]) =>
	counts.map((c) => `${c.label}, reached ${STAGE_KIND[c.kind]}`);

export const saveGoal = approvedNow({
	operation: "pipeline.saveGoal",
	description:
		"Propose adding a sending goal or changing one: leaders to develop, churches to plant, the year, why, the day it counts from and up to four counts (each a stage kind with its label). To change a goal give its goalId from pipeline.readGoals and only the fields the user names: the rest stay. counts, when given, is the whole new list. A new goal needs leaderTarget, plantTarget, targetYear and the user's own why (rationale): ask for what is missing. countingFrom is a local date, today or earlier; a new goal counts from today without one. Nothing changes until the user approves",
	input: goalInput,
	async review(actor, value, { db }) {
		const goals = found(await readPipelineGoals(db, actor.authority));
		const was = goals.goals.find((g) => g.id === value.goalId);
		if (value.goalId && !was) throw new EvryRefusal("not_found");
		const next = {
			leaderTarget: value.leaderTarget ?? was?.leaderTarget,
			plantTarget: value.plantTarget ?? was?.plantTarget,
			targetYear: value.targetYear ?? was?.targetYear,
			rationale: value.rationale ?? was?.rationale,
			countingFrom: value.countingFrom ?? was?.countingFrom ?? goals.asOf,
			counts: value.counts ?? was?.counts.map(({ kind, label }) => ({ kind, label })) ?? [],
		};
		const request = saveGoalRequest.safeParse({
			goalId: was?.id ?? randomUUID(),
			expectedRevision: was?.revision ?? null,
			...next,
			countingFrom: value.countingFrom ?? was?.countingFrom ?? null,
		});
		if (!request.success) throw new EvryRefusal("invalid_input");
		const goal = request.data;
		const changes = [
			...changed("leaderTarget", was?.leaderTarget ?? null, goal.leaderTarget),
			...changed("plantTarget", was?.plantTarget ?? null, goal.plantTarget),
			...changed("targetYear", was ? String(was.targetYear) : null, String(goal.targetYear)),
			...changed("rationale", was?.rationale ?? null, goal.rationale),
			...changed("countingFrom", was ? dayText(was.countingFrom) : null, dayText(next.countingFrom)),
			...changed(
				"goalCounts",
				was ? countText(was.counts) : null,
				goal.counts.length || was ? countText(goal.counts) : null,
			),
		];
		return card(
			{
				target: {
					kind: "organization",
					id: actor.owner.id,
					label: was ? goalHeadline(was) : "New sending goal",
				},
				changes,
				notes: ["Saving a goal moves no one and changes no stage."],
				refusal:
					next.countingFrom > goals.asOf
						? "The counting-from date can't be after today, so there is nothing to approve."
						: changes.length
							? null
							: "The goal already says this, so nothing would change.",
			},
			goal,
		);
	},
	reason: false,
	run: async (db, authority, args) => settled(await pipelineWriter.saveGoal(db, authority, args)),
});

const stagesInput = z.strictObject({
	stages: z
		.array(
			z.strictObject({
				stageId: rowId.optional(),
				label: z.string().trim().min(1).max(80),
				kind: pipelineStageKind.optional(),
			}),
		)
		.min(1)
		.max(30),
	remove: z.array(rowId).max(30).optional(),
});
const heldRow = z.strictObject({ id: z.string(), held: z.coerce.number() });

export const saveStages = approvedNow({
	operation: "pipeline.saveStages",
	description:
		"Propose renaming, adding, reordering or removing this organization's pipeline stages. Read pipeline.listPeople first, then give every stage that stays, in its new order: a kept stage by its stageId with its label (its current one unless the user renames it), a new stage with a label and the kind it counts as (potential_leader, apprentice, resident, commissioned, not_continuing or other; other when the user names none). List removed stages in remove. A stage's kind never changes, a stage with people in it can't be removed, and no person moves. Nothing changes until the user approves",
	input: stagesInput,
	async review(actor, value, { db }) {
		const board = found(await readPipelineBoard(db, actor.authority, {}));
		const held = new Map(
			z
				.array(heldRow)
				.parse(
					(
						await db.execute(sql`SELECT pp.stage_id AS id,count(*) AS held FROM pipeline_person pp
							JOIN person p ON p.id=pp.person_id AND p.tenant_id=pp.organization_id AND p.state IN ('live','retired')
							WHERE pp.organization_id=${actor.owner.id}::uuid GROUP BY pp.stage_id`)
					).rows,
				)
				.map((r) => [r.id, r.held]),
		);
		const byId = new Map<string, (typeof board.stages)[number]>(board.stages.map((s) => [s.id, s]));
		const removing = new Set(value.remove ?? []);
		const kept = new Set(value.stages.flatMap((s) => (s.stageId ? [s.stageId] : [])));
		const known = [...kept, ...removing].every((id) => byId.has(id));
		const once = kept.size === value.stages.filter((s) => s.stageId).length;
		const clear = [...removing].every((id) => !kept.has(id));
		if (!known || !once || !clear || board.stages.some((s) => !kept.has(s.id) && !removing.has(s.id)))
			throw new EvryRefusal("invalid_input");
		const rows = value.stages.map((s) => {
			const was = s.stageId ? byId.get(s.stageId) : undefined;
			return {
				id: was?.id ?? randomUUID(),
				label: s.label,
				kind: s.kind ?? was?.kind ?? ("other" as const),
				expectedRevision: was?.revision ?? null,
				was,
			};
		});
		const removed = board.stages.filter((s) => removing.has(s.id));
		const rekinded = rows.find((r) => r.was && r.kind !== r.was.kind)?.was;
		const labels = rows.map((r) => r.label.toLowerCase());
		const twice = rows.find((r, n) => labels.indexOf(r.label.toLowerCase()) !== n);
		const occupied = removed.find((s) => (held.get(s.id) ?? 0) > 0);
		const renamed = rows.filter((r) => r.was && r.was.label !== r.label);
		const added = rows.filter((r) => !r.was);
		const stays = board.stages.filter((s) => kept.has(s.id)).map((s) => s.id);
		const natural = [...stays, ...added.map((r) => r.id)];
		const moved = rows.some((r, n) => r.id !== natural[n]);
		const changes = [
			...(renamed.length
				? [{ field: "renamedStages", before: renamed.map((r) => r.was?.label), after: renamed.map((r) => r.label) }]
				: []),
			...(added.length
				? [
						{
							field: "addedStages",
							before: null,
							after: added.map((r) => `${r.label}, counted as ${STAGE_KIND[r.kind]}`),
						},
					]
				: []),
			...(removed.length ? [{ field: "removedStages", before: removed.map((s) => s.label), after: null }] : []),
			...(moved
				? [{ field: "stageOrder", before: board.stages.map((s) => s.label), after: rows.map((r) => r.label) }]
				: []),
		];
		const refusal = rekinded
			? `${rekinded.label} counts as ${STAGE_KIND[rekinded.kind]}, and a stage's kind can't change. Add a new stage instead.`
			: twice
				? `Two stages would be called ${twice.label}. Each stage needs its own name.`
				: occupied
					? `${occupied.label} still has ${counted(held.get(occupied.id) ?? 0, "person", "people")}, so it can't be removed. Move or remove them first. Retired people count too.`
					: changes.length
						? null
						: "The stages are already like this, so nothing would change.";
		return card(
			{
				target: { kind: "organization", id: actor.owner.id, label: "Pipeline stages" },
				changes,
				notes: ["No person moves. Only the stages listed here change."],
				refusal,
			},
			{
				stages: rows.map(({ id, label, kind, expectedRevision }) => ({ id, label, kind, expectedRevision })),
				removed: removed.map((s) => ({ id: s.id, expectedRevision: s.revision })),
			},
		);
	},
	reason: false,
	run: async (db, authority, args) => settled(await pipelineWriter.saveStages(db, authority, args)),
});

const enrollInput = z.strictObject({
	programId: rowId,
	personId: rowId,
	cohort: z.string().trim().min(1).max(80),
	startedOn: dayInput,
	expectedEndOn: dayInput,
	stageId: rowId.optional(),
	nextMeetingAt: localTimeInput.nullable().optional(),
});
const meetingText = (at: string | null, zone: string) => (at ? `${localWhenText(at)} (${zone})` : null);
const enrollmentHref = (enrollmentId: string) => `/organization/pipeline/programs/enrollments/${enrollmentId}`;

export const enroll = approvedNow({
	operation: "development.enroll",
	description:
		"Propose enrolling one live pipeline person (personId, a candidate row of development.readProgram with enrolled: true) in a published program: the cohort's name, the start and expected end dates, the program stage (stageId of the published version; the first stage without one) and the next meeting as a local date and time in the organization's time zone, if any. Ask for a cohort or date the user didn't give. Their pipeline stage doesn't change. Owner or Admin. Nothing changes until the user approves",
	input: enrollInput,
	async review(actor, value, { db }) {
		const p = found(await readProgram(db, actor.authority, { programId: value.programId }));
		const person = p.people.find((x) => x.personId === value.personId);
		if (!person) throw new EvryRefusal("not_found");
		const stages = p.published?.stages ?? [];
		const stage = value.stageId ? stages.find((s) => s.id === value.stageId) : stages[0];
		if (p.published && !stage) throw new EvryRefusal("invalid_input");
		const duplicate = p.enrollments.some((e) => e.personId === value.personId && e.status === "active");
		const meeting = value.nextMeetingAt ?? null;
		const enrollmentId = randomUUID();
		const args = {
			enrollmentId,
			...value,
			stageId: stage?.id,
			nextMeetingAt: meeting,
		};
		const refusal = !p.published
			? `${p.name} has no published version yet. Its director publishes it from Programs before anyone is enrolled.`
			: duplicate
				? `${person.name} is already enrolled in ${p.name}. Each person can have one active enrollment per program.`
				: value.expectedEndOn < value.startedOn
					? "The expected end can't be before the start."
					: null;
		if (!refusal && !enrollRequest.safeParse(args).success) throw new EvryRefusal("invalid_input");
		return card(
			{
				target: {
					kind: "person",
					id: person.personId,
					label: person.name,
					href: enrollmentHref(enrollmentId),
				},
				changes: [
					{ field: "program", before: null, after: p.published ? `${p.name}, Version ${p.published.number}` : p.name },
					{ field: "cohort", before: null, after: value.cohort },
					{ field: "startedOn", before: null, after: dayText(value.startedOn) },
					{ field: "expectedEndOn", before: null, after: dayText(value.expectedEndOn) },
					{ field: "programStage", before: null, after: stage?.label ?? null },
					...(meeting ? [{ field: "nextMeeting", before: null, after: meetingText(meeting, p.timezone) }] : []),
				],
				notes: [
					"Their pipeline stage doesn't change. The enrollment stays on this version until the director applies a newer one.",
				],
				refusal,
			},
			args,
		);
	},
	reason: false,
	run: async (db, authority, args) => settled(await programWriter.enroll(db, authority, args)),
});

const directedEnrollment = async (
	db: Parameters<typeof readEnrollment>[0],
	authority: Parameters<typeof readEnrollment>[1],
	enrollmentId: string,
) => {
	const e = found(await readEnrollment(db, authority, { enrollmentId }));
	if (!e.viewer.director) throw new EvryRefusal("access_denied");
	return e;
};
const enrollmentTarget = (e: EnrollmentDetail): Card["target"] => ({
	kind: "person",
	id: e.person.personId,
	label: e.person.name,
	href: enrollmentHref(e.id),
});
const closed = (e: EnrollmentDetail) =>
	e.status === "active"
		? null
		: `${e.person.name}'s enrollment in ${e.program.name} has ended as ${ENROLLMENT_STATUS[e.status]}, so it can't change.`;

const updateInput = z
	.strictObject({
		enrollmentId: rowId,
		changes: z
			.strictObject({
				cohort: z.string().trim().min(1).max(80).optional(),
				expectedEndOn: dayInput.optional(),
				stageId: rowId.optional(),
				nextMeetingAt: localTimeInput.nullable().optional(),
			})
			.refine((c) => Object.keys(c).length > 0, "empty changes")
			.optional(),
		outcome: enrollmentOutcome.optional(),
	})
	.refine((v) => (v.changes === undefined) !== (v.outcome === undefined), "changes or outcome, not both");

function endReview(e: EnrollmentDetail, outcome: z.infer<typeof enrollmentOutcome>) {
	return card(
		{
			target: enrollmentTarget(e),
			changes: [{ field: "status", before: ENROLLMENT_STATUS.active, after: ENROLLMENT_STATUS[outcome] }],
			notes: [`${e.program.name}, Version ${e.versionNumber}.`, ...ENROLLMENT_END_NOTES],
			refusal: closed(e),
		},
		{ enrollmentId: e.id, expectedRevision: e.revision, outcome },
	);
}

export const updateEnrollment = approvedNow({
	operation: "development.updateEnrollment",
	description:
		"Propose changing one active enrollment the user directs (enrollmentId from development.readProgram): only the fields named, of its cohort, expected end date, program stage (stageId, a stage row of that enrollment's own version) and next meeting (a local date and time in the organization's time zone, or null to clear it). Its version, finished milestones and the person's pipeline stage stay. Or, with outcome instead of changes, end it as completed or withdrawn; it can't be reopened. Nothing changes until the user approves",
	input: updateInput,
	allowed: organizationSeat,
	async review(actor, value, { db }) {
		const e = await directedEnrollment(db, actor.authority, value.enrollmentId);
		if (value.outcome) return endReview(e, value.outcome);
		const c = value.changes ?? {};
		const stage = c.stageId ? e.stages.find((s) => s.id === c.stageId) : e.stage;
		if (!stage) throw new EvryRefusal("invalid_input");
		const program = found(await readProgram(db, actor.authority, { programId: e.program.id }));
		const end = c.expectedEndOn ?? e.expectedEndOn;
		const before = e.nextMeeting ? meetingText(e.nextMeeting.at, e.nextMeeting.timezone) : null;
		const changes = [
			...changed("cohort", e.cohort, c.cohort ?? e.cohort),
			...changed("expectedEndOn", dayText(e.expectedEndOn), dayText(end)),
			...changed("programStage", e.stage.label, stage.label),
			...changed(
				"nextMeeting",
				before,
				c.nextMeetingAt === undefined ? before : meetingText(c.nextMeetingAt, program.timezone),
			),
		];
		return card(
			{
				target: enrollmentTarget(e),
				changes,
				notes: [
					`${e.program.name}, Version ${e.versionNumber}. The version, finished milestones and their pipeline stage stay as they are.`,
				],
				refusal:
					closed(e) ??
					(end < e.startedOn
						? `The expected end can't be before the start, ${dayText(e.startedOn)}.`
						: changes.length
							? null
							: "The enrollment already says this, so nothing would change."),
			},
			{ enrollmentId: e.id, expectedRevision: e.revision, changes: c },
		);
	},
	reason: false,
	run: async (db, authority, args) =>
		settled(
			await ("outcome" in args
				? programWriter.endEnrollment(db, authority, args)
				: programWriter.updateEnrollment(db, authority, args)),
		),
});

const applyInput = z.strictObject({ enrollmentId: rowId, stageId: rowId.optional() });

export const applyVersion = approvedNow({
	operation: "development.applyVersion",
	description:
		"Propose moving one enrollment the user directs (enrollmentId from development.readProgram) to the program's current published version. The card lists the added, removed and changed milestones and the new program stage: the matching one, or stageId, a stage of the published version, when the user names another. Finished milestones are kept. Nothing changes until the user approves",
	input: applyInput,
	allowed: organizationSeat,
	async review(actor, value, { db }) {
		const e = await directedEnrollment(db, actor.authority, value.enrollmentId);
		const refusal =
			closed(e) ??
			(e.newerVersion ? null : `${e.person.name} is already on Version ${e.versionNumber}, the current one.`);
		if (refusal) return card({ target: enrollmentTarget(e), changes: [], refusal }, { enrollmentId: e.id });
		const r = found(await readVersionReview(db, actor.authority, { enrollmentId: e.id }));
		const stage = r.stages.find((s) => s.id === (value.stageId ?? r.stageId));
		if (!stage) throw new EvryRefusal("invalid_input");
		const titles = (ms: readonly { title: string; finished: boolean }[]) =>
			ms.map((m) => (m.finished ? `${m.title} (finished)` : m.title));
		const work = (m: (typeof r.added)[number]) =>
			[m.title, m.handsOn ? "hands-on assignment" : null, m.description].filter(Boolean).join(", ");
		return card(
			{
				target: enrollmentTarget(e),
				changes: [
					{ field: "programVersion", before: `Version ${r.fromNumber}`, after: `Version ${r.toNumber}` },
					{ field: "programStage", before: r.stage, after: stage.label },
					...(r.added.length ? [{ field: "addedMilestones", before: null, after: titles(r.added) }] : []),
					...(r.changed.length
						? [
								{
									field: "changedMilestones",
									before: r.changed.map((c) => work(c.before)),
									after: r.changed.map((c) => work(c.after)),
								},
							]
						: []),
					...(r.removed.length ? [{ field: "removedMilestones", before: titles(r.removed), after: null }] : []),
				],
				notes: [
					r.carried.length
						? `Finished work kept: ${r.carried.join("; ")}.`
						: "No finished milestone carries over, because none is finished yet.",
					`Only ${r.name} changes version. Finished work on removed milestones stays in their record.`,
				],
			},
			{ enrollmentId: e.id, versionId: r.versionId, stageId: stage.id, basis: r.basis },
		);
	},
	reason: false,
	run: async (db, authority, args) => settled(await programWriter.applyVersion(db, authority, args)),
});

const milestoneOf = (e: EnrollmentDetail, milestoneId: string) => {
	const m = e.milestones.find((x) => x.id === milestoneId);
	if (!m) throw new EvryRefusal("not_found");
	return m;
};

export const confirmMilestone = approvedNow({
	operation: "development.confirmMilestone",
	description:
		"Propose confirming one milestone the linked resident marked done and shares (its progress says Waiting for confirmation), by enrollmentId and milestoneId from development.readProgram. Only the program's current director. Nothing changes until the user approves",
	input: z.strictObject({ enrollmentId: rowId, milestoneId: rowId }),
	allowed: organizationSeat,
	async review(actor, value, { db }) {
		const e = await directedEnrollment(db, actor.authority, value.enrollmentId);
		const m = milestoneOf(e, value.milestoneId);
		const c = m.completion;
		const refusal =
			closed(e) ??
			(e.resident.status === "not_linked"
				? `${e.person.name} has no linked account, so there is nothing to confirm. Record the milestone as finished instead.`
				: e.resident.milestones === "not_shared"
					? `${e.person.name} doesn't share milestone progress, so there is nothing to confirm here.`
					: !c
						? `${e.person.name} hasn't marked this milestone done yet. They mark it on My residency.`
						: c.confirmedOn !== null
							? "This milestone is already confirmed."
							: null);
		return card(
			{
				target: enrollmentTarget(e),
				changes: [
					{ field: "milestone", before: null, after: m.title },
					{
						field: "milestoneProgress",
						before: c && c.confirmedOn === null ? `Marked done ${dayText(c.completedOn)}` : null,
						after: "Confirmed by you",
					},
				],
				notes: [`${e.program.name}, Version ${e.versionNumber}.`],
				refusal,
			},
			value,
		);
	},
	reason: false,
	run: async (db, authority, args) => settled(await programWriter.confirmMilestone(db, authority, args)),
});

export const completeMilestone = approvedNow({
	operation: "development.completeMilestone",
	description:
		"Propose recording one milestone as finished for someone with no linked account, by enrollmentId and milestoneId from development.readProgram, with the day they finished it (a local date, today or earlier; ask when the user gave none). A linked resident marks their own milestones on My residency. Only the program's current director. Nothing changes until the user approves",
	input: z.strictObject({ enrollmentId: rowId, milestoneId: rowId, completedOn: dayInput }),
	allowed: organizationSeat,
	async review(actor, value, { db }) {
		const e = await directedEnrollment(db, actor.authority, value.enrollmentId);
		const m = milestoneOf(e, value.milestoneId);
		const refusal =
			closed(e) ??
			(e.resident.status === "linked"
				? `${e.person.name} has a linked account, so they mark this milestone themselves on My residency.`
				: m.completion?.confirmedOn
					? "This milestone is already recorded as finished."
					: value.completedOn > e.today
						? "The finish date can't be after today."
						: null);
		return card(
			{
				target: enrollmentTarget(e),
				changes: [
					{ field: "milestone", before: null, after: m.title },
					{
						field: "milestoneProgress",
						before: "Not finished",
						after: `Finished ${dayText(value.completedOn)}`,
					},
				],
				notes: [
					`${e.program.name}, Version ${e.versionNumber}. It shows as recorded and confirmed by you, the program leader.`,
				],
				refusal,
			},
			value,
		);
	},
	reason: false,
	run: async (db, authority, args) => settled(await programWriter.recordMilestone(db, authority, args)),
});

export const PIPELINE_COMMANDS = {
	"pipeline.proposeStageMove": proposeStageMove,
	"pipeline.saveGoal": saveGoal,
	"pipeline.saveStages": saveStages,
	"development.saveProgram": saveProgram,
	"development.draftNextVersion": draftNextVersion,
	"development.enroll": enroll,
	"development.updateEnrollment": updateEnrollment,
	"development.applyVersion": applyVersion,
	"development.confirmMilestone": confirmMilestone,
	"development.completeMilestone": completeMilestone,
} as const;
