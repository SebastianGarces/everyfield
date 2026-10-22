// One save lane per card or dialog (C58, C65, C68, C69). Pure rules; the hook in save.tsx holds the state.
//
// Every submit is a new save intent with its own new request key. A lost answer is sent once more at once with the same
// key; when it is still unknown, the lane says the change may already be saved and offers Check again, which sends the
// same request with the same key. Only a server answer says "not saved". While a save is in flight or unknown, nothing
// else on the card can submit, and nothing is queued. An unknown result cannot be dismissed, only checked.
import type { Outcome } from "./model.ts";

export type Lane = {
	/** What is saving now ("The outcome"), or null. */
	saving: string | null;
	/** A save whose answer is still unknown after its replay. Cleared only by a server answer. */
	unknown: { what: string; checking: boolean } | null;
	/** The server's refusal of the last save, kept until the next save or Dismiss. */
	refused: { what: string; code: string } | null;
};
export const idle: Lane = { saving: null, unknown: null, refused: null };

/** Why a card's Save is off now: a save is running, or its result is unknown. Null when a save may start. */
export type Wait = "saving" | "unknown" | null;
export const waitOf = (l: Lane): Wait => (l.saving ? "saving" : l.unknown ? "unknown" : null);
export const WAIT_HINT: Record<Exclude<Wait, null>, string> = {
	saving: "Waiting for the last save to finish.",
	unknown: "Check the last save first.",
};

/**
 * A server refusal that asks for the same request again (`temporary`) or says the result is not known (`unknown`) is
 * not a "not saved": it is treated like a lost answer.
 */
export const settledOf = <T>(r: Outcome<T>): Outcome<T> =>
	r.status === "refused" && (r.code === "temporary" || r.code === "unknown") ? { status: "lost" } : r;

/** Sends once, and once more with the same key when the answer is lost. A thrown call reads as lost. */
export async function sendTwice<T>(call: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
	const once = () => call().then(settledOf, (): Outcome<T> => ({ status: "lost" }));
	const first = await once();
	return first.status === "lost" ? once() : first;
}

export const laneStart = (l: Lane, what: string): Lane | null =>
	waitOf(l) ? null : { saving: what, unknown: null, refused: null };
export const laneCheck = (l: Lane): Lane | null =>
	l.unknown && !l.unknown.checking && !l.saving ? { ...l, unknown: { ...l.unknown, checking: true } } : null;
/** The lane after an answer, a replay or a Check again. */
export function laneAnswer<T>(l: Lane, what: string, r: Outcome<T>): Lane {
	if (r.status === "lost") return { saving: null, unknown: { what, checking: false }, refused: null };
	if (r.status === "refused") return { saving: null, unknown: null, refused: { what, code: r.code } };
	return idle;
}
export const laneDismiss = (l: Lane): Lane => ({ ...l, refused: null });
