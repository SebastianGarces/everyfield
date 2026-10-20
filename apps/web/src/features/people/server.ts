import { requestDatabase } from "@/server/database";
import type { PeopleContext, PeopleReply, PeopleWriteContext } from "@everyfield/contracts/people";
import type { Transaction } from "@everyfield/db/client";
import { type readPeopleViewer, PeopleReadContext, withPeopleWrite } from "@everyfield/domain/people";
import "server-only";
import type { PeopleQuery } from "./model.ts";
import { readPeoplePage, readPersonPage } from "./page-data.ts";

// Layout, pages and actions share this request's native session and actor.
// Reads consume that observation; writes recheck authority inside their transaction.

export type Viewer = Extract<Awaited<ReturnType<typeof readPeopleViewer>>, { status: "viewer" }>["viewer"];
export type Role = Viewer["role"];
export const canWrite = (v: Viewer) => v.role === "owner" || v.role === "admin";

/** Runs one read in its own transaction. A thrown database error reads as unavailable, never as a crash. */
export async function read<T>(
	viewer: Viewer,
	run: (tx: Transaction, context: PeopleContext) => Promise<PeopleReply<T>>,
): Promise<PeopleReply<T> | { status: "failed" }> {
	const store = requestDatabase();
	if (!store) return { status: "failed" };
	try {
		return await store.transaction((tx) => run(tx, new PeopleReadContext(viewer.authority)));
	} catch (error) {
		console.error(JSON.stringify({ component: "people", outcome: "read_failed", error: String(error) }));
		return { status: "failed" };
	}
}

/** Runs one native write in its own transaction. Origin is built here, never taken from the browser. */
export async function write<T>(
	viewer: Viewer,
	run: (tx: Transaction, context: PeopleWriteContext) => Promise<PeopleReply<T>>,
): Promise<PeopleReply<T> | { status: "failed" }> {
	const store = requestDatabase();
	if (!store) return { status: "failed" };
	try {
		return await withPeopleWrite(store, viewer.authority, run);
	} catch (error) {
		console.error(JSON.stringify({ component: "people", outcome: "write_failed", error: String(error) }));
		return { status: "failed" };
	}
}

export type { PeopleData, PeopleView } from "./page-data.ts";

export async function loadPerson(viewer: Viewer, personId: Parameters<typeof readPersonPage>[2]) {
	return read(viewer, (tx, ctx) => readPersonPage(tx, ctx, personId));
}

export async function loadPeople(viewer: Viewer, query: PeopleQuery) {
	const result = await read(viewer, async (tx, ctx) => ({ status: "ok", value: await readPeoplePage(tx, ctx, query) }));
	return result.status === "ok" ? result.value : { query, data: { kind: "failed" } as const, workspaceEmpty: false };
}
