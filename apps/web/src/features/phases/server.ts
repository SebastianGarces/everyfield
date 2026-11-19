import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import { phasesError, type PhasesReply } from "@everyfield/contracts/phases";
import type { Database } from "@everyfield/db/client";
import type { RequestActor } from "@everyfield/domain/access";
import { createFacts } from "@everyfield/domain/intelligence";
import { createLaunchReader } from "@everyfield/domain/launch";
import { phaseReader, readCatalog, readReadiness, type PhaseWriter } from "@everyfield/domain/phases";
import "server-only";
import { phasesMount } from "./mount.ts";
import type { Outcome } from "./model.ts";
import { logFailure } from "@everyfield/domain/log";

type PhaseViewer = {
	authority: RequestActor;
	accountId: string;
	role: "owner" | "admin" | "member";
	displayName: string;
};

export async function phaseViewer(): Promise<PhaseViewer | null> {
	const v = await getViewer();
	const authority = v?.authority;
	if (!authority) return null;
	const ctx = authority.actor.context;
	if (ctx.kind !== "seat" || ctx.owner.kind !== "plant") return null;
	return { authority, accountId: authority.actor.accountId, role: ctx.role, displayName: v.displayName ?? "" };
}
export const administers = (v: Pick<PhaseViewer, "role">) => v.role !== "member";

const facts = createFacts();
const launch = createLaunchReader();

export async function loadJourney(viewer: PhaseViewer) {
	const db = requestDatabase();
	if (!db) return { status: "lost" } as const;
	try {
		const [history, catalog, measured, journal] = await Promise.all([
			phaseReader.readHistory(db, viewer.authority),
			readCatalog(),
			facts.readFacts(db, viewer.authority),
			launch.readJournal(db, viewer.authority),
		]);
		if (history.status !== "ok") return { status: "refused", error: history.error } as const;
		if (measured.status !== "ok") return { status: "refused", error: measured.error } as const;
		if (journal.status !== "ok") return { status: "refused", error: journal.error } as const;
		const readiness = readReadiness(catalog, measured.value.criteria);
		const launchDates = journal.value.entries.filter((e) => e.change.kind === "date");
		return {
			status: "ok",
			value: { history: history.value, catalog, readiness, facts: measured.value, launchDates },
		} as const;
	} catch (error) {
		logFailure({ component: "phases", outcome: "read_failed" }, error);
		return { status: "lost" } as const;
	}
}

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
		logFailure({ component: "phases", outcome: "write_failed" }, error);
		return { status: "lost" };
	}
}
const denied = () =>
	phasesError.parse({ code: "access_denied", details: {}, correlationId: crypto.randomUUID(), retry: "never" });
