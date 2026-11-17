"use server";

import type { DeclareResult, TransitionResult } from "@everyfield/contracts/phases";
import type { Outcome } from "./model.ts";
import { write } from "./server.ts";

export async function declarePhase(
	requestKey: string,
	expectedRevision: string,
	phase: unknown,
): Promise<Outcome<DeclareResult>> {
	return write((w, db, authority) => w.declare(db, authority, { requestKey, expectedRevision, input: { phase } }));
}

export async function movePhase(
	requestKey: string,
	expectedRevision: string,
	toPhase: unknown,
	reason: unknown,
): Promise<Outcome<TransitionResult>> {
	return write((w, db, authority) =>
		w.transition(db, authority, { requestKey, expectedRevision, input: { toPhase, reason } }),
	);
}
