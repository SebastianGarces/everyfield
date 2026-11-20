"use server";

import { pipelineWrite } from "../organizations/pipeline-mount";
import { requestDatabase } from "@/server/database";
import { oversightViewer } from "./server.ts";
import { level, type IntelligenceView } from "@everyfield/contracts/oversight";
import { submitIntelligenceFeedback, readIntelligence, requestIntelligenceRefresh } from "@everyfield/domain/oversight";

export async function refreshIntelligence(
	runId: string,
	shownLevel: string,
): Promise<{ status: "ok"; view: IntelligenceView } | { status: "refused" } | { status: "lost" }> {
	const ran = await pipelineWrite((db, authority) => requestIntelligenceRefresh(db, authority, { runId }));
	if (ran.status !== "ok") return ran.status === "lost" ? { status: "lost" } : { status: "refused" };
	const who = await oversightViewer();
	if (who.kind !== "organization") return { status: "refused" };
	const db = requestDatabase();
	const view = await readIntelligence(db, who.viewer.authority, {
		level: level.catch("portfolio").parse(shownLevel),
		runId,
	});
	return view ? { status: "ok", view } : { status: "lost" };
}

export async function ratePattern(input: unknown) {
	return pipelineWrite((db, authority) => submitIntelligenceFeedback(db, authority, input));
}
