import { requestDatabase } from "@/server/database";
import { plantSeat, type PlantSeat } from "@/server/request-context";
import { refusedWith, withError } from "@everyfield/contracts/common";
import { careError, type CarePage, type CareReply } from "@everyfield/contracts/intelligence";
import type { Database } from "@everyfield/db/client";
import type { RequestActor } from "@everyfield/domain/access";
import { createPrivateCare, type PrivateCare } from "@everyfield/domain/intelligence";
import "server-only";
import type { Outcome } from "./model.ts";
import { LOST, transient } from "../../server/platform/transient.ts";
import { readDb } from "../../server/platform/tx.ts";

const care = createPrivateCare();

export async function loadCheckIn(viewer: PlantSeat): Promise<Outcome<CarePage>> {
	return readDb("private-care", async (db) => withError(await care.readTrends(db, viewer.authority, {})));
}

type Body<T> = (care: PrivateCare, db: Database, authority: RequestActor) => Promise<CareReply<T>>;

export const run = async <T>(body: Body<T>) => runAs(await plantSeat(), body);

export async function runAs<T>(viewer: PlantSeat | null, body: Body<T>): Promise<Outcome<T>> {
	if (!viewer)
		return refusedWith(
			careError.parse({
				code: "access_denied",
				details: {},
				correlationId: crypto.randomUUID(),
				retry: "never",
			}),
		);
	const db = requestDatabase();
	return transient(
		{ component: "private-care", outcome: "call_failed" },
		async () => withError(await body(care, db, viewer.authority)),
		LOST,
	);
}
