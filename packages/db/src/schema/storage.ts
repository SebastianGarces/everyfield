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
import type { Pool, PoolClient } from "pg";
import { validateCommitment } from "./validate-file.js";
import type { FileObjectRow } from "./file.generated.js";

export type FilePurpose = FileObjectRow["purpose"];
export interface PrivateStorage {
	client: S3Client;
	bucket: string;
}
export type FileIdentity = Pick<FileObjectRow, "id" | "tenant_id" | "purpose">;
type StoredFile = FileObjectRow;
// Native producers supply fresh current resource/session/lifecycle checks in this transaction.
// This trusted server callback is never a request field, bearer witness or persisted grant.
export type FileAuthorization =
	{ kind: "account"; actorId: string } | { kind: "system"; cause: "native_file_upload" | "object_cleanup" };
export type ResourceAuthorizer = (
	tx: PoolClient,
	file: FileIdentity,
	intent: "put" | "read" | "cleanup",
) => Promise<FileAuthorization | null>;
const unavailable = () => new Error("unavailable");
function providerFailure(): never {
	throw unavailable();
}

async function transaction<T>(db: Pool, run: (tx: PoolClient) => Promise<T>): Promise<T> {
	const tx = await db.connect();
	try {
		await tx.query("BEGIN");
		const result = await run(tx);
		await tx.query("COMMIT");
		return result;
	} catch (error) {
		await tx.query("ROLLBACK");
		throw error;
	} finally {
		tx.release();
	}
}
async function authorized(
	db: Pool,
	authorize: ResourceAuthorizer,
	id: string,
	intent: "read" | "cleanup",
): Promise<StoredFile> {
	return transaction(db, async (tx) => {
		const result = await tx.query<StoredFile>("SELECT * FROM file_object WHERE id=$1 AND state='ready' FOR SHARE", [
			id,
		]);
		const file = result.rows[0];
		if (!file || !(await authorize(tx, file, intent))) throw unavailable();
		return file;
	});
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export async function putPrivateObject(
	db: Pool,
	storage: PrivateStorage,
	authorize: ResourceAuthorizer,
	input: { tenantId: string; purpose: FilePurpose; mediaType: string; bytes: Uint8Array; uploadKey: string },
) {
	// uploadKey is the owning native effect/receipt's stable key, never an object path.
	if (!input.uploadKey.trim() || input.uploadKey.length > 200) throw new Error("invalid_upload_key");
	const acl = await storage.client.send(new GetBucketAclCommand({ Bucket: storage.bucket })).catch(providerFailure);
	if (!acl.Grants?.length || acl.Grants.some((grant) => /AllUsers|AuthenticatedUsers/.test(grant.Grantee?.URI ?? "")))
		throw new Error("private_bucket_required");
	if (!input.bytes.length || input.bytes.length > 10 * 1024 * 1024) throw new Error("invalid_file");
	if (input.purpose === "commitment") await validateCommitment(input.bytes, input.mediaType);
	const sha256 = hash(input.bytes);
	const file = await transaction(db, async (tx) => {
		const candidate = { id: randomUUID(), tenant_id: input.tenantId, purpose: input.purpose };
		if (!(await authorize(tx, candidate, "put"))) throw unavailable();
		await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["file:" + input.uploadKey]);
		const prior = await tx.query<StoredFile>("SELECT * FROM file_object WHERE upload_key=$1 FOR UPDATE", [
			input.uploadKey,
		]);
		let current = prior.rows[0];
		if (!current) {
			const inserted = await tx.query<StoredFile>(
				"INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,byte_count,sha256,state,upload_key,claim_generation,expires_at) VALUES($1,$2,$3,$4,$5,$6,$6,$7,'pending',$8,0,clock_timestamp()+interval '15 minutes') RETURNING *",
				[
					candidate.id,
					candidate.tenant_id,
					candidate.purpose,
					`private/${candidate.tenant_id}/${randomUUID()}`,
					input.mediaType,
					input.bytes.length,
					sha256,
					input.uploadKey,
				],
			);
			current = inserted.rows[0];
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
	// Provider calls hold no SQL locks. Lost responses retry the same immutable key.
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
	return transaction(db, async (tx) => {
		const authority = await authorize(tx, file, "put");
		if (!authority) throw unavailable();
		const result = await tx.query(
			"UPDATE file_object SET state='ready',revision=revision+1 WHERE id=$1 AND state='pending' AND claim_generation=$2 AND expires_at>clock_timestamp() RETURNING id",
			[file.id, file.claim_generation],
		);
		if (result.rowCount !== 1) {
			const replay = await tx.query("SELECT id FROM file_object WHERE id=$1 AND state='ready' AND sha256=$2", [
				file.id,
				sha256,
			]);
			if (replay.rowCount !== 1) throw unavailable();
		}
		await tx.query(
			"INSERT INTO event(tenant_id,target_record_id,actor_id,system_cause,kind,occurred_at,recorded_at,after_revision,event_key,action) SELECT tenant_id,id,$2,$3,'finalize',clock_timestamp(),clock_timestamp(),revision,'file:ready','files.finalized' FROM file_object WHERE id=$1 ON CONFLICT(target_record_id,event_key) DO NOTHING",
			[
				file.id,
				authority.kind === "account" ? authority.actorId : null,
				authority.kind === "system" ? authority.cause : null,
			],
		);
		return { id: file.id };
	});
}
export async function readAuthorizedObject(
	db: Pool,
	storage: PrivateStorage,
	authorize: ResourceAuthorizer,
	id: string,
): Promise<Uint8Array> {
	const file = await authorized(db, authorize, id, "read");
	const result = await storage.client
		.send(new GetObjectCommand({ Bucket: storage.bucket, Key: file.opaque_key }))
		.catch(providerFailure);
	if (!result.Body || result.ContentLength !== Number(file.byte_count)) throw unavailable();
	const bytes = await result.Body.transformToByteArray();
	if (bytes.length !== Number(file.byte_count) || hash(bytes) !== file.sha256) throw unavailable();
	// Revocation while bytes are in flight must still deny delivery.
	await authorized(db, authorize, id, "read");
	return bytes;
}
export async function createAuthorizedDownload(
	db: Pool,
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
	db: Pool,
	storage: PrivateStorage,
	authorize: ResourceAuthorizer,
	id: string,
) {
	const claimed = await transaction(db, async (tx) => {
		const result = await tx.query<StoredFile>(
			"SELECT * FROM file_object WHERE id=$1 AND state IN ('ready','pending','failed','cleanup') FOR UPDATE",
			[id],
		);
		const file = result.rows[0];
		if (!file || !(await authorize(tx, file, "cleanup"))) throw unavailable();
		const refs = await tx.query<{ referenced: boolean }>("SELECT file_is_referenced($1) AS referenced", [id]);
		if (refs.rows[0]?.referenced !== false) throw unavailable();
		const claim = await tx.query<{ claim_generation: string }>(
			"UPDATE file_object SET state='cleanup',claim_generation=claim_generation+1,revision=revision+1,purge_requested_at=coalesce(purge_requested_at,clock_timestamp()) WHERE id=$1 RETURNING claim_generation",
			[id],
		);
		const generation = claim.rows[0]?.claim_generation;
		if (!generation) throw unavailable();
		return { file, generation };
	});
	try {
		await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: claimed.file.opaque_key }));
	} catch {
		return { status: "unknown" as const };
	} // Retained claim is retried with the same immutable key.
	const result = await db.query(
		"UPDATE file_object SET state='purged',purged_at=clock_timestamp(),revision=revision+1 WHERE id=$1 AND state='cleanup' AND claim_generation=$2 RETURNING id",
		[id, claimed.generation],
	);
	return { status: result.rowCount === 1 ? ("inaccessible" as const) : ("unknown" as const) };
}
