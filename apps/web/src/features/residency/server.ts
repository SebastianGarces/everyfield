import type { ProgramReply } from "@everyfield/contracts/organizations";
import type { RequestActor } from "@everyfield/domain/access";
import type { Database } from "@everyfield/db/client";
import { readMyResidency, readResidentReading } from "@everyfield/domain/organizations";
import "server-only";
import { requestDatabase } from "../../server/database";
import { viewerActor } from "../../server/request-context";
import type { ProgramAnswer } from "../organizations/programs/mount";
import { LOST, transient } from "../../server/platform/transient.ts";

export async function residentCall<T>(
	run: (db: Database, authority: RequestActor) => Promise<ProgramReply<T>>,
	authority?: RequestActor,
): Promise<ProgramAnswer<T>> {
	const actor = authority ?? (await viewerActor());
	if (!actor) return { status: "refused", refusal: { code: "unavailable" } };
	const db = requestDatabase();
	return transient({ component: "residency", outcome: "failed" }, () => run(db, actor), LOST);
}

export const loadMyResidency = (authority: RequestActor) => residentCall((db, a) => readMyResidency(db, a), authority);
export const loadResidentReading = (authority: RequestActor, readingId: string) =>
	residentCall((db, a) => readResidentReading(db, a, { readingId }), authority);
