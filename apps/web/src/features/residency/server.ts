import type { ProgramReply } from "@everyfield/contracts/organizations";
import type { RequestActor } from "@everyfield/domain/access";
import type { Database } from "@everyfield/db/client";
import { readMyResidency, readResidentReading } from "@everyfield/domain/organizations";
import "server-only";
import { requestDatabase } from "../../server/database";
import { getViewer } from "../../server/request-context";
import type { ProgramAnswer } from "../organizations/programs/mount";
import { LOST, transient } from "@/server/platform/transient";

export async function residentActor(): Promise<RequestActor | "signed_out" | null> {
	const v = await getViewer();
	if (v.status === "unauthenticated") return "signed_out";
	return v.status === "active" && v.authority ? v.authority : null;
}

export async function residentCall<T>(
	run: (db: Database, authority: RequestActor) => Promise<ProgramReply<T>>,
	authority?: RequestActor,
): Promise<ProgramAnswer<T>> {
	let actor = authority;
	if (!actor) {
		const who = await residentActor();
		if (!who || who === "signed_out") return { status: "refused", refusal: { code: "unavailable" } };
		actor = who;
	}
	const db = requestDatabase();
	return transient({ component: "residency", outcome: "failed" }, () => run(db, actor), LOST);
}

export const loadMyResidency = (authority: RequestActor) => residentCall((db, a) => readMyResidency(db, a), authority);
export const loadResidentReading = (authority: RequestActor, readingId: string) =>
	residentCall((db, a) => readResidentReading(db, a, { readingId }), authority);
