import { instant, type Clock } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/intelligence";
import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import type { Catalog } from "@everyfield/contracts/phases";
import { liveRead, type RequestActor } from "../access/session.ts";
import { plantViewer } from "../documents/access.ts";
import { readCatalog } from "../phases/catalog.ts";
import { checkDraft } from "./checks.ts";
import { sectionsOf, textHash } from "./retrieval.ts";
import {
	concernOf,
	concernsSql,
	criteriaOf,
	lensesOf,
	storedConcern,
	trendCells,
	trendCellsSql,
	trendOf,
} from "./views.ts";

// Plant Intelligence assessments (WP-041 to WP-043). Nobody runs an assessment by hand: a changed input or reference,
// seven quiet days, or an Owner's or Admin's request (intelligence.requestRefresh) queues a demand, and the scheduled
// job (assessment-job.ts) captures one consistent snapshot, drafts outside any transaction and publishes only while
// its inputs, the reference activation and its own claim are still current. This file holds the drafting budget, the
// published shape and the plant's reads. Reads call no model.

/** One model call. `feedback` holds the previous draft's violations, so the next draft can correct them. */
export type DraftCall = { input: c.ModelInput; feedback: c.Violation[]; ordinal: number; maxOutputTokens: number };
export type DraftReply = { output: unknown; usage: { inputTokens: number; outputTokens: number } };
/**
 * The model port. Tests and CI use only the scripted drafter (D77); no paid drafter exists without spend approval. A
 * drafter makes exactly one dispatch per call: any SDK of a real one sets its own retries to zero (PI-020), because the
 * run's budget owns every dispatch. A busy provider (429 or 5xx) throws ProviderBusy; any other failure is an uncertain
 * call that may still be charged.
 */
export interface Drafter {
	readonly id: string;
	draft(call: DraftCall, signal: AbortSignal): Promise<DraftReply>;
}
/** The provider said it is busy (429, or a 5xx), with its Retry-After when it sent one. */
export class ProviderBusy extends Error {
	readonly status: number;
	readonly retryAfterMs: number | null;
	constructor(status: number, retryAfterMs: number | null = null) {
		super(`provider_busy_${status}`);
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}

type Code = c.AssessmentError["code"];
class Refusal extends Error {
	readonly code: Code;
	constructor(code: Code) {
		super(code);
		this.code = code;
	}
}
function deny(code: Code): never {
	throw new Refusal(code);
}
async function settle<T>(body: () => Promise<T>): Promise<c.AssessmentReply<T>> {
	try {
		return { status: "ok", value: await body() };
	} catch (error) {
		if (!(error instanceof Refusal)) throw error;
		return {
			status: "refused",
			error: c.assessmentError.parse({ code: error.code, details: {}, correlationId: randomUUID(), retry: "never" }),
		};
	}
}
function scopeOf(authority: RequestActor) {
	const viewer = plantViewer(authority);
	if (!viewer || viewer.access.role === "member") deny("access_denied");
	return { me: viewer.accountId, plant: viewer.plantId, ok: liveRead(viewer.access, true) };
}
export const iso = (v: string) => sql`to_char(${sql.raw(v)} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** A bound on the input tokens of one call: a byte-level tokenizer never makes more tokens than the bytes it reads. */
const inputBound = (call: Omit<DraftCall, "maxOutputTokens">) =>
	Buffer.byteLength(JSON.stringify({ input: call.input, feedback: call.feedback })) + 512;
/** Each call may write at most this much, so four uncertain attempts fit the run's 12,000 output tokens. */
const OUTPUT_PER_CALL = 3000;

export type StoredDraft = { ordinal: number; attempts: number; output: unknown; violations: c.Violation[] };
export type Usage = { attempts: number; inputTokens: number; outputTokens: number };
/** A run's drafting so far, as stored with it: a resumed run continues from here within the same budget. */
export type DraftProgress = { drafts: StoredDraft[]; usage: Usage; pendingAttempts: number };
export const NO_PROGRESS: DraftProgress = {
	drafts: [],
	usage: { attempts: 0, inputTokens: 0, outputTokens: 0 },
	pendingAttempts: 0,
};
export type Drafted = {
	progress: DraftProgress;
	published: c.DraftOutput | null;
	/** Why drafting stopped without a clean draft; `busy` waits and resumes, `lost_claim` leaves the run to its new owner. */
	reason: "invalid_drafts" | "attempts" | "budget" | "busy" | "lost_claim" | null;
	retryAfterMs: number | null;
};

/**
 * Up to three drafts, four provider dispatches each, inside the run's 60,000 input and 12,000 output tokens, resuming
 * from `progress`. Every dispatch is counted before it is sent: `reserve` stores the counters with the dispatch charged
 * in full (the most an uncertain call can cost), and a refused reservation (the claim was lost) sends nothing. A busy
 * provider stops drafting so the run can wait; the dispatch it cost stays counted. Pure apart from the two ports.
 */
export async function draftWithin(
	drafter: Drafter,
	input: c.ModelInput,
	from: DraftProgress = NO_PROGRESS,
	reserve: (progress: DraftProgress) => Promise<boolean> = async () => true,
	callMs: number = c.ASSESSMENT_BUDGET.callMs,
): Promise<Drafted> {
	const B = c.ASSESSMENT_BUDGET;
	let p: DraftProgress = { ...from, usage: { ...from.usage }, drafts: [...from.drafts] };
	const stop = (reason: Drafted["reason"], retryAfterMs: number | null = null): Drafted => ({
		progress: p,
		published: null,
		reason,
		retryAfterMs,
	});
	while (p.drafts.length < B.drafts) {
		const ordinal = p.drafts.length + 1;
		const feedback = p.drafts.at(-1)?.violations ?? [];
		let reply: DraftReply | null = null;
		while (!reply) {
			if (p.pendingAttempts >= B.attemptsPerDraft) return stop("attempts");
			const bound = inputBound({ input, feedback, ordinal });
			const outputLeft = B.outputTokens - p.usage.outputTokens;
			if (p.usage.inputTokens + bound > B.inputTokens || outputLeft <= 0) return stop("budget");
			const allowance = Math.min(OUTPUT_PER_CALL, outputLeft);
			const before = p.usage;
			p = {
				...p,
				pendingAttempts: p.pendingAttempts + 1,
				usage: {
					attempts: before.attempts + 1,
					inputTokens: before.inputTokens + bound,
					outputTokens: before.outputTokens + allowance,
				},
			};
			if (!(await reserve(p))) return stop("lost_claim");
			try {
				reply = await drafter.draft(
					{ input, feedback, ordinal, maxOutputTokens: allowance },
					AbortSignal.timeout(Math.min(callMs, B.callMs)),
				);
				p = {
					...p,
					usage: {
						attempts: p.usage.attempts,
						inputTokens: before.inputTokens + Math.max(0, Math.round(reply.usage.inputTokens)),
						outputTokens: before.outputTokens + Math.max(0, Math.round(reply.usage.outputTokens)),
					},
				};
			} catch (error) {
				// The reservation stands: an uncertain call may still be charged.
				if (error instanceof ProviderBusy) return stop("busy", error.retryAfterMs);
			}
		}
		const violations = checkDraft(reply.output, input);
		p = {
			...p,
			pendingAttempts: 0,
			drafts: [...p.drafts, { ordinal, attempts: p.pendingAttempts, output: reply.output, violations }],
		};
		if (!violations.length)
			return { progress: p, published: c.draftOutput.parse(reply.output), reason: null, retryAfterMs: null };
	}
	return stop("invalid_drafts");
}

/** The published assessment as stored: the draft plus every citation it uses, resolved from the run input. */
export function publication(draft: c.DraftOutput, input: c.ModelInput) {
	const facts = new Map(input.facts.map((f) => [f.key, f]));
	const passages = new Map(input.passages.map((p) => [p.key, p]));
	const keys = new Set([draft.focus, ...draft.supporting, ...draft.positives].flatMap((p) => p.citations));
	const citations = Object.fromEntries(
		[...keys].map((k) => {
			const p = passages.get(k);
			if (p) return [k, { kind: "passage", ...p }];
			const f = facts.get(k)!;
			return [k, { kind: "fact", key: k, label: f.label, value: f.value }];
		}),
	);
	return { draft, citations };
}
/** The insights a published draft writes (PI-023): one per point, in order, with its urgency's stored severity. */
export function insightsOf(draft: c.DraftOutput) {
	const points = [
		{ role: "focus" as const, p: draft.focus },
		...draft.supporting.map((p) => ({ role: "supporting" as const, p })),
		...draft.positives.map((p) => ({ role: "positive" as const, p })),
	];
	return points.map(({ role, p }, ordinal) => ({ ordinal, role, severity: c.SEVERITY[p.urgency], title: p.title }));
}

/**
 * The plant's scheduled runs that failed in a row, newest first: held for an operator once three did (PI-042). A
 * manual run or any other settled outcome ends the streak. One lateral row: `held` and the streak's run ids.
 */
export const heldSql = (plant: SQL) => sql`(SELECT count(*)=${c.HELD_AFTER_FAILURES}::int
	AND coalesce(bool_and(x.outcome IN ('failed','degraded') AND x.demand<>'manual'),false) AS held
	FROM (SELECT r.outcome,r.demand FROM assessment_run r WHERE r.plant_id=${plant}
		AND r.outcome NOT IN ('superseded','pending','deferred') ORDER BY r.captured_at DESC,r.id DESC
		LIMIT ${c.HELD_AFTER_FAILURES}::int) x)`;
/** A plant whose account or deletion hides it: no demand, run or publication for it. */
export const plantHidden = (plant: SQL) => sql`EXISTS(SELECT FROM lifecycle_witness w WHERE w.opaque_subject_id=${plant}
	AND w.kind='plant' AND w.state NOT IN ('active','cancelled'))`;
const openJob = (plant: SQL) => sql`EXISTS(SELECT FROM job j WHERE j.kind='assessment' AND j.subject_record_id=${plant}
	AND j.state IN ('ready','claimed','retry_wait'))`;

/** The newest work since the current assessment, as the planter reads it. */
function newestOf(r: z.infer<typeof readRow>): c.NewestRun | null {
	const n = r.newest && r.newest.newer ? r.newest : null;
	if (r.open)
		return {
			state: n?.outcome === "deferred" ? "deferred" : "preparing",
			retryAt: n?.outcome === "deferred" ? n.retryAt : null,
			grounding: n?.grounding ?? null,
		};
	if (n && (n.outcome === "failed" || n.outcome === "degraded"))
		return { state: r.held ? "needs_review" : "failed", retryAt: null, grounding: n.grounding };
	return null;
}

export function createAssessments(config: { clock?: Clock } = {}) {
	const now = () =>
		config.clock ? sql`${new Date(config.clock.now()).toISOString()}::timestamptz` : sql`clock_timestamp()`;
	return {
		/**
		 * intelligence.requestRefresh: an Owner or Admin asks for a fresh assessment of their plant. It queues one demand
		 * for the scheduled job with its audit row, in one statement; the browser names the request id, so a repeated
		 * request queues one run. A refused request queues nothing.
		 */
		async requestRefresh(db: Pick<Database, "execute">, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const q = c.requestRefreshRequest.safeParse(raw);
				if (!q.success) deny("invalid_input");
				const s = scopeOf(authority);
				const id = q.data.requestId;
				const { rows } =
					await db.execute(sql`WITH gate AS (SELECT ${s.ok} AND NOT ${plantHidden(sql`${s.plant}::uuid`)} AS ok),
j AS (INSERT INTO job(tenant_id,kind,subject_record_id,producer_key,state,eligible_at,attempt_count,max_attempts,claim_generation)
	SELECT ${s.plant}::uuid,'assessment',${s.plant}::uuid,${"manual/" + id},'ready',${now()},0,10,0 WHERE (SELECT ok FROM gate)
	ON CONFLICT DO NOTHING RETURNING id),
a AS (INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id,event_key,request_key,metadata)
	SELECT ${s.plant}::uuid,${s.me}::uuid,'intelligence.refresh_requested','create','plant',${s.plant}::uuid,
		${"assessment-refresh:" + id},${id},jsonb_build_object('requestId',${id}::text) FROM j RETURNING 1)
SELECT (SELECT ok FROM gate) AS ok`);
				if (!z.object({ ok: z.boolean() }).parse(rows[0]).ok) deny("access_denied");
				return c.refreshReceipt.parse({ requestId: id, state: "preparing" });
			});
		},

		/**
		 * intelligence.readAssessment: the latest published assessment (by publication instant and id) with its insights,
		 * its delta and its real age, and the state of any newer work: being prepared, waiting for the provider, couldn't
		 * be finished, or held for an operator. Pending, deferred, failed or superseded work never replaces it. The
		 * measured facts are read separately (intelligence.readFacts). One statement, no model call.
		 */
		async readAssessment(db: Pick<Database, "execute">, authority: RequestActor, raw: unknown = {}) {
			return settle(async () => {
				if (!c.readAssessmentRequest.safeParse(raw).success) deny("invalid_input");
				const s = scopeOf(authority);
				const { rows } = await db.execute(sql`WITH gate AS (SELECT ${s.ok} AS ok),
x AS (SELECT pl.id,pl.timezone,pl.phase FROM plant pl WHERE pl.id=${s.plant}::uuid AND (SELECT ok FROM gate)),
cur AS (SELECT r.* FROM assessment_run r JOIN x ON x.id=r.plant_id WHERE r.outcome='published'
	ORDER BY r.available_at DESC,r.id DESC LIMIT 1),
nw AS (SELECT r.* FROM assessment_run r JOIN x ON x.id=r.plant_id WHERE r.outcome<>'superseded'
	ORDER BY r.captured_at DESC,r.id DESC LIMIT 1)
SELECT (SELECT ok FROM gate) AS ok,
	(SELECT json_build_object('runId',cur.id,'asOf',${iso("cur.as_of")},'phase',cur.phase,'rubricVersion',cur.rubric_version,
		'release',cur.reference_release,'activation',cur.reference_activation,'result',cur.result,'delta',cur.delta,
		'measuredOn',cur.facts->>'today','daysToLaunch',cur.facts->'launch'->'daysToLaunch',
		'ageDays',((${now()} AT TIME ZONE x.timezone)::date-(cur.as_of AT TIME ZONE x.timezone)::date),
		'insights',(SELECT coalesce(json_agg(json_build_object('role',i.role,'title',i.title,'severity',i.severity)
			ORDER BY array_position(ARRAY['high','medium','low','info'],i.severity),i.ordinal),'[]'::json)
			FROM assessment_insight i WHERE i.run_id=cur.id),
		'facts',cur.facts,'concerns',${concernsSql("cur")})
		FROM cur,x) AS current,
	(SELECT x.phase FROM x) AS current_phase,
	EXISTS(SELECT FROM assessment_seen v JOIN cur ON cur.id=v.run_id WHERE v.account_id=${s.me}::uuid) AS seen,
	(SELECT coalesce(json_agg(json_build_object('ordinal',f.ordinal,'rating',f.rating,'comment',f.comment,
		'recordedAt',${iso("f.recorded_at")}) ORDER BY f.ordinal),'[]'::json)
		FROM assessment_feedback f JOIN cur ON cur.id=f.run_id WHERE f.account_id=${s.me}::uuid) AS feedback,
	(SELECT json_build_object('outcome',nw.outcome,'grounding',nw.grounding,'retryAt',${iso("nw.retry_at")},
		'newer',NOT EXISTS(SELECT FROM cur WHERE cur.captured_at>=nw.captured_at)) FROM nw) AS newest,
	(SELECT ${openJob(sql`x.id`)} FROM x) AS open,
	(SELECT h.held FROM x, LATERAL ${heldSql(sql`x.id`)} h) AS held`);
				const r = readRow.parse(rows[0]);
				if (!r.ok || r.current_phase === null) deny("access_denied");
				const catalog = r.current ? await readCatalog() : null;
				return c.assessmentView.parse({
					current: r.current && present(r.current, catalog!),
					newest: newestOf(r),
					currentPhase: r.current_phase,
					seen: r.seen,
					feedback: r.feedback,
				});
			});
		},

		/**
		 * intelligence.markAssessmentSeen: an Owner's or Admin's explicit open of one of the plant's published runs. Their
		 * first open is recorded once, with its intelligence.assessment_opened audit row; the plant's earliest open
		 * releases the run to its organizations before the 72 hours pass (PI-032). Rendering never calls this, and an
		 * organization seat or a Member is refused. One statement.
		 */
		async markAssessmentSeen(db: Pick<Database, "execute">, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const q = c.markSeenRequest.safeParse(raw);
				if (!q.success) deny("invalid_input");
				const s = scopeOf(authority);
				const { rows } =
					await db.execute(sql`WITH gate AS (SELECT ${s.ok} AND NOT ${plantHidden(sql`${s.plant}::uuid`)} AS ok),
r AS (SELECT r.id FROM assessment_run r WHERE r.id=${q.data.runId}::uuid AND r.plant_id=${s.plant}::uuid
	AND r.outcome='published' AND (SELECT ok FROM gate)),
v AS (INSERT INTO assessment_seen(run_id,account_id,plant_id,seen_at) SELECT r.id,${s.me}::uuid,${s.plant}::uuid,${now()}
	FROM r ON CONFLICT DO NOTHING RETURNING run_id),
a AS (INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id,event_key,metadata)
	SELECT ${s.plant}::uuid,${s.me}::uuid,'intelligence.assessment_opened','create','plant',${s.plant}::uuid,
		'assessment-opened:'||v.run_id||':'||${s.me}::text,jsonb_build_object('runId',v.run_id) FROM v RETURNING 1)
SELECT (SELECT ok FROM gate) AS ok,EXISTS(SELECT FROM r) AS found,EXISTS(SELECT FROM v) AS recorded`);
				const r = z.object({ ok: z.boolean(), found: z.boolean(), recorded: z.boolean() }).parse(rows[0]);
				if (!r.ok) deny("access_denied");
				if (!r.found) deny("not_found");
				return c.seenReceipt.parse({ outcome: r.recorded ? "recorded" : "already_seen" });
			});
		},

		/**
		 * intelligence.submitFeedback: the reader's own rating of one point of one of the plant's published runs, useful
		 * or not useful, with an optional comment (blank means none). It replaces only the reader's own earlier rating of
		 * that point, is bound to the run's rubric version, and never changes the run, its insights or the rubric. A
		 * change writes one intelligence.feedback_saved audit row naming the changed fields, never the comment; the same
		 * rating and comment again write nothing. One statement.
		 */
		async submitFeedback(db: Pick<Database, "execute">, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const q = c.submitFeedbackRequest.safeParse(raw);
				if (!q.success) deny("invalid_input");
				const s = scopeOf(authority);
				const { runId, ordinal, rating } = q.data;
				const comment = q.data.comment.trim() || null;
				const me = sql`${s.me}::uuid`;
				const { rows } = await db.execute(sql`WITH gate AS (SELECT ${s.ok} AS ok),
i AS (SELECT i.run_id,i.ordinal,r.rubric_version FROM assessment_insight i JOIN assessment_run r ON r.id=i.run_id
	AND r.plant_id=i.plant_id WHERE i.run_id=${runId}::uuid AND i.ordinal=${ordinal}::int AND r.plant_id=${s.plant}::uuid
	AND r.outcome='published' AND (SELECT ok FROM gate)),
old AS (SELECT f.ordinal,f.rating,f.comment,f.recorded_at FROM assessment_feedback f JOIN i ON i.run_id=f.run_id
	AND i.ordinal=f.ordinal WHERE f.account_id=${me}),
f AS (INSERT INTO assessment_feedback(run_id,ordinal,plant_id,account_id,rubric_version,rating,comment,recorded_at)
	SELECT i.run_id,i.ordinal,${s.plant}::uuid,${me},i.rubric_version,${rating},${comment}::text,${now()} FROM i
	ON CONFLICT (run_id,ordinal,account_id) DO UPDATE SET rating=excluded.rating,comment=excluded.comment,
		rubric_version=excluded.rubric_version,recorded_at=excluded.recorded_at
	WHERE (assessment_feedback.rating,assessment_feedback.comment) IS DISTINCT FROM (excluded.rating,excluded.comment)
	RETURNING ordinal,rating,comment,recorded_at),
a AS (INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id,metadata)
	SELECT ${s.plant}::uuid,${me},'intelligence.feedback_saved',CASE WHEN EXISTS(SELECT FROM old) THEN 'edit' ELSE 'create' END,
		'plant',${s.plant}::uuid,jsonb_build_object('runId',${runId}::text,'ordinal',${ordinal}::int,
		'rubricVersion',(SELECT rubric_version FROM i),'fields',to_jsonb(array_remove(ARRAY[
			CASE WHEN (SELECT rating FROM old) IS DISTINCT FROM ${rating}::text THEN 'rating' END,
			CASE WHEN (SELECT comment FROM old) IS DISTINCT FROM ${comment}::text THEN 'comment' END],NULL)))
	FROM f RETURNING 1)
SELECT (SELECT ok FROM gate) AS ok,EXISTS(SELECT FROM i) AS found,
	(SELECT json_build_object('ordinal',x.ordinal,'rating',x.rating,'comment',x.comment,'recordedAt',${iso("x.recorded_at")})
		FROM f x) AS saved,
	(SELECT json_build_object('ordinal',x.ordinal,'rating',x.rating,'comment',x.comment,'recordedAt',${iso("x.recorded_at")})
		FROM old x) AS kept`);
				const r = z
					.object({
						ok: z.boolean(),
						found: z.boolean(),
						saved: c.ownFeedback.nullable(),
						kept: c.ownFeedback.nullable(),
					})
					.parse(rows[0]);
				if (!r.ok) deny("access_denied");
				if (!r.found) deny("not_found");
				return c.feedbackReceipt.parse({
					outcome: r.saved ? "saved" : "unchanged",
					feedback: r.saved ?? r.kept,
				});
			});
		},

		/**
		 * intelligence.readAssessmentHistory: the plant's latest twelve published runs, newest first, each with its as-of,
		 * the date it was measured on, the phase it assessed and the trend facts its own original snapshot held. A fact
		 * the snapshot did not have reads Not measured, never zero. One statement, no model call.
		 */
		async readHistory(db: Pick<Database, "execute">, authority: RequestActor, raw: unknown = {}) {
			return settle(async () => {
				if (!c.readAssessmentHistoryRequest.safeParse(raw).success) deny("invalid_input");
				const s = scopeOf(authority);
				const { rows } = await db.execute(sql`WITH gate AS (SELECT ${s.ok} AS ok),
x AS (SELECT pl.id,pl.timezone FROM plant pl WHERE pl.id=${s.plant}::uuid AND (SELECT ok FROM gate)),
r AS (SELECT r.*,x.timezone FROM assessment_run r JOIN x ON x.id=r.plant_id WHERE r.outcome='published'
	ORDER BY r.available_at DESC,r.id DESC LIMIT ${c.TREND_RUNS}::int)
SELECT (SELECT ok FROM gate) AS ok,(SELECT coalesce(json_agg(json_build_object('runId',r.id,'asOf',${iso("r.as_of")},
	'measuredOn',coalesce(r.facts->>'today',(r.as_of AT TIME ZONE r.timezone)::date::text),'phase',r.phase,
	'cells',${trendCellsSql("r")}) ORDER BY r.available_at DESC,r.id DESC),'[]'::json) FROM r) AS runs`);
				const r = z
					.object({
						ok: z.boolean(),
						runs: z.array(
							z.object({
								runId: z.string(),
								asOf: z.string(),
								measuredOn: z.string(),
								phase: z.int(),
								cells: trendCells,
							}),
						),
					})
					.parse(rows[0]);
				if (!r.ok) deny("access_denied");
				return c.assessmentHistory.parse({
					runs: r.runs.map(({ cells, ...run }) => ({ ...run, values: trendOf(cells) })),
				});
			});
		},

		/**
		 * intelligence.resolveCitation: one citation of one of the plant's runs. A fact resolves against the run's own fact
		 * snapshot, whether a point cited it or a tile or criterion shows it as evidence; a passage against the exact
		 * revision the run read, which must still hash to the cited text. A network's or sending church's own article
		 * resolves only while the plant still shares the Wiki with that organization: its text never leaves the statement
		 * otherwise. The people a fact counted link only while they are still live in the plant: a removed or merged-away
		 * person is counted without a name or link (PI-026). One statement, no model call.
		 */
		async resolveCitation(db: Pick<Database, "execute">, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const q = c.resolveCitationRequest.safeParse(raw);
				if (!q.success) deny("invalid_input");
				const { runId, key } = q.data;
				const s = scopeOf(authority);
				const cite = sql`r.result->'citations'->${key}::text`;
				const { rows } = await db.execute(sql`WITH gate AS (SELECT ${s.ok} AS ok),
r AS (SELECT r.* FROM assessment_run r WHERE r.id=${runId}::uuid AND r.plant_id=${s.plant}::uuid
	AND r.outcome='published' AND (SELECT ok FROM gate)),
c AS (SELECT ${cite} AS cite,r.facts FROM r),
pr AS (SELECT DISTINCT x->>'id' AS id FROM c CROSS JOIN LATERAL jsonb_array_elements(${countedPeople(key)}) x),
ppl AS (SELECT coalesce(json_agg(json_build_object('personId',pe.id,'name',pe.display_name) ORDER BY pe.display_name,pe.id)
	FILTER (WHERE pe.id IS NOT NULL),'[]'::json) AS shown,(count(*) FILTER (WHERE pe.id IS NULL))::int AS hidden
	FROM pr LEFT JOIN person pe ON pe.id::text=pr.id AND pe.plant_id=${s.plant}::uuid AND pe.state='live'),
src AS (SELECT v.body,v.content_type FROM c JOIN article_revision v ON v.id=(c.cite->>'revisionId')::uuid
	AND v.tenant_id=(c.cite->>'sourceId')::uuid
	WHERE c.cite->>'kind'='passage' AND (c.cite->>'sourceKind'='global' OR EXISTS(SELECT FROM affiliation f
		WHERE f.plant_id=${s.plant}::uuid AND f.organization_id=v.tenant_id AND f.ended_at IS NULL AND f.share_wiki)))
SELECT (SELECT ok FROM gate) AS ok,(SELECT cite FROM c) AS cite,(SELECT facts FROM c) AS facts,
	(SELECT row_to_json(src) FROM src) AS source,(SELECT row_to_json(ppl) FROM ppl) AS people,
	(SELECT r2.release_key FROM reference_activation a JOIN reference_release r2 ON r2.id=a.release_id
		ORDER BY a.activation_number DESC LIMIT 1) AS current_release`);
				const r = citationRow.parse(rows[0]);
				if (!r.ok) deny("access_denied");
				const view = checkCitation(key, r);
				if (!view) deny("not_found");
				return c.citationView.parse(view);
			});
		},

		/**
		 * intelligence.listRunsForReview: for a platform operator with a current assessment_operator grant, every plant
		 * held after three failed scheduled runs, each with its newest failed run's cause, counters and final-draft rules.
		 * Never the plant's facts, the model input or any draft's words. One statement.
		 */
		async listRunsForReview(db: Pick<Database, "execute">, authority: RequestActor, raw: unknown = {}) {
			return settle(async () => {
				if (!c.listRunsForReviewRequest.safeParse(raw).success) deny("invalid_input");
				const { rows } = await db.execute(sql`WITH gate AS (SELECT ${operator(authority)} AS ok),
h AS (SELECT p.id,p.name FROM plant p CROSS JOIN LATERAL ${heldSql(sql`p.id`)} hh WHERE (SELECT ok FROM gate) AND hh.held),
r AS (SELECT DISTINCT ON (r.plant_id) r.*,h.name AS plant_name FROM assessment_run r JOIN h ON h.id=r.plant_id
	WHERE r.outcome IN ('failed','degraded') ORDER BY r.plant_id,r.captured_at DESC,r.id DESC)
SELECT (SELECT ok FROM gate) AS ok,
	coalesce((SELECT json_agg(${reviewJson} ORDER BY r.settled_at DESC,r.id) FROM r),'[]'::json) AS runs`);
				const row = z.object({ ok: z.boolean(), runs: z.array(storedReview) }).parse(rows[0]);
				if (!row.ok) deny("access_denied");
				return row.runs.map(presentReview);
			});
		},

		/**
		 * intelligence.describeRunFailure: one run that did not publish, for a platform operator: the real cause
		 * (provider, output check with the final draft's rules, budget, persistence, deadline or guidance), its counters
		 * and the plant's failed streak, and no raw plant data, model input or output. One statement.
		 */
		async describeRunFailure(db: Pick<Database, "execute">, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const q = c.describeRunFailureRequest.safeParse(raw);
				if (!q.success) deny("invalid_input");
				const { rows } = await db.execute(sql`WITH gate AS (SELECT ${operator(authority)} AS ok),
r AS (SELECT r.*,p.name AS plant_name FROM assessment_run r JOIN plant p ON p.id=r.plant_id
	WHERE r.id=${q.data.runId}::uuid AND r.outcome IN ('failed','degraded') AND (SELECT ok FROM gate))
SELECT (SELECT ok FROM gate) AS ok,(SELECT ${reviewJson} FROM r) AS run`);
				const row = z.object({ ok: z.boolean(), run: storedReview.nullable() }).parse(rows[0]);
				if (!row.ok) deny("access_denied");
				if (!row.run) deny("not_found");
				return presentReview(row.run);
			});
		},
	};
}
export type Assessments = ReturnType<typeof createAssessments>;

/** platformAdmin.authorize for assessment review: the caller's own live account holds a current operator grant. */
const operator = (authority: RequestActor): SQL =>
	sql`(${liveRead({ session: authority.session, owner: { kind: "account", id: authority.actor.accountId } })}
	AND EXISTS(SELECT FROM platform_grant g WHERE g.account_id=${authority.actor.accountId}::uuid
	AND g.capability='assessment_operator' AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())))`;
/** A run as the operator reads it: counters, reason and the final draft's rules only. `r` is the run, `r.plant_name`. */
const reviewJson = sql`json_build_object('runId',r.id,'plantName',r.plant_name,'demand',r.demand,'asOf',${iso("r.as_of")},
	'settledAt',${iso("r.settled_at")},'outcome',r.outcome,'reason',r.reason,
	'violations',(SELECT coalesce(json_agg(json_build_object('rule',v->>'rule','where',v->>'where')),'[]'::json)
		FROM jsonb_array_elements(coalesce(r.drafts->-1->'violations','[]'::jsonb)) v),
	'drafts',jsonb_array_length(r.drafts),'attempts',r.attempts,'inputTokens',r.input_tokens,'outputTokens',r.output_tokens,
	'streak',(SELECT json_agg(json_build_object('runId',s.id,'settledAt',${iso("s.settled_at")},'reason',s.reason)
		ORDER BY s.captured_at DESC,s.id DESC) FROM (SELECT s.* FROM assessment_run s WHERE s.plant_id=r.plant_id
		AND s.outcome NOT IN ('superseded','pending','deferred') ORDER BY s.captured_at DESC,s.id DESC
		LIMIT ${c.HELD_AFTER_FAILURES}::int) s WHERE s.outcome IN ('failed','degraded')))`;
const storedReview = z.object({
	runId: z.string(),
	plantName: z.string(),
	demand: c.demandKind,
	asOf: z.string(),
	settledAt: z.string(),
	outcome: c.runOutcome,
	reason: c.runReason.nullable(),
	violations: z.array(z.object({ rule: c.draftRule, where: z.string() })),
	drafts: z.int(),
	attempts: z.int(),
	inputTokens: z.int(),
	outputTokens: z.int(),
	streak: z.array(z.object({ runId: z.string(), settledAt: z.string(), reason: c.runReason.nullable() })).nullable(),
});
/** The cause an operator reads for each reason a run did not publish; guidance covers the rest. */
const CAUSE: Partial<Record<c.RunReason, c.FailureCause>> = {
	invalid_drafts: "output_check",
	attempts: "provider",
	busy: "provider",
	budget: "budget",
	deadline: "deadline",
	persistence: "persistence",
};
const causeOrGuidance = (reason: c.RunReason | null) => (reason && CAUSE[reason]) ?? "guidance";
function presentReview(r: z.infer<typeof storedReview>): c.ReviewRun {
	return c.reviewRun.parse({
		runId: r.runId,
		plantName: r.plantName,
		demand: r.demand,
		asOf: r.asOf,
		settledAt: r.settledAt,
		outcome: r.outcome,
		cause: causeOrGuidance(r.reason),
		violations: r.reason === "invalid_drafts" ? r.violations : [],
		drafts: r.drafts,
		usage: { attempts: r.attempts, inputTokens: r.inputTokens, outputTokens: r.outputTokens },
		streak: (r.streak ?? []).map((s) => ({ runId: s.runId, settledAt: s.settledAt, cause: causeOrGuidance(s.reason) })),
	});
}

const readRow = z.object({
	ok: z.boolean(),
	current: z.lazy(() => storedCurrent).nullable(),
	newest: z
		.object({
			outcome: c.runOutcome,
			grounding: z.enum(["grounded", "degraded"]),
			retryAt: instant.nullable(),
			newer: z.boolean(),
		})
		.nullable(),
	open: z.boolean().nullable(),
	held: z.boolean().nullable(),
	current_phase: z.int().nullable(),
	seen: z.boolean(),
	feedback: z.array(c.ownFeedback),
});

const storedCurrent = z.object({
	runId: z.string(),
	asOf: z.string(),
	phase: z.int(),
	rubricVersion: z.string(),
	release: z.string(),
	activation: z.coerce.number().int(),
	result: z.object({
		draft: c.draftOutput,
		citations: z.record(z.string(), z.object({ kind: z.enum(["fact", "passage"]) }).loose()),
	}),
	delta: c.snapshotDelta.nullable(),
	measuredOn: z.string(),
	daysToLaunch: z.int().nullable(),
	ageDays: z.int(),
	insights: c.assessment.shape.insights,
	facts: z.unknown(),
	concerns: z.array(storedConcern),
});
function present(row: z.infer<typeof storedCurrent>, catalog: Catalog): c.Assessment {
	const draft = row.result.draft;
	const label = (k: string) => {
		const cite = row.result.citations[k] as {
			kind: "fact" | "passage";
			label?: string;
			title?: string;
			section?: string | null;
		};
		return {
			key: k,
			kind: cite.kind,
			label: cite.kind === "fact" ? cite.label! : cite.section ? `${cite.title} — ${cite.section}` : cite.title!,
		};
	};
	const point = (p: c.DraftPoint) => ({
		title: p.title,
		body: p.body,
		severity: c.SEVERITY[p.urgency],
		citations: p.citations.map(label),
	});
	return c.assessment.parse({
		runId: row.runId,
		asOf: row.asOf,
		ageDays: Math.max(0, row.ageDays),
		measuredOn: row.measuredOn,
		daysToLaunch: row.daysToLaunch,
		phase: row.phase,
		rubricVersion: row.rubricVersion,
		reference: { release: row.release, activation: row.activation },
		summary: draft.summary,
		focus: point(draft.focus),
		supporting: draft.supporting.map(point),
		positives: draft.positives.map(point),
		insights: row.insights,
		delta: row.delta,
		lenses: lensesOf(row.facts, draft),
		criteria: criteriaOf(catalog, row.phase, row.facts),
		concerns: row.concerns.map((x) => concernOf(row.runId, x)),
	});
}

const citationRow = z.object({
	ok: z.boolean(),
	cite: z.record(z.string(), z.unknown()).nullable(),
	facts: z.unknown().nullable(),
	source: z.object({ body: z.string(), content_type: z.string() }).nullable(),
	people: c.citationView.options[0].shape.people.nullable(),
	current_release: z.string().nullable(),
});
/**
 * The people a fact counted, as a JSON array of person refs from snapshot `c.facts`: the counted adults, the people who
 * need classifying, the disengaged, the prayer leaders or everyone across the ministry responsibilities. Other facts
 * count no person.
 */
function countedPeople(key: string): SQL {
	const f = sql`c.facts`;
	if (["committedAdults.status", "committedAdults.count", "committedAdults.atLeast"].includes(key))
		return sql`(SELECT coalesce(jsonb_agg(e->'person'),'[]'::jsonb) FROM jsonb_array_elements(${f}->'committedAdults'->'evidence') e)`;
	if (key === "committedAdults.needsClassifying") return sql`${f}->'committedAdults'->'needsClassifying'`;
	if (key === "cohesion.disengaged") return sql`${f}->'cohesion'->'disengaged'`;
	if (key === "coverage.prayerLeader") return sql`${f}->'coverage'->'prayerLeader'`;
	if (key === "coverage.filled" || key === "coverage.people")
		return sql`(SELECT coalesce(jsonb_agg(p),'[]'::jsonb) FROM jsonb_array_elements(${f}->'coverage'->'responsibilities') x
			CROSS JOIN LATERAL jsonb_array_elements(x->'people') p)`;
	return sql`'[]'::jsonb`;
}
const storedPassage = c.passage.extend({ kind: z.literal("passage") });
const storedFact = z.object({
	kind: z.literal("fact"),
	key: z.string(),
	label: z.string(),
	value: c.factEntry.shape.value,
});

/**
 * A stored citation checked against its source now: verified, can't be verified, or no longer available. A key no
 * point cited is any fact of the run's snapshot, or not found.
 */
function checkCitation(key: string, r: z.infer<typeof citationRow>): c.CitationView | null {
	if (!r.cite || r.cite.kind === "fact") {
		// A fact resolves against the run's own stored snapshot, not the live facts: the snapshot never changes, so
		// "can't be verified" here means a corrupt or tampered row, never that the plant's facts moved on since.
		const snapshot = c.plantFacts.safeParse(r.facts);
		const fact = snapshot.success ? c.factCatalog(snapshot.data).find((f) => f.key === key) : undefined;
		if (!snapshot.success || !fact) return r.cite ? { status: "unverifiable", key } : null;
		if (r.cite) {
			const cite = storedFact.safeParse(r.cite);
			if (!cite.success || JSON.stringify(fact.value) !== JSON.stringify(cite.data.value))
				return { status: "unverifiable", key };
		}
		return {
			status: "verified",
			kind: "fact",
			key,
			label: fact.label,
			value: fact.value,
			people: r.people ?? { shown: [], hidden: 0 },
			asOf: snapshot.data.asOf,
			measuredOn: snapshot.data.today,
			formulaVersion: snapshot.data.formulaVersion,
		};
	}
	const cite = storedPassage.safeParse(r.cite);
	if (!cite.success) return { status: "unverifiable", key };
	const p = cite.data;
	// Only a global passage, or an organization's article the plant still reaches, ever has a source row here.
	if (!r.source) return p.sourceKind === "global" ? { status: "unverifiable", key } : { status: "unavailable", key };
	const section = sectionsOf(r.source.content_type, r.source.body).find((s) => s.section === p.section);
	if (!section || textHash(section.text) !== p.textHash || section.text !== p.text)
		return { status: "unverifiable", key };
	return {
		status: "verified",
		kind: "passage",
		key,
		title: p.title,
		slug: p.slug,
		section: p.section,
		phase: p.phase,
		sourceKind: p.sourceKind,
		text: section.text,
		version: p.version,
		currentVersion: p.sourceKind !== "global" || p.version.release === r.current_release,
	};
}
