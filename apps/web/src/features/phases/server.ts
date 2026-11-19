import { plantSeat, type PlantSeat } from "@/server/request-context";
import { phasesError, type PhasesReply } from "@everyfield/contracts/phases";
import type { Database } from "@everyfield/db/client";
import type { RequestActor } from "@everyfield/domain/access";
import { createFacts } from "@everyfield/domain/intelligence";
import { createLaunchReader } from "@everyfield/domain/launch";
import { phaseReader, readCatalog, readReadiness, type PhaseWriter } from "@everyfield/domain/phases";
import "server-only";
import { phasesMount } from "./mount.ts";
import type { Outcome } from "./model.ts";
import { readDb, guardedWrite } from "../../server/platform/tx.ts";

export const administers = (v: Pick<PlantSeat, "role">) => v.role !== "member";

const facts = createFacts();
const launch = createLaunchReader();

export async function loadJourney(viewer: PlantSeat) {
	return readDb("phases", async (db) => {
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
	});
}

export async function write<T>(
	run: (writer: PhaseWriter, db: Database, authority: RequestActor) => Promise<PhasesReply<T>>,
): Promise<Outcome<T>> {
	const viewer = await plantSeat();
	if (!viewer) return { status: "refused", error: denied() };
	const mount = phasesMount();
	return guardedWrite("phases", () => run(mount.writer, mount.db, viewer.authority));
}
const denied = () =>
	phasesError.parse({ code: "access_denied", details: {}, correlationId: crypto.randomUUID(), retry: "never" });
