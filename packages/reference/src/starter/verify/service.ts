import { z } from "zod";
import { sql } from "@everyfield/db/query";
import type { Database, Transaction } from "@everyfield/db/client";
import "server-only";
import { promotion } from "@everyfield/contracts/reference";
import type { Promotion, ReferencePassage, ReferenceProfile } from "@everyfield/contracts/reference";
import { chunkEntries } from "../../bundle.ts";
import { canonical, hash, stableId, vectorHash } from "../../hash.ts";
import { referenceService as promoteService, ReferenceRefusal } from "../../server.ts";
import type { ReferenceAuthority } from "../../server.ts";
import { approvedSource, approvedWiki } from "../manifest/approved.ts";
import type { WikiSource } from "../manifest/approved.ts";
import { resolveWikiEmbedding, type WikiEmbedder, type WikiEmbedFetch } from "./embed.ts";
import { wikiBundle, wikiEntries, wikiPolicy } from "./generation.ts";
import { EmbeddingRefusal } from "./openai.ts";
import { checkSnapshot, loadApprovedSnapshot, WikiRefusal } from "./snapshot.ts";
import type { ApprovedSnapshot } from "./snapshot.ts";

const GLOBAL = "00000000-0000-0000-0000-000000000000";
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const releaseKey = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const callerSchema = z.strictObject({ actorId: z.uuid(), userId: z.uuid(), sessionId: z.uuid() });
const installSchema = z.strictObject({
	release: releaseKey,
	manifestSha256: sha,
	payloadSha256: sha,
	requestKey: z.string().min(1).max(200),
	expectedActivation: z.string().regex(/^\d+$/),
	target: z.literal(approvedWiki.target),
	kind: z.enum(["install", "rollback"]),
	fault: z.enum(["required_source_unavailable", "required_write_before_commit"]).optional(),
});
const rebuildSchema = z.strictObject({
	release: releaseKey,
	manifestSha256: sha,
	payloadSha256: sha,
	requestKey: z.string().min(1).max(200),
	expectedActivation: z.string().regex(/^\d+$/),
	target: z.literal(approvedWiki.target),
});
const cacheSchema = z.strictObject({ requestKey: z.string().min(1).max(200) });
const cacheReceipt = z.object({
	activeRelease: z.string(),
	activationNumber: z.string(),
	cacheGeneration: z.number().int(),
	replayed: z.boolean(),
});
const exportRow = z.object({
	gate: z.number().int(),
	activeRelease: z.string().nullable(),
	activationNumber: z.string().nullable(),
	partialActivation: z.boolean(),
	passages: z.number().int().nullable(),
	articles: z.number().int(),
	sections: z.number().int(),
	systemTemplates: z.number().int(),
	discovery: z.number().int(),
});

export interface WikiCaller {
	actorId: string;
	userId: string;
	sessionId: string;
}
export interface WikiDependencies {
	root?: URL;
	/** The pinned source to install. Defaults to the living seed; a rollback test passes an earlier pin. */
	source?: WikiSource;
	loadSnapshot?: () => Promise<ApprovedSnapshot>;
	embed?: WikiEmbedder;
	embeddingProfile?: string;
	embeddingDimensions?: number;
	fetch?: WikiEmbedFetch;
}
interface PlannedPassages {
	ok: true;
	passages: ReferencePassage[];
	usageTokens: number;
}
interface PassageFailure {
	ok: false;
	reason: string;
	usageTokens: number;
}

const localProfile: ReferenceProfile = {
	chunker: approvedWiki.chunker,
	model: approvedWiki.embeddingProfile,
	dimensions: approvedWiki.embeddingDimensions,
};

function wikiOf(error: unknown): never {
	if (error instanceof WikiRefusal) throw error;
	if (error instanceof ReferenceRefusal) {
		switch (error.code) {
			case "invalid_generation":
			case "stale_claim":
				throw new WikiRefusal("incomplete_candidate");
			case "access_denied":
			case "revision_conflict":
			case "idempotency_conflict":
			case "immutable_conflict":
			case "rollback_unavailable":
				throw new WikiRefusal(error.code);
		}
	}
	throw error instanceof Error ? error : new WikiRefusal("incomplete_candidate", "write_failed");
}
function parseCaller(input: unknown): WikiCaller {
	const parsed = callerSchema.safeParse(input);
	if (!parsed.success) throw new WikiRefusal("access_denied");
	return parsed.data;
}
function requirePins(source: WikiSource, manifestSha256: string, payloadSha256: string): void {
	if (manifestSha256 !== source.manifestSha256 || payloadSha256 !== source.payloadSha256)
		throw new WikiRefusal("digest_conflict");
}
function commandDigest(value: Record<string, string>): string {
	return hash(canonical(value));
}
function failedRebuild(reason: string, usageTokens = 0) {
	return {
		activated: false,
		activeRelease: null,
		activationNumber: null,
		passages: 0,
		reason,
		usageTokens,
	};
}
async function authorizeCaller(
	tx: Transaction,
	caller: WikiCaller,
	command: Promotion,
	source: WikiSource,
): Promise<ReferenceAuthority | null> {
	const selected = await tx.execute(sql`
		SELECT s.id
		FROM auth_session s
		JOIN account a ON a.id = ${caller.actorId}::uuid AND a.auth_user_id = s.user_id
		WHERE s.id = ${caller.sessionId}::uuid
		  AND s.user_id = ${caller.userId}::uuid
		  AND s.expires_at > clock_timestamp()
	`);
	if (selected.rows.length !== 1) return null;
	return {
		actorId: caller.actorId,
		mode: "operator",
		review: {
			commandDigest: hash(canonical(command)),
			approvalLocator: source.version,
			approvalHash: source.payloadSha256,
		},
	};
}

export function referenceService(db: Database, deps: WikiDependencies = {}) {
	const embedding = resolveWikiEmbedding(process.env, deps);
	const source = deps.source ?? approvedSource;
	async function snapshot(): Promise<ApprovedSnapshot> {
		const loaded = deps.loadSnapshot ? await deps.loadSnapshot() : await loadApprovedSnapshot(deps.root, source);
		checkSnapshot(loaded);
		return loaded;
	}
	async function activate(
		caller: WikiCaller,
		input: { release: string; requestKey: string; expectedActivation: string; kind: "activate" | "rollback" },
		bundle: ReturnType<typeof wikiBundle>,
		deferDerivatives: boolean,
	) {
		const request = {
			kind: input.kind,
			generationKey: bundle.key,
			manifestHash: hash(canonical(bundle)),
			expectedActivation: input.expectedActivation,
			reason: input.kind === "rollback" ? approvedWiki.rollbackReason : source.version,
			requestKey: input.requestKey,
		};
		const parsed = promotion.safeParse(request);
		if (!parsed.success) throw new WikiRefusal("incomplete_candidate", "promotion");
		const promoter = promoteService(db, {
			async loadArtifact(locator: string) {
				if (locator !== bundle.key) throw new WikiRefusal("incomplete_candidate", "artifact");
				return bundle;
			},
			policyFor(key: string) {
				if (key !== bundle.key) throw new WikiRefusal("incomplete_candidate", "policy");
				return wikiPolicy(source, bundle, deferDerivatives);
			},
			authorize: (tx, command) => authorizeCaller(tx, caller, command, source),
		});
		try {
			return await promoter.promote(parsed.data, bundle.key);
		} catch (error) {
			wikiOf(error);
		}
	}
	async function planPassages(snapshot: ApprovedSnapshot, release: string): Promise<PlannedPassages | PassageFailure> {
		try {
			const chunks = chunkEntries(wikiEntries(snapshot, release));
			let raws: readonly (readonly number[])[] = [];
			let usageTokens = 0;
			if (embedding.embedMany) {
				const embedded = await embedding.embedMany(chunks.map((chunk) => chunk.text));
				raws = embedded.vectors;
				usageTokens = embedded.totalTokens;
			} else if (embedding.embed) {
				const rows: number[][] = [];
				for (const chunk of chunks) rows.push([...(await embedding.embed(chunk.text))]);
				raws = rows;
			} else return { ok: false, reason: "incomplete_candidate", usageTokens: 0 };
			if (raws.length !== chunks.length) return { ok: false, reason: "incomplete_candidate", usageTokens };
			const passages: ReferencePassage[] = [];
			for (const [index, chunk] of chunks.entries()) {
				const raw = raws[index];
				if (!raw || raw.length !== embedding.dimensions || raw.some((value) => !Number.isFinite(value)))
					return { ok: false, reason: "incomplete_candidate", usageTokens };
				const vector = raw.map((value) => Math.fround(value));
				passages.push({
					key: chunk.key,
					revisionId: chunk.revisionId,
					ordinal: chunk.ordinal,
					text: chunk.text,
					contentHash: chunk.contentHash,
					embedding: vector,
					embeddingChecksum: vectorHash(vector),
				});
			}
			return { ok: true, passages, usageTokens };
		} catch (error) {
			if (error instanceof WikiRefusal) throw error;
			if (error instanceof EmbeddingRefusal)
				return { ok: false, reason: error.message, usageTokens: error.usageTokens };
			const reason = error instanceof Error && error.message ? error.message : "embedding_failed";
			return { ok: false, reason, usageTokens: 0 };
		}
	}
	async function installApprovedWiki(callerInput: unknown, input: unknown) {
		const caller = parseCaller(callerInput);
		const parsed = installSchema.safeParse(input);
		if (!parsed.success) throw new WikiRefusal("access_denied");
		const command = parsed.data;
		requirePins(source, command.manifestSha256, command.payloadSha256);
		if (command.fault === "required_source_unavailable") throw new WikiRefusal("source_unavailable");
		if (command.fault === "required_write_before_commit") throw new WikiRefusal("incomplete_candidate");
		const loaded = await snapshot();
		const bundle = wikiBundle(loaded, command.release, localProfile, []);
		const receipt = await activate(
			caller,
			{
				release: command.release,
				requestKey: command.requestKey,
				expectedActivation: command.expectedActivation,
				kind: command.kind === "rollback" ? "rollback" : "activate",
			},
			bundle,
			true,
		);
		return {
			release: receipt.generationKey,
			activationNumber: receipt.number,
			replayed: receipt.replayed,
			insertedArticles: receipt.createdRelease ? loaded.articles.length : 0,
			activeRelease: receipt.generationKey,
		};
	}
	async function rebuildEmbeddings(callerInput: unknown, input: unknown) {
		const caller = parseCaller(callerInput);
		const parsed = rebuildSchema.safeParse(input);
		if (!parsed.success) throw new WikiRefusal("access_denied");
		const command = parsed.data;
		requirePins(source, command.manifestSha256, command.payloadSha256);
		const loaded = await snapshot();
		const planned = await planPassages(loaded, command.release);
		if (!planned.ok) return failedRebuild(planned.reason, planned.usageTokens);
		const profile: ReferenceProfile = {
			chunker: approvedWiki.chunker,
			model: embedding.profile,
			dimensions: embedding.dimensions,
		};
		const bundle = wikiBundle(loaded, command.release, profile, planned.passages);
		const receipt = await activate(
			caller,
			{
				release: command.release,
				requestKey: command.requestKey,
				expectedActivation: command.expectedActivation,
				kind: "activate",
			},
			bundle,
			false,
		);
		return {
			activated: true,
			activeRelease: receipt.generationKey,
			activationNumber: receipt.number,
			passages: planned.passages.length,
			reason: null,
			usageTokens: planned.usageTokens,
		};
	}
	async function invalidateWikiCache(callerInput: unknown, input: unknown) {
		const caller = parseCaller(callerInput);
		const parsed = cacheSchema.safeParse(input);
		if (!parsed.success) throw new WikiRefusal("access_denied");
		const requestKey = parsed.data.requestKey;
		const digest = commandDigest({ kind: "cache", target: approvedWiki.target });
		const selected = await db.execute(sql`
				WITH prior AS (
				  SELECT id, result, metadata->>'requestDigest' AS digest, actor_id
				  FROM audit_event WHERE tenant_id = ${GLOBAL}::uuid AND request_key = ${requestKey}
				),
				gate AS (
				  SELECT a.id
				  FROM account a
				  JOIN platform_grant g ON g.account_id = a.id AND g.capability = 'reference_publish' AND g.revoked_at IS NULL
				    AND (g.expires_at IS NULL OR g.expires_at > clock_timestamp())
				  JOIN auth_session s ON s.id = ${caller.sessionId}::uuid AND s.user_id = ${caller.userId}::uuid
				    AND s.expires_at > clock_timestamp() AND a.auth_user_id = s.user_id
				  WHERE a.id = ${caller.actorId}::uuid AND a.registration_state = 'active'
				  FOR UPDATE OF a
				),
				current AS (
				  SELECT a.id, a.activation_number::text AS activation_number, r.release_key
				  FROM reference_activation a
				  JOIN reference_release r ON r.id = a.release_id
				  ORDER BY a.activation_number DESC
				  LIMIT 1
				),
				ins AS (
				  INSERT INTO audit_event(
				    id, tenant_id, actor_id, action, kind, subject_type, subject_id, request_key, metadata, result
				  )
				  SELECT ${stableId(`audit:${requestKey}`)}::uuid, ${GLOBAL}::uuid, ${caller.actorId}::uuid,
				    'reference.activated', 'noop', 'reference_activation', current.id, ${requestKey},
				    jsonb_build_object('requestDigest', ${digest}::text, 'purpose', 'wiki_cache'),
				    jsonb_build_object(
				      'activeRelease', current.release_key,
				      'activationNumber', current.activation_number,
				      'cacheGeneration', (
				        SELECT count(*)::int FROM audit_event WHERE metadata->>'purpose' = 'wiki_cache'
				      ) + 1,
				      'replayed', false
				    )
				  FROM current
				  WHERE (SELECT count(*) FROM gate) = 1 AND (SELECT id FROM prior) IS NULL
				  RETURNING result
				)
				SELECT CASE
				  WHEN (SELECT id FROM prior) IS NOT NULL AND (
				    (SELECT digest FROM prior) IS DISTINCT FROM ${digest}::text
				    OR (SELECT actor_id FROM prior) IS DISTINCT FROM ${caller.actorId}::uuid
				  ) THEN 'idempotency_conflict'
				  WHEN (SELECT id FROM prior) IS NOT NULL THEN 'replay'
				  WHEN (SELECT count(*) FROM gate) <> 1 THEN 'access_denied'
				  WHEN (SELECT id FROM current) IS NULL THEN 'revision_conflict'
				  ELSE 'written'
				END AS status,
				CASE
				  WHEN (SELECT id FROM prior) IS NOT NULL AND (
				    (SELECT digest FROM prior) IS NOT DISTINCT FROM ${digest}::text
				    AND (SELECT actor_id FROM prior) IS NOT DISTINCT FROM ${caller.actorId}::uuid
				  ) THEN (SELECT result FROM prior)
				  ELSE (SELECT result FROM ins)
				END AS result
			`);
		const row = z
			.object({
				status: z.enum(["written", "replay", "access_denied", "idempotency_conflict", "revision_conflict"]),
				result: z.unknown(),
			})
			.parse(selected.rows[0]);
		if (row.status !== "written" && row.status !== "replay") throw new WikiRefusal(row.status);
		return { ...cacheReceipt.parse(row.result), replayed: row.status === "replay" };
	}
	async function exportApprovedWiki(callerInput: unknown) {
		const caller = parseCaller(callerInput);
		const loaded = await snapshot();
		if (loaded.discoveryIds.some((id) => !z.uuid().safeParse(id).success))
			throw new WikiRefusal("incomplete_candidate", "discovery_id");
		const selected = await db.execute(sql`
				SELECT gate.n AS gate,
				  cur.release_key AS "activeRelease",
				  cur.activation_number AS "activationNumber",
				  coalesce((cur.passage_count IS DISTINCT FROM cur.expected_passages), false) AS "partialActivation",
				  cur.passage_count AS passages,
				  (SELECT count(*)::int FROM reference_item WHERE kind = 'article' AND tenant_id = ${GLOBAL}::uuid) AS articles,
				  (SELECT count(*)::int FROM reference_item WHERE kind = 'section' AND tenant_id = ${GLOBAL}::uuid) AS sections,
				  (SELECT count(*)::int FROM reference_item WHERE kind = 'mail_template' AND tenant_id = ${GLOBAL}::uuid) AS "systemTemplates",
				  (SELECT count(*)::int FROM reference_item WHERE kind = 'article' AND tenant_id = ${GLOBAL}::uuid
				    AND id = ANY(${sql.param([...loaded.discoveryIds])}::uuid[])) AS discovery
				FROM (
				  SELECT count(*)::int AS n
				  FROM (
				    SELECT a.id
				    FROM account a
				    JOIN platform_grant g ON g.account_id = a.id AND g.capability = 'reference_publish' AND g.revoked_at IS NULL
				      AND (g.expires_at IS NULL OR g.expires_at > clock_timestamp())
				    JOIN auth_session s ON s.id = ${caller.sessionId}::uuid AND s.user_id = ${caller.userId}::uuid
				      AND s.expires_at > clock_timestamp() AND a.auth_user_id = s.user_id
				    WHERE a.id = ${caller.actorId}::uuid AND a.registration_state = 'active'
				    FOR UPDATE OF a
				  ) locked
				) gate
				LEFT JOIN LATERAL (
				  SELECT r.release_key, a.activation_number::text AS activation_number, r.expected_passages,
				    (SELECT count(*)::int FROM passage p WHERE p.release_id = a.release_id) AS passage_count
				  FROM reference_activation a
				  JOIN reference_release r ON r.id = a.release_id
				  ORDER BY a.activation_number DESC
				  LIMIT 1
				) cur ON true
			`);
		const row = exportRow.parse(selected.rows[0]);
		if (row.gate !== 1) throw new WikiRefusal("access_denied");
		if (!row.activeRelease || !row.activationNumber || row.passages === null)
			throw new WikiRefusal("revision_conflict");
		return {
			activeRelease: row.activeRelease,
			activationNumber: row.activationNumber,
			partialActivation: row.partialActivation,
			orgAdoptionRequired: false as const,
			articles: row.articles,
			sections: row.sections,
			systemTemplates: row.systemTemplates,
			passages: row.passages,
			discoveryArticles: row.discovery,
			documentTemplatesSeparate: approvedWiki.documentTemplatesSeparate,
		};
	}
	return { exportApprovedWiki, installApprovedWiki, invalidateWikiCache, rebuildEmbeddings };
}
