import * as c from "@everyfield/contracts/intelligence";
import { tenantId } from "@everyfield/contracts/common";
import { wikiBlocks } from "@everyfield/contracts/wiki";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import {
	DAILY_QUERY_CAP_USD,
	EmbeddingRefusal,
	recordSpend,
	tokensFor,
	type WikiQueryEmbedder,
} from "@everyfield/reference/wiki-embedding";
import { createHash } from "node:crypto";
import "server-only";
import { z } from "zod";
import { asLogWord, logLine } from "../log.ts";
import { corpusCtes, visibleBodySql } from "../wiki/corpus.ts";
import { fuseCandidates, pickMethodologyCandidates } from "./candidates.ts";

const QUERIES: Record<c.FactTopic | "coverage", string> = {
	committedAdults: "commit | committed | commitment | core <-> group",
	growth: "growth | grow | momentum",
	vision: "vision",
	cohesion: "cohesion | attendance | engage",
	followUps: "follow | guest",
	coverage: "ministry | leader | responsibility",
	training: "training | train",
};
const STEMS: Record<keyof typeof QUERIES, string[]> = {
	committedAdults: ["commit", "core group"],
	growth: ["grow", "momentum"],
	vision: ["vision"],
	cohesion: ["cohesion", "attend", "engag"],
	followUps: ["follow", "guest"],
	coverage: ["ministr", "leader", "responsib"],
	training: ["train"],
};
const MEANINGS: Record<keyof typeof QUERIES, string> = {
	committedAdults: "building a committed core group of adults",
	growth: "growing the core group and keeping momentum",
	vision: "casting vision at vision meetings",
	cohesion: "core group cohesion and attendance",
	followUps: "following up with guests after a first visit",
	coverage: "filling ministry leader responsibilities",
	training: "training and preparing the launch team",
};
type Topic = keyof typeof QUERIES;
const TOPICS = Object.keys(QUERIES) as Topic[];
const PER_TOPIC = 2;
const PER_LEG = 8;
const MEANING_PASSAGES = 40;
const MEANING_DISTANCE = 0.7;
const DIMENSIONS = 1536;
const MEANING_VECTOR = `public.vector(${DIMENSIONS})`;
const TEXT_MAX = 1200;

const hit = z.object({
	topic: z.enum(TOPICS as [Topic]),
	leg: z.enum(["dense", "sparse"]),
	fts_rank: z.int(),
	article_id: z.uuid(),
	revision_id: z.uuid(),
	revision_number: z.int(),
	source_kind: z.enum(["global", "church", "network"]),
	source_id: z.uuid(),
	title: z.string(),
	slug: z.string(),
	phase: z.int().nullable(),
	content_type: z.string(),
	body: z.string().nullable(),
});
const retrievalRow = z.object({
	allowed: z.boolean(),
	phase: z.int().nullable(),
	activation: z.object({ number: z.coerce.number().int(), release: z.string() }).nullable(),
	hits: z.array(hit),
});

export function sectionsOf(contentType: string, body: string): { section: string | null; text: string }[] {
	let current: { section: string | null; lines: string[] } = { section: null, lines: [] };
	const out = [current];
	for (const block of wikiBlocks(contentType, body)) {
		if (block.kind === "heading") {
			current = { section: block.text, lines: [] };
			out.push(current);
		} else current.lines.push(...block.lines);
	}
	return out
		.map((s) => ({ section: s.section, text: s.lines.join("\n").trim().slice(0, TEXT_MAX) }))
		.filter((s) => s.text.length > 0);
}
export const textHash = (text: string) => createHash("sha256").update(text).digest("hex");

export type Retrieved =
	| {
			status: "ok";
			phase: number;
			activation: { number: number; release: string };
			passages: c.Passage[];
	  }
	| { status: "reference_missing"; phase: number }
	| { status: "unavailable"; phase: null };

export type Meanings = Record<Topic, string>;

const probeRow = z.object({
	profile: z.string().nullable(),
	dimensions: z.int().nullable(),
	spent: z.coerce.number(),
});

function denseSkipped(reason: string): null {
	logLine({ component: "intelligence", outcome: "dense-skipped", reason: asLogWord(reason) });
	return null;
}

export async function embedTopics(db: Database, embedder: WikiQueryEmbedder | null): Promise<Meanings | null> {
	if (!embedder) return denseSkipped("no_embedder");
	const probe = probeRow.parse(
		(
			await db.execute(sql`SELECT rel.embedding_profile AS profile, rel.embedding_dimensions AS dimensions,
				COALESCE((SELECT usage FROM embedding_spend
					WHERE day=(clock_timestamp() AT TIME ZONE 'UTC')::date AND purpose='query'),0) AS spent
				FROM (SELECT 1) one LEFT JOIN LATERAL (SELECT r.embedding_profile, r.embedding_dimensions
					FROM reference_activation a JOIN reference_release r ON r.id=a.release_id
					ORDER BY a.activation_number DESC LIMIT 1) rel ON true`)
		).rows[0],
	);
	if (
		probe.profile !== embedder.profile ||
		probe.dimensions !== embedder.dimensions ||
		embedder.dimensions !== DIMENSIONS
	)
		return denseSkipped("profile_mismatch");
	let spent = probe.spent;
	const meanings: Partial<Meanings> = {};
	for (const topic of TOPICS) {
		if (spent >= tokensFor(DAILY_QUERY_CAP_USD)) return denseSkipped("daily_limit");
		let embedded: Awaited<ReturnType<WikiQueryEmbedder["embed"]>>;
		try {
			embedded = await embedder.embed(MEANINGS[topic]);
		} catch (error) {
			if (!(error instanceof EmbeddingRefusal)) return denseSkipped("embedding_failed");
			await recordSpend(db, "query", error.usageTokens);
			return denseSkipped(error.code);
		}
		await recordSpend(db, "query", embedded.tokens);
		spent += embedded.tokens;
		meanings[topic] = `[${embedded.vector.join(",")}]`;
	}
	return meanings as Meanings;
}

function denseSql(meanings: Meanings | null) {
	if (!meanings) return sql`SELECT NULL::text AS topic, NULL::uuid AS revision_id, NULL::int AS fts_rank WHERE false`;
	const type = sql.raw(MEANING_VECTOR);
	return sql`SELECT t.topic, d.revision_id, row_number() OVER (PARTITION BY t.topic ORDER BY d.distance, d.revision_id)::int AS fts_rank
		FROM (VALUES ${sql.join(
			TOPICS.map((t) => sql`(${t},${meanings[t]}::${type})`),
			sql`,`,
		)}) t(topic,v) CROSS JOIN LATERAL (
			SELECT DISTINCT ON (m.revision_id) m.revision_id, m.distance FROM (
				SELECT ps.revision_id, ps.embedding::${type} OPERATOR(public.<=>) t.v AS distance FROM passage ps
				WHERE (ps.release_id=(SELECT release_id FROM release)
						OR (ps.release_id IS NULL AND ps.tenant_id IN (SELECT org_id FROM links)))
					AND public.vector_dims(ps.embedding)=${DIMENSIONS}
				ORDER BY ps.embedding::${type} OPERATOR(public.<=>) t.v LIMIT ${MEANING_PASSAGES}) m
			JOIN picked p ON p.revision_id=m.revision_id
			WHERE NOT p.hidden AND m.distance<=${MEANING_DISTANCE}
			ORDER BY m.revision_id, m.distance) d`;
}

export async function retrieveMethodology(
	db: Pick<Database, "execute">,
	plant: string,
	meanings: Meanings | null = null,
): Promise<Retrieved> {
	const owner = { kind: "plant" as const, id: tenantId.parse(plant) };
	const access = { job: "assessment" as const, owner };
	if (meanings) await db.execute(sql`SELECT set_config('hnsw.iterative_scan','relaxed_order',true)`);
	const { rows } = await db.execute(sql`WITH ${corpusCtes(access, { kind: "current" })},
	ph AS (SELECT pl.phase FROM plant pl WHERE pl.id=${owner.id}::uuid AND EXISTS(SELECT FROM me)),
	act AS (SELECT a.activation_number, r.release_key FROM reference_activation a
		JOIN reference_release r ON r.id=a.release_id ORDER BY a.activation_number DESC LIMIT 1),
	topics(topic,q) AS (VALUES ${sql.join(
		TOPICS.map((t) => sql`(${t},to_tsquery('english',${QUERIES[t]}))`),
		sql`,`,
	)}),
	sparse AS (SELECT topic, revision_id, dense_rank() OVER (PARTITION BY topic ORDER BY score DESC)::int AS fts_rank
		FROM (SELECT t.topic, h.revision_id, h.score FROM topics t CROSS JOIN LATERAL (
			SELECT p.revision_id, ts_rank(r.search_vector,t.q) AS score
			FROM picked p JOIN article_revision r ON r.id=p.revision_id
			WHERE NOT p.hidden AND r.search_vector @@ t.q ORDER BY score DESC, p.article_id LIMIT ${PER_LEG}) h) s),
	dense AS (${denseSql(meanings)}),
	hits AS (SELECT l.topic, l.leg, l.fts_rank, p.article_id, p.revision_id, p.revision_number, p.source_kind, p.source_id,
			p.title, p.slug, p.phase, p.content_type, ${visibleBodySql()} AS body
		FROM (SELECT topic, revision_id, fts_rank, 'sparse' AS leg FROM sparse
			UNION ALL SELECT topic, revision_id, fts_rank, 'dense' FROM dense) l
		JOIN picked p ON p.revision_id=l.revision_id)
	SELECT EXISTS(SELECT FROM me) AS allowed,(SELECT phase FROM ph) AS phase,
	(SELECT json_build_object('number',activation_number,'release',release_key) FROM act) AS activation,
	coalesce((SELECT json_agg(json_build_object('topic',topic,'leg',leg,'fts_rank',fts_rank,'article_id',article_id,
		'revision_id',revision_id,'revision_number',revision_number,'source_kind',source_kind,'source_id',source_id,
		'title',title,'slug',slug,'phase',phase,'content_type',content_type,'body',body)
		ORDER BY topic,leg,fts_rank,article_id) FROM hits),'[]') AS hits`);
	const r = retrievalRow.parse(rows[0]);
	if (!r.allowed || r.phase === null) return { status: "unavailable", phase: null };
	const phaseNow = r.phase;
	if (!r.activation) return { status: "reference_missing", phase: phaseNow };
	const passages: c.Passage[] = [];
	const seen = new Set<string>();
	for (const topic of TOPICS) {
		const found = r.hits.filter((h) => h.topic === topic);
		const leg = (name: "dense" | "sparse") =>
			found
				.filter((h) => h.leg === name)
				.map((h) => ({ passage: h.revision_id, phase: h.phase, fts_rank: h.fts_rank }));
		const fused = fuseCandidates(
			pickMethodologyCandidates({
				phase: phaseNow,
				dense_candidates: leg("dense"),
				sparse_candidates: leg("sparse"),
				candidate_source: "activated-global-generation",
				ended_org_body: null,
			}),
		);
		let taken = 0;
		for (const revision of fused) {
			const h = found.find((x) => x.revision_id === revision);
			if (!h || h.body === null || taken >= PER_TOPIC) continue;
			const sections = sectionsOf(h.content_type, h.body);
			const best =
				sections
					.map((s) => ({ ...s, score: STEMS[topic].filter((stem) => s.text.toLowerCase().includes(stem)).length }))
					.filter((s) => s.score > 0)
					.sort((a, b) => b.score - a.score || Number(a.section === null) - Number(b.section === null))[0] ??
				sections.find((s) => s.section !== null) ??
				sections[0];
			const id = `${h.revision_id}#${best?.section ?? ""}`;
			if (!best || seen.has(id)) continue;
			seen.add(id);
			taken++;
			passages.push(
				c.passage.parse({
					key: `passage:${passages.length + 1}`,
					articleId: h.article_id,
					revisionId: h.revision_id,
					sourceKind: h.source_kind,
					sourceId: h.source_id,
					title: h.title,
					slug: h.slug,
					section: best.section,
					phase: h.phase,
					text: best.text,
					textHash: textHash(best.text),
					version: { release: r.activation.release, activation: r.activation.number, revision: h.revision_number },
				}),
			);
		}
	}
	return { status: "ok", phase: phaseNow, activation: r.activation, passages };
}
