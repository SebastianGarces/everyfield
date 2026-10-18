import "server-only";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { generation, promotion } from "@everyfield/contracts/reference";
import type { Promotion, ReferenceGeneration } from "@everyfield/contracts/reference";
import { validateBundle } from "./bundle.ts";
import type { ValidationPolicy } from "./bundle.ts";
import { hash, canonical, stableId, vectorHash } from "./hash.ts";

type ReferenceErrorCode =
	| "access_denied"
	| "invalid_generation"
	| "revision_conflict"
	| "idempotency_conflict"
	| "immutable_conflict"
	| "stale_claim"
	| "rollback_unavailable";
const GLOBAL = "00000000-0000-0000-0000-000000000000";
export class ReferenceRefusal extends Error {
	readonly code: ReferenceErrorCode;
	constructor(code: ReferenceErrorCode) {
		super(code);
		this.code = code;
	}
}
interface ReviewedOperator {
	actorId: string;
	// Trusted adapter loads current session/lifecycle and exact reviewed command, never client flags.
	review: { commandDigest: string; approvalLocator: string; approvalHash: string };
}
export type ReferenceAuthority = ReviewedOperator &
	({ mode: "operator" } | { mode: "worker"; claim: { jobId: string; generation: string; leaseOwner: string } });
export interface ReferenceDependencies {
	loadArtifact: (locator: string) => Promise<unknown>;
	policyFor: (key: string) => ValidationPolicy;
	authorize: (tx: PoolClient, command: Promotion) => Promise<ReferenceAuthority | null>;
}
export interface ActivationReceipt {
	operationId: string;
	activationId: string;
	eventId: string | null;
	number: string;
	generationKey: string;
	replayed: boolean;
}

// No HTTP/session adapter is installed by this producer. Its trusted adapter owns session and review loading.
export function referenceService(db: Pool, deps: ReferenceDependencies) {
	async function authorizeCurrent(
		tx: PoolClient,
		command: Promotion,
		requestDigest: string,
	): Promise<ReferenceAuthority> {
		const authority = await deps.authorize(tx, command);
		if (!authority || authority.review.commandDigest !== requestDigest) throw new ReferenceRefusal("access_denied");
		const grant = await tx.query(
			`SELECT g.id FROM platform_grant g JOIN account a ON a.id=g.account_id
      WHERE g.account_id=$1 AND g.capability='reference_publish' AND g.revoked_at IS NULL
      AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp()) AND a.registration_state='active' FOR SHARE OF g,a`,
			[authority.actorId],
		);
		if (grant.rowCount !== 1) throw new ReferenceRefusal("access_denied");
		return authority;
	}
	async function promote(input: unknown, artifactLocator: string): Promise<ActivationReceipt> {
		const command = promotion.parse(input),
			requestDigest = hash(canonical(command));
		// Refuse before protected artifact access, then refresh authority at the commit boundary.
		const preflight = await db.connect();
		try {
			await preflight.query("BEGIN");
			await authorizeCurrent(preflight, command, requestDigest);
			await preflight.query("COMMIT");
		} catch (error) {
			await preflight.query("ROLLBACK");
			throw error;
		} finally {
			preflight.release();
		}
		// All artifact/provider I/O and CPU work precedes SQL locks.
		const candidate = generation.safeParse(await deps.loadArtifact(artifactLocator));
		if (!candidate.success || candidate.data.key !== command.generationKey)
			throw new ReferenceRefusal("invalid_generation");
		const bundle = candidate.data,
			report = validateBundle(bundle, deps.policyFor(bundle.key));
		if (!report.ok || report.manifestHash !== command.manifestHash) throw new ReferenceRefusal("invalid_generation");
		const tx = await db.connect();
		try {
			await tx.query("BEGIN");
			await tx.query("SELECT pg_advisory_xact_lock(7341032)");
			const authority = await authorizeCurrent(tx, command, requestDigest);
			const actor = authority.actorId;
			if (authority.mode === "worker") {
				const claim = await tx.query(
					`SELECT id FROM job WHERE id=$1 AND tenant_id=$2 AND kind='reference_generation'
          AND state='claimed' AND claim_generation=$3 AND lease_owner=$4 AND checkpoint_key=$5 AND lease_until>clock_timestamp() FOR SHARE`,
					[authority.claim.jobId, GLOBAL, authority.claim.generation, authority.claim.leaseOwner, command.manifestHash],
				);
				if (claim.rowCount !== 1) throw new ReferenceRefusal("stale_claim");
			}
			const old = await tx.query<{ id: string; actor_id: string; request_digest: string }>(
				"SELECT id,actor_id,request_digest FROM operation WHERE tenant_id=$1 AND request_key=$2",
				[GLOBAL, command.requestKey],
			);
			const prior = old.rows[0];
			if (prior) {
				if (prior.actor_id !== actor || prior.request_digest !== requestDigest)
					throw new ReferenceRefusal("idempotency_conflict");
				const receipt = await readReceipt(tx, prior.id);
				await tx.query("COMMIT");
				return { ...receipt, replayed: true };
			}
			const current = (
				await tx.query<{ id: string; activation_number: string; release_id: string }>(
					"SELECT id,activation_number::text,release_id FROM reference_activation ORDER BY activation_number DESC LIMIT 1",
				)
			).rows[0];
			if (command.expectedActivation !== (current?.activation_number ?? "0"))
				throw new ReferenceRefusal("revision_conflict");
			const saved = (
				await tx.query<{ id: string; manifest_hash: string; state: string }>(
					"SELECT id,manifest_hash,state FROM reference_release WHERE release_key=$1 FOR SHARE",
					[bundle.key],
				)
			).rows[0];
			if (saved && (saved.manifest_hash !== command.manifestHash || saved.state !== "validated"))
				throw new ReferenceRefusal("immutable_conflict");
			if (command.kind === "rollback") {
				const historical =
					saved && (await tx.query("SELECT 1 FROM reference_activation WHERE release_id=$1", [saved.id]));
				if (!historical?.rowCount) throw new ReferenceRefusal("rollback_unavailable");
			}
			const releaseId =
				saved?.id ?? (await install(tx, bundle, artifactLocator, command.manifestHash, authority.review));
			// Immutable rows are checked again before reuse. A stale or corrupted persisted derivative is not readiness.
			await verifyStored(tx, bundle, releaseId);
			const operationId = randomUUID();
			await tx.query(
				`INSERT INTO operation(id,tenant_id,actor_id,name,request_key,request_digest,state,outcome,
        started_at,completed_at,tool_calls,reserved_input,reserved_output,used_input,used_output)
        VALUES($1,$2,$3,$4,$5,$6,'complete',$7,clock_timestamp(),clock_timestamp(),0,0,0,0,0)`,
				[
					operationId,
					GLOBAL,
					actor,
					command.kind === "activate" ? "reference.activateGeneration" : "reference.rollbackActivation",
					command.requestKey,
					requestDigest,
					current?.release_id === releaseId ? "no_effect" : "committed",
				],
			);
			const unchanged = current?.release_id === releaseId;
			const activationId = unchanged ? current.id : randomUUID();
			const number = unchanged ? current.activation_number : (BigInt(command.expectedActivation) + 1n).toString();
			if (!unchanged)
				await tx.query(
					`INSERT INTO reference_activation(id,release_id,activation_number,previous_id,activated_at,actor_id,reason,expected_prior_number)
        VALUES($1,$2,$3,$4,clock_timestamp(),$5,$6,$7)`,
					[activationId, releaseId, number, current?.id ?? null, actor, command.reason, command.expectedActivation],
				);
			const eventId = randomUUID();
			// The factual no-op event provides a durable link to the original activation, without another activation.
			await tx.query(
				`INSERT INTO event(id,tenant_id,target_record_id,operation_id,actor_id,kind,occurred_at,recorded_at,event_key,action,diff)
        VALUES($1,$2,$3,$4,$5,$6,clock_timestamp(),clock_timestamp(),$7,$8,$9)`,
				[
					eventId,
					GLOBAL,
					activationId,
					operationId,
					actor,
					unchanged ? "noop" : "publish",
					operationId,
					unchanged ? null : "reference.activated",
					JSON.stringify({ after: { version_id: releaseId, content_hash: command.manifestHash } }),
				],
			);
			await tx.query("COMMIT");
			return { operationId, activationId, eventId, number, generationKey: bundle.key, replayed: false };
		} catch (error) {
			await tx.query("ROLLBACK");
			throw error;
		} finally {
			tx.release();
		}
	}
	return {
		promote,
		async current() {
			// Every consumer joins all publication and derivative rows by this release_id from one read snapshot.
			const row = (
				await db.query<{
					id: string;
					release_id: string;
					activation_number: string;
					release_key: string;
					manifest_hash: string;
				}>(
					`SELECT a.id,a.release_id,a.activation_number::text,r.release_key,r.manifest_hash
       FROM reference_activation a JOIN reference_release r ON r.id=a.release_id ORDER BY a.activation_number DESC LIMIT 1`,
				)
			).rows[0];
			return row ?? null;
		},
	};
}
async function readReceipt(tx: PoolClient, operationId: string): Promise<ActivationReceipt> {
	const row = (
		await tx.query<{ id: string; event_id: string; activation_number: string; release_key: string }>(
			`SELECT a.id,e.id AS event_id,a.activation_number::text,r.release_key FROM event e
     JOIN reference_activation a ON a.id=e.target_record_id JOIN reference_release r ON r.id=a.release_id WHERE e.operation_id=$1`,
			[operationId],
		)
	).rows[0];
	if (!row) throw new ReferenceRefusal("immutable_conflict");
	return {
		operationId,
		activationId: row.id,
		eventId: row.event_id,
		number: row.activation_number,
		generationKey: row.release_key,
		replayed: true,
	};
}
async function install(
	tx: PoolClient,
	bundle: ReferenceGeneration,
	locator: string,
	manifestHash: string,
	review: ReferenceAuthority["review"],
): Promise<string> {
	const id = randomUUID();
	await tx.query(
		`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,chunker_version,embedding_profile,
    embedding_dimensions,tenant_id,expected_passages) VALUES($1,$2,$3,$4,'building',$5,$6,$7,$8,$9)`,
		[
			id,
			bundle.key,
			locator,
			manifestHash,
			bundle.profile.chunker,
			bundle.profile.model,
			bundle.profile.dimensions,
			GLOBAL,
			bundle.passages.length,
		],
	);
	// Bounded bulk inserts keep provider latency out of per-item transaction work.
	await tx.query(
		`INSERT INTO reference_item(id,kind,canonical_key,tenant_id)
    SELECT id,kind,key,$2 FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,kind text,key text) ON CONFLICT DO NOTHING`,
		[JSON.stringify(bundle.entries), GLOBAL],
	);
	const items = await tx.query<{ id: string; kind: string; canonical_key: string; tenant_id: string }>(
		"SELECT id,kind,canonical_key,tenant_id FROM reference_item WHERE id=ANY($1::uuid[]) ORDER BY id",
		[bundle.entries.map((e) => e.id)],
	);
	const expected = bundle.entries
		.map((e) => ({ id: e.id, kind: e.kind, canonical_key: e.key, tenant_id: GLOBAL }))
		.sort((a, b) => a.id.localeCompare(b.id, "en"));
	if (canonical(items.rows) !== canonical(expected)) throw new ReferenceRefusal("immutable_conflict");
	const versions = bundle.entries.map((e) => ({
		id: stableId("version:" + e.revisionId),
		item: e.id,
		path: locator + "#" + e.id,
		hash: e.contentHash,
		credit: e.sourcePath + "@" + e.sourceHash,
	}));
	await tx.query(
		`INSERT INTO reference_version(id,item_id,release_id,version_number,artifact_path,content_hash,source_credit)
    SELECT x.id,x.item,$2,coalesce((SELECT max(version_number) FROM reference_version WHERE item_id=x.item),0)+1,x.path,x.hash,x.credit
    FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,item uuid,path text,hash text,credit text)`,
		[JSON.stringify(versions), id],
	);
	const articles = bundle.entries
		.filter((e) => e.kind === "article")
		.map((e) => {
			const a = JSON.parse(e.body);
			return {
				id: e.revisionId,
				item: e.id,
				title: a.title,
				slug: a.slug,
				excerpt: a.excerpt,
				body: a.content,
				phase: a.phase,
				position: a.sort_order,
				hash: hash(a.content),
				section: e.sectionId,
			};
		});
	await tx.query(
		`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,excerpt,body,content_type,
    phase,parent_article_id,position,content_hash,published_at,meaningful,meaningful_sequence,section_id)
    SELECT x.id,x.item,$3,$2,coalesce((SELECT max(revision_number) FROM article_revision WHERE article_id=x.item AND tenant_id=$3),0)+1,
    x.title,x.slug,x.excerpt,x.body,'safe_mdx',x.phase,null,x.position,x.hash,clock_timestamp(),true,
    coalesce((SELECT max(meaningful_sequence) FROM article_revision WHERE article_id=x.item AND tenant_id=$3),0)+1,x.section
    FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,item uuid,title text,slug text,excerpt text,body text,phase int,position int,hash text,section uuid)`,
		[JSON.stringify(articles), id, GLOBAL],
	);
	const passages = bundle.passages.map((p) => ({ ...p, id: randomUUID(), vector: JSON.stringify(p.embedding) }));
	await tx.query(
		`INSERT INTO passage(id,release_id,revision_id,tenant_id,ordinal,content,content_hash,embedding,embedding_checksum)
    SELECT x.id,$2,x."revisionId",$3,x.ordinal,x.text,x."contentHash",x.vector::vector,x."embeddingChecksum"
    FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,"revisionId" uuid,ordinal int,text text,"contentHash" text,vector text,"embeddingChecksum" text)`,
		[JSON.stringify(passages), id, GLOBAL],
	);
	await tx.query(
		`UPDATE reference_release SET state='validated',complete_at=clock_timestamp(),validated_at=clock_timestamp(),approval_locator=$2,approval_hash=$3
    WHERE id=$1`,
		[id, review.approvalLocator, review.approvalHash],
	);
	return id;
}
async function verifyStored(tx: PoolClient, bundle: ReferenceGeneration, id: string): Promise<void> {
	const release = (
		await tx.query<{
			artifact_locator: string;
			manifest_hash: string;
			state: string;
			chunker_version: string;
			embedding_profile: string;
			embedding_dimensions: number;
			expected_passages: number;
			tenant_id: string;
		}>(
			"SELECT artifact_locator,manifest_hash,state,chunker_version,embedding_profile,embedding_dimensions,expected_passages,tenant_id FROM reference_release WHERE id=$1",
			[id],
		)
	).rows[0];
	if (
		!release ||
		release.manifest_hash !== hash(canonical(bundle)) ||
		release.state !== "validated" ||
		release.tenant_id !== GLOBAL ||
		release.chunker_version !== bundle.profile.chunker ||
		release.embedding_profile !== bundle.profile.model ||
		release.embedding_dimensions !== bundle.profile.dimensions ||
		release.expected_passages !== bundle.passages.length
	)
		throw new ReferenceRefusal("immutable_conflict");
	const versions = await tx.query<{
		id: string;
		item_id: string;
		content_hash: string;
		artifact_path: string;
		source_credit: string;
	}>(
		"SELECT id,item_id,content_hash,artifact_path,source_credit FROM reference_version WHERE release_id=$1 ORDER BY id",
		[id],
	);
	const expected = bundle.entries
		.map((e) => ({
			id: stableId("version:" + e.revisionId),
			item_id: e.id,
			content_hash: e.contentHash,
			artifact_path: release.artifact_locator + "#" + e.id,
			source_credit: e.sourcePath + "@" + e.sourceHash,
		}))
		.sort((a, b) => a.id.localeCompare(b.id, "en"));
	if (canonical(versions.rows) !== canonical(expected)) throw new ReferenceRefusal("immutable_conflict");
	const published = await tx.query(
		"SELECT id,article_id,section_id,tenant_id,title,slug,excerpt,body,phase,position,content_hash,content_type FROM article_revision WHERE release_id=$1 ORDER BY id",
		[id],
	);
	const expectedArticles = bundle.entries
		.filter((e) => e.kind === "article")
		.map((e) => {
			const a = JSON.parse(e.body);
			return {
				id: e.revisionId,
				article_id: e.id,
				section_id: e.sectionId,
				tenant_id: GLOBAL,
				title: a.title,
				slug: a.slug,
				excerpt: a.excerpt,
				body: a.content,
				phase: a.phase,
				position: a.sort_order,
				content_hash: hash(a.content),
				content_type: "safe_mdx",
			};
		})
		.sort((a, b) => a.id.localeCompare(b.id, "en"));
	if (canonical(published.rows) !== canonical(expectedArticles)) throw new ReferenceRefusal("immutable_conflict");
	const articles = new Set(bundle.entries.filter((e) => e.kind === "article").map((e) => e.revisionId));
	const passages = await tx.query<{
		revision_id: string;
		ordinal: number;
		content: string;
		content_hash: string;
		embedding_checksum: string;
		embedding: string;
	}>(
		"SELECT revision_id,ordinal,content,content_hash,embedding_checksum,embedding::text FROM passage WHERE release_id=$1",
		[id],
	);
	const actual = passages.rows
		.map((p) => ({
			key: p.revision_id + ":" + p.ordinal,
			contentHash: p.content_hash,
			text: p.content,
			checksum: p.embedding_checksum,
			embedding: vectorHash(JSON.parse(p.embedding)),
		}))
		.sort((a, b) => a.key.localeCompare(b.key, "en"));
	const planned = bundle.passages
		.filter((p) => articles.has(p.revisionId))
		.map((p) => ({
			key: p.key,
			contentHash: p.contentHash,
			text: p.text,
			checksum: p.embeddingChecksum,
			embedding: vectorHash(p.embedding),
		}))
		.sort((a, b) => a.key.localeCompare(b.key, "en"));
	if (canonical(actual) !== canonical(planned)) throw new ReferenceRefusal("immutable_conflict");
}
