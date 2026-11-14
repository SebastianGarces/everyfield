import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { programKind, programPlan, programRhythm, type ProgramDetail } from "@everyfield/contracts/organizations";
import type { RequestActor } from "@everyfield/domain/access";
import { pipelineWriter, programWriter, readProgram } from "@everyfield/domain/organizations";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import type { EffectResult, ReviewedWrite } from "../../../proposals/types.ts";
import { change, organizationAdmin, organizationSeat, target } from "../../native.ts";

// The pipeline and program reviewed writes (WP-101). The model proposes only identities and a plan; a person approves
// the exact card. Each runs the native pipeline or program command the Pipeline and Programs pages run, once, in the
// approval request (approveNow): those commands take the organization's write gate themselves. Both are an Owner's or
// Admin's, as natively, except a program's next version, which only its current director drafts, whatever their role.
// Evry never logs a conversation, writes a note or a reason, records a milestone, publishes or enrolls (REQ-MUL-015).

/** A native pipeline or program reply as an effect result: its new revision, or the domain's refusal code. */
const settled = (
	reply: { status: "ok"; value: { revision: string } } | { status: "refused"; refusal: { code: string } },
) => (reply.status === "ok" ? { revision: reply.value.revision } : { refused: reply.refusal.code });

/** A reviewed write that runs in the approval request; the job path never reaches it. */
function approvedNow<I>(spec: {
	operation: string;
	description: string;
	input: z.ZodType<I>;
	/** Who may propose it: an Owner or Admin unless set. */
	allowed?: (actor: EvryActor) => boolean;
	review: ReviewedWrite<I>["review"];
	reason: boolean;
	run(
		db: Database,
		authority: RequestActor,
		args: Record<string, unknown>,
		reason: string | null,
	): Promise<EffectResult>;
	current?(p: SQL): SQL;
}): ReviewedWrite<I> {
	return {
		operation: spec.operation,
		description: spec.description,
		input: spec.input,
		allowed: spec.allowed ?? organizationAdmin,
		review: spec.review,
		execute: async () => ({ refused: "review_closed" }),
		approveNow: {
			reason: spec.reason,
			run: (db, authority, args, reason) => spec.run(db, authority, args as Record<string, unknown>, reason),
		},
		...(spec.current && { current: spec.current }),
	};
}

export const proposeStageMove = approvedNow({
	operation: "pipeline.proposeStageMove",
	description:
		"Propose moving one person in this organization's pipeline to another stage: only the person (personId) and the destination stage (stageId), both from pipeline.listPeople. It takes no reason, note or other text: the user types the reason on the review card, and Evry never sees it. Nothing changes until the user approves",
	// Identities only (REQ-MUL-015): a reason, note or any other field is refused.
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
	// A move refused because the person moved since the review: where they are now.
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
	/** A seat row's id from development.draftPlan. */
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
const monthsText = (n: number) => `${n} ${n === 1 ? "month" : "months"}`;
const rangeText = (min: number, max: number) => (min === max ? monthsText(min) : `${min}–${monthsText(max)}`);

export const saveProgram = approvedNow({
	operation: "development.saveProgram",
	description:
		"Propose creating one program from a drafted plan: kind, name, director (a seat id from development.draftPlan), expected length, rhythm, stages and milestones. It is saved as an unpublished draft: nothing is published and no one is enrolled, and only the director publishes it from Programs. Nothing changes until the user approves",
	input: planInput,
	review(actor, value) {
		// The native request, with the ids it names once: a repeated approval creates no second program.
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
					${after("expectedLength", monthsText(value.expectedMonths))},${after("rhythm", RHYTHM_TEXT[value.rhythm])},
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
	/** A program row's id from development.readProgram. */
	programId: z.uuid(),
	plan: z.strictObject({
		rhythm: programRhythm,
		expectedMonths: z.int().min(1).max(120),
		stages: planInput.shape.stages,
		milestones: z
			.array(
				z.strictObject({
					/** A milestone the plan keeps names its lineage from development.readProgram; a new one has none. */
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

/**
 * The review of a director's next plan against the plan it starts from (the draft in progress, else the published
 * version): each change, then what stays. Pure, so the eval and unit tests read the same card the panel shows.
 */
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
		// The draft keeps the reading list of the plan it starts from: Evry never edits a reading list.
		readings: base.readings.map((r) => ({ revisionId: r.revisionId })),
	});
	if (!plan.success) throw new EvryRefusal("invalid_input");
	const kept = milestones.filter((m) => byLineage.has(m.lineage));
	const edited = kept.filter((m) => {
		const was = byLineage.get(m.lineage)!;
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
						before: monthsText(base.expectedMonths),
						after: monthsText(value.plan.expectedMonths),
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
						before: edited.map((m) => byLineage.get(m.lineage)!.title),
						after: edited.map((m) => m.title),
					},
				]
			: []),
		...(removed.length ? [{ field: "removedMilestones", before: removed.map((m) => m.title), after: null }] : []),
		...(reordered
			? [
					{
						field: "milestoneOrder",
						before: keptOrder.map((l) => byLineage.get(l)!.title),
						after: kept.map((m) => m.title),
					},
				]
			: []),
	];
	const same = kept.filter((m) => !edited.includes(m)).map((m) => m.title);
	const stays = [
		...(base.rhythm === value.plan.rhythm ? [`Meets: ${RHYTHM_TEXT[base.rhythm]}`] : []),
		...(base.expectedMonths === value.plan.expectedMonths
			? [`Expected length: ${monthsText(base.expectedMonths)}`]
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
	// Natively only the current director saves a plan, whatever their role: the review refuses anyone else.
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

/** The installed pipeline and program reviewed writes, keyed by operation. */
export const PIPELINE_COMMANDS = {
	"pipeline.proposeStageMove": proposeStageMove,
	"development.saveProgram": saveProgram,
	"development.draftNextVersion": draftNextVersion,
} as const;
