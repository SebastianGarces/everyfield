import { requestDatabase } from "@/server/database";
import type { TeamsReply } from "@everyfield/contracts/teams";
import type { Database } from "@everyfield/db/client";
import { responsibilityReader } from "@everyfield/domain/teams";
import "server-only";
import type { Outcome } from "../model.ts";
import { outcome, type Viewer } from "../server.ts";

async function read<T>(
	viewer: Viewer,
	run: (db: Database, authority: Viewer["authority"]) => Promise<TeamsReply<T>>,
): Promise<Outcome<T>> {
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		return outcome(await run(db, viewer.authority));
	} catch (error) {
		console.error(JSON.stringify({ component: "responsibilities", outcome: "read_failed", error: String(error) }));
		return { status: "lost" };
	}
}

export function listResponsibilities(v: Viewer, teamId: string, page: number) {
	return read(v, (db, authority) => responsibilityReader.listResponsibilities(db, authority, { teamId, page }));
}

export function previewResponsibilities(v: Viewer, teamId: string) {
	return read(v, (db, authority) => responsibilityReader.previewResponsibilities(db, authority, { teamId }));
}
