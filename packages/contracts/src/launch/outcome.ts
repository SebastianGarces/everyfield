import { z } from "zod";
import { accountId, recordId, requestKey, revision } from "../common/values.ts";
import { instant, localDate, type LocalDate } from "../common/time.ts";

export const COUNT_MAX = 1_000_000;
export const OUTCOME_NOTE_MAX = 10_000;
export const ANSWER_MAX = 10_000;
export const SUMMARY_MAX = 4_000;
export const GUEST_NAME_MAX = 255;
export const GUEST_QUESTION =
	"Was there anyone that visited as a guest and has not been entered by name into our People CRM?";

const person = z.strictObject({ accountId, displayName: z.string() });
const count = z.int().min(0).max(COUNT_MAX);
const blankable = (v: string | null) => {
	const t = (v ?? "").trim();
	return t ? t : null;
};

export const outcomeProblem = z.enum(["date_in_future", "count_out_of_range", "note_too_long"]);
export type OutcomeProblem = z.infer<typeof outcomeProblem>;
export type OutcomeInput = {
	actualDate: string;
	attendance: number | null;
	decisions: number | null;
	note: string | null;
};
export function checkOutcome(
	input: OutcomeInput,
	today: LocalDate,
): { ok: true; value: OutcomeInput } | { ok: false; problem: OutcomeProblem } {
	if (input.actualDate > today) return { ok: false, problem: "date_in_future" };
	for (const n of [input.attendance, input.decisions])
		if (n !== null && !count.safeParse(n).success) return { ok: false, problem: "count_out_of_range" };
	const note = blankable(input.note);
	if (note && note.length > OUTCOME_NOTE_MAX) return { ok: false, problem: "note_too_long" };
	return { ok: true, value: { ...input, note } };
}

export const debriefAnswers = z.strictObject({
	wentWell: z.string().nullable(),
	toChange: z.string().nullable(),
	operations: z.string().nullable(),
	followUpPlan: z.string().nullable(),
	supportNeeded: z.string().nullable(),
	missingNames: z.enum(["yes", "no"]).nullable(),
	missingCount: z.int().nullable(),
});
export type DebriefAnswers = z.infer<typeof debriefAnswers>;
export const WRITTEN_AREAS = ["wentWell", "toChange", "operations", "followUpPlan", "supportNeeded"] as const;
export const debriefProblem = z.enum(["guest_answer_needed", "guest_count_needed", "count_out_of_range", "too_long"]);
export type DebriefProblem = z.infer<typeof debriefProblem>;
export function checkDebrief(
	raw: DebriefAnswers,
	submit: boolean,
): { ok: true; answers: DebriefAnswers } | { ok: false; problem: DebriefProblem } {
	const answers = { ...raw };
	for (const k of WRITTEN_AREAS) {
		answers[k] = blankable(raw[k]);
		if ((answers[k]?.length ?? 0) > ANSWER_MAX) return { ok: false, problem: "too_long" };
	}
	if (answers.missingNames !== "yes") answers.missingCount = null;
	if (answers.missingCount !== null && (answers.missingCount < 1 || answers.missingCount > COUNT_MAX))
		return { ok: false, problem: "count_out_of_range" };
	if (submit && !answers.missingNames) return { ok: false, problem: "guest_answer_needed" };
	if (submit && answers.missingNames === "yes" && answers.missingCount === null)
		return { ok: false, problem: "guest_count_needed" };
	return { ok: true, answers };
}

export const summaryProblem = z.enum(["empty", "too_long"]);
export type SummaryProblem = z.infer<typeof summaryProblem>;
export function checkSummary(raw: string): { ok: true; body: string } | { ok: false; problem: SummaryProblem } {
	const body = raw.trim();
	if (!body) return { ok: false, problem: "empty" };
	if (body.length > SUMMARY_MAX) return { ok: false, problem: "too_long" };
	return { ok: true, body };
}

const envelope = { requestKey, expectedRevision: revision };
const outcomeInput = {
	actualDate: localDate,
	attendance: z.int().nullable(),
	decisions: z.int().nullable(),
	note: z.string().nullable(),
};
export const recordOutcomeRequest = z.strictObject({ ...envelope, input: z.strictObject(outcomeInput) });
export const correctOutcomeRequest = z.strictObject({
	...envelope,
	input: z.strictObject({ ...outcomeInput, reason: z.string() }),
});
export const addGuestRequest = z.strictObject({
	requestKey,
	input: z.union([z.strictObject({ personId: recordId }), z.strictObject({ displayName: z.string() })]),
});
export const debriefRequest = z.strictObject({
	...envelope,
	input: z.strictObject({ draftId: recordId.nullable(), answers: debriefAnswers }),
});
export const summaryRequest = z.strictObject({
	...envelope,
	input: z.strictObject({ draftId: recordId.nullable(), body: z.string() }),
});

export const outcome = z.strictObject({
	actualDate: localDate,
	attendance: count.nullable(),
	decisions: count.nullable(),
	note: z.string().nullable(),
	recordedAt: instant,
	recordedBy: person.nullable(),
});
export type Outcome = z.infer<typeof outcome>;
export const namedGuest = z.strictObject({
	guestId: recordId,
	personId: recordId,
	displayName: z.string(),
	recordedAt: instant,
});
export type NamedGuest = z.infer<typeof namedGuest>;
export const guests = z.strictObject({
	count: z.int().min(0),
	named: z.array(namedGuest).nullable(),
});
export const debriefVersion = z.strictObject({
	id: recordId,
	version: z.int().min(1),
	revision,
	answers: debriefAnswers,
	savedAt: instant,
	savedBy: person.nullable(),
	submittedAt: instant.nullable(),
	submittedBy: person.nullable(),
});
export type DebriefVersion = z.infer<typeof debriefVersion>;
export const debrief = z.strictObject({
	draft: debriefVersion.nullable(),
	submitted: debriefVersion.nullable(),
});
export type Debrief = z.infer<typeof debrief>;

export const evidenceStatus = z.enum(["met", "not_met", "unknown"]);
export type EvidenceStatus = z.infer<typeof evidenceStatus>;
export const DERIVED_MILESTONES = ["guest_data_entered", "debrief_done"] as const;
export const derivedMilestone = z.enum(DERIVED_MILESTONES);
export const evidence = z.strictObject({
	guestNamesEntered: z.strictObject({ status: evidenceStatus, remaining: z.int().min(1).nullable() }),
	debriefDone: z.strictObject({ status: z.enum(["met", "unknown"]) }),
	submittedAt: instant.nullable(),
});
export type Evidence = z.infer<typeof evidence>;
export function evidenceOf(
	submitted: { answers: DebriefAnswers; submittedAt: string | null } | null,
): z.input<typeof evidence> {
	if (!submitted)
		return {
			guestNamesEntered: { status: "unknown", remaining: null },
			debriefDone: { status: "unknown" },
			submittedAt: null,
		};
	const yes = submitted.answers.missingNames === "yes";
	return {
		guestNamesEntered: yes
			? { status: "not_met", remaining: submitted.answers.missingCount }
			: { status: "met", remaining: null },
		debriefDone: { status: "met" },
		submittedAt: submitted.submittedAt,
	};
}

export const summaryDraft = z.strictObject({ id: recordId, revision, body: z.string(), savedAt: instant });
export const publishedSummary = z.strictObject({
	id: recordId,
	version: z.int().min(1),
	body: z.string(),
	publishedAt: instant,
	publishedBy: person.nullable(),
});
export type PublishedSummary = z.infer<typeof publishedSummary>;
export const summary = z.strictObject({
	draft: summaryDraft.nullable(),
	published: z.array(publishedSummary),
});
export type Summary = z.infer<typeof summary>;

export const guestMatch = z.strictObject({
	personId: recordId,
	displayName: z.string(),
	detail: z.string(),
	alreadyGuest: z.boolean(),
});
export type GuestMatch = z.infer<typeof guestMatch>;

export const outcomeField = z.enum(["actualDate", "attendance", "decisions", "note"]);
export type OutcomeField = z.infer<typeof outcomeField>;
const value = z.union([z.string(), z.int(), z.null()]);
export const historyChange = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("date"),
		event: z.enum(["scheduled", "moved", "postponed", "rescheduled"]),
		from: localDate.nullable(),
		to: localDate.nullable(),
		reason: z.string().nullable(),
	}),
	z.strictObject({ kind: z.literal("milestone"), event: z.enum(["completed", "reopened"]), title: z.string() }),
	z.strictObject({
		kind: z.literal("outcome"),
		event: z.enum(["recorded", "corrected"]),
		changes: z.array(z.strictObject({ field: outcomeField, before: value, after: value })),
		reason: z.string().nullable(),
	}),
	z.strictObject({ kind: z.literal("guest"), name: z.string().nullable(), added: z.boolean() }),
	z.strictObject({ kind: z.literal("debrief"), event: z.enum(["submitted", "corrected"]), version: z.int() }),
	z.strictObject({ kind: z.literal("summary"), version: z.int() }),
	z.strictObject({
		kind: z.literal("path"),
		to: z.enum(["launch_sunday", "milestone"]),
		milestone: z.string().nullable(),
		organization: z.string().nullable(),
	}),
	z.strictObject({
		kind: z.literal("gathering"),
		event: z.enum(["recorded", "corrected", "cleared"]),
		name: z.string(),
		from: localDate.nullable(),
		to: localDate.nullable(),
		noteChanged: z.boolean(),
		reason: z.string().nullable(),
	}),
]);
export type HistoryChange = z.infer<typeof historyChange>;
export const historyEntry = z.strictObject({
	id: recordId,
	at: instant,
	actor: person.nullable(),
	change: historyChange,
});
export type HistoryEntry = z.infer<typeof historyEntry>;
export const history = z.strictObject({ timeZone: z.string(), entries: z.array(historyEntry) });
export type History = z.infer<typeof history>;

export const sharedSummary = z.strictObject({ version: z.int().min(1), body: z.string(), publishedAt: instant });
export type SharedSummary = z.infer<typeof sharedSummary>;
