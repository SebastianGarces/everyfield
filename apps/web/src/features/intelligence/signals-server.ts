import { requestDatabase } from "@/server/database";
import {
	signalError,
	type AttestationsPage,
	type CandidateWriteResult,
	type SignalReply,
	type SignalWriteResult,
} from "@everyfield/contracts/intelligence";
import type { Database } from "@everyfield/db/client";
import type { RequestActor } from "@everyfield/domain/access";
import { createSignals, type Signals } from "@everyfield/domain/intelligence";
import "server-only";
import type { SignalOutcome } from "./signals-model.ts";
import { careViewer, type CareViewer } from "./server.ts";

// The Attestations page reaches the signals domain here. Pages and actions share the request's one viewer (D59/D60),
// and every read and write rechecks the live Owner or Admin seat inside its statement. Failures log their kind only:
// no answer, detail, reference or name ever reaches a log line.

const signals = createSignals();

export type SignalsViewer = CareViewer;
export const signalsViewer = careViewer;

const report = (outcome: string, error: unknown) =>
	console.error(
		JSON.stringify({ component: "signals", outcome, kind: (error as { code?: string })?.code ?? "unknown" }),
	);

/** The Attestations page: the seven signals, the counts, the candidates and the history. One statement. */
export async function loadAttestations(viewer: SignalsViewer): Promise<SignalOutcome<AttestationsPage>> {
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		return await signals.readAttestations(db, viewer.authority, {});
	} catch (error) {
		report("read_failed", error);
		return { status: "lost" };
	}
}

/** One signals operation for the request's viewer. */
export async function runSignals<T extends SignalWriteResult | CandidateWriteResult | AttestationsPage>(
	body: (signals: Signals, db: Database, authority: RequestActor) => Promise<SignalReply<T>>,
): Promise<SignalOutcome<T>> {
	const viewer = await signalsViewer();
	if (!viewer)
		return {
			status: "refused",
			error: signalError.parse({
				code: "access_denied",
				details: {},
				correlationId: crypto.randomUUID(),
				retry: "never",
			}),
		};
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		return await body(signals, db, viewer.authority);
	} catch (error) {
		report("call_failed", error);
		return { status: "lost" };
	}
}
