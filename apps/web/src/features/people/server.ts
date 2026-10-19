import "server-only";
import { sessionId } from "@everyfield/contracts/common";
import type { Transaction } from "@everyfield/db/client";
import type { PeopleContext, PeopleReply, PeopleWriteContext } from "@everyfield/contracts/people";
import { readPeopleViewer, PeopleReadContext } from "@everyfield/domain/people";
import { readPeoplePage, readPersonPage } from "./page-data.ts";
import type { PeopleQuery } from "./model.ts";
import { cache } from "react";
import { requestDatabase as database, getSession } from "@/server/request-context";

// Layout, pages and actions share this request's native session and actor.
// Reads consume that observation; writes recheck authority inside their transaction.

export type Viewer = Extract<Awaited<ReturnType<typeof readPeopleViewer>>, { status: "viewer" }>["viewer"];
export type Role = Viewer["role"];
export type ViewerResult =
	Awaited<ReturnType<typeof readPeopleViewer>> | { status: "signed_out" } | { status: "unavailable" };

/** One actor and own-Person summary for this request, shared by layout/page/actions. */
export const getViewer = cache(async (): Promise<ViewerResult> => {
	const store = database();
	if (!store) return { status: "unavailable" };
	try {
		const native = await getSession();
		if (!native) return { status: "signed_out" };
		const session = sessionId.parse(native.session.id);
		return await store.transaction((tx) => readPeopleViewer(tx, session));
	} catch {
		console.error(JSON.stringify({ component: "request-context", outcome: "viewer_failed" }));
		return { status: "unavailable" };
	}
});

export const canWrite = (v: Viewer) => v.role === "owner" || v.role === "admin";

/** Runs one read in its own transaction. A thrown database error reads as unavailable, never as a crash. */
export async function read<T>(
	viewer: Viewer,
	run: (tx: Transaction, context: PeopleContext) => Promise<PeopleReply<T>>,
): Promise<PeopleReply<T> | { status: "failed" }> {
	const store = database();
	if (!store) return { status: "failed" };
	try {
		return await store.transaction((tx) => run(tx, new PeopleReadContext(viewer.authority, "native")));
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
	const store = database();
	if (!store) return { status: "failed" };
	try {
		return await store.transaction((tx) =>
			run(tx, {
				session: viewer.session,
				selected: viewer.selected,
				purpose: "native",
				origin: { kind: "native" },
			}),
		);
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
