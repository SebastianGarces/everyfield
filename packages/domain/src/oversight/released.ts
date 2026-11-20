import * as C from "@everyfield/contracts/oversight";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { iso } from "../intelligence/assessment.ts";
import { concernOf, concernsSql, releasedRun, storedConcern } from "../intelligence/views.ts";

export const releasedJson = (plant: SQL, now: SQL) =>
	sql`(SELECT json_build_object('runId',rr.id,'asOf',${iso("rr.as_of")},'phase',rr.phase,'concerns',${concernsSql("rr")})
	FROM ${releasedRun(plant, now)} rr)`;
export const released = z
	.object({ runId: z.string(), asOf: z.string(), phase: z.int(), concerns: z.array(storedConcern) })
	.nullable();

export type Shares = { people: boolean; meetings: boolean; tasks: boolean; ministry: boolean };
const CATEGORIES: Record<string, readonly (keyof Shares)[]> = {
	committedAdults: ["people"],
	growth: ["people"],
	humanRecords: ["people"],
	vision: ["meetings"],
	cohesion: ["meetings", "people"],
	followUps: ["meetings", "tasks"],
	coverage: ["ministry"],
	training: ["ministry"],
};
export function releasedOf(sharedFindings: boolean, shares: Shares, r: z.infer<typeof released>): C.ReleasedAssessment {
	if (!sharedFindings) return { status: "withheld" };
	if (!r) return { status: "not_assessed" };
	const visible = (x: z.infer<typeof storedConcern>) =>
		x.keys.every((k) => (CATEGORIES[k.split(".")[0] ?? ""] ?? []).every((category) => shares[category]));
	return C.releasedAssessment.parse({
		status: "released",
		runId: r.runId,
		asOf: r.asOf,
		phase: r.phase,
		concerns: r.concerns.filter(visible).map((x) => concernOf(r.runId, x)),
		withheld: r.concerns.filter((x) => !visible(x)).length,
	});
}
export const releasedHealth = (a: C.ReleasedAssessment): C.Released =>
	a.status === "released" ? { concerns: a.concerns.length, withheld: a.withheld > 0 } : null;
