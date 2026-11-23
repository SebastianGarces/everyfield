"use server";

import type { CandidateWriteResult, SignalWriteResult } from "@everyfield/contracts/intelligence";
import type { SignalOutcome } from "./signals-model.ts";
import { runSignals } from "./signals-server.ts";

export async function attestSignal(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<SignalOutcome<SignalWriteResult>> {
	return runSignals((signals, db, authority) => signals.attest(db, authority, { requestKey, expectedRevision, input }));
}

export async function correctSignal(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<SignalOutcome<SignalWriteResult>> {
	return runSignals((signals, db, authority) =>
		signals.correct(db, authority, { requestKey, expectedRevision, input }),
	);
}

export async function reaffirmSignal(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<SignalOutcome<SignalWriteResult>> {
	return runSignals((signals, db, authority) =>
		signals.reaffirm(db, authority, { requestKey, expectedRevision, input }),
	);
}

export async function attestCandidate(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<SignalOutcome<CandidateWriteResult>> {
	return runSignals((signals, db, authority) =>
		signals.attestCandidate(db, authority, { requestKey, expectedRevision, input }),
	);
}

export async function correctCandidate(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<SignalOutcome<CandidateWriteResult>> {
	return runSignals((signals, db, authority) =>
		signals.correctCandidate(db, authority, { requestKey, expectedRevision, input }),
	);
}
