import * as tables from "@everyfield/db/tables";
import { and, asc, desc, eq, gt, isNull, or, sql } from "@everyfield/db/query";
import { alias } from "@everyfield/db/query";
import "server-only";
import { randomUUID } from "node:crypto";
import type { Database, Transaction } from "@everyfield/db/client";
import { generation, promotion } from "@everyfield/contracts/reference";
import type { Promotion, ReferenceGeneration } from "@everyfield/contracts/reference";
import { validateBundle } from "./bundle.ts";
import type { ValidationPolicy } from "./bundle.ts";
import { hash, canonical, stableId, vectorHash } from "./hash.ts";
const platform_grant_g = alias(tables.platform_grant, "g");
const account_a = alias(tables.account, "a");
const reference_activation_a = alias(tables.reference_activation, "a");
const reference_release_r = alias(tables.reference_release, "r");
const event_e = alias(tables.event, "e");

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
	authorize: (tx: Transaction, command: Promotion) => Promise<ReferenceAuthority | null>;
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
export function referenceService(db: Database, deps: ReferenceDependencies) {
	async function authorizeCurrent(
		tx: Transaction,
		command: Promotion,
		requestDigest: string,
	): Promise<ReferenceAuthority> {
		const authority = await deps.authorize(tx, command);
		if (!authority || authority.review.commandDigest !== requestDigest) throw new ReferenceRefusal("access_denied");
		const grant = await tx
			.select({ id: platform_grant_g.id })
			.from(platform_grant_g)
			.innerJoin(account_a, eq(account_a.id, platform_grant_g.account_id))
			.where(
				and(
					and(
						and(
							and(
								eq(platform_grant_g.account_id, authority.actorId),
								eq(platform_grant_g.capability, "reference_publish"),
							),
							isNull(platform_grant_g.revoked_at),
						),
						or(
							isNull(platform_grant_g.expires_at),
							gt(
								platform_grant_g.expires_at,
								sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
							),
						),
					),
					eq(account_a.registration_state, "active"),
				),
			)
			.for("share", { of: [platform_grant_g, account_a] });
		if (grant.length !== 1) throw new ReferenceRefusal("access_denied");
		return authority;
	}
	async function promote(input: unknown, artifactLocator: string): Promise<ActivationReceipt> {
		const command = promotion.parse(input),
			requestDigest = hash(canonical(command));
		// Refuse before protected artifact access, then refresh authority at the commit boundary.
		await db.transaction((preflight) => authorizeCurrent(preflight, command, requestDigest));
		// All artifact/provider I/O and CPU work precedes SQL locks.
		const candidate = generation.safeParse(await deps.loadArtifact(artifactLocator));
		if (!candidate.success || candidate.data.key !== command.generationKey)
			throw new ReferenceRefusal("invalid_generation");
		const bundle = candidate.data,
			report = validateBundle(bundle, deps.policyFor(bundle.key));
		if (!report.ok || report.manifestHash !== command.manifestHash) throw new ReferenceRefusal("invalid_generation");
		return db.transaction(async (tx) => {
			await tx.execute(sql`SELECT pg_advisory_xact_lock(7341032)`);
			const authority = await authorizeCurrent(tx, command, requestDigest);
			const actor = authority.actorId;
			if (authority.mode === "worker") {
				const claim = await tx
					.select({ id: tables.job.id })
					.from(tables.job)
					.where(
						and(
							and(
								and(
									and(
										and(
											and(
												and(eq(tables.job.id, authority.claim.jobId), eq(tables.job.tenant_id, GLOBAL)),
												eq(tables.job.kind, "reference_generation"),
											),
											eq(tables.job.state, "claimed"),
										),
										eq(tables.job.claim_generation, authority.claim.generation),
									),
									eq(tables.job.lease_owner, authority.claim.leaseOwner),
								),
								eq(tables.job.checkpoint_key, command.manifestHash),
							),
							gt(
								tables.job.lease_until,
								sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
							),
						),
					)
					.for("share");
				if (claim.length !== 1) throw new ReferenceRefusal("stale_claim");
			}
			const old = await tx
				.select({
					id: tables.operation.id,
					actor_id: tables.operation.actor_id,
					request_digest: tables.operation.request_digest,
				})
				.from(tables.operation)
				.where(and(eq(tables.operation.tenant_id, GLOBAL), eq(tables.operation.request_key, command.requestKey)));
			const prior = old[0];
			if (prior) {
				if (prior.actor_id !== actor || prior.request_digest !== requestDigest)
					throw new ReferenceRefusal("idempotency_conflict");
				const receipt = await readReceipt(tx, prior.id);
				return { ...receipt, replayed: true };
			}
			const current = (
				await tx
					.select({
						id: tables.reference_activation.id,
						activation_number: sql<string>`(${tables.reference_activation.activation_number})::text`,
						release_id: tables.reference_activation.release_id,
					})
					.from(tables.reference_activation)
					.orderBy(desc(tables.reference_activation.activation_number))
					.limit(1)
			)[0];
			if (command.expectedActivation !== (current?.activation_number ?? "0"))
				throw new ReferenceRefusal("revision_conflict");
			const saved = (
				await tx
					.select({
						id: tables.reference_release.id,
						manifest_hash: tables.reference_release.manifest_hash,
						state: tables.reference_release.state,
					})
					.from(tables.reference_release)
					.where(eq(tables.reference_release.release_key, bundle.key))
					.for("share")
			)[0];
			if (saved && (saved.manifest_hash !== command.manifestHash || saved.state !== "validated"))
				throw new ReferenceRefusal("immutable_conflict");
			if (command.kind === "rollback") {
				const historical =
					saved && (await tx.execute(sql`SELECT 1 FROM reference_activation WHERE release_id=${sql.param(saved.id)}`));
				if (!historical?.rowCount) throw new ReferenceRefusal("rollback_unavailable");
			}
			const releaseId =
				saved?.id ?? (await install(tx, bundle, artifactLocator, command.manifestHash, authority.review));
			// Immutable rows are checked again before reuse. A stale or corrupted persisted derivative is not readiness.
			await verifyStored(tx, bundle, releaseId);
			const operationId = randomUUID();
			await tx.insert(tables.operation).values({
				id: operationId,
				tenant_id: GLOBAL,
				actor_id: actor,
				name: command.kind === "activate" ? "reference.activateGeneration" : "reference.rollbackActivation",
				request_key: command.requestKey,
				request_digest: requestDigest,
				state: "complete",
				outcome: current?.release_id === releaseId ? "no_effect" : "committed",
				started_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
				completed_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
				tool_calls: 0,
				reserved_input: 0,
				reserved_output: 0,
				used_input: 0,
				used_output: 0,
			});
			const unchanged = current?.release_id === releaseId;
			const activationId = unchanged ? current.id : randomUUID();
			const number = unchanged ? current.activation_number : (BigInt(command.expectedActivation) + 1n).toString();
			if (!unchanged)
				await tx.insert(tables.reference_activation).values({
					id: activationId,
					release_id: releaseId,
					activation_number: sql`${number}`,
					previous_id: current?.id ?? null,
					activated_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
					actor_id: actor,
					reason: command.reason,
					expected_prior_number: sql`${command.expectedActivation}`,
				});
			const eventId = randomUUID();
			// The factual no-op event provides a durable link to the original activation, without another activation.
			await tx.insert(tables.event).values({
				id: eventId,
				tenant_id: GLOBAL,
				target_record_id: activationId,
				operation_id: operationId,
				actor_id: actor,
				kind: unchanged ? "noop" : "publish",
				occurred_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
				recorded_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
				event_key: operationId,
				action: unchanged ? null : "reference.activated",
				diff: { after: { version_id: releaseId, content_hash: command.manifestHash } },
			});
			return { operationId, activationId, eventId, number, generationKey: bundle.key, replayed: false };
		});
	}
	return {
		promote,
		async current() {
			// Every consumer joins all publication and derivative rows by this release_id from one read snapshot.
			const row = (
				await db
					.select({
						id: reference_activation_a.id,
						release_id: reference_activation_a.release_id,
						activation_number: sql<string>`(${reference_activation_a.activation_number})::text`,
						release_key: reference_release_r.release_key,
						manifest_hash: reference_release_r.manifest_hash,
					})
					.from(reference_activation_a)
					.innerJoin(reference_release_r, eq(reference_release_r.id, reference_activation_a.release_id))
					.orderBy(desc(reference_activation_a.activation_number))
					.limit(1)
			)[0];
			return row ?? null;
		},
	};
}
async function readReceipt(tx: Transaction, operationId: string): Promise<ActivationReceipt> {
	const row = (
		await tx
			.select({
				id: reference_activation_a.id,
				event_id: event_e.id,
				activation_number: sql<string>`(${reference_activation_a.activation_number})::text`,
				release_key: reference_release_r.release_key,
			})
			.from(event_e)
			.innerJoin(reference_activation_a, eq(reference_activation_a.id, event_e.target_record_id))
			.innerJoin(reference_release_r, eq(reference_release_r.id, reference_activation_a.release_id))
			.where(eq(event_e.operation_id, operationId))
	)[0];
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
	tx: Transaction,
	bundle: ReferenceGeneration,
	locator: string,
	manifestHash: string,
	review: ReferenceAuthority["review"],
): Promise<string> {
	const id = randomUUID();
	await tx.insert(tables.reference_release).values({
		id: id,
		release_key: bundle.key,
		artifact_locator: locator,
		manifest_hash: manifestHash,
		state: "building",
		chunker_version: bundle.profile.chunker,
		embedding_profile: bundle.profile.model,
		embedding_dimensions: bundle.profile.dimensions,
		tenant_id: GLOBAL,
		expected_passages: bundle.passages.length,
	});
	// Bounded bulk inserts keep provider latency out of per-item transaction work.
	await tx.execute(sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id)
    SELECT id,kind,key,${sql.param(GLOBAL)} FROM jsonb_to_recordset(${sql.param(JSON.stringify(bundle.entries))}::jsonb) AS x(id uuid,kind text,key text) ON CONFLICT DO NOTHING`);
	const items = await tx
		.select({
			id: tables.reference_item.id,
			kind: tables.reference_item.kind,
			canonical_key: tables.reference_item.canonical_key,
			tenant_id: tables.reference_item.tenant_id,
		})
		.from(tables.reference_item)
		.where(eq(tables.reference_item.id, sql<unknown>`any((${sql.param(bundle.entries.map((e) => e.id))})::uuid [])`))
		.orderBy(asc(tables.reference_item.id));
	const expected = bundle.entries
		.map((e) => ({ id: e.id, kind: e.kind, canonical_key: e.key, tenant_id: GLOBAL }))
		.sort((a, b) => a.id.localeCompare(b.id, "en"));
	if (canonical(items) !== canonical(expected)) throw new ReferenceRefusal("immutable_conflict");
	const versions = bundle.entries.map((e) => ({
		id: stableId("version:" + e.revisionId),
		item: e.id,
		path: locator + "#" + e.id,
		hash: e.contentHash,
		credit: e.sourcePath + "@" + e.sourceHash,
	}));
	await tx.execute(sql`INSERT INTO reference_version(id,item_id,release_id,version_number,artifact_path,content_hash,source_credit)
    SELECT x.id,x.item,${sql.param(id)},coalesce((SELECT max(version_number) FROM reference_version WHERE item_id=x.item),0)+1,x.path,x.hash,x.credit
    FROM jsonb_to_recordset(${sql.param(JSON.stringify(versions))}::jsonb) AS x(id uuid,item uuid,path text,hash text,credit text)`);
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
	await tx.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,excerpt,body,content_type,
    phase,parent_article_id,position,content_hash,published_at,meaningful,meaningful_sequence,section_id)
    SELECT x.id,x.item,${sql.param(GLOBAL)},${sql.param(id)},coalesce((SELECT max(revision_number) FROM article_revision WHERE article_id=x.item AND tenant_id=${sql.param(GLOBAL)}),0)+1,
    x.title,x.slug,x.excerpt,x.body,'safe_mdx',x.phase,null,x.position,x.hash,clock_timestamp(),true,
    coalesce((SELECT max(meaningful_sequence) FROM article_revision WHERE article_id=x.item AND tenant_id=${sql.param(GLOBAL)}),0)+1,x.section
    FROM jsonb_to_recordset(${sql.param(JSON.stringify(articles))}::jsonb) AS x(id uuid,item uuid,title text,slug text,excerpt text,body text,phase int,position int,hash text,section uuid)`);
	const passages = bundle.passages.map((p) => ({ ...p, id: randomUUID(), vector: JSON.stringify(p.embedding) }));
	await tx.execute(sql`INSERT INTO passage(id,release_id,revision_id,tenant_id,ordinal,content,content_hash,embedding,embedding_checksum)
    SELECT x.id,${sql.param(id)},x."revisionId",${sql.param(GLOBAL)},x.ordinal,x.text,x."contentHash",x.vector::public.vector,x."embeddingChecksum"
    FROM jsonb_to_recordset(${sql.param(JSON.stringify(passages))}::jsonb) AS x(id uuid,"revisionId" uuid,ordinal int,text text,"contentHash" text,vector text,"embeddingChecksum" text)`);
	await tx
		.update(tables.reference_release)
		.set({
			state: "validated",
			complete_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
			validated_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
			approval_locator: review.approvalLocator,
			approval_hash: review.approvalHash,
		})
		.where(eq(tables.reference_release.id, id));
	return id;
}
async function verifyStored(tx: Transaction, bundle: ReferenceGeneration, id: string): Promise<void> {
	const release = (
		await tx
			.select({
				artifact_locator: tables.reference_release.artifact_locator,
				manifest_hash: tables.reference_release.manifest_hash,
				state: tables.reference_release.state,
				chunker_version: tables.reference_release.chunker_version,
				embedding_profile: tables.reference_release.embedding_profile,
				embedding_dimensions: tables.reference_release.embedding_dimensions,
				expected_passages: tables.reference_release.expected_passages,
				tenant_id: tables.reference_release.tenant_id,
			})
			.from(tables.reference_release)
			.where(eq(tables.reference_release.id, id))
	)[0];
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
	const versions = await tx
		.select({
			id: tables.reference_version.id,
			item_id: tables.reference_version.item_id,
			content_hash: tables.reference_version.content_hash,
			artifact_path: tables.reference_version.artifact_path,
			source_credit: tables.reference_version.source_credit,
		})
		.from(tables.reference_version)
		.where(eq(tables.reference_version.release_id, id))
		.orderBy(asc(tables.reference_version.id));
	const expected = bundle.entries
		.map((e) => ({
			id: stableId("version:" + e.revisionId),
			item_id: e.id,
			content_hash: e.contentHash,
			artifact_path: release.artifact_locator + "#" + e.id,
			source_credit: e.sourcePath + "@" + e.sourceHash,
		}))
		.sort((a, b) => a.id.localeCompare(b.id, "en"));
	if (canonical(versions) !== canonical(expected)) throw new ReferenceRefusal("immutable_conflict");
	const published = await tx
		.select({
			id: tables.article_revision.id,
			article_id: tables.article_revision.article_id,
			section_id: tables.article_revision.section_id,
			tenant_id: tables.article_revision.tenant_id,
			title: tables.article_revision.title,
			slug: tables.article_revision.slug,
			excerpt: tables.article_revision.excerpt,
			body: tables.article_revision.body,
			phase: tables.article_revision.phase,
			position: tables.article_revision.position,
			content_hash: tables.article_revision.content_hash,
			content_type: tables.article_revision.content_type,
		})
		.from(tables.article_revision)
		.where(eq(tables.article_revision.release_id, id))
		.orderBy(asc(tables.article_revision.id));
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
	if (canonical(published) !== canonical(expectedArticles)) throw new ReferenceRefusal("immutable_conflict");
	const articles = new Set(bundle.entries.filter((e) => e.kind === "article").map((e) => e.revisionId));
	const passages = await tx
		.select({
			revision_id: tables.passage.revision_id,
			ordinal: tables.passage.ordinal,
			content: tables.passage.content,
			content_hash: tables.passage.content_hash,
			embedding_checksum: tables.passage.embedding_checksum,
			embedding: sql<string>`(${tables.passage.embedding})::text`,
		})
		.from(tables.passage)
		.where(eq(tables.passage.release_id, id));
	const actual = passages
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
