"use server";

import type { CarePage, CareWriteResult } from "@everyfield/contracts/intelligence";
import type { Outcome } from "./model.ts";
import { run } from "./server.ts";

// The browser boundary of the check-in page. Each action hands the browser's values to privateCare, which parses them
// with the strict contract and takes the author from the session, never from the request.

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

export async function readCheckInHistory(page: unknown): Promise<Outcome<CarePage>> {
	return run((care, db, authority) => care.readHistory(db, authority, { page }));
}
