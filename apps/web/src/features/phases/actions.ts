"use server";

import type { DeclareResult, TransitionResult } from "@everyfield/contracts/phases";
import type { Outcome } from "./model.ts";
import { write } from "./server.ts";

// The browser boundary of the journey screen's two writes. Each hands the browser's values to the phase writer, which
// parses them with the strict phases contract and rechecks the live Owner or Admin seat inside its statement. The
// server reads the starting phase itself; a retry with the same request key replays the stored answer.

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
