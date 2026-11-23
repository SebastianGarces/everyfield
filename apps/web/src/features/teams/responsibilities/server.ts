import type { TeamsReply } from "@everyfield/contracts/teams";
import type { Database } from "@everyfield/db/client";
import { responsibilityReader } from "@everyfield/domain/teams";
import "server-only";
import { outcomeOf } from "@everyfield/contracts/common";
import type { Viewer } from "../server.ts";
import { readDb } from "../../../server/platform/tx.ts";

async function read<T>(viewer: Viewer, run: (db: Database, authority: Viewer["authority"]) => Promise<TeamsReply<T>>) {
	return readDb("responsibilities", async (db) => outcomeOf(await run(db, viewer.authority)));
}

export function listResponsibilities(v: Viewer, teamId: string, page: number) {
	return read(v, (db, authority) => responsibilityReader.listResponsibilities(db, authority, { teamId, page }));
}

export function previewResponsibilities(v: Viewer, teamId: string) {
	return read(v, (db, authority) => responsibilityReader.previewResponsibilities(db, authority, { teamId }));
}
