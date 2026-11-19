import type { ProgramReply } from "@everyfield/contracts/organizations";
import type { RequestActor } from "@everyfield/domain/access";
import type { Database } from "@everyfield/db/client";
import { readEnrollment, readProgram, readPrograms } from "@everyfield/domain/organizations";
import "server-only";
import { requestDatabase } from "../../../server/database";
import { pipelineActor } from "../pipeline-mount";
import { logFailure } from "@everyfield/domain/log";

export type ProgramAnswer<T> = ProgramReply<T> | { status: "lost" };

export async function programCall<T>(
	run: (db: Database, authority: RequestActor) => Promise<ProgramReply<T>>,
	authority?: RequestActor,
): Promise<ProgramAnswer<T>> {
	let actor = authority;
	if (!actor) {
		const who = await pipelineActor();
		if (who.kind !== "seat") return { status: "refused", refusal: { code: "unavailable" } };
		actor = who.authority;
	}
	const db = requestDatabase();
	try {
		return await run(db, actor);
	} catch (error) {
		logFailure({ component: "programs", outcome: "failed" }, error);
		return { status: "lost" };
	}
}

export const loadPrograms = (authority: RequestActor) => programCall((db, a) => readPrograms(db, a), authority);
export const loadProgram = (authority: RequestActor, programId: string) =>
	programCall((db, a) => readProgram(db, a, { programId }), authority);
export const loadEnrollment = (authority: RequestActor, enrollmentId: string) =>
	programCall((db, a) => readEnrollment(db, a, { enrollmentId }), authority);
