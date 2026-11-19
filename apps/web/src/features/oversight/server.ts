import type { RequestActor } from "@everyfield/domain/access";
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
import { requestDatabase } from "../../server/database";
import { getViewer } from "../../server/request-context";
import { logFailure } from "@everyfield/domain/log";

export type OversightViewer = {
	authority: RequestActor;
	organizationKind: "sending_church" | "sending_network";
};

export async function oversightViewer(): Promise<
	{ kind: "signed_out" } | { kind: "other" } | { kind: "organization"; viewer: OversightViewer }
> {
	const v = await getViewer();
	if (!v || v.status === "unauthenticated") return { kind: "signed_out" };
	const context = v.authority?.actor.context;
	if (!v.authority || context?.kind !== "seat" || context.owner.kind !== "organization") return { kind: "other" };
	return {
		kind: "organization",
		viewer: { authority: v.authority, organizationKind: context.owner.organizationKind },
	};
}

export type Loaded<T> = { status: "ok"; value: T } | { status: "missing" } | { status: "lost" };

async function load<T>(read: (db: Database) => Promise<T | null>): Promise<Loaded<T>> {
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		const value = await read(db);
		return value === null ? { status: "missing" } : { status: "ok", value };
	} catch (error) {
		logFailure({ component: "oversight", outcome: "read_failed" }, error);
		return { status: "lost" };
	}
}

export const loadDirectory = (v: OversightViewer) => load((db) => listPlants(db, v.authority));
export const loadPlant = (v: OversightViewer, plantId: string) =>
	load((db) =>
		getPlant(db, v.authority, plantId, (section, error) =>
			logFailure({ component: "oversight", outcome: "section_failed", section }, error),
		),
	);
export const loadRoster = (v: OversightViewer) => load((db) => listSendingChurches(db, v.authority));
export const loadSendingChurch = (v: OversightViewer, churchId: string) =>
	load((db) => getSendingChurch(db, v.authority, churchId));
export const loadIntelligence = (v: OversightViewer, level: Level, runId: string | null) =>
	load((db) => readIntelligence(db, v.authority, { level, runId }));
