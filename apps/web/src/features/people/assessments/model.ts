// Pure rules of the 4 C's, interview and commitment cards (REQ-PPL-012, 013, 014, 020, 026). No React and no server
// code, so the rules run the same in the browser, on the server and in node tests.
import type * as c from "@everyfield/contracts/people";
import type { z } from "zod";
import { STAGES, type Outcome, type StageValue } from "../model.ts";

export type Assessment = z.infer<typeof c.assessment>;
export type Interview = z.infer<typeof c.interview>;
export type Commitment = z.infer<typeof c.commitment>;
export type CommitmentStatus = z.infer<typeof c.commitmentStatus>;
export type FirstAcquisition = z.infer<typeof c.commitmentsResult>["firstAcquisition"];
export type Assessments = z.infer<typeof c.assessmentsResult>;
export type Interviews = z.infer<typeof c.interviewsResult>;
export type Commitments = z.infer<typeof c.commitmentsResult>;
export type RecordedPerson = z.infer<typeof c.recordedPerson>;
export type Lens = (typeof c.fourCs)[number];
export type CriterionKey = (typeof c.interviewCriteria)[number];
export type Rating = z.infer<typeof c.criterionRating>;
export type Result = z.infer<typeof c.interviewResult>;
export type Kind = z.infer<typeof c.commitmentKind>;

/** The three histories on the Person page. Null when that read was refused or failed; the card says so. */
export type PersonRecords = {
	assessments: Assessments | null;
	interviews: Interviews | null;
	commitments: Commitments | null;
};

export const LENSES: readonly Lens[] = ["committed", "compelled", "contagious", "courageous"];
export const LENS_LABEL: Record<Lens, string> = {
	committed: "Committed",
	compelled: "Compelled",
	contagious: "Contagious",
	courageous: "Courageous",
};
export const CRITERIA: readonly CriterionKey[] = ["maturity", "gifted", "chemistry", "rightReasons", "season"];
export const CRITERION_LABEL: Record<CriterionKey, string> = {
	maturity: "Maturity",
	gifted: "Giftedness",
	chemistry: "Chemistry",
	rightReasons: "Right reasons",
	season: "Season of life",
};
export const RATINGS: readonly Rating[] = ["pass", "concern", "fail"];
export const RATING_LABEL: Record<Rating, string> = { pass: "Pass", concern: "Concern", fail: "Fail" };
export const RESULTS: readonly Result[] = ["qualified", "qualified_with_notes", "follow_up", "not_qualified"];
export const RESULT_LABEL: Record<Result, string> = {
	qualified: "Qualified",
	qualified_with_notes: "Qualified with notes",
	follow_up: "Follow up",
	not_qualified: "Not qualified",
};
/** The StatusBadge state each result shows with. The label always says the result; the dot only repeats it. */
export const RESULT_STATUS = {
	qualified: "positive",
	qualified_with_notes: "measured",
	follow_up: "attention",
	not_qualified: "risk",
} as const satisfies Record<Result, string>;
export const KIND_LABEL: Record<Kind, string> = { core_group: "Core group", launch_team: "Launch team" };

/** Today's date in this browser's zone (yyyy-mm-dd). The server refuses a date after today at the church. */
export function today(now = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * The stage a person shows while a record that advances them saves (REQ-PPL-013, 014): an earlier stage moves up to
 * `target`; a stage at or past it stays. Only an explicit stage change moves someone back.
 */
export function advancedStage(stage: StageValue, target: "interviewed" | "core_group"): StageValue {
	return STAGES.indexOf(stage) < STAGES.indexOf(target) ? target : stage;
}

/**
 * The first acquisition after a new valid card (REQ-PPL-026): the earliest valid signed date. A known earlier date
 * stays. An unknown first acquisition stays unknown, because the card alone cannot settle it.
 */
export function withCard(first: FirstAcquisition, card: Pick<Commitment, "id" | "occurredOn">): FirstAcquisition {
	if (first.status === "unknown") return first;
	if (first.status === "known" && first.occurredOn <= card.occurredOn) return first;
	return { status: "known", occurredOn: card.occurredOn, evidenceId: card.id };
}

/**
 * A history with a new record shown first (or in its date place): records sort latest first by occurrence date, then
 * recorded instant, then ID, so a late historical entry never becomes the latest (REQ-PPL-012).
 */
export function withRecord<R extends { id: string; occurredOn: string; recordedAt: string }>(
	items: readonly R[],
	record: R,
): R[] {
	const rest = items.filter((r) => r.id !== record.id);
	return [...rest, record].sort(
		(a, b) =>
			b.occurredOn.localeCompare(a.occurredOn) || b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id),
	);
}

/** The total of four scores, for the form's running sum. The saved total is the server's. */
export const totalOf = (scores: readonly (number | null)[]) =>
	scores.every((s) => s !== null) ? scores.reduce<number>((t, s) => t + (s ?? 0), 0) : null;

export const firstName = (name: string) => name.split(" ")[0] || name;

/**
 * Sends a save, and once more with the same request key when the answer is lost. The producer returns the first result
 * for a key it already saved, so the second try can never save twice. A second lost answer goes back to the person.
 */
export async function sendTwice<T>(call: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
	const once = () => call().catch((): Outcome<T> => ({ status: "lost" }));
	const first = await once();
	return first.status === "lost" ? once() : first;
}

// One card's record form and its saves (C58). Every opened form is one save intent with its own new request key and
// current validation. A save closes the form. A lost answer is sent once more at once with the same key; when the result
// is still unknown, the card says the record may already be saved and offers Check again, which sends the same request
// with the same key once more. A refusal opens the form again with the reason while it is still the person's latest
// form; after a newer form was opened or closed, the card says the record was not saved and why. No failed form waits to
// be reopened later.

export type Notice =
	| { tone: "refused"; id: string; what: string; problem: string }
	| { tone: "unknown"; id: string; what: string; check: () => void; checking: boolean };
export type FormState<E> = { editing: E | null; notice: Notice | null; intent: number };
export const formStart = <E>(): FormState<E> => ({ editing: null, notice: null, intent: 0 });
export const formOpen = <E>(s: FormState<E>, e: E): FormState<E> => ({ ...s, editing: e, intent: s.intent + 1 });
export const formClose = <E>(s: FormState<E>): FormState<E> => ({ ...s, editing: null, intent: s.intent + 1 });
/** Closes the form for a save. The token tells whether it is still the latest form when the save is refused. */
export function formSend<E>(s: FormState<E>) {
	const state = formClose(s);
	return { state, token: state.intent };
}
/** A refused save: its form opens again with the reason, unless the person opened or closed a form since. */
export function formRefused<E extends { problem?: string }>(
	s: FormState<E>,
	token: number,
	e: E,
	notice: { id: string; what: string },
): FormState<E> {
	return token === s.intent
		? { ...s, editing: e }
		: { ...s, notice: { tone: "refused", ...notice, problem: e.problem ?? "" } };
}
/** A save whose answer is still unknown after the replay: the card offers Check again with the same request. */
export const formUnknown = <E>(s: FormState<E>, id: string, what: string, check: () => void): FormState<E> => ({
	...s,
	notice: { tone: "unknown", id, what, check, checking: false },
});
export const formChecking = <E>(s: FormState<E>): FormState<E> =>
	s.notice?.tone === "unknown" ? { ...s, notice: { ...s.notice, checking: true } } : s;
/** A save that is now known to be saved clears its own notice, never another one. */
export const formSettled = <E>(s: FormState<E>, id: string): FormState<E> =>
	s.notice?.id === id ? { ...s, notice: null } : s;
export const formDismiss = <E>(s: FormState<E>): FormState<E> => ({ ...s, notice: null });

/**
 * A save whose result is still unknown: its answer was lost twice, or a Check again (token -1) could not start because
 * another change to the person was saving. That sent nothing, so the first request may still be saved: never a refusal.
 */
export const stillUnknown = (r: Outcome<unknown> | null, token: number): boolean =>
	r?.status === "lost" || (r === null && token === -1);
