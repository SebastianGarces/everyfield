"use server";

import { pipelineWrite } from "@/server/organizations/pipeline";
import { requestDatabase } from "@/server/database";
import { oversightViewer } from "@/server/oversight";
import { level, type IntelligenceView } from "@everyfield/contracts/oversight";
import { rateIntelligence, readIntelligence, runIntelligence } from "@everyfield/domain/oversight";

// Server actions behind Network Intelligence (WP-047b). Each rebuilds the request actor; the domain parses the input and
// rechecks the seat, so a Member's refresh or rating is refused on the server whatever the page shows.

/** A new run, then that run at the level the page shows: the page replaces its view with the answer. */
export async function refreshIntelligence(
	runId: string,
	shownLevel: string,
): Promise<{ status: "ok"; view: IntelligenceView } | { status: "refused" } | { status: "lost" }> {
	const ran = await pipelineWrite((db, authority) => runIntelligence(db, authority, { runId }));
	if (ran.status !== "ok") return ran.status === "lost" ? { status: "lost" } : { status: "refused" };
	const who = await oversightViewer();
	const db = requestDatabase();
	if (who.kind !== "organization" || !db) return { status: "lost" };
	const view = await readIntelligence(db, who.viewer.authority, {
		level: level.catch("portfolio").parse(shownLevel),
		runId,
	});
	return view ? { status: "ok", view } : { status: "lost" };
}

/** This seat's own rating of one pattern in one run. */
export async function ratePattern(input: unknown) {
	return pipelineWrite((db, authority) => rateIntelligence(db, authority, input));
}
