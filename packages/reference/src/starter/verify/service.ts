import { z } from "zod";
import { sql } from "@everyfield/db/query";
import type { Database } from "@everyfield/db/client";
import "server-only";
import { canonical, hash, stableId, vectorHash } from "../../hash.ts";
import { chunkEntries } from "../../bundle.ts";
import { approvedWiki } from "../manifest/approved.ts";
import { localEmbedding } from "./embed.ts";
import { loadApprovedSnapshot, WikiRefusal } from "./snapshot.ts";
import type { ApprovedSnapshot, WikiErrorCode } from "./snapshot.ts";

const GLOBAL = "00000000-0000-0000-0000-000000000000";
const LOCK = 7341033;
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
const installReceipt = z.object({
	release: z.string(),
	activationNumber: z.string(),
	replayed: z.boolean(),
	insertedArticles: z.number().int(),
	activeRelease: z.string(),
});
const embeddingReceipt = z.object({
	activated: z.boolean(),
	activeRelease: z.string().nullable(),
	activationNumber: z.string().nullable(),
	passages: z.number().int(),
});
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
	loadSnapshot?: () => Promise<ApprovedSnapshot>;
	embed?: (text: string) => readonly number[];
}
type InstallCommand = z.infer<typeof installSchema>;
type PassageRow = {
	id: string;
	revision: string;
	ordinal: number;
	body: string;
	hash: string;
	vector: string;
	checksum: string;
};

const refusalCodes: Record<string, WikiErrorCode> = {
	access_denied: "access_denied",
	source_unavailable: "source_unavailable",
	digest_conflict: "digest_conflict",
	immutable_conflict: "immutable_conflict",
	revision_conflict: "revision_conflict",
	incomplete_candidate: "incomplete_candidate",
	rollback_unavailable: "rollback_unavailable",
	idempotency_conflict: "idempotency_conflict",
	fault: "incomplete_candidate",
};

function quote(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}
function uuidList(ids: readonly string[]): string {
	if (ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))
		throw new WikiRefusal("incomplete_candidate", "discovery_id");
	return ids.map((id) => `${quote(id)}::uuid`).join(",");
}
function quoteJson(value: unknown): string {
	return `${quote(JSON.stringify(value))}::jsonb`;
}
function dollar(body: string): string {
	let tag = "evfwikido";
	while (body.includes(`$${tag}$`)) tag += "q";
	return `$${tag}$${body}$${tag}$`;
}
function textOf(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
		parts.push(current.message);
		if ("code" in current && typeof current.code === "string") parts.push(current.code);
		current = current.cause;
	}
	return parts.join(" ");
}
function refuse(error: unknown): never {
	if (error instanceof WikiRefusal) throw error;
	const text = textOf(error);
	const named = /invalid input syntax for type integer: "wiki_([a-z_]+)"/.exec(text);
	const code = named ? refusalCodes[named[1] ?? ""] : undefined;
	if (code) throw new WikiRefusal(code);
	if (text.includes("incomplete_reference_passages") || text.includes("incomplete_reference_release"))
		throw new WikiRefusal("incomplete_candidate");
	if (text.includes("23505")) throw new WikiRefusal("revision_conflict");
	throw error instanceof Error ? error : new WikiRefusal("incomplete_candidate", "write_failed");
}
function parseCaller(input: unknown): WikiCaller {
	const parsed = callerSchema.safeParse(input);
	if (!parsed.success) throw new WikiRefusal("access_denied");
	return parsed.data;
}
function requirePins(manifestSha256: string, payloadSha256: string): void {
	if (manifestSha256 !== approvedWiki.manifestSha256 || payloadSha256 !== approvedWiki.payloadSha256)
		throw new WikiRefusal("digest_conflict");
}
function commandDigest(value: Record<string, string>): string {
	return hash(canonical(value));
}
function planPassages(
	snapshot: ApprovedSnapshot,
	release: string,
	embed: (text: string) => readonly number[],
): PassageRow[] | null {
	try {
		const entries = snapshot.articles.map((article) => ({
			id: article.id,
			revisionId: stableId(`revision:${release}:${article.id}`),
			kind: "article" as const,
			key: article.slug,
			body: canonical({
				church_id: null,
				content: article.content,
				id: article.id,
				related_article_slugs: [...article.relatedSlugs],
				section_id: article.sectionId,
				slug: article.slug,
				status: "published",
			}),
			contentHash: article.contentSha256,
			sourcePath: approvedWiki.payloadPath,
			sourceHash: approvedWiki.payloadSha256,
			format: "safe_mdx" as const,
			slug: article.slug,
			sectionId: article.sectionId,
		}));
		const passages: PassageRow[] = [];
		for (const chunk of chunkEntries(entries)) {
			const raw = embed(chunk.text);
			if (raw.length !== approvedWiki.embeddingDimensions || raw.some((value) => !Number.isFinite(value))) return null;
			const embedding = raw.map((value) => Math.fround(value));
			passages.push({
				id: stableId(`passage:${release}:${chunk.revisionId}:${chunk.ordinal}`),
				revision: chunk.revisionId,
				ordinal: chunk.ordinal,
				body: chunk.text,
				hash: chunk.contentHash,
				vector: JSON.stringify(embedding),
				checksum: vectorHash(embedding),
			});
		}
		return passages;
	} catch {
		return null;
	}
}
function rowsFor(snapshot: ApprovedSnapshot, release: string, passages: readonly PassageRow[]) {
	const credit = `${approvedWiki.payloadPath}@${approvedWiki.payloadSha256}`;
	const items = [
		...snapshot.sections.map((section) => ({ id: section.id, kind: "section", key: section.slug })),
		...snapshot.articles.map((article) => ({ id: article.id, kind: "article", key: article.slug })),
		...snapshot.templates.map((template) => ({
			id: stableId(`mail_template:${template.name}`),
			kind: "mail_template",
			key: template.name,
		})),
	];
	const versions = [
		...snapshot.sections.map((section) => ({
			id: stableId(`version:${release}:${section.id}`),
			item: section.id,
			path: `${approvedWiki.payloadPath}#${section.id}`,
			hash: section.recordSha256,
			credit,
		})),
		...snapshot.articles.map((article) => ({
			id: stableId(`version:${release}:${article.id}`),
			item: article.id,
			path: `${approvedWiki.payloadPath}#${article.id}`,
			hash: article.contentSha256,
			credit,
		})),
		...snapshot.templates.map((template) => {
			const item = stableId(`mail_template:${template.name}`);
			return {
				id: stableId(`version:${release}:${item}`),
				item,
				path: `${approvedWiki.payloadPath}#${item}`,
				hash: template.sha256,
				credit,
			};
		}),
	];
	const articles = snapshot.articles.map((article) => ({
		id: stableId(`revision:${release}:${article.id}`),
		item: article.id,
		title: article.title,
		slug: article.slug,
		excerpt: article.excerpt,
		body: article.content,
		phase: article.phase,
		sort_order: article.position,
		hash: article.contentSha256,
		section: article.sectionId,
	}));
	return { items, versions, articles, passages };
}

// One client statement. Statements inside the DO block see one another, so the activation trigger can see its passages.
function writeSql(input: {
	caller: WikiCaller;
	release: string;
	kind: "install" | "rollback" | "rebuild";
	requestKey: string;
	expectedActivation: string;
	digest: string;
	fault: string;
	reason: string;
	passages: number;
	items: unknown[];
	versions: unknown[];
	articles: unknown[];
	passageRows: readonly PassageRow[];
}): string {
	const body = `
DECLARE
  v_actor uuid := ${quote(input.caller.actorId)}::uuid;
  v_user uuid := ${quote(input.caller.userId)}::uuid;
  v_session uuid := ${quote(input.caller.sessionId)}::uuid;
  v_global uuid := ${quote(GLOBAL)}::uuid;
  v_release_key text := ${quote(input.release)};
  v_kind text := ${quote(input.kind)};
  v_request_key text := ${quote(input.requestKey)};
  v_expected bigint := ${input.expectedActivation};
  v_digest text := ${quote(input.digest)};
  v_fault text := ${quote(input.fault)};
  v_reason text := ${quote(input.reason)};
  v_payload_sha text := ${quote(approvedWiki.payloadSha256)};
  v_locator text := ${quote(approvedWiki.payloadPath)};
  v_approval text := ${quote(approvedWiki.version)};
  v_new_release uuid := ${quote(stableId(`release:${input.release}`))}::uuid;
  v_activation_id uuid := ${quote(stableId(`activation:${input.requestKey}`))}::uuid;
  v_audit_id uuid := ${quote(stableId(`audit:${input.requestKey}`))}::uuid;
  v_items jsonb := ${quoteJson(input.items)};
  v_versions jsonb := ${quoteJson(input.versions)};
  v_articles jsonb := ${quoteJson(input.articles)};
  v_passages jsonb := ${quoteJson(input.passageRows)};
  v_reported_passages int := ${input.passages};
  v_expected_passages int := ${input.kind === "rebuild" ? input.passages : 0};
  v_gate int;
  v_prior_id uuid;
  v_prior_digest text;
  v_prior_actor uuid;
  v_current_id uuid;
  v_current_number bigint;
  v_current_release uuid;
  v_current_key text;
  v_existing_hash text;
  v_saved uuid;
  v_activating boolean;
  v_number bigint;
  v_subject uuid;
  v_active_key text;
  v_inserted int := 0;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(${LOCK});
  SELECT id, metadata->>'requestDigest', actor_id INTO v_prior_id, v_prior_digest, v_prior_actor
  FROM audit_event WHERE tenant_id = v_global AND request_key = v_request_key;
  IF v_prior_id IS NOT NULL THEN
    IF v_prior_digest IS DISTINCT FROM v_digest OR v_prior_actor IS DISTINCT FROM v_actor THEN
      PERFORM CAST('wiki_idempotency_conflict' AS integer);
    END IF;
    PERFORM set_config('evf.wiki_replayed', 'true', true);
    RETURN;
  END IF;
  PERFORM set_config('evf.wiki_replayed', 'false', true);
  SELECT count(*) INTO v_gate FROM (
    SELECT a.id
    FROM account a
    JOIN platform_grant g ON g.account_id = a.id AND g.capability = 'reference_publish' AND g.revoked_at IS NULL
      AND (g.expires_at IS NULL OR g.expires_at > clock_timestamp())
    JOIN auth_session s ON s.id = v_session AND s.user_id = v_user AND s.expires_at > clock_timestamp()
    WHERE a.id = v_actor AND a.registration_state = 'active'
    FOR UPDATE OF a
  ) locked;
  IF v_gate <> 1 THEN PERFORM CAST('wiki_access_denied' AS integer); END IF;
  IF v_fault = 'required_write_before_commit' THEN PERFORM CAST('wiki_fault' AS integer); END IF;
  SELECT a.id, a.activation_number, a.release_id, r.release_key
  INTO v_current_id, v_current_number, v_current_release, v_current_key
  FROM reference_activation a
  JOIN reference_release r ON r.id = a.release_id
  ORDER BY a.activation_number DESC
  LIMIT 1;
  IF v_expected IS DISTINCT FROM coalesce(v_current_number, 0) THEN
    PERFORM CAST('wiki_revision_conflict' AS integer);
  END IF;
  SELECT manifest_hash INTO v_existing_hash FROM reference_release WHERE release_key = v_release_key;
  IF v_kind = 'rollback' AND NOT EXISTS (
    SELECT 1 FROM reference_activation act
    JOIN reference_release rel ON rel.id = act.release_id
    WHERE rel.release_key = v_release_key
  ) THEN PERFORM CAST('wiki_rollback_unavailable' AS integer); END IF;
  IF v_existing_hash IS NOT NULL AND v_existing_hash IS DISTINCT FROM v_payload_sha THEN
    PERFORM CAST('wiki_immutable_conflict' AS integer);
  END IF;
  IF v_kind <> 'rollback' AND EXISTS (
    SELECT 1 FROM reference_version v
    JOIN jsonb_to_recordset(v_versions) AS x(item uuid, hash text) ON v.item_id = x.item
    WHERE v.content_hash IS DISTINCT FROM x.hash
  ) THEN PERFORM CAST('wiki_immutable_conflict' AS integer); END IF;
  IF v_kind = 'rollback' THEN
    SELECT id INTO v_saved FROM reference_release WHERE release_key = v_release_key;
  ELSE
    INSERT INTO reference_release(
      id, release_key, artifact_locator, manifest_hash, state, complete_at, validated_at,
      approval_locator, approval_hash, chunker_version, embedding_profile, embedding_dimensions,
      tenant_id, expected_passages
    )
    SELECT v_new_release, v_release_key, v_locator, v_payload_sha, 'validated', clock_timestamp(), clock_timestamp(),
      v_approval, v_payload_sha, ${quote(approvedWiki.chunker)}, ${quote(approvedWiki.embeddingProfile)},
      ${approvedWiki.embeddingDimensions}, v_global, v_expected_passages
    WHERE NOT EXISTS (SELECT 1 FROM reference_release WHERE release_key = v_release_key);
    SELECT id INTO v_saved FROM reference_release WHERE release_key = v_release_key;
    INSERT INTO reference_item(id, kind, canonical_key, tenant_id)
    SELECT x.id, x.kind, x.key, v_global
    FROM jsonb_to_recordset(v_items) AS x(id uuid, kind text, key text)
    ON CONFLICT DO NOTHING;
    INSERT INTO reference_version(id, item_id, release_id, version_number, artifact_path, content_hash, source_credit)
    SELECT x.id, x.item, v_saved, coalesce((SELECT max(version_number) FROM reference_version WHERE item_id = x.item), 0) + 1,
      x.path, x.hash, x.credit
    FROM jsonb_to_recordset(v_versions) AS x(id uuid, item uuid, path text, hash text, credit text)
    WHERE NOT EXISTS (SELECT 1 FROM reference_version existing WHERE existing.id = x.id);
    INSERT INTO article_revision(
      id, article_id, tenant_id, release_id, revision_number, title, slug, excerpt, body, content_type,
      phase, parent_article_id, position, content_hash, published_at, meaningful, meaningful_sequence, section_id
    )
    SELECT x.id, x.item, v_global, v_saved,
      coalesce((SELECT max(revision_number) FROM article_revision WHERE article_id = x.item AND tenant_id = v_global), 0) + 1,
      x.title, x.slug, x.excerpt, x.body, 'safe_mdx', x.phase, null, x.sort_order, x.hash, clock_timestamp(), true,
      coalesce((SELECT max(meaningful_sequence) FROM article_revision WHERE article_id = x.item AND tenant_id = v_global), 0) + 1,
      x.section
    FROM jsonb_to_recordset(v_articles) AS x(
      id uuid, item uuid, title text, slug text, excerpt text, body text, phase int, sort_order int, hash text, section uuid
    )
    WHERE NOT EXISTS (SELECT 1 FROM article_revision existing WHERE existing.id = x.id);
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    INSERT INTO passage(id, release_id, revision_id, tenant_id, ordinal, content, content_hash, embedding, embedding_checksum)
    SELECT x.id, v_saved, x.revision, v_global, x.ordinal, x.body, x.hash, x.vector::public.vector, x.checksum
    FROM jsonb_to_recordset(v_passages) AS x(
      id uuid, revision uuid, ordinal int, body text, hash text, vector text, checksum text
    )
    WHERE NOT EXISTS (SELECT 1 FROM passage existing WHERE existing.id = x.id);
  END IF;
  v_activating := v_kind = 'rollback' OR v_current_release IS DISTINCT FROM v_saved;
  IF v_activating THEN
    v_number := coalesce(v_current_number, 0) + 1;
    v_subject := v_activation_id;
    v_active_key := v_release_key;
    INSERT INTO reference_activation(
      id, release_id, activation_number, previous_id, activated_at, actor_id, reason, expected_prior_number
    ) VALUES (
      v_activation_id, v_saved, v_number, v_current_id, clock_timestamp(), v_actor, v_reason, coalesce(v_current_number, 0)
    );
  ELSE
    v_number := v_current_number;
    v_subject := v_current_id;
    v_active_key := v_current_key;
  END IF;
  v_result := jsonb_build_object(
    'release', v_release_key,
    'activationNumber', v_number::text,
    'replayed', false,
    'insertedArticles', v_inserted,
    'activeRelease', v_active_key,
    'activated', true,
    'passages', v_reported_passages
  );
  INSERT INTO audit_event(
    id, tenant_id, actor_id, action, kind, subject_type, subject_id, request_key, metadata, before_value, after_value, result
  ) VALUES (
    v_audit_id, v_global, v_actor, 'reference.activated', CASE WHEN v_activating THEN 'publish' ELSE 'noop' END,
    'reference_activation', v_subject, v_request_key,
    jsonb_build_object('requestDigest', v_digest, 'purpose', 'wiki_snapshot'),
    CASE WHEN v_activating THEN jsonb_build_object('releaseId', v_current_release) ELSE NULL END,
    CASE WHEN v_activating THEN jsonb_build_object('releaseId', v_saved) ELSE NULL END,
    v_result
  );
END`;
	return `DO ${dollar(body)}`;
}

export function referenceService(db: Database, deps: WikiDependencies = {}) {
	const embed = deps.embed ?? localEmbedding;
	async function snapshot(): Promise<ApprovedSnapshot> {
		return deps.loadSnapshot ? deps.loadSnapshot() : loadApprovedSnapshot(deps.root);
	}
	async function commit(body: string, requestKey: string): Promise<{ result: unknown; replayed: boolean }> {
		try {
			let receipt: { result: unknown; replayed: boolean } | undefined;
			await db.transaction(async (tx) => {
				await tx.execute(sql.raw(body));
				const selected = await tx.execute(
					sql`SELECT result, current_setting('evf.wiki_replayed', true) AS replayed FROM audit_event WHERE tenant_id = ${GLOBAL}::uuid AND request_key = ${requestKey}`,
				);
				const row = z.object({ result: z.unknown(), replayed: z.string().nullable() }).parse(selected.rows[0]);
				receipt = { result: row.result, replayed: row.replayed === "true" };
			});
			if (!receipt) throw new WikiRefusal("revision_conflict");
			return receipt;
		} catch (error) {
			refuse(error);
		}
	}
	function overlay<T extends { replayed: boolean }>(receipt: T, replayed: boolean): T {
		return { ...receipt, replayed };
	}
	async function installApprovedWiki(callerInput: unknown, input: unknown) {
		const caller = parseCaller(callerInput);
		const parsed = installSchema.safeParse(input);
		if (!parsed.success) throw new WikiRefusal("access_denied");
		const command: InstallCommand = parsed.data;
		requirePins(command.manifestSha256, command.payloadSha256);
		if (command.fault === "required_source_unavailable") throw new WikiRefusal("source_unavailable");
		const loaded = await snapshot();
		const built =
			command.kind === "rollback"
				? { items: [], versions: [], articles: [], passages: [] }
				: rowsFor(loaded, command.release, []);
		const digest = commandDigest({
			release: command.release,
			manifestSha256: command.manifestSha256,
			payloadSha256: command.payloadSha256,
			expectedActivation: command.expectedActivation,
			kind: command.kind,
			target: command.target,
		});
		const stored = await commit(
			writeSql({
				caller,
				release: command.release,
				kind: command.kind,
				requestKey: command.requestKey,
				expectedActivation: command.expectedActivation,
				digest,
				fault: command.fault ?? "",
				reason: command.kind === "rollback" ? approvedWiki.rollbackReason : approvedWiki.version,
				passages: 0,
				items: built.items,
				versions: built.versions,
				articles: built.articles,
				passageRows: [],
			}),
			command.requestKey,
		);
		return overlay(installReceipt.parse(stored.result), stored.replayed);
	}
	async function rebuildEmbeddings(callerInput: unknown, input: unknown) {
		const caller = parseCaller(callerInput);
		const parsed = rebuildSchema.safeParse(input);
		if (!parsed.success) throw new WikiRefusal("access_denied");
		const command = parsed.data;
		requirePins(command.manifestSha256, command.payloadSha256);
		const loaded = await snapshot();
		const passageRows = planPassages(loaded, command.release, embed);
		if (!passageRows) return { activated: false, activeRelease: null, activationNumber: null, passages: 0 };
		const built = rowsFor(loaded, command.release, passageRows);
		const digest = commandDigest({
			release: command.release,
			manifestSha256: command.manifestSha256,
			payloadSha256: command.payloadSha256,
			expectedActivation: command.expectedActivation,
			kind: "rebuild",
			target: command.target,
		});
		const stored = await commit(
			writeSql({
				caller,
				release: command.release,
				kind: "rebuild",
				requestKey: command.requestKey,
				expectedActivation: command.expectedActivation,
				digest,
				fault: "",
				reason: approvedWiki.version,
				passages: passageRows.length,
				items: built.items,
				versions: built.versions,
				articles: built.articles,
				passageRows,
			}),
			command.requestKey,
		);
		const receipt = embeddingReceipt.parse(stored.result);
		return stored.replayed ? { ...receipt, activated: true } : receipt;
	}
	async function invalidateWikiCache(callerInput: unknown, input: unknown) {
		const caller = parseCaller(callerInput);
		const parsed = cacheSchema.safeParse(input);
		if (!parsed.success) throw new WikiRefusal("access_denied");
		const requestKey = parsed.data.requestKey;
		const digest = commandDigest({ kind: "cache", target: approvedWiki.target });
		try {
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
				    AND s.expires_at > clock_timestamp()
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
			return overlay(cacheReceipt.parse(row.result), row.status === "replay");
		} catch (error) {
			refuse(error);
		}
	}
	async function exportApprovedWiki(callerInput: unknown) {
		const caller = parseCaller(callerInput);
		const loaded = await snapshot();
		const idList = uuidList(loaded.discoveryIds);
		try {
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
				    AND id = ANY(ARRAY[${sql.raw(idList)}])) AS discovery
				FROM (
				  SELECT count(*)::int AS n
				  FROM (
				    SELECT a.id
				    FROM account a
				    JOIN platform_grant g ON g.account_id = a.id AND g.capability = 'reference_publish' AND g.revoked_at IS NULL
				      AND (g.expires_at IS NULL OR g.expires_at > clock_timestamp())
				    JOIN auth_session s ON s.id = ${caller.sessionId}::uuid AND s.user_id = ${caller.userId}::uuid
				      AND s.expires_at > clock_timestamp()
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
		} catch (error) {
			refuse(error);
		}
	}
	return { exportApprovedWiki, installApprovedWiki, invalidateWikiCache, rebuildEmbeddings };
}
