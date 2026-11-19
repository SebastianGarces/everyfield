import { requestDatabase } from "@/server/database";
import type { PeopleContext, PeopleReply, PeopleWriteContext } from "@everyfield/contracts/people";
import type { Database, Transaction } from "@everyfield/db/client";
import { type peopleViewer, PeopleReadContext, withPeopleWrite } from "@everyfield/domain/people";
import "server-only";
import type { PeopleQuery } from "./model.ts";
import { HISTORY_PAGE } from "./assessments/server.ts";
import { loadPersonFollowUps } from "../followups/server.ts";
import { readPeoplePage, readPersonPage } from "./page-data.ts";
import { canWrite } from "../../components/seat-role.ts";
import { transient } from "../../server/platform/transient.ts";

export type Viewer = NonNullable<ReturnType<typeof peopleViewer>>;
export type Role = Viewer["role"];

export async function read<T>(
	viewer: Viewer,
	run: (tx: Transaction, context: PeopleContext) => Promise<PeopleReply<T>>,
): Promise<PeopleReply<T> | { status: "failed" }> {
	return readOnPool(viewer, (db, context) => db.transaction((tx) => run(tx, context)));
}

async function readOnPool<T>(
	viewer: Viewer,
	run: (db: Database, context: PeopleReadContext) => Promise<PeopleReply<T>>,
): Promise<PeopleReply<T> | { status: "failed" }> {
	const store = requestDatabase();
	return transient(
		{ component: "people", outcome: "read_failed" },
		() => run(store, new PeopleReadContext(viewer.authority)),
		{ status: "failed" },
	);
}

export async function write<T>(
	viewer: Viewer,
	run: (tx: Transaction, context: PeopleWriteContext) => Promise<PeopleReply<T>>,
): Promise<PeopleReply<T> | { status: "failed" }> {
	const store = requestDatabase();
	return transient(
		{ component: "people", outcome: "write_failed" },
		() => withPeopleWrite(store, viewer.authority, run),
		{ status: "failed" },
	);
}

export type { PeopleData, PeopleView } from "./page-data.ts";

export async function loadPerson(viewer: Viewer, personId: Parameters<typeof readPersonPage>[2], withFields = true) {
	const followUps = withFields ? loadPersonFollowUps(viewer.authority, personId) : Promise.resolve(null);
	const loaded = await readPersonView(viewer, personId, withFields);
	const parts = await followUps;
	if (loaded.status !== "ok") return loaded;
	const { found } = loaded.value;
	const plant = withFields && found.status === "available" && "stage" in found.person;
	return { status: "ok" as const, value: { ...loaded.value, followUps: plant ? parts : null } };
}

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

export async function loadPeople(viewer: Viewer, query: PeopleQuery, pairs = false) {
	const result = await read(viewer, async (tx, ctx) => ({
		status: "ok",
		value: await readPeoplePage(tx, ctx, query, { pairs }),
	}));
	return result.status === "ok"
		? result.value
		: { query, data: { kind: "failed" } as const, workspaceEmpty: false, review: null };
}
