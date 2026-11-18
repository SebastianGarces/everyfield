import * as c from "@everyfield/contracts/intelligence";
import { tenantId } from "@everyfield/contracts/common";
import { wikiBlocks } from "@everyfield/contracts/wiki";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { createHash } from "node:crypto";
import "server-only";
import { z } from "zod";
import { corpusCtes, visibleBodySql } from "../wiki/corpus.ts";

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
const PER_TOPIC = 2;
const TEXT_MAX = 1200;

const hit = z.object({
	topic: z.enum(Object.keys(QUERIES) as [keyof typeof QUERIES]),
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
	const out: { section: string | null; lines: string[] }[] = [{ section: null, lines: [] }];
	for (const block of wikiBlocks(contentType, body)) {
		if (block.kind === "heading") out.push({ section: block.text, lines: [] });
		else out.at(-1)!.lines.push(...block.lines);
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

export async function retrieveMethodology(db: Pick<Database, "execute">, plant: string): Promise<Retrieved> {
	const owner = { kind: "plant" as const, id: tenantId.parse(plant) };
	const access = { job: "assessment" as const, owner };
	const phase = sql`(SELECT phase FROM ph)`;
	const { rows } = await db.execute(sql`WITH ${corpusCtes(access, { kind: "current" })},
	ph AS (SELECT pl.phase FROM plant pl WHERE pl.id=${owner.id}::uuid AND EXISTS(SELECT FROM me)),
	act AS (SELECT a.activation_number, r.release_key FROM reference_activation a
		JOIN reference_release r ON r.id=a.release_id ORDER BY a.activation_number DESC LIMIT 1),
	topics(topic,q) AS (VALUES ${sql.join(
		Object.entries(QUERIES).map(([t, q]) => sql`(${t},to_tsquery('english',${q}))`),
		sql`,`,
	)}),
	hits AS (SELECT t.topic,h.* FROM topics t CROSS JOIN LATERAL (
		SELECT p.article_id,p.revision_id,p.revision_number,p.source_kind,p.source_id,p.title,p.slug,p.phase,p.content_type,
			${visibleBodySql()} AS body,
			ts_rank(r.search_vector,t.q)*CASE WHEN p.phase IS NULL THEN 1 ELSE 2 END AS score
		FROM picked p JOIN article_revision r ON r.id=p.revision_id
		WHERE NOT p.hidden AND (p.phase IS NULL OR p.phase=${phase}) AND r.search_vector @@ t.q ORDER BY score DESC,p.article_id LIMIT 4) h)
	SELECT EXISTS(SELECT FROM me) AS allowed,${phase} AS phase,
	(SELECT json_build_object('number',activation_number,'release',release_key) FROM act) AS activation,
	coalesce((SELECT json_agg(json_build_object('topic',topic,'article_id',article_id,'revision_id',revision_id,
		'revision_number',revision_number,'source_kind',source_kind,'source_id',source_id,'title',title,'slug',slug,
		'phase',phase,'content_type',content_type,'body',body) ORDER BY topic,score DESC,article_id) FROM hits),'[]') AS hits`);
	const r = retrievalRow.parse(rows[0]);
	if (!r.allowed || r.phase === null) return { status: "unavailable", phase: null };
	const phaseNow = r.phase;
	if (!r.activation) return { status: "reference_missing", phase: phaseNow };
	const passages: c.Passage[] = [];
	const seen = new Set<string>();
	for (const topic of Object.keys(QUERIES) as (keyof typeof QUERIES)[]) {
		let taken = 0;
		for (const h of r.hits) {
			if (h.topic !== topic || h.body === null || taken >= PER_TOPIC) continue;
			const best = sectionsOf(h.content_type, h.body)
				.map((s) => ({ ...s, score: STEMS[topic].filter((stem) => s.text.toLowerCase().includes(stem)).length }))
				.filter((s) => s.score > 0)
				.sort((a, b) => b.score - a.score || Number(a.section === null) - Number(b.section === null))[0];
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
