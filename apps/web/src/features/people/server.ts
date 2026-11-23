import { requestDatabase } from "@/server/database";
import type { PlantSeat } from "@/server/request-context";
import type { PeopleContext, PeopleReply, PeopleWriteContext } from "@everyfield/contracts/people";
import type { Database } from "@everyfield/db/client";
import { PeopleReadContext, withPeopleWrite } from "@everyfield/domain/people";
import "server-only";
import type { PeopleQuery } from "./model.ts";
import { HISTORY_PAGE } from "./assessments/server.ts";
import { loadPersonFollowUps } from "../followups/server.ts";
import { readPeoplePage, readPersonPage } from "./page-data.ts";
import { canWrite } from "../../components/seat-role.ts";
import { guardedWrite, readDb, readTx } from "../../server/platform/tx.ts";
import type { WriteTx } from "@everyfield/domain/access";

export type Role = PlantSeat["role"];

export function read<T>(viewer: PlantSeat, run: (tx: WriteTx, context: PeopleContext) => Promise<PeopleReply<T>>) {
	return readTx("people", (tx) => run(tx, new PeopleReadContext(viewer.authority)));
}

function readOnPool<T>(viewer: PlantSeat, run: (db: Database, context: PeopleReadContext) => Promise<PeopleReply<T>>) {
	return readDb("people", (db) => run(db, new PeopleReadContext(viewer.authority)));
}

export function write<T>(
	viewer: PlantSeat,
	run: (tx: WriteTx, context: PeopleWriteContext) => Promise<PeopleReply<T>>,
) {
	return guardedWrite("people", () => withPeopleWrite(requestDatabase(), viewer.authority, run));
}
export type { PeopleData, PeopleView } from "./page-data.ts";

export async function loadPerson(viewer: PlantSeat, personId: Parameters<typeof readPersonPage>[2], withFields = true) {
	const followUps = withFields ? loadPersonFollowUps(viewer.authority, personId) : Promise.resolve(null);
	const loaded = await readPersonView(viewer, personId, withFields);
	const parts = await followUps;
	if (loaded.status !== "ok") return loaded;
	const { found } = loaded.value;
	const plant = withFields && found.status === "available" && "stage" in found.person;
	return { status: "ok" as const, value: { ...loaded.value, followUps: plant ? parts : null } };
}

export async function readPersonView(
	viewer: PlantSeat,
	personId: Parameters<typeof readPersonPage>[2],
	withFields = true,
) {
	const parts = withFields
		? { fields: true, duplicates: true, ...(canWrite(viewer) ? { records: HISTORY_PAGE } : {}) }
		: {};
	return readOnPool(viewer, (db, ctx) => readPersonPage(db, ctx, personId, parts));
}

export async function loadPeople(viewer: PlantSeat, query: PeopleQuery, pairs = false) {
	const result = await read(viewer, async (tx, ctx) => ({
		status: "ok",
		value: await readPeoplePage(tx, ctx, query, { pairs }),
	}));
	return result.status === "ok"
		? result.value
		: { query, data: { kind: "failed" } as const, workspaceEmpty: false, review: null };
}
