import { z } from "zod";
import { defineSafeError, recordId, requestKey, revision, type Reply } from "../common/values.ts";
import { instant, localDate } from "../common/time.ts";

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
export const REAFFIRM_WINDOW_DAYS = 30;
export const CANDIDATE_DAYS = 60;
export const SIGNAL_QUESTION_VERSION = "manual-signals/1";
export const CANDIDATE_QUESTION_VERSION = "leadership-candidate/1";
export const TEXT_MAX = 500;

export const SIGNAL_GROUPS = [
	{ id: "prayer", title: "Prayer" },
	{ id: "generosity", title: "Generosity and finance" },
	{ id: "launch", title: "Launch readiness" },
	{ id: "foundations", title: "Foundations" },
] as const;

export const signalValue = z.enum(["yes", "not_yet"]);
export type SignalValue = z.infer<typeof signalValue>;
const optionalText = z.string().max(TEXT_MAX).optional();
export const textOf = (raw: string | undefined) => raw?.trim() || null;

export const signalDefinition = z.strictObject({
	key: signalKey,
	label: z.string().min(1),
	description: z.string().min(1),
	reaffirms: z.boolean(),
	windowDays: z.literal(REAFFIRM_WINDOW_DAYS).nullable(),
});
export type SignalDefinition = z.infer<typeof signalDefinition>;
export const listDefinitionsRequest = z.strictObject({});

const asOf = localDate.optional();
export const attestRequest = z.strictObject({
	requestKey,
	expectedRevision: revision,
	input: z.strictObject({ key: signalKey, value: signalValue, asOf, detail: optionalText, reference: optionalText }),
});
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

export const renewal = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("current"), daysLeft: z.int().min(0).max(REAFFIRM_WINDOW_DAYS) }),
	z.strictObject({ status: z.literal("needs_renewing") }),
	z.strictObject({ status: z.literal("does_not_expire") }),
	z.strictObject({ status: z.literal("unknown") }),
]);
export type Renewal = z.infer<typeof renewal>;

export const signalEntry = z.strictObject({
	key: signalKey,
	state: z.enum(["answered", "retracted", "unanswered"]),
	value: signalValue.nullable(),
	asOf: localDate.nullable(),
	detail: z.string().nullable(),
	reference: z.string().nullable(),
	authorName: z.string().nullable(),
	recordedAt: instant.nullable(),
	revision,
	ageDays: z.int().min(0).nullable(),
	renewal,
});
export type SignalEntry = z.infer<typeof signalEntry>;

const DAY = 86_400_000;
export const daysBetween = (from: string, to: string) =>
	Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / DAY);
export function renewalOf(
	key: SignalKey,
	state: "answered" | "retracted" | "unanswered",
	ageDays: number | null,
): Renewal {
	if (state !== "answered" || ageDays === null) return { status: "unknown" };
	const definition = SIGNAL_DEFINITIONS.find((d) => d.key === key);
	if (!definition) throw Error("unknown_signal");
	if (!definition.reaffirms) return { status: "does_not_expire" };
	return ageDays <= REAFFIRM_WINDOW_DAYS
		? { status: "current", daysLeft: REAFFIRM_WINDOW_DAYS - ageDays }
		: { status: "needs_renewing" };
}
export function countsOf(entries: readonly SignalEntry[]): AttestationCounts {
	const answered = entries.filter((e) => e.state === "answered");
	const stale = answered.filter((e) => e.renewal.status === "needs_renewing").length;
	return { current: answered.length - stale, needsRenewing: stale, notAnswered: entries.length - answered.length };
}

export const candidateReason = z.enum(["attendance_not_attested", "volunteering_not_attested", "period_too_short"]);
export type CandidateReason = z.infer<typeof candidateReason>;

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

export const candidateEntry = z.strictObject({
	personId: recordId,
	personName: z.string().min(1),
	personState: z.enum(["live", "retired"]),
	state: z.enum(["answered", "retracted"]),
	attended: z.boolean(),
	volunteered: z.boolean(),
	periodStart: localDate,
	periodEnd: localDate,
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
	candidateRevision: revision,
});

export const attestationCounts = z.strictObject({
	current: z.int().min(0),
	needsRenewing: z.int().min(0),
	notAnswered: z.int().min(0),
});
export type AttestationCounts = z.infer<typeof attestationCounts>;

export const attestationsPage = z.strictObject({
	zone: z.string().min(1),
	today: localDate,
	signals: z.array(signalEntry).length(SIGNAL_DEFINITIONS.length),
	counts: attestationCounts,
	candidates: z.array(candidateEntry),
	people: z.array(personOption),
	history: z.array(humanRevision),
});
export type AttestationsPage = z.infer<typeof attestationsPage>;

export const signalWriteResult = z.strictObject({ outcome: z.literal("saved"), signal: signalEntry });
export type SignalWriteResult = z.infer<typeof signalWriteResult>;
export const candidateWriteResult = z.strictObject({ outcome: z.literal("saved"), candidate: candidateEntry });
export type CandidateWriteResult = z.infer<typeof candidateWriteResult>;

export const signalError = z.discriminatedUnion("code", [
	defineSafeError("invalid_input", {}, "never"),
	defineSafeError("access_denied", {}, "never"),
	defineSafeError("not_found", {}, "never"),
	defineSafeError("idempotency_conflict", {}, "never"),
	defineSafeError("revision_conflict", {}, "refresh"),
	defineSafeError("no_change", {}, "never"),
	defineSafeError("not_current", {}, "refresh"),
	defineSafeError("not_reaffirmable", {}, "never"),
]);
export type SignalError = z.infer<typeof signalError>;
export type SignalReply<T> = Reply<T, SignalError>;
