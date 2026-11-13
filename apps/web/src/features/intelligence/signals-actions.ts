"use server";

import type { AttestationsPage, CandidateWriteResult, SignalWriteResult } from "@everyfield/contracts/intelligence";
import type { SignalOutcome } from "./signals-model.ts";
import { runSignals } from "./signals-server.ts";

// The browser boundary of the Attestations page. Each action hands the browser's values to the signals domain, which
// parses them with the strict contract and takes the author from the session, never from the request.

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

/** Reload the page after a conflict, so the admin sees where the signals stand now. */
export async function reloadAttestations(): Promise<SignalOutcome<AttestationsPage>> {
	return runSignals((signals, db, authority) => signals.readAttestations(db, authority, {}));
}
