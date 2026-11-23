"use server";

import type { CareWriteResult } from "@everyfield/contracts/intelligence";
import type { Outcome } from "./model.ts";
import { run } from "./server.ts";

export async function saveCheckIn(
	requestKey: string,
	expectedRevision: string,
	answers: unknown,
	note: unknown,
): Promise<Outcome<CareWriteResult>> {
	return run((care, db, authority) =>
		care.save(db, authority, { requestKey, expectedRevision, input: { answers, note } }),
	);
}

export async function correctCheckIn(
	requestKey: string,
	expectedRevision: string,
	weekId: unknown,
	answers: unknown,
	note: unknown,
): Promise<Outcome<CareWriteResult>> {
	return run((care, db, authority) =>
		care.correct(db, authority, { requestKey, expectedRevision, input: { weekId, answers, note } }),
	);
}
