"use server";

import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import type { TeamsReply } from "@everyfield/contracts/teams";
import type { Database } from "@everyfield/db/client";
import { trainingReader, trainingWriter } from "@everyfield/domain/teams";
import { outcome, write } from "../server.ts";
import type { Outcome, PersonLoad, TrainingLoad } from "./model.ts";

// Server actions for the training screens. The browser cannot send an actor. Each action reads the seat again and
// hands the form to the training producer, which parses it. A lost answer may be retried with the same request key.

const noSeat = { status: "refused", code: "unavailable" } as const;
type Seat = NonNullable<Awaited<ReturnType<typeof seat>>>;
type Authority = Seat["authority"];

async function seat() {
	return (await getViewer())?.people ?? null;
}

async function read<T>(viewer: Seat, run: (db: Database, authority: Authority) => Promise<TeamsReply<T>>) {
	const db = requestDatabase();
	if (!db) return { status: "failed" } as const;
	try {
		return await run(db, viewer.authority);
	} catch (error) {
		console.error(JSON.stringify({ component: "training", outcome: "read_failed", error: String(error) }));
		return { status: "failed" } as const;
	}
}

/** Programs and, beside them, who is on each required list. The list still shows when the assignment read fails. */
export async function loadTraining(): Promise<Outcome<TrainingLoad>> {
	const viewer = await seat();
	if (!viewer) return noSeat;
	const [list, matrix] = await Promise.all([
		read(viewer, (db, authority) => trainingReader.listTraining(db, authority, {})),
		read(viewer, (db, authority) => trainingReader.readTrainingMatrix(db, authority, {})),
	]);
	const programs = outcome(list);
	if (programs.status !== "ok") return programs;
	const assigned = outcome(matrix);
	return {
		status: "ok",
		value: { programs: programs.value.programs, assigned: assigned.status === "ok" ? assigned.value.programs : null },
	};
}

/** One person's training summary and credit history, read together. */
export async function loadPersonTraining(personId: string): Promise<PersonLoad> {
	const viewer = await seat();
	if (!viewer) return { summary: noSeat, credits: noSeat };
	const [summary, history] = await Promise.all([
		read(viewer, (db, authority) => trainingReader.readPersonTraining(db, authority, { personId })),
		read(viewer, (db, authority) => trainingReader.readTrainingHistory(db, authority, { personId })),
	]);
	const credits = outcome(history);
	return {
		summary: outcome(summary),
		credits: credits.status === "ok" ? { status: "ok", value: credits.value.credits } : credits,
	};
}

export async function createProgram(
	requestKey: string,
	input: { name: string; required: boolean; teamId: string | null },
) {
	const viewer = await seat();
	if (!viewer) return noSeat;
	return write(viewer, (tx, ctx) => trainingWriter.createProgram(tx, ctx, { requestKey, input }));
}

export async function correctProgram(
	requestKey: string,
	expectedRevision: string,
	input: { programId: string; name: string; required: boolean; reason: string },
) {
	const viewer = await seat();
	if (!viewer) return noSeat;
	return write(viewer, (tx, ctx) => trainingWriter.correctProgram(tx, ctx, { requestKey, expectedRevision, input }));
}

export async function previewRoster(programId: string, personIds: string[]) {
	const viewer = await seat();
	if (!viewer) return noSeat;
	return outcome(
		await read(viewer, (db, authority) =>
			trainingReader.readRequiredTrainingPreview(db, authority, { programId, personIds }),
		),
	);
}

export async function saveRoster(
	requestKey: string,
	expectedRevision: string,
	input: { programId: string; personIds: string[]; rosterDigest: string },
) {
	const viewer = await seat();
	if (!viewer) return noSeat;
	return write(viewer, (tx, ctx) =>
		trainingWriter.setRequiredTrainingParticipants(tx, ctx, { requestKey, expectedRevision, input }),
	);
}

export async function attestCompletion(
	requestKey: string,
	expectedRevision: string,
	input:
		| { kind: "program"; personId: string; programId: string; earnedOn: string }
		| { kind: "service"; personId: string; attendanceDays: number; volunteerDays: number },
) {
	const viewer = await seat();
	if (!viewer) return noSeat;
	return write(viewer, (tx, ctx) => trainingWriter.attestCompletion(tx, ctx, { requestKey, expectedRevision, input }));
}

export async function revokeCompletion(
	requestKey: string,
	expectedRevision: string,
	input: { personId: string; programId: string },
) {
	const viewer = await seat();
	if (!viewer) return noSeat;
	return write(viewer, (tx, ctx) => trainingWriter.revokeCompletion(tx, ctx, { requestKey, expectedRevision, input }));
}

export async function recompleteTraining(
	requestKey: string,
	expectedRevision: string,
	input: { personId: string; programId: string; earnedOn: string },
) {
	const viewer = await seat();
	if (!viewer) return noSeat;
	return write(viewer, (tx, ctx) =>
		trainingWriter.recompleteTraining(tx, ctx, { requestKey, expectedRevision, input }),
	);
}
