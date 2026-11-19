import "server-only";
import { randomUUID, createHash } from "node:crypto";
import {
	GetObjectCommand,
	PutObjectCommand,
	DeleteObjectCommand,
	GetBucketAclCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, Transaction } from "../client.ts";
import { file_object, audit_event } from "./tables.ts";
import { StorageError } from "./storage-error.ts";
import { validateCommitment } from "./validate-file.ts";
import { isProduction } from "../deployment.ts";
type FileObjectRow = typeof file_object.$inferSelect;

export type FilePurpose = FileObjectRow["purpose"];
export interface PrivateStorage {
	client: S3Client;
	bucket: string;
}

const storageEnv = z.object({
	AWS_BUCKET_NAME: z.string().min(1),
	AWS_ACCESS_KEY_ID: z.string().min(1),
	AWS_SECRET_ACCESS_KEY: z.string().min(1),
	AWS_ENDPOINT_URL_S3: z.url(),
	AWS_REGION: z.string().min(1).default("auto"),
});
const PRODUCTION_BUCKET = "everyfield";
export function privateStorageFrom(env: Record<string, string | undefined>): PrivateStorage | null {
	if (env.AWS_BUCKET_NAME === PRODUCTION_BUCKET && !isProduction(env))
		throw new Error(`The "${PRODUCTION_BUCKET}" bucket is for production only. Set AWS_BUCKET_NAME to everyfield-dev.`);
	const parsed = storageEnv.safeParse(env);
	if (!parsed.success) return null;
	const v = parsed.data;
	return {
		bucket: v.AWS_BUCKET_NAME,
		client: new S3Client({
			endpoint: v.AWS_ENDPOINT_URL_S3,
			region: v.AWS_REGION,
			forcePathStyle: true,
			credentials: { accessKeyId: v.AWS_ACCESS_KEY_ID, secretAccessKey: v.AWS_SECRET_ACCESS_KEY },
		}),
	};
}
type Shared = { configured?: PrivateStorage | null; checks: WeakMap<PrivateStorage, Promise<void>> };
const SHARED: unique symbol = Symbol.for("everyfield.db.privateStorage");
const shared: Shared = ((globalThis as { [SHARED]?: Shared })[SHARED] ??= { checks: new WeakMap() });
export function privateStorage(): PrivateStorage | null {
	if (shared.configured === undefined) shared.configured = privateStorageFrom(process.env);
	return shared.configured;
}
export type FileIdentity = Pick<FileObjectRow, "id" | "tenant_id" | "purpose">;
export type FileAuthorization =
	{ kind: "account"; actorId: string } | { kind: "system"; cause: "native_file_upload" | "object_cleanup" };
export type ResourceAuthorizer = (
	tx: Transaction,
	file: FileIdentity,
	intent: "put" | "read" | "cleanup",
) => Promise<FileAuthorization | null>;
const unavailable = () => new StorageError("unavailable");
function providerFailure(): never {
	throw unavailable();
}

async function authorized(
	db: Database,
	authorize: ResourceAuthorizer,
	id: string,
	intent: "read" | "cleanup",
): Promise<FileObjectRow> {
	return db.transaction(async (tx) => {
		const [file] = await tx
			.select()
			.from(file_object)
			.where(and(eq(file_object.id, id), eq(file_object.state, "ready")))
			.for("share");
		if (!file || !(await authorize(tx, file, intent))) throw unavailable();
		return file;
	});
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export async function putPrivateObject(
	db: Database,
	storage: PrivateStorage,
	authorize: ResourceAuthorizer,
	input: { tenantId: string; purpose: FilePurpose; mediaType: string; bytes: Uint8Array; uploadKey: string },
) {
	if (!input.uploadKey.trim() || input.uploadKey.length > 200) throw new StorageError("invalid_upload_key");
	await assertPrivateBucket(storage);
	if (!input.bytes.length || input.bytes.length > 10 * 1024 * 1024) throw new StorageError("invalid_file");
	if (input.purpose === "commitment") await validateCommitment(input.bytes, input.mediaType);
	const sha256 = hash(input.bytes);
	const file = await db.transaction(async (tx) => {
		const candidate = { id: randomUUID(), tenant_id: input.tenantId, purpose: input.purpose };
		if (!(await authorize(tx, candidate, "put"))) throw unavailable();
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"file:" + input.uploadKey},0))`);
		const prior = await tx.select().from(file_object).where(eq(file_object.upload_key, input.uploadKey)).for("update");
		let current = prior[0];
		if (!current) {
			const inserted = await tx
				.insert(file_object)
				.values({
					id: candidate.id,
					tenant_id: candidate.tenant_id,
					purpose: candidate.purpose,
					opaque_key: `private/${candidate.tenant_id}/${randomUUID()}`,
					media_type: input.mediaType,
					max_bytes: String(input.bytes.length),
					byte_count: String(input.bytes.length),
					sha256,
					state: "pending",
					upload_key: input.uploadKey,
					claim_generation: "0",
					expires_at: sql`clock_timestamp()+interval '15 minutes'`,
				})
				.returning();
			current = inserted[0];
		}
		if (
			!current ||
			current.tenant_id !== input.tenantId ||
			current.purpose !== input.purpose ||
			current.media_type !== input.mediaType ||
			current.sha256 !== sha256 ||
			Number(current.byte_count) !== input.bytes.length ||
			!["pending", "ready"].includes(current.state) ||
			!(await authorize(tx, current, "put"))
		)
			throw unavailable();
		if (current.state === "pending" && (!current.expires_at || current.expires_at.getTime() <= Date.now()))
			throw unavailable();
		return current;
	});
	if (file.state === "ready") return { id: file.id };
	try {
		await storage.client.send(
			new PutObjectCommand({
				Bucket: storage.bucket,
				Key: file.opaque_key,
				Body: input.bytes,
				ContentType: input.mediaType,
				ACL: "private",
				CacheControl: "private, no-store",
				IfNoneMatch: "*",
			}),
		);
	} catch (error) {
		if (!(error instanceof Error) || error.name !== "PreconditionFailed") throw unavailable();
		const existing = await storage.client
			.send(new GetObjectCommand({ Bucket: storage.bucket, Key: file.opaque_key }))
			.catch(providerFailure);
		if (
			!existing.Body ||
			existing.ContentLength !== input.bytes.length ||
			hash(await existing.Body.transformToByteArray()) !== sha256
		)
			throw unavailable();
	}
	return db.transaction(async (tx) => {
		const authority = await authorize(tx, file, "put");
		if (!authority) throw unavailable();
		const result = await tx
			.update(file_object)
			.set({ state: "ready", revision: sql`${file_object.revision}+1` })
			.where(
				and(
					eq(file_object.id, file.id),
					eq(file_object.state, "pending"),
					eq(file_object.claim_generation, file.claim_generation),
					gt(file_object.expires_at, sql`clock_timestamp()`),
				),
			)
			.returning({ revision: file_object.revision });
		let revision = result[0]?.revision;
		if (!revision) {
			const [replay] = await tx
				.select({ revision: file_object.revision })
				.from(file_object)
				.where(and(eq(file_object.id, file.id), eq(file_object.state, "ready"), eq(file_object.sha256, sha256)));
			if (!replay) throw unavailable();
			revision = replay.revision;
		}
		await tx
			.insert(audit_event)
			.values({
				tenant_id: file.tenant_id,
				subject_id: file.id,
				actor_id: authority.kind === "account" ? authority.actorId : null,
				system_cause: authority.kind === "system" ? authority.cause : null,
				kind: "finalize",
				occurred_at: sql`clock_timestamp()`,
				recorded_at: sql`clock_timestamp()`,
				after_revision: revision,
				event_key: "file:ready",
				action: "files.finalized",
			})
			.onConflictDoNothing({ target: [audit_event.subject_id, audit_event.event_key] });
		return { id: file.id };
	});
}

export function assertPrivateBucket(storage: PrivateStorage): Promise<void> {
	const privateChecks = shared.checks;
	const known = privateChecks.get(storage);
	if (known) return known;
	const check = storage.client
		.send(new GetBucketAclCommand({ Bucket: storage.bucket }))
		.catch(providerFailure)
		.then((acl) => {
			if (!acl.Grants?.length || acl.Grants.some((g) => /AllUsers|AuthenticatedUsers/.test(g.Grantee?.URI ?? "")))
				throw new StorageError("private_bucket_required");
		});
	privateChecks.set(storage, check);
	check.catch(() => privateChecks.delete(storage));
	return check;
}
const UPLOAD_URL_SECONDS = 300;
export async function signPrivatePut(storage: PrivateStorage, key: string, mediaType: string, byteLength: number) {
	await assertPrivateBucket(storage);
	const issuedAt = new Date();
	const url = await getSignedUrl(
		storage.client,
		new PutObjectCommand({
			Bucket: storage.bucket,
			Key: key,
			ContentType: mediaType,
			ContentLength: byteLength,
			IfNoneMatch: "*",
			CacheControl: "private, no-store",
		}),
		{
			expiresIn: UPLOAD_URL_SECONDS,
			signingDate: issuedAt,
			signableHeaders: new Set(["content-type", "content-length", "if-none-match", "cache-control"]),
		},
	).catch(providerFailure);
	return {
		url,
		headers: { "content-type": mediaType, "if-none-match": "*", "cache-control": "private, no-store" },
		expiresAt: new Date(issuedAt.getTime() + UPLOAD_URL_SECONDS * 1000).toISOString(),
	};
}
export async function readPrivateObject(storage: PrivateStorage, key: string, maxBytes: number) {
	const object = await readPrivateUpload(storage, key, maxBytes);
	return typeof object === "string" ? null : object;
}
export async function readPrivateUpload(
	storage: PrivateStorage,
	key: string,
	maxBytes: number,
): Promise<{ bytes: Uint8Array; mediaType: string } | "missing" | "too_large"> {
	const object = await storage.client
		.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key }))
		.catch(() => null);
	if (!object?.Body || !object.ContentLength) return "missing";
	if (object.ContentLength > maxBytes) return "too_large";
	const bytes = await object.Body.transformToByteArray().catch(() => null);
	return bytes && bytes.length === object.ContentLength ? { bytes, mediaType: object.ContentType ?? "" } : "missing";
}
export async function readAuthorizedObject(
	db: Database,
	storage: PrivateStorage,
	authorize: ResourceAuthorizer,
	id: string,
): Promise<Uint8Array> {
	return fetchAuthorized(db, storage, authorize, await authorized(db, authorize, id, "read"));
}
export async function readAuthorizedObjectIfChanged(
	db: Database,
	storage: PrivateStorage,
	authorize: ResourceAuthorizer,
	id: string,
	current: (sha256: string) => boolean,
): Promise<{ sha256: string; mediaType: string; bytes: Uint8Array | null }> {
	const file = await authorized(db, authorize, id, "read");
	if (!file.sha256) throw unavailable();
	const stored = { sha256: file.sha256, mediaType: file.media_type };
	if (current(file.sha256)) return { ...stored, bytes: null };
	return { ...stored, bytes: await fetchAuthorized(db, storage, authorize, file) };
}
async function fetchAuthorized(
	db: Database,
	storage: PrivateStorage,
	authorize: ResourceAuthorizer,
	file: FileObjectRow,
): Promise<Uint8Array> {
	const result = await storage.client
		.send(new GetObjectCommand({ Bucket: storage.bucket, Key: file.opaque_key }))
		.catch(providerFailure);
	if (!result.Body || result.ContentLength !== Number(file.byte_count)) throw unavailable();
	const bytes = await result.Body.transformToByteArray();
	if (bytes.length !== Number(file.byte_count) || hash(bytes) !== file.sha256) throw unavailable();
	await authorized(db, authorize, file.id, "read");
	return bytes;
}
export async function createAuthorizedDownload(
	db: Database,
	storage: PrivateStorage,
	authorize: ResourceAuthorizer,
	id: string,
) {
	const file = await authorized(db, authorize, id, "read");
	const issuedAt = new Date();
	const url = await getSignedUrl(
		storage.client,
		new GetObjectCommand({
			Bucket: storage.bucket,
			Key: file.opaque_key,
			ResponseCacheControl: "private, no-store",
			ResponseContentDisposition: "attachment",
		}),
		{ expiresIn: 300, signingDate: issuedAt },
	).catch(providerFailure);
	await authorized(db, authorize, id, "read");
	return { url, expiresAt: new Date(issuedAt.getTime() + 300_000).toISOString(), expiresInSeconds: 300 as const };
}
export async function deleteUnreferencedObject(
	db: Database,
	storage: PrivateStorage,
	authorize: ResourceAuthorizer,
	id: string,
) {
	const claimed = await db.transaction(async (tx) => {
		const [file] = await tx
			.select()
			.from(file_object)
			.where(and(eq(file_object.id, id), inArray(file_object.state, ["ready", "pending", "failed", "cleanup"])))
			.for("update");
		if (!file || !(await authorize(tx, file, "cleanup"))) throw unavailable();
		const refs = await tx.execute<{ referenced: boolean }>(sql`SELECT file_is_referenced(${id}) AS referenced`);
		if (refs.rows[0]?.referenced !== false) throw unavailable();
		const [claim] = await tx
			.update(file_object)
			.set({
				state: "cleanup",
				claim_generation: sql`${file_object.claim_generation}+1`,
				revision: sql`${file_object.revision}+1`,
				purge_requested_at: sql`coalesce(${file_object.purge_requested_at},clock_timestamp())`,
			})
			.where(eq(file_object.id, id))
			.returning({ claim_generation: file_object.claim_generation });
		const generation = claim?.claim_generation;
		if (!generation) throw unavailable();
		return { file, generation };
	});
	try {
		await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: claimed.file.opaque_key }), {
			abortSignal: AbortSignal.timeout(10_000),
		});
	} catch {
		return { status: "unknown" as const };
	}
	const result = await db
		.update(file_object)
		.set({ state: "purged", purged_at: sql`clock_timestamp()`, revision: sql`${file_object.revision}+1` })
		.where(
			and(
				eq(file_object.id, id),
				eq(file_object.state, "cleanup"),
				eq(file_object.claim_generation, claimed.generation),
			),
		)
		.returning({ id: file_object.id });
	return { status: result.length === 1 ? ("inaccessible" as const) : ("unknown" as const) };
}
