"use server";

import { pipelineWrite } from "../organizations/pipeline-mount";
import { requestDatabase } from "@/server/database";
import { organizationSeat } from "@/server/request-context";
import { level, type IntelligenceView } from "@everyfield/contracts/oversight";
import { submitIntelligenceFeedback, readIntelligence, requestIntelligenceRefresh } from "@everyfield/domain/oversight";

export async function refreshIntelligence(
	runId: string,
	shownLevel: string,
): Promise<{ status: "ok"; view: IntelligenceView } | { status: "refused" } | { status: "lost" }> {
	const ran = await pipelineWrite((db, authority) => requestIntelligenceRefresh(db, authority, { runId }));
	if (ran.status !== "ok") return ran.status === "lost" ? { status: "lost" } : { status: "refused" };
	const seat = await organizationSeat();
	if (!seat) return { status: "refused" };
	const db = requestDatabase();
	const view = await readIntelligence(db, seat.authority, {
		level: level.catch("portfolio").parse(shownLevel),
		runId,
	});
	return view ? { status: "ok", view } : { status: "lost" };
}

export async function ratePattern(input: unknown) {
	return pipelineWrite((db, authority) => submitIntelligenceFeedback(db, authority, input));
}
