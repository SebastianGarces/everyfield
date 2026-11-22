import type { Lost } from "@everyfield/contracts/common";
import type { ProgramReply } from "@everyfield/contracts/organizations";
import type { RequestActor } from "@everyfield/domain/access";
import type { Database } from "@everyfield/db/client";
import { readEnrollment, readProgram, readPrograms } from "@everyfield/domain/organizations";
import "server-only";
import { organizationSeat } from "@/server/request-context";
import { requestDatabase } from "../../../server/database";
import { LOST, transient } from "../../../server/platform/transient.ts";

export type ProgramAnswer<T> = ProgramReply<T> | Lost;

export async function programCall<T>(
	run: (db: Database, authority: RequestActor) => Promise<ProgramReply<T>>,
	authority?: RequestActor,
): Promise<ProgramAnswer<T>> {
	let actor = authority;
	if (!actor) {
		const seat = await organizationSeat();
		if (!seat) return { status: "refused", refusal: { code: "unavailable" } };
		actor = seat.authority;
	}
	const db = requestDatabase();
	return transient({ component: "programs", outcome: "failed" }, () => run(db, actor), LOST);
}

export const loadPrograms = (authority: RequestActor) => programCall((db, a) => readPrograms(db, a), authority);
export const loadProgram = (authority: RequestActor, programId: string) =>
	programCall((db, a) => readProgram(db, a, { programId }), authority);
export const loadEnrollment = (authority: RequestActor, enrollmentId: string) =>
	programCall((db, a) => readEnrollment(db, a, { enrollmentId }), authority);
