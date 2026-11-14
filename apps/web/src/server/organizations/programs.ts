import type { ProgramReply } from "@everyfield/contracts/organizations";
import type { RequestActor } from "@everyfield/domain/access";
import type { Database } from "@everyfield/db/client";
import { readEnrollment, readProgram, readPrograms } from "@everyfield/domain/organizations";
import "server-only";
import { requestDatabase } from "../database";
import { pipelineActor } from "./pipeline";

// The development programs mount (WP-099), beside the pipeline's. Pages and actions take the request's one actor
// (D59); every read and write rechecks the seat inside its own statement or transaction. A database failure reads as
// "lost", never a crash.

export type ProgramAnswer<T> = ProgramReply<T> | { status: "lost" };

/** One program read or write as the request's actor, or the refusal of a request with no organization seat. */
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
	if (!db) return { status: "lost" };
	try {
		return await run(db, actor);
	} catch (error) {
		console.error(JSON.stringify({ component: "programs", outcome: "failed", error: String(error) }));
		return { status: "lost" };
	}
}

export const loadPrograms = (authority: RequestActor) => programCall((db, a) => readPrograms(db, a), authority);
export const loadProgram = (authority: RequestActor, programId: string) =>
	programCall((db, a) => readProgram(db, a, { programId }), authority);
export const loadEnrollment = (authority: RequestActor, enrollmentId: string) =>
	programCall((db, a) => readEnrollment(db, a, { enrollmentId }), authority);
