import { z } from "zod";
import { correlationId, recordId, requestKey, revision } from "../common/values.ts";
import { instant, localDate } from "../common/time.ts";

// Manual signals and leadership-candidate attestations (WP-039 slice 2, REQ-PI-014, REQ-PI-015, REQ-TEAM-017, REQ-KNOW-050).
// An Owner or Admin of a church plant gives a dated statement. Requests name no author: the server takes it from the
// session. Optional fields are never required. Requests are strict.

/**
 * The seven manual signals in the order docs/reference/manual-signals.ts declares them. A test compares this list with
 * that file, so the two cannot drift. `reaffirms` signals go stale after the reaffirm window; the rest never expire.
 */
export const SIGNAL_DEFINITIONS = [
	{
		key: "values_documented",
		group: "foundations",
		label: "Core values documented",
		description: "Your plant's vision and values are written down and shared.",
		reaffirms: false,
	},
	{
		key: "financial_base_established",
		group: "generosity",
		label: "Launch funding viable",
		description: "Funds and support available now are enough to launch and sustain ministry.",
		reaffirms: false,
	},
	{
		key: "core_group_giving",
		group: "generosity",
		label: "Core group giving sacrificially",
		description: "People in your core group are learning to give sacrificially and regularly.",
		reaffirms: true,
	},
	{
		key: "prayer_leader_assigned",
		group: "prayer",
		label: "Prayer leader assigned",
		description: "Someone owns the prayer covering for the plant.",
		reaffirms: false,
	},
	{
		key: "prayer_rhythm_established",
		group: "prayer",
		label: "Corporate prayer rhythm established",
		description: "Your core group has a regular, recurring rhythm of praying together.",
		reaffirms: true,
	},
	{
		key: "prayer_in_gatherings",
		group: "prayer",
		label: "Prayer woven into gatherings",
		description: "Prayer is a regular part of core-group and leadership gatherings.",
		reaffirms: true,
	},
	{
		key: "systems_tested",
		group: "launch",
		label: "Launch systems tested",
		description: "Check-in, giving, and gathering logistics have a dry run.",
		reaffirms: false,
	},
] as const;
export const SIGNAL_KEYS = SIGNAL_DEFINITIONS.map((d) => d.key) as unknown as readonly [SignalKey, ...SignalKey[]];
export type SignalKey = (typeof SIGNAL_DEFINITIONS)[number]["key"];
export const signalKey = z.enum(SIGNAL_KEYS);
/** Days a reaffirming answer stays current, counted in the church's calendar days. */
export const REAFFIRM_WINDOW_DAYS = 30;
/** Days a candidate period must cover, both ends included. */
export const CANDIDATE_DAYS = 60;
/** The version of the question each revision records. */
export const SIGNAL_QUESTION_VERSION = "manual-signals/1";
export const CANDIDATE_QUESTION_VERSION = "leadership-candidate/1";
export const TEXT_MAX = 500;

/** The page's groups, in the prototype's order. */
export const SIGNAL_GROUPS = [
	{ id: "prayer", title: "Prayer" },
	{ id: "generosity", title: "Generosity and finance" },
	{ id: "launch", title: "Launch readiness" },
	{ id: "foundations", title: "Foundations" },
] as const;

export const signalValue = z.enum(["yes", "not_yet"]);
export type SignalValue = z.infer<typeof signalValue>;
/** Optional text: blank means none. */
const optionalText = z.string().max(TEXT_MAX).optional();
export const textOf = (raw: string | undefined) => raw?.trim() || null;

export const signalDefinition = z.strictObject({
	key: signalKey,
	label: z.string().min(1),
	description: z.string().min(1),
	reaffirms: z.boolean(),
	/** Days the answer stays current; null when it never expires. */
	windowDays: z.literal(REAFFIRM_WINDOW_DAYS).nullable(),
});
export type SignalDefinition = z.infer<typeof signalDefinition>;
export const listDefinitionsRequest = z.strictObject({});

/** A statement is true as of a date no later than today in the church's time zone; blank means today. */
const asOf = localDate.optional();
export const attestRequest = z.strictObject({
	requestKey,
	expectedRevision: revision,
	input: z.strictObject({ key: signalKey, value: signalValue, asOf, detail: optionalText, reference: optionalText }),
});
/** Correct a current answer to the other value, or retract it. */
export const correctSignalRequest = z.strictObject({
	requestKey,
	expectedRevision: revision,
	input: z.discriminatedUnion("action", [
		z.strictObject({
			action: z.literal("correct"),
			key: signalKey,
			value: signalValue,
			asOf,
			detail: optionalText,
			reference: optionalText,
		}),
		z.strictObject({ action: z.literal("retract"), key: signalKey }),
	]),
});
/** "Still true": names the revision and the answer the admin reviewed. */
export const reaffirmRequest = z.strictObject({
	requestKey,
	expectedRevision: revision,
	input: z.strictObject({ key: signalKey, expectedValue: signalValue }),
});
export const getHistoryRequest = z.strictObject({ key: signalKey.nullable() });
export const readAttestationsRequest = z.strictObject({});

export const attestCandidateRequest = z.strictObject({
	requestKey,
	expectedRevision: revision,
	input: z.strictObject({
		personId: recordId,
		periodStart: localDate,
		periodEnd: localDate,
		attended: z.boolean(),
		volunteered: z.boolean(),
		asOf,
		statement: optionalText,
	}),
});
export const correctCandidateRequest = z.strictObject({
	requestKey,
	expectedRevision: revision,
	input: z.discriminatedUnion("action", [
		z.strictObject({
			action: z.literal("correct"),
			personId: recordId,
			periodStart: localDate,
			periodEnd: localDate,
			attended: z.boolean(),
			volunteered: z.boolean(),
			asOf,
			statement: optionalText,
		}),
		z.strictObject({ action: z.literal("retract"), personId: recordId }),
	]),
});

/** What the admin sees about renewal. An unanswered or retracted signal is Unknown, never no. */
export const renewal = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("current"), daysLeft: z.int().min(0).max(REAFFIRM_WINDOW_DAYS) }),
	z.strictObject({ status: z.literal("needs_renewing") }),
	z.strictObject({ status: z.literal("does_not_expire") }),
	z.strictObject({ status: z.literal("unknown") }),
]);
export type Renewal = z.infer<typeof renewal>;

/** One signal as the page shows it. `revision` is what the next write names. */
export const signalEntry = z.strictObject({
	key: signalKey,
	state: z.enum(["answered", "retracted", "unanswered"]),
	/** The answer while the signal is answered; null once it is retracted or never answered (Unknown). */
	value: signalValue.nullable(),
	asOf: localDate.nullable(),
	detail: z.string().nullable(),
	reference: z.string().nullable(),
	authorName: z.string().nullable(),
	recordedAt: instant.nullable(),
	revision,
	/** Calendar days from the as-of date to today in the church's zone. */
	ageDays: z.int().min(0).nullable(),
	renewal,
});
export type SignalEntry = z.infer<typeof signalEntry>;

const DAY = 86_400_000;
/** Whole calendar days from `from` to `to`, both LocalDates. */
export const daysBetween = (from: string, to: string) =>
	Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / DAY);
/**
 * The renewal state of one signal. Only an answered signal has an age. The three reaffirming signals are current
 * through day 30 and need renewing from day 31, keeping their value. The others never expire. Unanswered and retracted
 * signals are Unknown, never no.
 */
export function renewalOf(
	key: SignalKey,
	state: "answered" | "retracted" | "unanswered",
	ageDays: number | null,
): Renewal {
	if (state !== "answered" || ageDays === null) return { status: "unknown" };
	if (!SIGNAL_DEFINITIONS.find((d) => d.key === key)!.reaffirms) return { status: "does_not_expire" };
	return ageDays <= REAFFIRM_WINDOW_DAYS
		? { status: "current", daysLeft: REAFFIRM_WINDOW_DAYS - ageDays }
		: { status: "needs_renewing" };
}
/** The page's counts over its seven entries: Current, Needs renewing and Not answered (unanswered or retracted). */
export function countsOf(entries: readonly SignalEntry[]): AttestationCounts {
	const answered = entries.filter((e) => e.state === "answered");
	const stale = answered.filter((e) => e.renewal.status === "needs_renewing").length;
	return { current: answered.length - stale, needsRenewing: stale, notAnswered: entries.length - answered.length };
}

export const candidateReason = z.enum(["attendance_not_attested", "volunteering_not_attested", "period_too_short"]);
export type CandidateReason = z.infer<typeof candidateReason>;

/** One revision of the human-evidence history. Candidate fields are null for a manual signal. */
export const humanRevision = z.strictObject({
	id: recordId,
	key: z.union([signalKey, z.literal("leadership_candidate")]),
	revision: z.int().min(1),
	kind: z.enum(["answered", "corrected", "retracted", "reaffirmed"]),
	value: signalValue.nullable(),
	asOf: localDate,
	detail: z.string().nullable(),
	reference: z.string().nullable(),
	personId: recordId.nullable(),
	personName: z.string().nullable(),
	periodStart: localDate.nullable(),
	periodEnd: localDate.nullable(),
	attended: z.boolean().nullable(),
	volunteered: z.boolean().nullable(),
	authorName: z.string().nullable(),
	recordedAt: instant,
	questionVersion: z.string().min(1),
});
export type HumanRevision = z.infer<typeof humanRevision>;
export const historyResult = z.strictObject({ revisions: z.array(humanRevision) });

/**
 * One leadership candidate: a live or retired Person with a dated attestation. Established only when every part holds.
 * A retired Person's row stays readable but takes no write: every candidate write for a retired Person refuses.
 */
export const candidateEntry = z.strictObject({
	personId: recordId,
	personName: z.string().min(1),
	personState: z.enum(["live", "retired"]),
	state: z.enum(["answered", "retracted"]),
	attended: z.boolean(),
	volunteered: z.boolean(),
	periodStart: localDate,
	periodEnd: localDate,
	/** Days the period covers, both ends included. */
	days: z.int().min(1),
	established: z.boolean(),
	reasons: z.array(candidateReason),
	asOf: localDate,
	statement: z.string().nullable(),
	authorName: z.string().nullable(),
	recordedAt: instant,
	revision,
});
export type CandidateEntry = z.infer<typeof candidateEntry>;

export const personOption = z.strictObject({
	id: recordId,
	displayName: z.string().min(1),
	/** The revision a candidate write names for this Person: 0 when there is no candidate row yet. */
	candidateRevision: revision,
});

export const attestationCounts = z.strictObject({
	current: z.int().min(0),
	needsRenewing: z.int().min(0),
	notAnswered: z.int().min(0),
});
export type AttestationCounts = z.infer<typeof attestationCounts>;

/** The Attestations page: the seven signals, the counts, the candidates and the Persons a candidate can be recorded for. */
export const attestationsPage = z.strictObject({
	zone: z.string().min(1),
	today: localDate,
	signals: z.array(signalEntry).length(SIGNAL_DEFINITIONS.length),
	counts: attestationCounts,
	candidates: z.array(candidateEntry),
	people: z.array(personOption),
	/** The whole history, newest first: the signals' and the candidates'. */
	history: z.array(humanRevision),
});
export type AttestationsPage = z.infer<typeof attestationsPage>;

export const signalWriteResult = z.strictObject({ outcome: z.literal("saved"), signal: signalEntry });
export type SignalWriteResult = z.infer<typeof signalWriteResult>;
export const candidateWriteResult = z.strictObject({ outcome: z.literal("saved"), candidate: candidateEntry });
export type CandidateWriteResult = z.infer<typeof candidateWriteResult>;

const error = <C extends string>(code: C, retry: "never" | "refresh") =>
	z.strictObject({ code: z.literal(code), details: z.strictObject({}), correlationId, retry: z.literal(retry) });
/**
 * Every refusal. `not_found` is the one answer for a missing, foreign or retired Person and for a foreign church. A
 * refusal never carries details.
 */
export const signalError = z.discriminatedUnion("code", [
	error("invalid_input", "never"),
	error("access_denied", "never"),
	error("not_found", "never"),
	error("idempotency_conflict", "never"),
	error("revision_conflict", "refresh"),
	/** The correction names the value the signal already has. */
	error("no_change", "never"),
	/** There is no current answer to correct, retract or reaffirm. */
	error("not_current", "refresh"),
	/** "Still true" is only for the three signals that go stale. */
	error("not_reaffirmable", "never"),
]);
export type SignalError = z.infer<typeof signalError>;
export type SignalReply<T> = { status: "ok"; value: T } | { status: "refused"; error: SignalError };
