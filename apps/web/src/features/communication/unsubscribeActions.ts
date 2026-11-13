"use server";

import {
	applyMessagesOptOut,
	undoMessagesOptOut,
	type MessagesOptInResult,
	type MessagesOptOutResult,
} from "@everyfield/domain/communication";
import type { Outcome } from "./model.ts";
import { unsubscribeCall } from "./unsubscribe.ts";

// The Unsubscribe page's two explicit posts (REQ-NTF-016). The token is the only authority, so neither needs a session.
// Opening the page only describes the token; only these change anything.

/** Stop this church's Messages email to the token's person. The result carries the one-hour undo token. */
export async function applyUnsubscribe(token: string): Promise<Outcome<MessagesOptOutResult>> {
	return unsubscribeCall(({ db, ring }) => applyMessagesOptOut(db, ring, () => new Date(), { token }));
}

/** Undo it with the token the unsubscribe returned, within one hour. */
export async function undoUnsubscribe(token: string): Promise<Outcome<MessagesOptInResult>> {
	return unsubscribeCall(({ db, ring }) => undoMessagesOptOut(db, ring, () => new Date(), { token }));
}
