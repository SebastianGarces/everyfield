import type { Database, Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import {
	DAILY_PUBLISH_CAP_USD,
	EmbeddingRefusal,
	estimateTokens,
	hash,
	passageTexts,
	recordSpend,
	RUN_CAP_USD,
	tokensFor,
	usdFor,
	vectorHash,
	type WikiPassageEmbedder,
} from "@everyfield/reference/wiki-embedding";
import "server-only";
import { z } from "zod";
import { claimDue, deferClaim, finishClaim, finishJob, lockClaim, recoverLease, type Claim } from "../jobs/queue.ts";
import { transaction } from "../jobs/index.ts";
import { asLogWord, logLine } from "../log.ts";

export { wikiPassageEmbedder } from "@everyfield/reference/wiki-embedding";

const NEXT_UTC_DAY = sql`(((clock_timestamp() AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE 'UTC')`;
const versionRow = z.object({
	article_id: z.uuid(),
	text: z.string().nullable(),
	current: z.boolean(),
	published: z.boolean(),
	profile: z.string().nullable(),
	dimensions: z.number().int().nullable(),
	spent: z.coerce.number(),
});
type Version = { articleId: string; texts: string[] };

function skipped(reason: string, estimatedTokens?: number) {
	logLine({
		component: "wiki",
		outcome: "embedding-skipped",
		reason: asLogWord(reason),
		...(estimatedTokens === undefined ? {} : { estimatedTokens }),
	});
}

async function versionOf(tx: Transaction, claim: Claim) {
	const found = await tx.execute(sql`
		SELECT r.article_id, wiki_search_words(r.content_type, r.body) AS text,
			COALESCE(e.current_revision_id = r.id, false) AS current,
			COALESCE(e.state = 'published', false) AS published,
			rel.embedding_profile AS profile, rel.embedding_dimensions AS dimensions,
			COALESCE((
				SELECT usage FROM embedding_spend
				WHERE day = (clock_timestamp() AT TIME ZONE 'UTC')::date AND purpose = 'publish'
			), 0) AS spent
		FROM article_revision r
		LEFT JOIN article_editor_state e ON e.organization_id = r.tenant_id AND e.article_id = r.article_id
		LEFT JOIN LATERAL (
			SELECT x.embedding_profile, x.embedding_dimensions
			FROM reference_activation a JOIN reference_release x ON x.id = a.release_id
			ORDER BY a.activation_number DESC LIMIT 1
		) rel ON true
		WHERE r.id = ${claim.subject_record_id}::uuid AND r.tenant_id = ${claim.tenant_id}::uuid
			AND r.published_at IS NOT NULL`);
	return found.rows[0] ? versionRow.parse(found.rows[0]) : null;
}

async function prepare(
	tx: Transaction,
	claim: Claim,
	embedder: WikiPassageEmbedder | null,
	runCapUsd: number,
): Promise<Version | null> {
	if (!(await lockClaim(tx, claim))) return null;
	const version = await versionOf(tx, claim);
	if (!version || !version.published) {
		await finishClaim(tx, claim, { state: "cancelled", code: "not_current" });
		return null;
	}
	if (!version.current) {
		await finishClaim(tx, claim, { state: "superseded", code: "stale" });
		return null;
	}
	if (!embedder) {
		await finishClaim(tx, claim, { state: "cancelled", code: "not_configured" });
		return null;
	}
	if (version.profile !== embedder.profile || version.dimensions !== embedder.dimensions) {
		await finishClaim(tx, claim, { state: "cancelled", code: "profile_mismatch" });
		return null;
	}
	const texts = passageTexts(version.text ?? "");
	const estimated = estimateTokens(texts);
	if (usdFor(estimated) > runCapUsd) {
		skipped("estimated_cost_over_cap", estimated);
		await finishClaim(tx, claim, { state: "failed", code: "over_cap" });
		return null;
	}
	if (version.spent >= tokensFor(DAILY_PUBLISH_CAP_USD)) {
		skipped("daily_limit");
		await deferClaim(tx, claim, NEXT_UTC_DAY);
		return null;
	}
	return { articleId: version.article_id, texts };
}

async function store(tx: Transaction, claim: Claim, version: Version, vectors: readonly number[][]) {
	if (!(await lockClaim(tx, claim))) return;
	const now = await versionOf(tx, claim);
	if (!now?.published || !now.current) {
		await finishClaim(tx, claim, { state: "superseded", code: "stale" });
		return;
	}
	const rows = version.texts.map((text, ordinal) => {
		const vector = (vectors[ordinal] ?? []).map((value) => (value === 0 ? 0 : Math.fround(value)));
		return { ordinal, text, contentHash: hash(text), vector: `[${vector.join(",")}]`, checksum: vectorHash(vector) };
	});
	await tx.execute(sql`
		DELETE FROM passage p
		USING article_revision r
		WHERE p.release_id IS NULL AND p.tenant_id = ${claim.tenant_id}::uuid
			AND r.id = p.revision_id AND r.tenant_id = p.tenant_id AND r.article_id = ${version.articleId}::uuid`);
	await tx.execute(sql`
		INSERT INTO passage(revision_id, tenant_id, ordinal, content, content_hash, embedding, embedding_checksum)
		SELECT ${claim.subject_record_id}::uuid, ${claim.tenant_id}::uuid, x.ordinal, x.text, x."contentHash",
			x.vector::public.vector, x.checksum
		FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(ordinal int, text text, "contentHash" text, vector text, checksum text)`);
	await finishClaim(tx, claim, { state: "succeeded" });
}

async function embed(db: Database, claim: Claim, embedder: WikiPassageEmbedder | null, runCapUsd: number) {
	const version = await transaction(db, (tx) => prepare(tx, claim, embedder, runCapUsd));
	if (!version || !embedder) return;
	let vectors: number[][] = [];
	if (version.texts.length) {
		try {
			const embedded = await embedder.embedMany(version.texts);
			await recordSpend(db, "publish", embedded.totalTokens);
			vectors = embedded.vectors;
		} catch (error) {
			const refusal = error instanceof EmbeddingRefusal ? error : null;
			if (refusal) await recordSpend(db, "publish", refusal.usageTokens);
			const reason = refusal?.code ?? "embedding_failed";
			logLine({ component: "wiki", outcome: "embedding-failed", reason: asLogWord(reason) });
			const unknown = reason === "openai_timeout" || reason === "openai_request_failed";
			await finishJob(db, claim, { state: "retry_wait", code: unknown ? "provider_unknown" : "provider_refused" });
			return;
		}
	}
	await transaction(db, (tx) => store(tx, claim, version, vectors));
}

export async function runDueWikiEmbedding(
	db: Database,
	embedder: WikiPassageEmbedder | null,
	limit: number,
	until: number,
	runCapUsd = RUN_CAP_USD,
): Promise<number> {
	await recoverLease(db);
	let claimed = 0;
	while (claimed < limit && Date.now() < until) {
		const [claim] = await claimDue(db, ["wiki_embedding"], 1);
		if (!claim) break;
		claimed++;
		await embed(db, claim, embedder, runCapUsd).catch(() => logLine({ component: "wiki", outcome: "embedding-error" }));
	}
	return claimed;
}
