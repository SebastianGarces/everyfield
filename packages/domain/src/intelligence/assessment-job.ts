import type { Clock } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/intelligence";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { pgCode } from "../wiki/core.ts";
import {
	draftWithin,
	heldSql,
	insightsOf,
	iso,
	NO_PROGRESS,
	plantHidden,
	publication,
	type Drafted,
	type Drafter,
	type DraftProgress,
} from "./assessment.ts";
import { captureFacts } from "./facts.ts";
import { retrieveMethodology, type Retrieved } from "./retrieval.ts";

export const ASSESSMENT_TIMING = {
	staleDays: 7,
	leaseMs: 5 * 60_000,
	deadlineMs: 60 * 60_000,
	backoffMs: [30_000, 60_000, 120_000, 240_000],
} as const;

const claimRow = z.object({
	id: z.uuid(),
	plant: z.uuid(),
	key: z.string(),
	generation: z.string(),
	run: z
		.object({
			id: z.uuid(),
			outcome: c.runOutcome,
			model_input: c.modelInput.nullable(),
			drafts: z.array(
				z.object({ ordinal: z.int(), attempts: z.int(), output: z.unknown(), violations: z.array(c.violation) }),
			),
			attempts: z.int(),
			input_tokens: z.int(),
			output_tokens: z.int(),
			pending_attempts: z.int(),
			as_of: z.string(),
			source_revision: z.string(),
			deadline_at: z.string(),
		})
		.nullable(),
	last: z.object({ source_revision: z.string(), reference_activation: z.coerce.number().nullable() }).nullable(),
});
type Claim = z.infer<typeof claimRow> & { owner: string };
type Run = { id: string; plant: string; input: c.ModelInput; asOf: string; revision: string; deadline: number };

const demandOf = (key: string): c.DemandKind => {
	const kind = key.slice(0, key.indexOf("/"));
	return kind === "reference" ? "change" : c.demandKind.parse(kind);
};
const json = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;
const progressOf = (run: NonNullable<Claim["run"]>): DraftProgress => ({
	drafts: run.drafts,
	usage: { attempts: run.attempts, inputTokens: run.input_tokens, outputTokens: run.output_tokens },
	pendingAttempts: run.pending_attempts,
});
const counters = (p: DraftProgress) => sql`drafts=${json(p.drafts)},attempts=${p.usage.attempts},
	input_tokens=${p.usage.inputTokens},output_tokens=${p.usage.outputTokens},pending_attempts=${p.pendingAttempts}`;

export function createAssessmentJob(config: { clock?: Clock } = {}) {
	const nowMs = () => (config.clock ? Date.parse(config.clock.now()) : Date.now());
	const now = () => (config.clock ? sql`${config.clock.now()}::timestamptz` : sql`clock_timestamp()`);
	const later = (ms: number) =>
		config.clock
			? sql`${new Date(nowMs() + ms).toISOString()}::timestamptz`
			: sql`clock_timestamp()+make_interval(secs=>${ms / 1000})`;
	const lock = (j: Claim) => sql`lk AS (SELECT j.id FROM job j WHERE j.id=${j.id}::uuid AND j.kind='assessment'
	AND j.state='claimed' AND j.claim_generation=${j.generation}::bigint AND j.lease_owner=${j.owner}
	AND j.lease_until>${now()} FOR UPDATE)`;
	const finish = (state: string, code: string | null) => sql`fin AS (UPDATE job SET state=${state},error_code=${code},
	lease_owner=NULL,lease_until=NULL,next_attempt_at=NULL,finished_at=clock_timestamp(),revision=revision+1
	WHERE id IN (SELECT id FROM lk) AND EXISTS(SELECT FROM r) RETURNING 1)`;
	const audit = sql`a AS (INSERT INTO audit_event(tenant_id,system_cause,action,kind,subject_type,subject_id,event_key,metadata)
	SELECT r.plant_id,'assessment_job','intelligence.assessed','create','plant',r.plant_id,'assessment:'||r.id,
		jsonb_build_object('runId',r.id,'outcome',r.outcome,'reason',r.reason,'demand',r.demand,'grounding',r.grounding,
			'drafts',jsonb_array_length(r.drafts),'model',r.model) FROM r RETURNING 1)`;

	async function claim(db: Database): Promise<Claim | null> {
		const owner = randomUUID();
		const { rows } = await db.execute(sql`WITH due AS (SELECT j.id FROM job j WHERE j.kind='assessment' AND (
		(j.state IN ('ready','retry_wait') AND j.eligible_at<=${now()} AND coalesce(j.next_attempt_at,j.eligible_at)<=${now()})
		OR (j.state='claimed' AND j.lease_until<=${now()}))
	ORDER BY coalesce(j.next_attempt_at,j.eligible_at),j.id FOR UPDATE SKIP LOCKED LIMIT 1),
up AS (UPDATE job j SET state='claimed',attempt_count=j.attempt_count+1,claim_generation=j.claim_generation+1,
	lease_owner=${owner},lease_until=${later(ASSESSMENT_TIMING.leaseMs)},next_attempt_at=NULL,revision=j.revision+1
	FROM due WHERE j.id=due.id RETURNING j.id,j.subject_record_id,j.producer_key,j.claim_generation)
SELECT up.id,up.subject_record_id AS plant,up.producer_key AS key,up.claim_generation::text AS generation,
	(SELECT json_build_object('id',r.id,'outcome',r.outcome,'model_input',r.model_input,'drafts',r.drafts,'attempts',r.attempts,
		'input_tokens',r.input_tokens,'output_tokens',r.output_tokens,'pending_attempts',r.pending_attempts,
		'as_of',${iso("r.as_of")},'source_revision',r.source_revision,'deadline_at',${iso("r.deadline_at")})
		FROM assessment_run r WHERE r.plant_id=up.subject_record_id AND r.demand_key=up.producer_key) AS run,
	(SELECT json_build_object('source_revision',r.source_revision,'reference_activation',r.reference_activation)
		FROM assessment_run r WHERE r.plant_id=up.subject_record_id AND r.outcome<>'superseded'
		ORDER BY r.captured_at DESC,r.id DESC LIMIT 1) AS last
FROM up`);
		return rows[0] ? { ...claimRow.parse(rows[0]), owner } : null;
	}

	async function close(db: Pick<Database, "execute">, j: Claim, state: "succeeded" | "cancelled", code: string) {
		await db.execute(sql`WITH ${lock(j)}, r AS (SELECT 1),
${finish(state, code)} SELECT 1`);
	}

	async function capture(db: Database, j: Claim, model: string): Promise<Run | "none"> {
		const runId = randomUUID();
		const demand = demandOf(j.key);
		return db.transaction(
			async (tx) => {
				await tx.execute(sql`SELECT set_config('lock_timeout','1s',true)`);
				const f = await captureFacts(tx, j.plant, config.clock ? config.clock.now() : null);
				if (!f) {
					await close(tx, j, "cancelled", "plant_removed");
					return "none" as const;
				}
				let retrieved: Retrieved;
				try {
					retrieved = await tx.transaction((t) => retrieveMethodology(t, j.plant));
				} catch (error) {
					const code = pgCode(error);
					if (code !== "55P03" && code !== "57014") throw error;
					retrieved = { status: "unavailable", phase: null };
				}
				const activation = retrieved.status === "ok" ? retrieved.activation : null;
				if (
					demand === "change" &&
					j.last?.source_revision === f.sourceRevision &&
					(j.last.reference_activation ?? null) === (activation?.number ?? null)
				) {
					await close(tx, j, "succeeded", "unchanged");
					return "none" as const;
				}
				const input =
					retrieved.status === "ok"
						? c.modelInput.parse({
								phase: retrieved.phase,
								asOf: f.asOf,
								today: f.today,
								rubric: c.ACTIVE_PLANT_RUBRIC,
								facts: c.factCatalog(f),
								passages: retrieved.passages,
							})
						: null;
				const degraded = !input;
				const reason = retrieved.status === "unavailable" ? "guidance_unavailable" : "reference_missing";
				const rubric = c.PLANT_RUBRICS[c.ACTIVE_PLANT_RUBRIC];
				const requested = j.key.startsWith("manual/")
					? sql`(SELECT e.actor_id FROM audit_event e WHERE e.subject_id=${j.plant}::uuid
						AND e.event_key=${"assessment-refresh:" + j.key.slice(7)})`
					: sql`NULL::uuid`;
				const asOf = f.asOf;
				const deadline = Date.parse(asOf) + ASSESSMENT_TIMING.deadlineMs;
				const { rows } = await tx.execute(sql`WITH ${lock(j)},
r AS (INSERT INTO assessment_run(id,plant_id,requested_by,as_of,phase,source_revision,formula_version,rubric_version,
	rubric_sha256,reference_release,reference_activation,model,outcome,grounding,reason,facts,model_input,drafts,result,
	attempts,input_tokens,output_tokens,demand,demand_key,captured_at,deadline_at,settled_at)
	SELECT ${runId}::uuid,pl.id,${requested},${asOf}::timestamptz,coalesce(${retrieved.phase}::int,pl.phase),
		${f.sourceRevision},${f.formulaVersion},${c.ACTIVE_PLANT_RUBRIC},${rubric.sha256},${activation?.release ?? null},
		${activation?.number ?? null}::bigint,${model},${degraded ? "degraded" : "pending"},
		${degraded ? "degraded" : "grounded"},${degraded ? reason : null},${json(f)},${input && JSON.stringify(input)}::jsonb,
		'[]'::jsonb,NULL,0,0,0,${demand},${j.key},transaction_timestamp(),${new Date(deadline).toISOString()}::timestamptz,
		${degraded ? sql`clock_timestamp()` : sql`NULL`}
	FROM plant pl WHERE pl.id=${j.plant}::uuid AND EXISTS(SELECT FROM lk)
	RETURNING id,plant_id,outcome,reason,demand,grounding,drafts,model)${
		degraded ? sql`, ${audit}, ${finish("failed", reason)}` : sql``
	}
SELECT EXISTS(SELECT FROM r) AS ok`);
				if (!z.object({ ok: z.boolean() }).parse(rows[0]).ok || !input) return "none" as const;
				return { id: runId, plant: j.plant, input, asOf, revision: f.sourceRevision, deadline };
			},
			{ isolationLevel: "repeatable read" },
		);
	}
	async function reserve(db: Database, j: Claim, run: Run, p: DraftProgress) {
		const { rows } = await db.execute(sql`WITH ${lock(j)},
r AS (UPDATE assessment_run SET outcome='pending',retry_at=NULL,${counters(p)}
	WHERE id=${run.id}::uuid AND outcome IN ('pending','deferred') AND EXISTS(SELECT FROM lk) RETURNING 1),
l AS (UPDATE job SET lease_until=${later(ASSESSMENT_TIMING.leaseMs)},revision=revision+1
	WHERE id IN (SELECT id FROM lk) AND EXISTS(SELECT FROM r) RETURNING 1)
SELECT EXISTS(SELECT FROM r) AS ok`);
		return z.object({ ok: z.boolean() }).parse(rows[0]).ok;
	}

	async function settleRun(
		db: Database,
		j: Claim,
		run: Run,
		p: DraftProgress,
		outcome: "failed" | "deferred" | "superseded",
		reason: c.RunReason,
		extra: { waitMs?: number; followup?: boolean } = {},
	) {
		const deferred = outcome === "deferred";
		const jobEnd = deferred
			? sql`fin AS (UPDATE job SET state='retry_wait',error_code=${reason},attempt_count=0,lease_owner=NULL,lease_until=NULL,
	next_attempt_at=(SELECT t FROM w),revision=revision+1 WHERE id IN (SELECT id FROM lk) AND EXISTS(SELECT FROM r) RETURNING 1)`
			: finish(outcome === "superseded" ? "superseded" : "failed", reason);
		const followup = extra.followup
			? sql`, f AS (INSERT INTO job(tenant_id,kind,subject_record_id,producer_key,state,eligible_at,attempt_count,max_attempts,
	claim_generation) SELECT r.plant_id,'assessment',r.plant_id,'followup/'||r.id::text,'ready',${now()},0,10,0 FROM r
	ON CONFLICT DO NOTHING RETURNING 1)`
			: sql``;
		await db.execute(sql`WITH ${lock(j)},
w AS (SELECT ${deferred ? later(extra.waitMs!) : sql`NULL::timestamptz`} AS t),
r AS (UPDATE assessment_run SET outcome=${outcome},reason=${reason},${counters(p)},
	retry_at=(SELECT t FROM w),settled_at=${deferred ? sql`NULL` : sql`clock_timestamp()`}
	WHERE id=${run.id}::uuid AND outcome IN ('pending','deferred') AND EXISTS(SELECT FROM lk)
	RETURNING id,plant_id,outcome,reason,demand,grounding,drafts,model),
${jobEnd}${deferred ? sql`` : sql`, ${audit}`}${followup}
SELECT 1`);
	}

	async function publish(db: Database, j: Claim, run: Run, p: DraftProgress, draft: c.DraftOutput) {
		const prior = sql`(SELECT q.id,q.as_of,q.model_input FROM assessment_run q WHERE q.plant_id=${run.plant}::uuid
	AND q.outcome='published' ORDER BY q.available_at DESC,q.id DESC LIMIT 1)`;
		const { rows } = await db.execute(sql`WITH ${lock(j)},
act AS (SELECT a.activation_number AS n FROM reference_activation a ORDER BY a.activation_number DESC LIMIT 1),
cur AS (SELECT r.reference_activation AS n FROM assessment_run r WHERE r.id=${run.id}::uuid),
vis AS (SELECT NOT ${plantHidden(sql`${run.plant}::uuid`)} AS v),
ok AS (SELECT EXISTS(SELECT FROM lk) AND (SELECT n FROM act) IS NOT DISTINCT FROM (SELECT n FROM cur)
	AND (SELECT v FROM vis) AS ok),
prev AS ${prior},
d AS (SELECT CASE WHEN prev.id IS NULL THEN NULL ELSE jsonb_build_object('previousRunId',prev.id,'previousAsOf',
	to_char(prev.as_of AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'changed',coalesce((SELECT jsonb_agg(
		jsonb_build_object('key',n->>'key','label',n->>'label','before',o->'value','after',n->'value') ORDER BY k)
		FROM jsonb_array_elements(${JSON.stringify(run.input.facts)}::jsonb) WITH ORDINALITY AS a(n,k)
		LEFT JOIN LATERAL (SELECT o FROM jsonb_array_elements(prev.model_input->'facts') o WHERE o->>'key'=n->>'key') o ON true
		WHERE (o->'value') IS DISTINCT FROM (n->'value')),'[]'::jsonb)) END AS delta
	FROM (SELECT 1) one LEFT JOIN prev ON true),
r AS (UPDATE assessment_run SET outcome='published',reason=NULL,${counters(p)},retry_at=NULL,
	result=${json(publication(draft, run.input))},delta=(SELECT delta FROM d),
	settled_at=clock_timestamp(),available_at=clock_timestamp()
	WHERE id=${run.id}::uuid AND outcome IN ('pending','deferred') AND (SELECT ok FROM ok)
	RETURNING id,plant_id,outcome,reason,demand,grounding,drafts,model),
i AS (INSERT INTO assessment_insight(run_id,ordinal,plant_id,role,severity,title)
	SELECT r.id,x.ordinal,r.plant_id,x.role,x.severity,x.title FROM r,
		jsonb_to_recordset(${json(insightsOf(draft))}) AS x(ordinal int,role text,severity text,title text) RETURNING 1),
${audit}, ${finish("succeeded", null)}
SELECT EXISTS(SELECT FROM r) AS published,EXISTS(SELECT FROM lk) AS claimed,(SELECT v FROM vis) AS visible,
	(SELECT n FROM act) IS NOT DISTINCT FROM (SELECT n FROM cur) AS reference`);
		return z
			.object({ published: z.boolean(), claimed: z.boolean(), visible: z.boolean(), reference: z.boolean() })
			.parse(rows[0]);
	}

	async function execute(db: Database, drafter: Drafter, j: Claim) {
		let run: Run;
		let from: DraftProgress = NO_PROGRESS;
		if (j.run) {
			if (j.run.outcome !== "pending" && j.run.outcome !== "deferred") return close(db, j, "succeeded", "settled");
			run = {
				id: j.run.id,
				plant: j.plant,
				input: j.run.model_input!,
				asOf: j.run.as_of,
				revision: j.run.source_revision,
				deadline: Date.parse(j.run.deadline_at),
			};
			from = progressOf(j.run);
		} else {
			const captured = await capture(db, j, drafter.id);
			if (captured === "none") return;
			run = captured;
		}
		const left = run.deadline - nowMs();
		if (left <= 0) return settleRun(db, j, run, from, "failed", "deadline");
		const drafted: Drafted = await draftWithin(drafter, run.input, from, (p) => reserve(db, j, run, p), left);
		const p = drafted.progress;
		switch (drafted.reason) {
			case "lost_claim":
				return;
			case "busy": {
				const wait = Math.max(
					drafted.retryAfterMs ?? 0,
					ASSESSMENT_TIMING.backoffMs[Math.max(0, p.pendingAttempts - 1)] ?? 0,
				);
				if (p.pendingAttempts >= c.ASSESSMENT_BUDGET.attemptsPerDraft)
					return settleRun(db, j, run, p, "failed", "attempts");
				if (nowMs() + wait >= run.deadline) return settleRun(db, j, run, p, "failed", "deadline");
				return settleRun(db, j, run, p, "deferred", "busy", { waitMs: wait });
			}
			case "invalid_drafts":
			case "attempts":
			case "budget":
			case "model_unavailable":
				return settleRun(db, j, run, p, "failed", drafted.reason);
		}
		const current = await captureFacts(db, run.plant, run.asOf);
		if (!current || current.sourceRevision !== run.revision)
			return settleRun(db, j, run, p, "superseded", "changed_input", { followup: !!current });
		let outcome;
		try {
			outcome = await publish(db, j, run, p, drafted.published!);
		} catch (error) {
			console.error(JSON.stringify({ component: "assessment", outcome: "persistence", code: pgCode(error) ?? null }));
			return settleRun(db, j, run, p, "failed", "persistence");
		}
		if (!outcome.published && outcome.claimed)
			return settleRun(db, j, run, p, "superseded", outcome.reference ? "changed_input" : "changed_reference", {
				followup: outcome.visible,
			});
	}

	return {
		async scheduleAssessments(db: Pick<Database, "execute">, limit = 25) {
			z.int().min(1).max(500).parse(limit);
			const t = now();
			const stale = sql`(${t}-make_interval(days=>${ASSESSMENT_TIMING.staleDays}))`;
			const { rows } = await db.execute(sql`WITH act AS (SELECT a.activation_number AS n FROM reference_activation a
	ORDER BY a.activation_number DESC LIMIT 1),
s AS (SELECT p.id AS plant,lr.captured_at,lr.as_of AS last_as_of,lr.reference_activation AS last_activation,
	cur.as_of AS current_as_of,h.held,
	(SELECT max(e.recorded_at) FROM audit_event e WHERE e.tenant_id=p.id AND e.recorded_at>lr.captured_at
		AND e.action NOT LIKE 'intelligence.%') AS changed_at
	FROM plant p
	LEFT JOIN LATERAL (SELECT r.captured_at,r.as_of,r.reference_activation FROM assessment_run r WHERE r.plant_id=p.id
		AND r.outcome<>'superseded' ORDER BY r.captured_at DESC,r.id DESC LIMIT 1) lr ON true
	LEFT JOIN LATERAL (SELECT r.as_of FROM assessment_run r WHERE r.plant_id=p.id AND r.outcome='published'
		ORDER BY r.available_at DESC,r.id DESC LIMIT 1) cur ON true
	CROSS JOIN LATERAL ${heldSql(sql`p.id`)} h
	WHERE NOT ${plantHidden(sql`p.id`)} AND NOT EXISTS(SELECT FROM job j WHERE j.kind='assessment'
		AND j.subject_record_id=p.id AND j.state IN ('ready','claimed','retry_wait'))),
d AS (SELECT plant,1 AS rank,'change/'||floor(extract(epoch FROM changed_at)*1000000)::bigint::text AS key FROM s
		WHERE changed_at IS NOT NULL
	UNION ALL SELECT plant,2,'reference/'||(SELECT n FROM act)::text FROM s
		WHERE captured_at IS NOT NULL AND (SELECT n FROM act) IS NOT NULL AND last_activation IS DISTINCT FROM (SELECT n FROM act)
	UNION ALL SELECT plant,3,'time/'||to_char(${t} AT TIME ZONE 'UTC','YYYY-MM-DD') FROM s
		WHERE (current_as_of IS NULL OR current_as_of<=${stale}) AND (NOT held OR last_as_of<=${stale})),
q AS (SELECT DISTINCT ON (d.plant) d.plant,d.key FROM d WHERE NOT EXISTS(SELECT FROM job j WHERE j.kind='assessment'
	AND j.subject_record_id=d.plant AND j.producer_key=d.key) ORDER BY d.plant,d.rank),
ins AS (INSERT INTO job(tenant_id,kind,subject_record_id,producer_key,state,eligible_at,attempt_count,max_attempts,
	claim_generation) SELECT plant,'assessment',plant,key,'ready',${t},0,10,0 FROM (SELECT * FROM q ORDER BY plant LIMIT ${limit}) q
	ON CONFLICT DO NOTHING RETURNING 1)
SELECT count(*)::int AS n FROM ins`);
			return z.object({ n: z.int() }).parse(rows[0]).n;
		},

		async runNext(db: Database, drafter: Drafter) {
			const j = await claim(db);
			if (!j) return false;
			try {
				await execute(db, drafter, j);
			} catch (error) {
				console.error(JSON.stringify({ component: "assessment", outcome: "error", code: pgCode(error) ?? null }));
			}
			return true;
		},
	};
}
export type AssessmentJob = ReturnType<typeof createAssessmentJob>;

export async function runAssessmentBatch(
	job: AssessmentJob,
	db: Database,
	drafter: Drafter,
	limit = 4,
	until = Infinity,
) {
	let ran = 0;
	while (ran < limit && Date.now() < until && (await job.runNext(db, drafter))) ran++;
	return ran;
}
