import type { Outcome } from "@everyfield/contracts/common";
import type { TeamsReply } from "@everyfield/contracts/teams";
import type { Database } from "@everyfield/db/client";
import { trainingReader } from "@everyfield/domain/teams";
import "server-only";
import { outcomeOf } from "@everyfield/contracts/common";
import type { Viewer as Seat } from "../server.ts";
import type { PersonLoad, TrainingLoad } from "./model.ts";
import { readDb } from "../../../server/platform/tx.ts";

type Authority = Seat["authority"];

async function read<T>(viewer: Seat, run: (db: Database, authority: Authority) => Promise<TeamsReply<T>>) {
	return readDb("training", (db) => run(db, viewer.authority));
}

export async function loadTraining(viewer: Seat, teamId: string): Promise<Outcome<TrainingLoad>> {
	const [list, matrix] = await Promise.all([
		read(viewer, (db, authority) => trainingReader.listTraining(db, authority, { teamId })),
		read(viewer, (db, authority) => trainingReader.readTrainingMatrix(db, authority, { teamId })),
	]);
	const programs = outcomeOf(list);
	if (programs.status !== "ok") return programs;
	const assigned = outcomeOf(matrix);
	return {
		status: "ok",
		value: { programs: programs.value.programs, assigned: assigned.status === "ok" ? assigned.value.programs : null },
	};
}

export async function loadPersonTraining(viewer: Seat, personId: string): Promise<PersonLoad> {
	const [summary, history] = await Promise.all([
		read(viewer, (db, authority) => trainingReader.readPersonTraining(db, authority, { personId })),
		read(viewer, (db, authority) => trainingReader.readTrainingHistory(db, authority, { personId })),
	]);
	const credits = outcomeOf(history);
	return {
		summary: outcomeOf(summary),
		credits: credits.status === "ok" ? { status: "ok", value: credits.value.credits } : credits,
	};
}

export async function readRosterPreview(viewer: Seat, programId: string, personIds: unknown) {
	return outcomeOf(
		await read(viewer, (db, authority) =>
			trainingReader.readRequiredTrainingPreview(db, authority, { programId, personIds }),
		),
	);
}
