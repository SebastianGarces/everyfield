import type { ProgramReply } from "@everyfield/contracts/organizations";
import type { RequestActor } from "@everyfield/domain/access";
import type { Database } from "@everyfield/db/client";
import { readMyResidency, readResidentReading } from "@everyfield/domain/organizations";
import "server-only";
import { requestDatabase } from "../database";
import { getViewer } from "../request-context";
import type { ProgramAnswer } from "./programs";

// The My residency mount (WP-100). The resident acts as their own account, never a seat: pages and actions take the
// request's one actor (D59), and every read and write rechecks the live residency link inside its own statement.

/** The signed-in account's request actor, "signed_out", or null when there is no active session. */
export async function residentActor(): Promise<RequestActor | "signed_out" | null> {
	const v = await getViewer();
	if (!v) return null;
	if (v.status === "unauthenticated") return "signed_out";
	return v.status === "active" && v.authority ? v.authority : null;
}

/** One residency read or write as the request's account. A database failure reads as "lost", never a crash. */
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
	if (!db) return { status: "lost" };
	try {
		return await run(db, actor);
	} catch (error) {
		console.error(JSON.stringify({ component: "residency", outcome: "failed", error: String(error) }));
		return { status: "lost" };
	}
}

export const loadMyResidency = (authority: RequestActor) => residentCall((db, a) => readMyResidency(db, a), authority);
export const loadResidentReading = (authority: RequestActor, readingId: string) =>
	residentCall((db, a) => readResidentReading(db, a, { readingId }), authority);
