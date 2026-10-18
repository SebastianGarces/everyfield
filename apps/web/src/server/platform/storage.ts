import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Pool } from "pg";
import { z } from "zod";
import { currentScope, transaction } from "./database.ts";
import { Refusal } from "./boundary.ts";
import { previewText, maxFileBytes } from "./preview.ts";
import type { FileFormat } from "./preview.ts";
import type { PlatformAuth } from "./auth.ts";

export const uploadInput = z.strictObject({
	ownerId: z.uuid(),
	format: z.enum(["docx", "xlsx", "pdf"]),
	checksum: z.string().regex(/^[a-f0-9]{64}$/),
	bytes: z.number().int().min(1).max(maxFileBytes),
});
export type Storage = { client: S3Client; bucket: string; prefix: string };
export function storageFromEnvironment(): Storage {
	const {
		PLATFORM_STORAGE_BUCKET: bucket,
		PLATFORM_STORAGE_PREFIX: prefix,
		AWS_ACCESS_KEY_ID,
		AWS_SECRET_ACCESS_KEY,
		AWS_ENDPOINT_URL_S3,
		AWS_REGION,
	} = process.env;
	if (
		!bucket ||
		!prefix ||
		!/^wp003\/[a-f0-9-]+\/$/.test(prefix) ||
		bucket !== "everyfield-evidence" ||
		!AWS_ACCESS_KEY_ID ||
		!AWS_SECRET_ACCESS_KEY ||
		!AWS_ENDPOINT_URL_S3 ||
		!AWS_REGION
	)
		throw new Refusal("unavailable", 503);
	return {
		bucket,
		prefix,
		client: new S3Client({
			endpoint: AWS_ENDPOINT_URL_S3,
			region: AWS_REGION,
			forcePathStyle: true,
			credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
		}),
	};
}
export async function uploadIntent(db: Pool, auth: PlatformAuth, headers: Headers, input: z.infer<typeof uploadInput>) {
	return transaction(db, async (tx) => {
		const scope = await currentScope(tx, auth, headers, input.ownerId);
		const id = randomUUID();
		await tx.query("INSERT INTO proof_object(id,owner_id,object_key,format,checksum,bytes) VALUES($1,$2,$3,$4,$5,$6)", [
			id,
			scope.owner.id,
			randomUUID(),
			input.format,
			input.checksum,
			input.bytes,
		]);
		return { id };
	});
}
export async function finalizeObject(
	db: Pool,
	auth: PlatformAuth,
	headers: Headers,
	storage: Storage,
	owner: string,
	id: string,
	bytes: Uint8Array,
) {
	// Validate bytes before external storage; no client key or content-type is trusted.
	const object = await transaction(db, async (tx) => {
		await currentScope(tx, auth, headers, owner);
		const result = await tx.query<{ object_key: string; format: FileFormat; checksum: string; bytes: number }>(
			"SELECT object_key,format,checksum,bytes FROM proof_object WHERE id=$1 AND owner_id=$2 AND state='pending'",
			[id, owner],
		);
		const row = result.rows[0];
		if (!row) throw new Refusal("unavailable", 404);
		return row;
	});
	if (bytes.length !== object.bytes || createHash("sha256").update(bytes).digest("hex") !== object.checksum)
		throw new Refusal("invalid_input", 422);
	const text = await previewText(bytes, object.format);
	await storage.client.send(
		new PutObjectCommand({
			Bucket: storage.bucket,
			Key: storage.prefix + object.object_key,
			Body: bytes,
			ContentType: "application/octet-stream",
			CacheControl: "private, no-store",
			IfNoneMatch: "*",
		}),
	);
	// Revocation during upload leaves an unattached orphan, never an authorized binding.
	return transaction(db, async (tx) => {
		await currentScope(tx, auth, headers, owner);
		const result = await tx.query(
			`UPDATE proof_object SET state='ready',preview=$3 WHERE id=$1 AND owner_id=$2 AND state='pending' RETURNING id`,
			[id, owner, text],
		);
		if (result.rowCount !== 1) throw new Refusal("conflict", 409);
		return { id, preview: text };
	});
}
export async function authorizedDownload(
	db: Pool,
	auth: PlatformAuth,
	headers: Headers,
	storage: Storage,
	owner: string,
	id: string,
	ttl = 60,
) {
	if (!Number.isInteger(ttl) || ttl < 1 || ttl > 60) throw new Refusal("invalid_input", 422);
	return transaction(db, async (tx) => {
		await currentScope(tx, auth, headers, owner);
		const result = await tx.query<{ object_key: string }>(
			"SELECT object_key FROM proof_object WHERE id=$1 AND owner_id=$2 AND state='ready' FOR SHARE",
			[id, owner],
		);
		const row = result.rows[0];
		if (!row) throw new Refusal("unavailable", 404);
		const url = await getSignedUrl(
			storage.client,
			new GetObjectCommand({
				Bucket: storage.bucket,
				Key: storage.prefix + row.object_key,
				ResponseCacheControl: "private, no-store",
				ResponseContentDisposition: "attachment",
			}),
			{ expiresIn: ttl },
		);
		return { url, expiresIn: ttl };
	});
}
