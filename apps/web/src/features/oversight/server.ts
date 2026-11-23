import type { Database } from "@everyfield/db/client";
import type { Level } from "@everyfield/contracts/oversight";
import {
	getPlant,
	getSendingChurch,
	listPlants,
	listSendingChurches,
	readIntelligence,
} from "@everyfield/domain/oversight";
import "server-only";
import type { OrganizationSeat } from "../../server/request-context";
import { logFailure } from "@everyfield/domain/log";
import { readDb } from "../../server/platform/tx.ts";

export type Loaded<T> = { status: "ok"; value: T } | { status: "missing" } | { status: "lost" };

function load<T>(read: (db: Database) => Promise<T | null>): Promise<Loaded<T>> {
	return readDb("oversight", async (db) => {
		const value = await read(db);
		return value === null ? { status: "missing" } : { status: "ok", value };
	});
}

export const loadDirectory = (v: OrganizationSeat) => load((db) => listPlants(db, v.authority));
export const loadPlant = (v: OrganizationSeat, plantId: string) =>
	load((db) =>
		getPlant(db, v.authority, plantId, (section, error) =>
			logFailure({ component: "oversight", outcome: "section_failed", section }, error),
		),
	);
export const loadRoster = (v: OrganizationSeat) => load((db) => listSendingChurches(db, v.authority));
export const loadSendingChurch = (v: OrganizationSeat, churchId: string) =>
	load((db) => getSendingChurch(db, v.authority, churchId));
export const loadIntelligence = (v: OrganizationSeat, level: Level, runId: string | null) =>
	load((db) => readIntelligence(db, v.authority, { level, runId }));
