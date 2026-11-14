import { z } from "zod";
import { accountId, recordId, requestKey, revision } from "../common/values.ts";
import { instant, localDate, type LocalDate } from "../common/time.ts";

// What happened on Launch Sunday (WP-046: LCH-002, 006, 007, 010, REQ-KNOW-112/114): the recorded outcome, the guests a
// planter named, the six-area debrief, the summary they publish and Launch history. The planned date stays on the plan;
// nothing here moves it, moves the phase, creates a meeting or sends anything.

/** Counts are whole numbers from 0 to 1,000,000. An empty count is Not recorded; 0 is 0. */
export const COUNT_MAX = 1_000_000;
export const OUTCOME_NOTE_MAX = 10_000;
export const ANSWER_MAX = 10_000;
/** The published summary is short, written by the planter for their sending church or network. */
export const SUMMARY_MAX = 4_000;
export const GUEST_NAME_MAX = 255;
/** The debrief's single guest question, word for word (launch.md "Formal debrief and criterion evidence"). */
export const GUEST_QUESTION =
	"Was there anyone that visited as a guest and has not been entered by name into our People CRM?";

const person = z.strictObject({ accountId, displayName: z.string() });
const count = z.int().min(0).max(COUNT_MAX);
const blankable = (v: string | null) => {
	const t = (v ?? "").trim();
	return t ? t : null;
};

/** Why a recorded outcome was refused, so the form can say it next to the field. */
export const outcomeProblem = z.enum(["date_in_future", "count_out_of_range", "note_too_long"]);
export type OutcomeProblem = z.infer<typeof outcomeProblem>;
export type OutcomeInput = {
	actualDate: string;
	attendance: number | null;
	decisions: number | null;
	note: string | null;
};
/** The outcome as saved (note trimmed, blank to null), or the problem with it. `today` is the church-local date. */
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
/** The five written areas, in the order the debrief asks them. The first area is the recorded Launch Sunday. */
export const WRITTEN_AREAS = ["wentWell", "toChange", "operations", "followUpPlan", "supportNeeded"] as const;
export const debriefProblem = z.enum(["guest_answer_needed", "guest_count_needed", "count_out_of_range", "too_long"]);
export type DebriefProblem = z.infer<typeof debriefProblem>;
/**
 * The answers as saved, or the problem with them. A draft may leave anything empty. A submission needs only the guest
 * answer, and a Yes needs how many (at least 1). No area has a minimum length. No asks nothing more, so a count sent
 * with No is dropped.
 */
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
/** The summary exactly as it will be published (trimmed), or the problem with it. Nothing is removed from it. */
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
/** Record what actually happened on Launch Sunday. `expectedRevision` is the plan's revision. */
export const recordOutcomeRequest = z.strictObject({ ...envelope, input: z.strictObject(outcomeInput) });
/** Correct the recorded outcome with a reason; the earlier values stay in Launch history. */
export const correctOutcomeRequest = z.strictObject({
	...envelope,
	input: z.strictObject({ ...outcomeInput, reason: z.string() }),
});
/** Name a guest: pick an existing Person of the church, or type a name to add a new one. Never both. */
export const addGuestRequest = z.strictObject({
	requestKey,
	input: z.union([z.strictObject({ personId: recordId }), z.strictObject({ displayName: z.string() })]),
});
/**
 * Save or submit the debrief. `draftId` is the draft the page holds (null when it holds none) and `expectedRevision`
 * its revision ("0" without a draft), so a second tab's save is refused rather than overwritten.
 */
export const debriefRequest = z.strictObject({
	...envelope,
	input: z.strictObject({ draftId: recordId.nullable(), answers: debriefAnswers }),
});
/** Save or publish the summary, with the same draft fence. Publishing sends exactly `body`. */
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
	/** Null when the account that recorded it has since been deleted. */
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
	/** Guests named, live People only: a retired or merged-away Person leaves the roster. */
	count: z.int().min(0),
	/** The names, for Owners and Admins; null for a Member, who sees only the count. */
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
	/** The latest submitted version: the one evidence reads, whatever a later draft says. */
	submitted: debriefVersion.nullable(),
	submissions: z.int().min(0),
});
export type Debrief = z.infer<typeof debrief>;

export const evidenceStatus = z.enum(["met", "not_met", "unknown"]);
export type EvidenceStatus = z.infer<typeof evidenceStatus>;
/** The two evidence-governed milestones. They have no manual checkbox: only a submitted debrief decides them. */
export const DERIVED_MILESTONES = ["guest_data_entered", "debrief_done"] as const;
export const derivedMilestone = z.enum(DERIVED_MILESTONES);
export const evidence = z.strictObject({
	guestNamesEntered: z.strictObject({ status: evidenceStatus, remaining: z.int().min(1).nullable() }),
	debriefDone: z.strictObject({ status: z.enum(["met", "unknown"]) }),
	/** When the deciding debrief was submitted; null while there is none. */
	submittedAt: instant.nullable(),
});
export type Evidence = z.infer<typeof evidence>;
/**
 * guest_data_entered and debrief_done from the latest submitted answer (launch.md table): No is met, Yes with a count
 * is not met with that many remaining, and no submission is unknown for both. Naming guests later never changes it.
 */
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
	/** Published versions, newest first. The first is the one organizations read. */
	published: z.array(publishedSummary),
});
export type Summary = z.infer<typeof summary>;

/** A Person a typed guest name may be: the planter picks one or adds a new Person. Typing never links on its own. */
export const guestMatch = z.strictObject({
	personId: recordId,
	displayName: z.string(),
	detail: z.string(),
	alreadyGuest: z.boolean(),
});
export type GuestMatch = z.infer<typeof guestMatch>;

/** What one Launch history entry changed. Values that are the planter's own words (a note) are never repeated here. */
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
]);
export type HistoryChange = z.infer<typeof historyChange>;
export const historyEntry = z.strictObject({
	id: recordId,
	at: instant,
	/** Who made the change; null when their account has since been deleted ("a former account"). */
	actor: person.nullable(),
	change: historyChange,
});
export type HistoryEntry = z.infer<typeof historyEntry>;
export const history = z.strictObject({ timeZone: z.string(), entries: z.array(historyEntry) });
export type History = z.infer<typeof history>;

/** The summary an organization reads: the latest published version only, never a draft or a debrief answer. */
export const sharedSummary = z.strictObject({ version: z.int().min(1), body: z.string(), publishedAt: instant });
export type SharedSummary = z.infer<typeof sharedSummary>;
