// Pure rules of the 4 C's, interview and commitment cards (REQ-PPL-012, 013, 014, 020, 026). No React and no server
// code, so the rules run the same in the browser, on the server and in node tests.
import type * as c from "@everyfield/contracts/people";
import type { z } from "zod";
import { keyFor, STAGES, type KeyedPayload, type Outcome, type StageValue } from "../model.ts";

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

// One card's record form and its save intents (review F2, F4). A save closes the form. A failed save opens it again only
// when no form was opened or closed since; otherwise it waits as `failed`, so a late reply never replaces newer work.
// Each intent keeps its own request key: a failed draft carries the key its lost try used, and resuming it sends that
// key again even after another save succeeded, so the producer replays instead of saving twice.

/** A form's values, the reason it failed and the key of its last lost try. */
export type Intent = { problem?: string; key?: KeyedPayload };
export type FormState<E extends Intent> = { editing: E | null; failed: E | null; intent: number };
export const formStart = <E extends Intent>(): FormState<E> => ({ editing: null, failed: null, intent: 0 });
export const formOpen = <E extends Intent>(s: FormState<E>, e: E): FormState<E> => ({
	...s,
	editing: e,
	intent: s.intent + 1,
});
export const formClose = <E extends Intent>(s: FormState<E>): FormState<E> => ({
	...s,
	editing: null,
	intent: s.intent + 1,
});
/** Closes the form for a save: the token tells whether it is still the latest form when the save fails. */
export function formSend<E extends Intent>(s: FormState<E>, fresh: () => string) {
	const prior = s.editing?.key ?? null;
	const state = formClose(s);
	return { state, token: state.intent, prior, keyFor: (payload: unknown) => keyFor(prior, payload, fresh) };
}
export const formFail = <E extends Intent>(s: FormState<E>, token: number, e: E): FormState<E> =>
	token === s.intent ? { ...s, editing: e } : { ...s, failed: e };
export const formResume = <E extends Intent>(s: FormState<E>): FormState<E> =>
	s.failed ? { ...formOpen(s, s.failed), failed: null } : s;
export const formDismiss = <E extends Intent>(s: FormState<E>): FormState<E> => ({ ...s, failed: null });
/** What a failed save keeps for its next try: its key after a lost answer, none after a refusal (a final answer). */
export const keptKey = (r: Outcome<unknown> | null, key: KeyedPayload) =>
	r === null || r.status === "lost" ? key : undefined;
