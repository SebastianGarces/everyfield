"use server";

import type { ReadinessWriteResult } from "./readiness-model.ts";
import type { SignalOutcome } from "./signals-model.ts";
import { runSignals } from "./signals-server.ts";

export async function attestReadiness(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<SignalOutcome<ReadinessWriteResult>> {
	return runSignals((signals, db, authority) =>
		signals.attestReadiness(db, authority, { requestKey, expectedRevision, input }),
	);
}

export async function correctReadiness(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<SignalOutcome<ReadinessWriteResult>> {
	return runSignals((signals, db, authority) =>
		signals.correctReadiness(db, authority, { requestKey, expectedRevision, input }),
	);
}
