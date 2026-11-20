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
import { plantSeat, type PlantSeat } from "@/server/request-context";
import { LOST, transient } from "../../server/platform/transient.ts";
import { readDb } from "../../server/platform/tx.ts";

const signals = createSignals();

export async function loadAttestations(viewer: PlantSeat): Promise<SignalOutcome<AttestationsPage>> {
	return readDb("signals", (db) => signals.readAttestations(db, viewer.authority, {}));
}

export async function runSignals<T extends SignalWriteResult | CandidateWriteResult | AttestationsPage>(
	body: (signals: Signals, db: Database, authority: RequestActor) => Promise<SignalReply<T>>,
): Promise<SignalOutcome<T>> {
	const viewer = await plantSeat();
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
	return transient({ component: "signals", outcome: "call_failed" }, () => body(signals, db, viewer.authority), LOST);
}
