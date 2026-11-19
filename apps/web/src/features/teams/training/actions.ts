"use server";

import { getViewer } from "@/server/request-context";
import { trainingWriter } from "@everyfield/domain/teams";
import { write } from "../server.ts";
import { readRosterPreview } from "./server.ts";

const noSeat = { status: "refused", code: "unavailable" } as const;

async function seat() {
	return (await getViewer()).people ?? null;
}

export async function createProgram(requestKey: string, input: unknown) {
	const viewer = await seat();
	if (!viewer) return noSeat;
	return write(viewer, (tx, ctx) => trainingWriter.createProgram(tx, ctx, { requestKey, input }));
}

export async function correctProgram(requestKey: string, expectedRevision: string, input: unknown) {
	const viewer = await seat();
	if (!viewer) return noSeat;
	return write(viewer, (tx, ctx) => trainingWriter.correctProgram(tx, ctx, { requestKey, expectedRevision, input }));
}

export async function previewRoster(programId: string, personIds: unknown) {
	const viewer = await seat();
	if (!viewer) return noSeat;
	return readRosterPreview(viewer, programId, personIds);
}

export async function saveRoster(requestKey: string, expectedRevision: string, input: unknown) {
	const viewer = await seat();
	if (!viewer) return noSeat;
	return write(viewer, (tx, ctx) =>
		trainingWriter.setRequiredTrainingParticipants(tx, ctx, { requestKey, expectedRevision, input }),
	);
}

export async function attestCompletion(requestKey: string, expectedRevision: string, input: unknown) {
	const viewer = await seat();
	if (!viewer) return noSeat;
	return write(viewer, (tx, ctx) => trainingWriter.attestCompletion(tx, ctx, { requestKey, expectedRevision, input }));
}

export async function attestService(requestKey: string, input: unknown) {
	const viewer = await seat();
	if (!viewer) return noSeat;
	return write(viewer, (tx, ctx) =>
		trainingWriter.attestCompletion(tx, ctx, {
			requestKey,
			input: input && typeof input === "object" ? { kind: "service", ...input } : input,
		}),
	);
}

export async function revokeCompletion(requestKey: string, expectedRevision: string, input: unknown) {
	const viewer = await seat();
	if (!viewer) return noSeat;
	return write(viewer, (tx, ctx) => trainingWriter.revokeCompletion(tx, ctx, { requestKey, expectedRevision, input }));
}

export async function recompleteTraining(requestKey: string, expectedRevision: string, input: unknown) {
	const viewer = await seat();
	if (!viewer) return noSeat;
	return write(viewer, (tx, ctx) =>
		trainingWriter.recompleteTraining(tx, ctx, { requestKey, expectedRevision, input }),
	);
}
