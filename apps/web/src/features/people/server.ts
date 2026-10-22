import { requestDatabase } from "@/server/database";
import type { PeopleContext, PeopleReply, PeopleWriteContext } from "@everyfield/contracts/people";
import type { Database, Transaction } from "@everyfield/db/client";
import { type peopleViewer, PeopleReadContext, withPeopleWrite } from "@everyfield/domain/people";
import "server-only";
import type { PeopleQuery } from "./model.ts";
import { HISTORY_PAGE } from "./assessments/server.ts";
import { loadPersonFollowUps } from "../followups/server.ts";
import { readPeoplePage, readPersonPage } from "./page-data.ts";

// Layout, pages and actions share this request's native session and actor.
// Reads consume that observation; writes recheck authority inside their transaction.

export type Viewer = NonNullable<ReturnType<typeof peopleViewer>>;
export type Role = Viewer["role"];
export const canWrite = (v: Viewer) => v.role === "owner" || v.role === "admin";

/** Runs one read in its own transaction. A thrown database error reads as unavailable, never as a crash. */
export async function read<T>(
	viewer: Viewer,
	run: (tx: Transaction, context: PeopleContext) => Promise<PeopleReply<T>>,
): Promise<PeopleReply<T> | { status: "failed" }> {
	return readOnPool(viewer, (db, context) => db.transaction((tx) => run(tx, context)));
}

/** Runs one single-statement read on the pool, with no transaction around it. A thrown database error reads as unavailable. */
async function readOnPool<T>(
	viewer: Viewer,
	run: (db: Database, context: PeopleReadContext) => Promise<PeopleReply<T>>,
): Promise<PeopleReply<T> | { status: "failed" }> {
	const store = requestDatabase();
	if (!store) return { status: "failed" };
	try {
		return await run(store, new PeopleReadContext(viewer.authority));
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

/**
 * The person page: the person read in one statement on the pool (readPersonView) and, for the page itself, the
 * follow-ups and contact log (WP-023) in their own short transaction at the same time, on a second connection: they
 * need nothing from the person read, and running beside it keeps the page within its one-second budget (C77). They
 * show only for a plant person. A conflict reload passes `withFields: false`: it needs only the person and Activity.
 */
export async function loadPerson(viewer: Viewer, personId: Parameters<typeof readPersonPage>[2], withFields = true) {
	const followUps = withFields ? loadPersonFollowUps(viewer.authority, personId) : Promise.resolve(null);
	const loaded = await readPersonView(viewer, personId, withFields);
	const parts = await followUps;
	if (loaded.status !== "ok") return loaded;
	const { found } = loaded.value;
	const plant = withFields && found.status === "available" && "stage" in found.person;
	return { status: "ok" as const, value: { ...loaded.value, followUps: plant ? parts : null } };
}

/**
 * The person, their first Activity page and, with `withFields`, their WP-012 fields and duplicate hints (WP-015), in
 * one statement on the pool. An Owner or Admin's page also reads the person's 4 C's, interviews and commitments; no
 * one else's page asks for them. Each field card reads its own part again when its own save is refused.
 */
export async function readPersonView(
	viewer: Viewer,
	personId: Parameters<typeof readPersonPage>[2],
	withFields = true,
) {
	const parts = withFields
		? { fields: true, duplicates: true, ...(canWrite(viewer) ? { records: HISTORY_PAGE } : {}) }
		: {};
	return readOnPool(viewer, (db, ctx) => readPersonPage(db, ctx, personId, parts));
}

export async function loadPeople(viewer: Viewer, query: PeopleQuery) {
	const result = await read(viewer, async (tx, ctx) => ({ status: "ok", value: await readPeoplePage(tx, ctx, query) }));
	return result.status === "ok" ? result.value : { query, data: { kind: "failed" } as const, workspaceEmpty: false };
}
