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
import { requestDatabase } from "../database";
import { getViewer } from "../request-context";

// The organization oversight pages (/network) reach the oversight reads here. Pages share the request's one viewer
// (D59/D60); every read rechecks the seat's live access, the plant's own link and its sharing inside its statements
// (C13). Nothing here keeps a result between requests, so a choice turned off shows on the next load.

export type OversightViewer = {
	authority: RequestActor;
	organizationKind: "sending_church" | "sending_network";
};

/** Who opens an oversight page: signed out, an organization seat, or anyone else (a plant seat or seatless account). */
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

/** A read's answer: its value, `missing` when the read found nothing this seat may see, or `lost` on a failure. */
export type Loaded<T> = { status: "ok"; value: T } | { status: "missing" } | { status: "lost" };

async function load<T>(read: (db: Database) => Promise<T | null>): Promise<Loaded<T>> {
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		const value = await read(db);
		return value === null ? { status: "missing" } : { status: "ok", value };
	} catch (error) {
		console.error(JSON.stringify({ component: "oversight", outcome: "read_failed", error: String(error) }));
		return { status: "lost" };
	}
}

export const loadDirectory = (v: OversightViewer) => load((db) => listPlants(db, v.authority));
export const loadPlant = (v: OversightViewer, plantId: string) =>
	load((db) =>
		getPlant(db, v.authority, plantId, (section, error) =>
			console.error(
				JSON.stringify({ component: "oversight", outcome: "section_failed", section, error: String(error) }),
			),
		),
	);
export const loadRoster = (v: OversightViewer) => load((db) => listSendingChurches(db, v.authority));
export const loadSendingChurch = (v: OversightViewer, churchId: string) =>
	load((db) => getSendingChurch(db, v.authority, churchId));
export const loadIntelligence = (v: OversightViewer, level: Level, runId: string | null) =>
	load((db) => readIntelligence(db, v.authority, { level, runId }));
