"use server";

import type { Outcome } from "@everyfield/contracts/common";
import {
	applyMessagesOptOut,
	undoMessagesOptOut,
	type MessagesOptInResult,
	type MessagesOptOutResult,
} from "@everyfield/domain/communication";

import { unsubscribeCall } from "./unsubscribe.ts";

export async function applyUnsubscribe(token: string): Promise<Outcome<MessagesOptOutResult>> {
	return unsubscribeCall(({ db, ring }) => applyMessagesOptOut(db, ring, () => new Date(), { token }));
}

export async function undoUnsubscribe(token: string): Promise<Outcome<MessagesOptInResult>> {
	return unsubscribeCall(({ db, ring }) => undoMessagesOptOut(db, ring, () => new Date(), { token }));
}
