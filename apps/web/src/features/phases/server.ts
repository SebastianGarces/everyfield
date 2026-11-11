import { requestDatabase } from "@/server/database";
import { phasesMount } from "@/server/phases";
import { getViewer } from "@/server/request-context";
import { phasesError, type PhasesReply } from "@everyfield/contracts/phases";
import type { Database } from "@everyfield/db/client";
import type { RequestActor } from "@everyfield/domain/access";
import { phaseReader, readCatalog, readReadiness, type PhaseWriter } from "@everyfield/domain/phases";
import "server-only";
import type { Outcome } from "./model.ts";

// The journey screen reaches the phases domain here. Pages and actions share the request's one viewer (D59/D60). Every
// read and write rechecks the live Owner or Admin seat inside its own statement (C13, D70).

type PhaseViewer = {
	authority: RequestActor;
	accountId: string;
	role: "owner" | "admin" | "member";
	displayName: string;
};

/** The request's plant seat, or null for a signed-out reader, an organization seat or an account without a seat. */
export async function phaseViewer(): Promise<PhaseViewer | null> {
	const v = await getViewer();
	const authority = v?.authority;
	if (!authority) return null;
	const ctx = authority.actor.context;
	if (ctx.kind !== "seat" || ctx.owner.kind !== "plant") return null;
	return { authority, accountId: authority.actor.accountId, role: ctx.role, displayName: v.displayName ?? "" };
}
export const administers = (v: Pick<PhaseViewer, "role">) => v.role !== "member";

/**
 * The /intelligence page: the journey (one statement), the catalog and the advisory readiness of every phase (no
 * statement until WP-040 measures criteria). A database failure reads as lost, never as an empty journey.
 */
export async function loadJourney(viewer: PhaseViewer) {
	const db = requestDatabase();
	if (!db) return { status: "lost" } as const;
	try {
		const [history, catalog] = await Promise.all([phaseReader.readHistory(db, viewer.authority), readCatalog()]);
		if (history.status !== "ok") return { status: "refused", error: history.error } as const;
		return { status: "ok", value: { history: history.value, catalog, readiness: readReadiness(catalog) } } as const;
	} catch (error) {
		console.error(JSON.stringify({ component: "phases", outcome: "read_failed", error: String(error) }));
		return { status: "lost" } as const;
	}
}

/** One phase write for the request's viewer. */
export async function write<T>(
	run: (writer: PhaseWriter, db: Database, authority: RequestActor) => Promise<PhasesReply<T>>,
): Promise<Outcome<T>> {
	const viewer = await phaseViewer();
	if (!viewer) return { status: "refused", error: denied() };
	const mount = phasesMount();
	if (!mount) return { status: "lost" };
	try {
		return await run(mount.writer, mount.db, viewer.authority);
	} catch (error) {
		console.error(JSON.stringify({ component: "phases", outcome: "write_failed", error: String(error) }));
		return { status: "lost" };
	}
}
const denied = () =>
	phasesError.parse({ code: "access_denied", details: {}, correlationId: crypto.randomUUID(), retry: "never" });
