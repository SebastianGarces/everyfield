import type { Clock } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/intelligence";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { liveRead, type RequestActor } from "../access/session.ts";
import { plantViewer } from "../documents/access.ts";
import { checkDraft } from "./checks.ts";
import { pgCode } from "../wiki/core.ts";
import { createFacts } from "./facts.ts";
import { retrieveMethodology, sectionsOf, textHash, type Retrieved } from "./retrieval.ts";

// Plant Intelligence assessments (WP-041 and WP-042). A run (intelligence.evaluateAssessment) captures the measured facts,
// the plant's phase and the keyword-retrieved methodology passages in one consistent read-only snapshot, stores that
// exact input with the run, then asks the drafter for up to three drafts, outside any transaction. Each draft goes
// through `checkDraft`; the first clean one is published with its citations. Retrieval that fails or finds no activated
// reference publishes nothing: the run is stored as degraded, and the previous assessment stays current with its real
// age. A run never writes a phase, task, message or notice. Reads call no model.

/** One model call. `feedback` holds the previous draft's violations, so the next draft can correct them. */
export type DraftCall = { input: c.ModelInput; feedback: c.Violation[]; ordinal: number; maxOutputTokens: number };
export type DraftReply = { output: unknown; usage: { inputTokens: number; outputTokens: number } };
/** The model port. Tests and CI use only the scripted drafter (D77); no paid drafter exists without spend approval. */
export interface Drafter {
	readonly id: string;
	draft(call: DraftCall, signal: AbortSignal): Promise<DraftReply>;
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
const iso = (v: string) => sql`to_char(${sql.raw(v)} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** A bound on the input tokens of one call: a byte-level tokenizer never makes more tokens than the bytes it reads. */
const inputBound = (call: Omit<DraftCall, "maxOutputTokens">) =>
	Buffer.byteLength(JSON.stringify({ input: call.input, feedback: call.feedback })) + 512;
/** Each call may write at most this much, so four uncertain attempts fit the run's 12,000 output tokens. */
const OUTPUT_PER_CALL = 3000;

type StoredDraft = { ordinal: number; attempts: number; output: unknown; violations: c.Violation[] };
type Drafted = {
	drafts: StoredDraft[];
	published: c.DraftOutput | null;
	reason: c.RunResult["reason"];
	usage: c.RunResult["usage"];
};

/** Up to three drafts, four provider attempts each, inside the run's token budget. Pure apart from the drafter. */
export async function draftWithin(drafter: Drafter, input: c.ModelInput): Promise<Drafted> {
	const B = c.ASSESSMENT_BUDGET;
	const usage = { attempts: 0, inputTokens: 0, outputTokens: 0 };
	const drafts: StoredDraft[] = [];
	let feedback: c.Violation[] = [];
	for (let ordinal = 1; ordinal <= B.drafts; ordinal++) {
		let reply: DraftReply | null = null;
		let attempts = 0;
		while (!reply && attempts < B.attemptsPerDraft) {
			const bound = inputBound({ input, feedback, ordinal });
			const outputLeft = B.outputTokens - usage.outputTokens;
			if (usage.inputTokens + bound > B.inputTokens || outputLeft <= 0)
				return { drafts, published: null, reason: "budget", usage };
			attempts++;
			usage.attempts++;
			try {
				reply = await drafter.draft(
					{ input, feedback, ordinal, maxOutputTokens: Math.min(OUTPUT_PER_CALL, outputLeft) },
					AbortSignal.timeout(B.callMs),
				);
				usage.inputTokens += Math.max(0, Math.round(reply.usage.inputTokens));
				usage.outputTokens += Math.max(0, Math.round(reply.usage.outputTokens));
			} catch {
				// An uncertain call may still be charged: count its whole input bound and output allowance.
				usage.inputTokens += bound;
				usage.outputTokens += Math.min(OUTPUT_PER_CALL, outputLeft);
			}
		}
		if (!reply) return { drafts, published: null, reason: "attempts", usage };
		const violations = checkDraft(reply.output, input);
		drafts.push({ ordinal, attempts, output: reply.output, violations });
		if (!violations.length) return { drafts, published: c.draftOutput.parse(reply.output), reason: null, usage };
		feedback = violations;
	}
	return { drafts, published: null, reason: "invalid_drafts", usage };
}

/** The published assessment as stored: the draft plus every citation it uses, resolved from the run input. */
function publication(draft: c.DraftOutput, input: c.ModelInput) {
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

export function createAssessments(config: { clock?: Clock } = {}) {
	const facts = createFacts(config);
	return {
		/**
		 * intelligence.evaluateAssessment: one assessment run of the actor's plant, by its Owner or Admin. The browser or the
		 * scheduler names the run id, so a repeated request records one run. Statements: the read-only snapshot
		 * transaction (facts, then retrieval under a savepoint) and one write with its audit row.
		 */
		async evaluateAssessment(db: Database, authority: RequestActor, raw: unknown, drafter: Drafter) {
			return settle(async () => {
				const request = c.evaluateAssessmentRequest.safeParse(raw);
				if (!request.success) deny("invalid_input");
				const runId = request.data.runId;
				const s = scopeOf(authority);
				const captured = await db.transaction(
					async (tx) => {
						await tx.execute(sql`SELECT set_config('lock_timeout','1s',true)`);
						const read = await facts.readFacts(tx, authority, {});
						if (read.status !== "ok") deny("access_denied");
						const f = read.value;
						let retrieved: Retrieved;
						try {
							retrieved = await tx.transaction((t) => retrieveMethodology(t, authority));
						} catch (error) {
							// The savepoint rolls back and keeps the facts: the run is degraded, never ungrounded.
							const code = pgCode(error);
							if (code !== "55P03" && code !== "57014") throw error;
							retrieved = { status: "unavailable", phase: null };
						}
						return { facts: f, retrieved };
					},
					{ isolationLevel: "repeatable read", accessMode: "read only" },
				);
				const { facts: f, retrieved } = captured;
				let input: c.ModelInput | null = null;
				let drafted: Drafted = {
					drafts: [],
					published: null,
					reason: null,
					usage: { attempts: 0, inputTokens: 0, outputTokens: 0 },
				};
				if (retrieved.status === "ok") {
					input = c.modelInput.parse({
						phase: retrieved.phase,
						asOf: f.asOf,
						today: f.today,
						rubric: c.ACTIVE_PLANT_RUBRIC,
						facts: c.factCatalog(f),
						passages: retrieved.passages,
					});
					drafted = await draftWithin(drafter, input);
				} else drafted.reason = retrieved.status === "unavailable" ? "guidance_unavailable" : "reference_missing";
				const outcome: c.RunOutcome = drafted.published
					? "published"
					: retrieved.status !== "ok"
						? "degraded"
						: drafted.reason === "invalid_drafts"
							? "failed"
							: "deferred";
				const grounding = retrieved.status === "ok" ? "grounded" : "degraded";
				const result = drafted.published && input ? publication(drafted.published, input) : null;
				const activation = retrieved.status === "ok" ? retrieved.activation : null;
				const rubric = c.PLANT_RUBRICS[c.ACTIVE_PLANT_RUBRIC];
				const { rows } = await db.execute(sql`WITH gate AS (SELECT ${s.ok} AS ok),
r AS (INSERT INTO assessment_run(id,plant_id,requested_by,as_of,phase,source_revision,formula_version,rubric_version,
	rubric_sha256,reference_release,reference_activation,model,outcome,grounding,reason,facts,model_input,drafts,result,
	attempts,input_tokens,output_tokens)
	SELECT ${runId}::uuid,pl.id,${s.me}::uuid,${f.asOf}::timestamptz,coalesce(${retrieved.phase}::int,pl.phase),
		${f.sourceRevision},${f.formulaVersion},${c.ACTIVE_PLANT_RUBRIC},${rubric.sha256},${activation?.release ?? null},
		${activation?.number ?? null}::bigint,${drafter.id},${outcome},${grounding},${drafted.reason},${JSON.stringify(f)}::jsonb,
		${input && JSON.stringify(input)}::jsonb,${JSON.stringify(drafted.drafts)}::jsonb,${result && JSON.stringify(result)}::jsonb,
		${drafted.usage.attempts},${drafted.usage.inputTokens},${drafted.usage.outputTokens}
	FROM plant pl WHERE pl.id=${s.plant}::uuid AND (SELECT ok FROM gate)
	ON CONFLICT (id) DO NOTHING RETURNING id,plant_id),
a AS (INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id,event_key,metadata)
	SELECT r.plant_id,${s.me}::uuid,'intelligence.assessed','create','plant',r.plant_id,'assessment:'||r.id,
		jsonb_build_object('runId',r.id,'outcome',${outcome}::text,'grounding',${grounding}::text,
			'drafts',${drafted.drafts.length}::int,'model',${drafter.id}::text) FROM r RETURNING 1)
SELECT (SELECT ok FROM gate) AS ok, EXISTS(SELECT FROM r) AS added,
	EXISTS(SELECT FROM assessment_run WHERE id=${runId}::uuid AND plant_id=${s.plant}::uuid) AS existing`);
				const w = z.object({ ok: z.boolean(), added: z.boolean(), existing: z.boolean() }).parse(rows[0]);
				if (!w.ok) deny("access_denied");
				if (!w.added && !w.existing) deny("not_found");
				return c.runResult.parse({
					runId,
					outcome,
					grounding,
					reason: drafted.reason,
					drafts: drafted.drafts.map((d) => ({ ordinal: d.ordinal, violations: d.violations })),
					usage: drafted.usage,
				});
			});
		},

		/**
		 * intelligence.readAssessment: the latest published assessment with its real age, and the latest run's outcome
		 * (degraded when guidance couldn't be checked). The measured facts are read separately (intelligence.readFacts)
		 * and stay readable whatever a run did. One statement, no model call.
		 */
		async readAssessment(db: Pick<Database, "execute">, authority: RequestActor, raw: unknown = {}) {
			return settle(async () => {
				if (!c.readAssessmentRequest.safeParse(raw).success) deny("invalid_input");
				const s = scopeOf(authority);
				const { rows } = await db.execute(sql`WITH gate AS (SELECT ${s.ok} AS ok),
x AS (SELECT pl.id,pl.timezone FROM plant pl WHERE pl.id=${s.plant}::uuid AND (SELECT ok FROM gate)),
cur AS (SELECT r.* FROM assessment_run r JOIN x ON x.id=r.plant_id WHERE r.outcome='published'
	ORDER BY r.as_of DESC,r.recorded_at DESC,r.id DESC LIMIT 1),
last AS (SELECT r.* FROM assessment_run r JOIN x ON x.id=r.plant_id ORDER BY r.recorded_at DESC,r.id DESC LIMIT 1)
SELECT (SELECT ok FROM gate) AS ok,
	(SELECT json_build_object('runId',cur.id,'asOf',${iso("cur.as_of")},'phase',cur.phase,'rubricVersion',cur.rubric_version,
		'release',cur.reference_release,'activation',cur.reference_activation,'result',cur.result,
		'ageDays',((clock_timestamp() AT TIME ZONE x.timezone)::date-(cur.as_of AT TIME ZONE x.timezone)::date))
		FROM cur,x) AS current,
	(SELECT json_build_object('runId',id,'asOf',${iso("as_of")},'outcome',outcome,'grounding',grounding) FROM last) AS latest`);
				const r = z
					.object({ ok: z.boolean(), current: storedCurrent.nullable(), latest: z.unknown().nullable() })
					.parse(rows[0]);
				if (!r.ok) deny("access_denied");
				return c.assessmentView.parse({ current: r.current && present(r.current), latest: r.latest });
			});
		},

		/**
		 * intelligence.resolveCitation: one citation of one of the plant's runs. A fact resolves against the run's own fact
		 * snapshot; a passage against the exact revision the run read, which must still hash to the cited text. A network's
		 * or sending church's own article resolves only while the plant still shares the Wiki with that organization: its
		 * text never leaves the statement otherwise. One statement, no model call.
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
src AS (SELECT v.body,v.content_type FROM c JOIN article_revision v ON v.id=(c.cite->>'revisionId')::uuid
	AND v.tenant_id=(c.cite->>'sourceId')::uuid
	WHERE c.cite->>'kind'='passage' AND (c.cite->>'sourceKind'='global' OR EXISTS(SELECT FROM affiliation f
		WHERE f.plant_id=${s.plant}::uuid AND f.organization_id=v.tenant_id AND f.ended_at IS NULL AND f.share_wiki)))
SELECT (SELECT ok FROM gate) AS ok,(SELECT cite FROM c) AS cite,(SELECT facts FROM c) AS facts,
	(SELECT row_to_json(src) FROM src) AS source,
	(SELECT r2.release_key FROM reference_activation a JOIN reference_release r2 ON r2.id=a.release_id
		ORDER BY a.activation_number DESC LIMIT 1) AS current_release`);
				const r = citationRow.parse(rows[0]);
				if (!r.ok) deny("access_denied");
				if (!r.cite) deny("not_found");
				return c.citationView.parse(checkCitation(key, r));
			});
		},
	};
}
export type Assessments = ReturnType<typeof createAssessments>;

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
	ageDays: z.int(),
});
function present(row: z.infer<typeof storedCurrent>): c.Assessment {
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
	const point = (p: c.DraftPoint) => ({ title: p.title, body: p.body, citations: p.citations.map(label) });
	return c.assessment.parse({
		runId: row.runId,
		asOf: row.asOf,
		ageDays: Math.max(0, row.ageDays),
		phase: row.phase,
		rubricVersion: row.rubricVersion,
		reference: { release: row.release, activation: row.activation },
		summary: draft.summary,
		focus: point(draft.focus),
		supporting: draft.supporting.map(point),
		positives: draft.positives.map(point),
	});
}

const citationRow = z.object({
	ok: z.boolean(),
	cite: z.record(z.string(), z.unknown()).nullable(),
	facts: z.unknown().nullable(),
	source: z.object({ body: z.string(), content_type: z.string() }).nullable(),
	current_release: z.string().nullable(),
});
const storedPassage = c.passage.extend({ kind: z.literal("passage") });
const storedFact = z.object({
	kind: z.literal("fact"),
	key: z.string(),
	label: z.string(),
	value: c.factEntry.shape.value,
});

/** A stored citation checked against its source now: verified, can't be verified, or no longer available. */
function checkCitation(key: string, r: z.infer<typeof citationRow>): c.CitationView {
	if (r.cite?.kind === "fact") {
		// A fact resolves against the run's own stored snapshot, not the live facts: the snapshot never changes, so
		// "can't be verified" here means a corrupt or tampered row, never that the plant's facts moved on since.
		const cite = storedFact.safeParse(r.cite);
		const snapshot = c.plantFacts.safeParse(r.facts);
		if (!cite.success || !snapshot.success) return { status: "unverifiable", key };
		const fact = c.factCatalog(snapshot.data).find((f) => f.key === cite.data.key);
		if (!fact || JSON.stringify(fact.value) !== JSON.stringify(cite.data.value)) return { status: "unverifiable", key };
		return {
			status: "verified",
			kind: "fact",
			key,
			label: fact.label,
			value: fact.value,
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
