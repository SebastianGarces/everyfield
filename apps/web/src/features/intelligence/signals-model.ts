import {
	CANDIDATE_DAYS,
	CANDIDATE_QUESTION_VERSION,
	countsOf,
	daysBetween,
	renewalOf,
	SIGNAL_DEFINITIONS,
	SIGNAL_QUESTION_VERSION,
	type AttestationsPage,
	type CandidateEntry,
	type CandidateReason,
	type HumanRevision,
	type Renewal,
	type SignalEntry,
	type SignalError,
	type SignalKey,
	type SignalValue,
} from "@everyfield/contracts/intelligence";
import { shortDate } from "./model.ts";

// The Attestations page's pure model: labels, dates, messages and the optimistic page. No React and no server code, so
// the UI tests call it directly.

/** A server action's answer: the operation's reply, or "lost" when no database answer came back. */
export type SignalOutcome<T> =
	{ status: "ok"; value: T } | { status: "refused"; error: SignalError } | { status: "lost" };

export const VALUE_LABEL: Record<SignalValue, string> = { yes: "Yes", not_yet: "Not yet" };
export const definitionOf = (key: SignalKey) => SIGNAL_DEFINITIONS.find((d) => d.key === key)!;
export const signalsIn = (page: AttestationsPage, group: string) =>
	page.signals.filter((s) => definitionOf(s.key).group === group);

/** "Yes", "Not yet", "Retracted" or "Not answered". Retracted and Not answered are both Unknown, never no. */
export function answerLabel(entry: SignalEntry) {
	if (entry.state === "answered") return VALUE_LABEL[entry.value!];
	return entry.state === "retracted" ? "Retracted" : "Not answered";
}
/** "today", "1 day ago" or "34 days ago". */
export const agoText = (days: number) => (days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`);
/** The renewal badge text: how many days remain, or that the answer needs renewing or never expires. */
export function renewalLabel(renewal: Renewal) {
	switch (renewal.status) {
		case "current":
			return `Current for ${renewal.daysLeft} more day${renewal.daysLeft === 1 ? "" : "s"}`;
		case "needs_renewing":
			return "Needs renewing";
		case "does_not_expire":
			return "Does not expire";
		case "unknown":
			return "Unknown";
	}
}
export const renewalStatus = (renewal: Renewal) =>
	({ current: "positive", needs_renewing: "attention", does_not_expire: "plain", unknown: "unknown" })[
		renewal.status
	] as "positive" | "attention" | "plain" | "unknown";
/** What a row's button says: answer it, update it or renew it. */
export function actionLabel(entry: SignalEntry) {
	if (entry.state !== "answered") return "Answer";
	return entry.renewal.status === "needs_renewing" ? "Renew" : "Update";
}
/** The attention count on the Attestations tab: answers to renew and signals nobody answered. */
export const attentionCount = (page: AttestationsPage) => page.counts.needsRenewing + page.counts.notAnswered;

/** An entry as the admin has just stated it, before the server confirms. */
export function stated(
	entry: SignalEntry,
	change: { value: SignalValue; asOf: string; detail: string; reference: string },
	today: string,
	authorName: string | null,
): SignalEntry {
	const age = Math.max(0, daysBetween(change.asOf, today));
	return {
		...entry,
		state: "answered",
		value: change.value,
		asOf: change.asOf as SignalEntry["asOf"],
		detail: change.detail.trim() || null,
		reference: change.reference.trim() || null,
		authorName,
		recordedAt: new Date().toISOString() as SignalEntry["recordedAt"],
		revision: String(BigInt(entry.revision) + 1n) as SignalEntry["revision"],
		ageDays: age,
		renewal: renewalOf(entry.key, "answered", age),
	};
}
/** An entry as a retraction leaves it: Retracted, which reads as Unknown. */
export function retracted(entry: SignalEntry, authorName: string | null): SignalEntry {
	return {
		...entry,
		state: "retracted",
		value: null,
		detail: null,
		reference: null,
		authorName,
		recordedAt: new Date().toISOString() as SignalEntry["recordedAt"],
		revision: String(BigInt(entry.revision) + 1n) as SignalEntry["revision"],
		ageDays: null,
		renewal: { status: "unknown" },
	};
}
/** An entry after "Still true": the same answer, as of today. */
export function reaffirmed(entry: SignalEntry, today: string, authorName: string | null): SignalEntry {
	return stated(
		entry,
		{ value: entry.value!, asOf: today, detail: entry.detail ?? "", reference: entry.reference ?? "" },
		today,
		authorName,
	);
}

/** The page with one signal replaced and the counts recomputed. */
export function withSignal(page: AttestationsPage, entry: SignalEntry): AttestationsPage {
	const signals = page.signals.map((s) => (s.key === entry.key ? entry : s));
	return { ...page, signals, counts: countsOf(signals) };
}
/** The history line a confirmed write adds at the top. */
export function historyLine(entry: SignalEntry, kind: HumanRevision["kind"], value: SignalValue | null): HumanRevision {
	return {
		id: crypto.randomUUID() as HumanRevision["id"],
		key: entry.key,
		revision: Number(entry.revision),
		kind,
		value,
		asOf: entry.asOf!,
		detail: entry.detail,
		reference: entry.reference,
		personId: null,
		personName: null,
		periodStart: null,
		periodEnd: null,
		attended: null,
		volunteered: null,
		authorName: entry.authorName,
		recordedAt: entry.recordedAt!,
		questionVersion: SIGNAL_QUESTION_VERSION,
	};
}
export const withHistory = (page: AttestationsPage, line: HumanRevision): AttestationsPage => ({
	...page,
	history: [line, ...page.history],
});
export const historyOf = (page: AttestationsPage, key: SignalKey) =>
	page.history.filter((h) => h.key === key && h.personId === null);

const KIND_LABEL: Record<HumanRevision["kind"], string> = {
	answered: "Answered",
	corrected: "Corrected",
	retracted: "Retracted",
	reaffirmed: "Still true",
};
/** "Yes · Weekly, Thursday evenings" for a history line; a retraction names itself. */
export function historyText(line: HumanRevision) {
	if (line.key === "leadership_candidate") {
		const days = daysBetween(line.periodStart!, line.periodEnd!) + 1;
		return `${KIND_LABEL[line.kind]} · ${shortDate(line.periodStart!)} to ${shortDate(line.periodEnd!)} · ${days} days`;
	}
	if (line.kind === "retracted") return "Retracted";
	const head = line.kind === "reaffirmed" ? "Still true" : line.kind === "corrected" ? "Corrected to" : "Answered";
	const value = line.value ? VALUE_LABEL[line.value] : "";
	return [head === "Still true" ? `Still true · ${value}` : `${head} ${value}`, line.detail]
		.filter(Boolean)
		.join(" · ");
}

/** A dialog draft. `asOf` stays a LocalDate string so the date input and the request agree. */
export type Draft = { value: SignalValue | null; asOf: string; detail: string; reference: string };
export const draftOf = (entry: SignalEntry, today: string): Draft => ({
	value: entry.value,
	asOf: today,
	detail: entry.detail ?? "",
	reference: entry.reference ?? "",
});
/** The date a draft states: the typed one, or today when the field is cleared, as the server dates it. */
export const statedAsOf = (draft: Draft, today: string) => draft.asOf || today;
/** A signal answer's request input. A cleared date is left out, never sent as "", so the server dates it today. */
export const signalInput = (key: SignalKey, value: SignalValue, draft: Draft) => ({
	key,
	value,
	asOf: draft.asOf || undefined,
	detail: draft.detail,
	reference: draft.reference,
});
/** What saving a draft would do for this entry, or why it cannot yet. */
export function intent(entry: SignalEntry, draft: Draft): "attest" | "correct" | "none" {
	if (!draft.value) return "none";
	if (entry.state !== "answered") return "attest";
	return draft.value === entry.value ? "none" : "correct";
}

/** What a refusal means for the admin, in words. */
export function refusalText(error: SignalError | null): string {
	switch (error?.code) {
		case "revision_conflict":
			return "This signal changed in another window or by another admin. Reload the page to see the latest answer, then try again.";
		case "no_change":
			return "That is the answer it already has. Choose the other answer to correct it, or use Still true.";
		case "not_current":
			return "There is no current answer to change. Reload the page to see where it stands.";
		case "not_reaffirmable":
			return "Only the three monthly answers can be renewed with Still true.";
		case "not_found":
			return "That person is not in your church's current list.";
		case "invalid_input":
			return "Check the dates. A statement cannot be dated in the future, and a period must end on or before its as-of date.";
		case "access_denied":
			return "Your seat no longer includes attestations. Only an Owner or Admin of a church plant can answer them.";
		case "idempotency_conflict":
			return "This save was sent twice with different answers. Save again.";
		default:
			return "Everyfield could not be reached, so this may not have saved. What you typed is still here. Save again.";
	}
}

/** Days a candidate period covers, both ends included; 0 while a date is missing or the order is wrong. */
export function periodDays(start: string, end: string) {
	if (!start || !end || start > end) return 0;
	return daysBetween(start, end) + 1;
}
/** Why a candidate is or is not established, as the draft stands. */
export function draftReasons(d: { start: string; end: string; attended: boolean; volunteered: boolean }) {
	const reasons: CandidateReason[] = [];
	if (!d.attended) reasons.push("attendance_not_attested");
	if (!d.volunteered) reasons.push("volunteering_not_attested");
	if (periodDays(d.start, d.end) < CANDIDATE_DAYS) reasons.push("period_too_short");
	return reasons;
}
export const REASON_TEXT: Record<CandidateReason, string> = {
	attendance_not_attested: "Attendance is not attested",
	volunteering_not_attested: "Volunteering is not attested",
	period_too_short: `The period is shorter than ${CANDIDATE_DAYS} days`,
};
/** "Aug 15 to Oct 13 · 60 days" */
export const periodText = (c: Pick<CandidateEntry, "periodStart" | "periodEnd" | "days">) =>
	`${shortDate(c.periodStart)} to ${shortDate(c.periodEnd)} · ${c.days} days`;

/** The page with one candidate replaced, added or (when retracted) kept as Retracted. */
export function withCandidate(page: AttestationsPage, entry: CandidateEntry): AttestationsPage {
	const known = page.candidates.some((c) => c.personId === entry.personId);
	const candidates = known
		? page.candidates.map((c) => (c.personId === entry.personId ? entry : c))
		: [entry, ...page.candidates];
	return {
		...page,
		candidates,
		people: page.people.map((p) => (p.id === entry.personId ? { ...p, candidateRevision: entry.revision } : p)),
	};
}
export function candidateLine(entry: CandidateEntry, kind: HumanRevision["kind"]): HumanRevision {
	return {
		id: crypto.randomUUID() as HumanRevision["id"],
		key: "leadership_candidate",
		revision: Number(entry.revision),
		kind,
		value: null,
		asOf: entry.asOf,
		detail: entry.statement,
		reference: null,
		personId: entry.personId,
		personName: entry.personName,
		periodStart: entry.periodStart,
		periodEnd: entry.periodEnd,
		attended: entry.attended,
		volunteered: entry.volunteered,
		authorName: entry.authorName,
		recordedAt: entry.recordedAt,
		questionVersion: CANDIDATE_QUESTION_VERSION,
	};
}
