import { localDate } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/launch";
import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import type { RequestActor } from "@everyfield/domain/access";
import { createLaunchReader, createLaunchWriter } from "@everyfield/domain/launch";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import type { EffectResult, NativePorts, ReviewContext, ReviewedWrite } from "../../../proposals/types.ts";
import { plantAdmin } from "../../native.ts";
import { launchDay } from "../reads/index.ts";

// The Launch reviewed writes (WP-076). The model only proposes; a person approves the exact card. Each review reads
// the plan through the Launch plan's own read and saves the native command's request with the revision it showed. On
// approval the executor runs that same command once, in its transaction, under the approving session's live seat, with
// the effect key as the request key; a plan that changed since refuses (conflict) and the card shows Launch Sunday as it
// is now. None of them moves a prep task, the church's phase, sends anything or creates a person (INH-LAUNCH-04/05).
// Owners and Admins only, as on the Launch plan. Completing a milestone (T-382) notifies the church's other Owners and
// Admins through the deployment's Launch notices, as the Launch plan does; no other write here notifies anyone.

const reader = createLaunchReader();
const writer = createLaunchWriter({ notices: async () => undefined });

type Change = { field: string; before: unknown; after: unknown };
type Prepared = { label?: string; changes: Change[]; notes?: string[]; refusal?: string | null; args: object };
const TARGET_LABEL = "Launch plan";

/** The words the Launch plan uses for a refused reason (launch/model.ts NOTE_MESSAGE). */
const NOTE_REFUSAL: Record<c.NoteProblem, string> = {
	empty: "A reason is needed. Tell Evry why, and it stays in the Launch history.",
	too_long: "Keep the reason to 2,000 characters or fewer.",
};
const OUTCOME_REFUSAL: Record<c.OutcomeProblem, string> = {
	date_in_future: "Launch Sunday can't be recorded for a date after today.",
	count_out_of_range: "Counts are whole numbers from 0 to 1,000,000.",
	note_too_long: "Keep the note to 10,000 characters or fewer.",
};
const DEBRIEF_REFUSAL: Record<c.DebriefProblem, string> = {
	guest_answer_needed: "Answer the guest question to submit: were there guests not entered by name?",
	guest_count_needed: "Say how many guests aren't entered by name yet.",
	count_out_of_range: "Use a whole number from 1 to 1,000,000.",
	too_long: "Keep each answer to 10,000 characters or fewer.",
};
/** Launch Sunday as the plan states it now. */
const plannedText = (plan: c.Plan) =>
	plan.launch?.status === "postponed"
		? "Postponed"
		: plan.launch?.targetDate
			? launchDay(plan.launch.targetDate)
			: null;
const guestAnswer = (a: Pick<c.DebriefAnswers, "missingNames" | "missingCount">) =>
	a.missingNames === "yes" ? `Yes, ${a.missingCount ?? "?"}` : a.missingNames === "no" ? "No" : null;
const UNCHANGED = "Prep task due dates, assignees and statuses stay as they are, and so does the church's phase.";

/**
 * One Launch reviewed write. `prepare` decides the card from the plan as the Launch plan reads it now; `run` is the
 * native command. The review is one SELECT of literal values: the plan was read just before, under the same live seat
 * that prepareProposal checks again in its own statement.
 */
function launchWrite<I>(spec: {
	operation: string;
	description: string;
	input: z.ZodType<I>;
	/** The card, or null when what it would change is not on the plan. */
	prepare(plan: c.Plan, input: I): Prepared | null;
	run(
		tx: Database,
		authority: RequestActor,
		args: Record<string, unknown>,
		key: string,
		ports: NativePorts | null,
	): Promise<EffectResult>;
	/** The records a refusal shows as they are now: Launch Sunday unless the write names others. */
	current?: (p: SQL) => SQL;
}): ReviewedWrite<I> {
	return {
		operation: spec.operation,
		description: spec.description,
		input: spec.input,
		allowed: plantAdmin,
		async review(actor: EvryActor, input: I, context: ReviewContext) {
			const reply = await reader.readPlan(context.db, actor.authority);
			if (reply.status !== "ok") return null;
			const plan = reply.value.plan;
			const p = spec.prepare(plan, input);
			if (!p) return null;
			const review = {
				target: { kind: "church", id: actor.owner.id, label: p.label ?? TARGET_LABEL },
				changes: p.changes,
				...(p.notes?.length && { notes: p.notes }),
				...(p.refusal && { refusal: p.refusal }),
			};
			return sql`SELECT ${JSON.stringify(review)}::jsonb AS review, ${JSON.stringify(p.args)}::jsonb AS args`;
		},
		async execute(tx, _context, args, effectKey, _reminders, native) {
			// The Launch commands open their own transaction; inside the executor's it is a savepoint of it.
			return spec.run(
				tx as unknown as Database,
				native.authority,
				args as Record<string, unknown>,
				effectKey,
				native.ports,
			);
		},
		current: spec.current ?? launchSundayNow,
	};
}
/** A plan that changed since the review: Launch Sunday as it is now. */
const launchSundayNow = (
	p: SQL,
) => sql`(SELECT jsonb_build_array(jsonb_build_object('id',${p}.tenant_id,'label','Launch Sunday',
			'value',CASE WHEN l.status='postponed' THEN 'Postponed' WHEN l.status='completed' THEN 'Launched'
				WHEN l.target_date IS NULL THEN 'No date set' ELSE trim(to_char(l.target_date,'Dy, Mon FMDD, YYYY')) END))
			FROM plant x LEFT JOIN launch l ON l.plant_id=x.id WHERE x.id=${p}.tenant_id)`;

/** A native Launch reply as an effect result: the plan's new revision, or the domain's refusal code. */
const settled = (reply: c.LaunchReply<c.PlanResult>): EffectResult =>
	reply.status === "ok" ? { revision: reply.value.plan.revision } : { refused: reply.error.code };

export const schedule = launchWrite({
	operation: "launch.schedule",
	description:
		"Propose setting or moving Launch Sunday to a church-local date (YYYY-MM-DD), with the user's reason in their own words. Moving a scheduled date needs a reason (at most 2,000 characters). Prep task due dates, assignees and statuses and the church's phase never change. Nothing changes until the user approves",
	input: z.strictObject({ date: localDate, reason: z.string().max(4000).nullable() }),
	prepare(plan, input) {
		const status = plan.launch?.status ?? "planning";
		const moving = status === "scheduled";
		const note = c.checkNote(input.reason, moving);
		const refusal =
			status === "completed"
				? "Launch Sunday is already recorded, so its date can't move."
				: moving && plan.launch?.targetDate === input.date
					? `Launch Sunday is already ${launchDay(input.date)}.`
					: !note.ok
						? NOTE_REFUSAL[note.problem]
						: null;
		return {
			changes: [
				{ field: "launchDate", before: plannedText(plan), after: launchDay(input.date) },
				{ field: "reason", before: null, after: note.ok ? note.note : (input.reason ?? null) },
			],
			notes: [UNCHANGED],
			refusal,
			args: {
				expectedRevision: plan.launch?.revision ?? plan.revision,
				input: { date: input.date, reason: input.reason },
			},
		};
	},
	run: async (db, authority, args, key) => settled(await writer.schedule(db, authority, { ...args, requestKey: key })),
});

export const postpone = launchWrite({
	operation: "launch.postpone",
	description:
		"Propose postponing Launch Sunday, with the user's reason in their own words (needed, at most 2,000 characters). The planned date is cleared and the Launch plan shows Postponed with no countdown; history keeps the former date. Nothing changes until the user approves",
	input: z.strictObject({ reason: z.string().max(4000) }),
	prepare(plan, input) {
		const status = plan.launch?.status ?? "planning";
		const note = c.checkNote(input.reason, true);
		const refusal =
			status === "postponed"
				? "The launch is already postponed."
				: status !== "scheduled"
					? "There's no scheduled Launch Sunday to postpone."
					: !note.ok
						? NOTE_REFUSAL[note.problem]
						: null;
		return {
			changes: [
				{ field: "launchDate", before: plannedText(plan), after: "Postponed" },
				{ field: "reason", before: null, after: note.ok ? note.note : input.reason },
			],
			notes: [UNCHANGED],
			refusal,
			args: { expectedRevision: plan.launch?.revision ?? plan.revision, input: { reason: input.reason } },
		};
	},
	run: async (db, authority, args, key) => settled(await writer.postpone(db, authority, { ...args, requestKey: key })),
});

const count = z.int().min(0).max(c.COUNT_MAX);
const EMPTY_ANSWERS: c.DebriefAnswers = {
	wentWell: null,
	toChange: null,
	operations: null,
	followUpPlan: null,
	supportNeeded: null,
	missingNames: null,
	missingCount: null,
};
/** The debrief version a write starts from: the draft being written, else the latest submission, else empty. */
const baseAnswers = (plan: c.Plan) => plan.debrief?.draft?.answers ?? plan.debrief?.submitted?.answers ?? EMPTY_ANSWERS;
/** The fence of the draft the page would hold: its id and revision, or none and "0". */
const draftFence = (draft: { id: string; revision: string } | null | undefined) => ({
	draftId: draft?.id ?? null,
	expectedRevision: draft?.revision ?? "0",
});

const outcomeInput = z.strictObject({
	/** The church-local date Launch Sunday happened (YYYY-MM-DD); the planned date when left out and not after today. */
	actualDate: localDate.optional(),
	attendance: count.nullable(),
	decisions: count.nullable().optional(),
	/** Guests who came but were not entered by name: 0 answers the debrief's guest question No. */
	guestsNotNamed: count.nullable().optional(),
});
export const recordOutcome = launchWrite({
	operation: "launch.recordOutcome",
	description: `Propose recording what happened on Launch Sunday: the actual date (the planned date when left out), attendance and decisions as counted, and optionally guestsNotNamed, the answer to the debrief's guest question ("${c.GUEST_QUESTION}"; 0 is No), saved as the debrief draft. It creates no person from any number. Nothing changes until the user approves`,
	input: outcomeInput,
	prepare(plan, input) {
		const planned = plan.launch?.targetDate;
		const actualDate = input.actualDate ?? (planned && planned <= plan.today ? planned : plan.today);
		const value = { actualDate, attendance: input.attendance, decisions: input.decisions ?? null, note: null };
		const checked = c.checkOutcome(value, plan.today);
		const guests = input.guestsNotNamed;
		const answers =
			guests === undefined || guests === null
				? null
				: {
						...baseAnswers(plan),
						missingNames: guests > 0 ? ("yes" as const) : ("no" as const),
						missingCount: guests > 0 ? guests : null,
					};
		const refusal = plan.outcome
			? "Launch Sunday is already recorded. Correct it on the Launch plan."
			: !checked.ok
				? OUTCOME_REFUSAL[checked.problem]
				: null;
		const changes: Change[] = [
			{ field: "actualDate", before: null, after: launchDay(actualDate) },
			{ field: "attendance", before: null, after: input.attendance },
			...(input.decisions !== undefined ? [{ field: "decisions", before: null, after: input.decisions }] : []),
			...(answers
				? [{ field: "guestAnswer", before: guestAnswer(baseAnswers(plan)), after: guestAnswer(answers) }]
				: []),
		];
		return {
			changes,
			notes: [
				"No people are created from these numbers. Name guests on the Launch plan.",
				...(answers ? [`The guest answer is saved in the debrief draft: ${c.GUEST_QUESTION}`] : []),
				"The planned date, prep tasks and the church's phase stay as they are.",
			],
			refusal,
			args: {
				record: { expectedRevision: plan.launch?.revision ?? plan.revision, input: value },
				debrief: answers && { ...draftFence(plan.debrief?.draft), answers },
			},
		};
	},
	async run(db, authority, args, key) {
		const a = z
			.object({
				record: z.record(z.string(), z.unknown()),
				debrief: z
					.object({ draftId: z.string().nullable(), expectedRevision: z.string(), answers: z.unknown() })
					.nullable(),
			})
			.parse(args);
		const recorded = settled(await writer.recordOutcome(db, authority, { ...a.record, requestKey: key }));
		if ("refused" in recorded || !a.debrief) return recorded;
		// The guest answer is saved as the debrief draft in the same transaction: a refusal undoes the outcome too.
		const { expectedRevision, ...input } = a.debrief;
		return settled(
			await writer.saveDebriefDraft(db, authority, { requestKey: `${key}:debrief`, expectedRevision, input }),
		);
	},
});

const answer = z.string().max(c.ANSWER_MAX).nullable().optional();
const debriefInput = z.strictObject({
	wentWell: answer,
	toChange: answer,
	operations: answer,
	followUpPlan: answer,
	supportNeeded: answer,
	/** The guest question: guests not entered by name; 0 is No. Left out keeps the draft's answer. */
	guestsNotNamed: count.nullable().optional(),
});
export const submitDebrief = launchWrite({
	operation: "launch.submitDebrief",
	description:
		"Propose submitting the Launch debrief: the saved draft's answers, with any area the user gives in their own words (wentWell, toChange, operations, followUpPlan, supportNeeded) and guestsNotNamed (0 is No) replacing the draft's. Submitting needs the guest answer, publishes nothing and copies nothing into the summary. Nothing changes until the user approves",
	input: debriefInput,
	prepare(plan, input) {
		const base = baseAnswers(plan);
		const guests = input.guestsNotNamed;
		const merged: c.DebriefAnswers = {
			...base,
			...Object.fromEntries(c.WRITTEN_AREAS.flatMap((k) => (input[k] !== undefined ? [[k, input[k]]] : []))),
			...(guests !== undefined &&
				guests !== null && { missingNames: guests > 0 ? "yes" : "no", missingCount: guests > 0 ? guests : null }),
		};
		const checked = c.checkDebrief(merged, true);
		const refusal = !plan.outcome
			? "Record Launch Sunday first: the debrief follows the recorded outcome."
			: !checked.ok
				? DEBRIEF_REFUSAL[checked.problem]
				: null;
		const answers = checked.ok ? checked.answers : merged;
		return {
			changes: [
				{ field: "guestAnswer", before: null, after: guestAnswer(answers) },
				...c.WRITTEN_AREAS.map((k) => ({ field: k, before: null, after: answers[k] })),
			],
			notes: [
				plan.debrief?.submitted
					? `This is a corrected version; version ${plan.debrief.submitted.version} stays in history.`
					: "This submits the debrief.",
				"Submitting publishes nothing. Your sending church and network see only a summary you publish.",
			],
			refusal,
			args: { ...draftFence(plan.debrief?.draft), answers },
		};
	},
	async run(db, authority, args, key) {
		const { expectedRevision, ...input } = args as { expectedRevision: string } & Record<string, unknown>;
		return settled(await writer.submitDebrief(db, authority, { requestKey: key, expectedRevision, input }));
	},
});

export const publishDebriefSummary = launchWrite({
	operation: "launch.publishDebriefSummary",
	description: `Propose publishing the Launch summary for the church's sending church and network: body is the exact text they will see (at most ${c.SUMMARY_MAX.toLocaleString("en-US")} characters), published word for word as the next version. It needs a submitted debrief. Nothing is sent, and nothing changes until the user approves`,
	input: z.strictObject({ body: z.string().max(c.SUMMARY_MAX * 2) }),
	prepare(plan, input) {
		const checked = c.checkSummary(input.body);
		const body = checked.ok ? checked.body : input.body;
		const refusal = !plan.evidence.submittedAt
			? "Submit the debrief first: the summary is published after it."
			: !checked.ok
				? checked.problem === "empty"
					? "Write the summary before you publish it."
					: "Keep the summary to 4,000 characters or fewer."
				: null;
		return {
			changes: [{ field: "summary", before: plan.summary?.published[0]?.body ?? null, after: body }],
			notes: [
				"This is the exact text your sending church and network will see. Earlier versions stay.",
				"Nothing is emailed, and no task, contact or phase changes.",
			],
			refusal,
			args: { ...draftFence(plan.summary?.draft), body },
		};
	},
	async run(db, authority, args, key) {
		const { expectedRevision, ...input } = args as { expectedRevision: string } & Record<string, unknown>;
		return settled(await writer.publishDebriefSummary(db, authority, { requestKey: key, expectedRevision, input }));
	},
});

/** A milestone as the Launch plan marks it: complete, needs review (a task complete at completion was reopened), or not. */
const milestoneState = (m: c.Milestone) =>
	!m.completion ? "Not complete" : m.needsReview ? "Needs review" : "Complete";
const OPEN_TASK = (t: c.PrepTask) => t.status !== "complete" && t.status !== "no_longer_needed";
/** The day of an instant in the church's time zone, as the Launch plan's history says it: "Oct 10, 2026". */
const dayIn = (at: string, timeZone: string) =>
	new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(new Date(at));
/**
 * A milestone card refused because the milestone or its linked tasks changed since the review: the milestone and each
 * of its live linked prep tasks as they are now, as the Launch plan lists them (LCH-004 stale_review).
 */
const milestoneNow = (p: SQL) => sql`(SELECT jsonb_build_array(jsonb_build_object('id',m.id,'label',m.title,'value',
	CASE WHEN m.completed_at IS NULL THEN 'Not complete' WHEN EXISTS(SELECT FROM task r WHERE r.id=ANY(m.completed_task_ids)
		AND r.plant_id=m.plant_id AND r.deleted_at IS NULL AND r.status NOT IN ('complete','no_longer_needed'))
		THEN 'Needs review' ELSE 'Complete' END))
	|| coalesce((SELECT jsonb_agg(jsonb_build_object('id',k.id,'label',k.title,'value',CASE k.status WHEN 'not_started' THEN 'Not started'
		WHEN 'in_progress' THEN 'In progress' WHEN 'blocked' THEN 'Blocked' WHEN 'complete' THEN 'Complete'
		ELSE 'No longer needed' END)
		ORDER BY split_part(k.launch_task_key,'/',2)::int,k.id) FROM task k WHERE k.plant_id=m.plant_id
		AND k.deleted_at IS NULL AND split_part(k.launch_task_key,'/',1)=m.template_key),'[]'::jsonb)
	FROM launch_milestone m WHERE m.id=(${p}.input->'input'->>'milestoneId')::uuid AND m.plant_id=${p}.tenant_id)`;

const milestoneInput = z.strictObject({
	/** The milestone row's id from launch.readWorkspace. */
	milestoneId: z.uuid(),
});
type MilestoneInput = z.infer<typeof milestoneInput>;
const KEPT_TASKS = "Its prep tasks' statuses, due dates and assignees stay as they are.";

export const completeMilestone = launchWrite({
	operation: "launch.completeMilestone",
	description:
		"Propose marking one Launch readiness milestone complete, by its milestone row id from launch.readWorkspace. A milestone can be completed while linked prep tasks are still open: they stay open, and the card says how many. Completing a milestone that needs review confirms the earlier completion. Prep tasks never change. Guest data entered and Debrief done follow the submitted debrief and are never completed by hand. Nothing changes until the user approves",
	input: milestoneInput,
	prepare(plan, input: MilestoneInput) {
		const m = plan.milestones.find((x) => x.id === input.milestoneId);
		if (!m) return null;
		const open = m.tasks.filter(OPEN_TASK);
		const earlier = m.completion && m.needsReview ? m.completion : null;
		return {
			label: m.title,
			changes: [{ field: "milestone", before: milestoneState(m), after: "Complete" }],
			notes: [
				open.length
					? `${open.length} of its ${m.tasks.length} prep tasks ${open.length === 1 ? "is still open and stays" : "are still open and stay"} open: ${open.map((t) => t.title).join("; ")}.`
					: "Every prep task linked to it is done.",
				...(earlier
					? [
							`This confirms the earlier completion${earlier.by ? ` by ${earlier.by.displayName}` : ""} on ${dayIn(earlier.at, plan.timeZone)}. A prep task that was complete then has been reopened since.`,
						]
					: []),
				KEPT_TASKS,
			],
			refusal: m.completion && !m.needsReview ? "This milestone is already complete." : null,
			args: { expectedRevision: m.revision, input: { milestoneId: m.id, reviewed: c.reviewedOf(m.tasks) } },
		};
	},
	async run(db, authority, args, key, ports) {
		// The Launch plan tells the church's other Owners and Admins; a server that can't tell them saves nothing.
		const notices = ports?.launchNotices;
		if (!notices) return { refused: "source_unavailable" };
		const w = createLaunchWriter({ notices });
		const reply = await w.completeMilestone(db, authority, { ...args, requestKey: key });
		return reply.status === "ok" ? { revision: reply.value.milestone.revision } : { refused: reply.error.code };
	},
	current: milestoneNow,
});

export const reopenMilestone = launchWrite({
	operation: "launch.reopenMilestone",
	description:
		"Propose reopening one completed Launch readiness milestone, by its milestone row id from launch.readWorkspace. Its prep tasks stay as they are, and the earlier completion stays in Launch history. Guest data entered and Debrief done follow the submitted debrief and are never reopened by hand. Nothing changes until the user approves",
	input: milestoneInput,
	prepare(plan, input: MilestoneInput) {
		const m = plan.milestones.find((x) => x.id === input.milestoneId);
		if (!m) return null;
		return {
			label: m.title,
			changes: [{ field: "milestone", before: milestoneState(m), after: "Not complete" }],
			notes: [KEPT_TASKS, "The earlier completion stays in Launch history."],
			refusal: m.completion ? null : "This milestone isn't complete, so there's nothing to reopen.",
			args: { expectedRevision: m.revision, input: { milestoneId: m.id } },
		};
	},
	async run(db, authority, args, key) {
		const reply = await writer.reopenMilestone(db, authority, { ...args, requestKey: key });
		return reply.status === "ok" ? { revision: reply.value.milestone.revision } : { refused: reply.error.code };
	},
	current: milestoneNow,
});

/** The installed Launch reviewed writes, keyed by operation. */
export const LAUNCH_COMMANDS = {
	"launch.schedule": schedule,
	"launch.postpone": postpone,
	"launch.recordOutcome": recordOutcome,
	"launch.submitDebrief": submitDebrief,
	"launch.publishDebriefSummary": publishDebriefSummary,
	"launch.completeMilestone": completeMilestone,
	"launch.reopenMilestone": reopenMilestone,
} as const;
