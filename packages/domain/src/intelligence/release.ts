import type { Clock } from "@everyfield/contracts/common";
import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { iso, plantHidden } from "./assessment.ts";
import { RELEASE_HOURS } from "./views.ts";

export const releaseRequest = z.strictObject({
	plantId: z.uuid(),
	assessmentId: z.uuid(),
	releaseCause: z.literal("elapsed_72_hours"),
	requestKey: z.uuid(),
});
const released = z.object({ runId: z.uuid(), releasedAt: z.string(), cause: z.enum(["opened", "elapsed_72_hours"]) });
export type Release = z.infer<typeof released>;
export type ReleaseReply =
	| { status: "ok"; value: Release }
	| { status: "refused"; error: { code: "invalid_input" | "not_found" | "not_due" } };

const releaseJson = (x: "x" | "e") =>
	sql`json_build_object('runId',${sql.raw(x)}.run_id,'releasedAt',${x === "x" ? iso("x.released_at") : iso("e.released_at")},
	'cause',${sql.raw(x)}.cause)`;

function releaseSql(due: SQL, at: SQL, key: SQL) {
	return sql`WITH t AS (SELECT ${at} AS at),
due AS (SELECT r.id,r.plant_id FROM assessment_run r,t WHERE ${due} AND r.outcome='published'
	AND r.available_at+make_interval(hours=>${RELEASE_HOURS})<=t.at AND NOT ${plantHidden(sql`r.plant_id`)}
	AND NOT EXISTS(SELECT FROM assessment_release x WHERE x.run_id=r.id)),
x AS (INSERT INTO assessment_release(run_id,plant_id,released_at,cause,request_key)
	SELECT due.id,due.plant_id,t.at,'elapsed_72_hours',${key} FROM due,t ON CONFLICT DO NOTHING
	RETURNING run_id,plant_id,released_at,cause),
a AS (INSERT INTO audit_event(tenant_id,system_cause,action,kind,subject_type,subject_id,event_key,metadata)
	SELECT x.plant_id,'assessment_release','intelligence.released','create','plant',x.plant_id,'assessment-released:'||x.run_id,
		jsonb_build_object('runId',x.run_id,'cause',x.cause) FROM x RETURNING 1)`;
}

export function createRelease(config: { clock?: Clock } = {}) {
	const now = () =>
		config.clock ? sql`${new Date(config.clock.now()).toISOString()}::timestamptz` : sql`clock_timestamp()`;
	return {
		async releaseAssessmentToOversight(db: Pick<Database, "execute">, raw: unknown): Promise<ReleaseReply> {
			const q = releaseRequest.safeParse(raw);
			if (!q.success) return { status: "refused", error: { code: "invalid_input" } };
			const { plantId, assessmentId, requestKey } = q.data;
			const { rows } = await db.execute(sql`${releaseSql(
				sql`r.id=${assessmentId}::uuid AND r.plant_id=${plantId}::uuid`,
				now(),
				sql`${requestKey}::uuid`,
			)}
SELECT (SELECT ${releaseJson("x")} FROM x) AS added,
	(SELECT ${releaseJson("e")} FROM assessment_release e WHERE e.run_id=${assessmentId}::uuid
		AND e.plant_id=${plantId}::uuid) AS existing,
	EXISTS(SELECT FROM assessment_run r WHERE r.id=${assessmentId}::uuid AND r.plant_id=${plantId}::uuid
		AND r.outcome='published') AS found`);
			const r = z
				.object({ added: released.nullable(), existing: released.nullable(), found: z.boolean() })
				.parse(rows[0]);
			const value = r.added ?? r.existing;
			if (value) return { status: "ok", value };
			return { status: "refused", error: { code: r.found ? "not_due" : "not_found" } };
		},

		async releaseDueAssessments(db: Pick<Database, "execute">, limit = 50) {
			z.int().min(1).max(500).parse(limit);
			const { rows } = await db.execute(sql`${releaseSql(
				sql`r.id IN (SELECT q.id FROM assessment_run q WHERE q.outcome='published'
					AND q.available_at+make_interval(hours=>${RELEASE_HOURS})<=t.at
					AND NOT EXISTS(SELECT FROM assessment_release y WHERE y.run_id=q.id)
					ORDER BY q.available_at,q.id LIMIT ${limit})`,
				now(),
				sql`NULL::uuid`,
			)}
SELECT count(*)::int AS n FROM x`);
			return z.object({ n: z.int() }).parse(rows[0]).n;
		},
	};
}
export type AssessmentRelease = ReturnType<typeof createRelease>;
