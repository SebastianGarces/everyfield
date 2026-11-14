import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { programKind, programPlan, programRhythm } from "@everyfield/contracts/organizations";
import type { RequestActor } from "@everyfield/domain/access";
import { pipelineWriter, programWriter } from "@everyfield/domain/organizations";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import type { EffectResult, ReviewedWrite } from "../../../proposals/types.ts";
import { change, organizationAdmin, target } from "../../native.ts";

// The pipeline and program reviewed writes (WP-101). The model proposes only identities and a plan; a person approves
// the exact card. Each runs the native pipeline or program command the Pipeline and Programs pages run, once, in the
// approval request (approveNow): those commands take the organization's write gate themselves. Both are an Owner's or
// Admin's, as natively. Evry never logs a conversation, writes a note or a reason, records a milestone, publishes or
// enrolls (REQ-MUL-015).

/** A native pipeline or program reply as an effect result: its new revision, or the domain's refusal code. */
const settled = (
	reply: { status: "ok"; value: { revision: string } } | { status: "refused"; refusal: { code: string } },
) => (reply.status === "ok" ? { revision: reply.value.revision } : { refused: reply.refusal.code });

/** A reviewed write that runs in the approval request; the job path never reaches it. */
function approvedNow<I>(spec: {
	operation: string;
	description: string;
	input: z.ZodType<I>;
	review(actor: EvryActor, input: I): SQL;
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
		allowed: organizationAdmin,
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

/** The installed pipeline and program reviewed writes, keyed by operation. */
export const PIPELINE_COMMANDS = {
	"pipeline.proposeStageMove": proposeStageMove,
	"development.saveProgram": saveProgram,
} as const;
