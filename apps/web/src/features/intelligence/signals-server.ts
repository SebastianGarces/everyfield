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

const signals = createSignals();

const report = (outcome: string, error: unknown) =>
	console.error(
		JSON.stringify({ component: "signals", outcome, kind: (error as { code?: string })?.code ?? "unknown" }),
	);

export async function loadAttestations(viewer: CareViewer): Promise<SignalOutcome<AttestationsPage>> {
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		return await signals.readAttestations(db, viewer.authority, {});
	} catch (error) {
		report("read_failed", error);
		return { status: "lost" };
	}
}

export async function runSignals<T extends SignalWriteResult | CandidateWriteResult | AttestationsPage>(
	body: (signals: Signals, db: Database, authority: RequestActor) => Promise<SignalReply<T>>,
): Promise<SignalOutcome<T>> {
	const viewer = await careViewer();
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
