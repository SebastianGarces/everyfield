import { getSession } from "../request-context";
import * as tables from "./tables.ts";
import { and, eq } from "@everyfield/db/query";
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Database } from "@everyfield/db/client";
import { z } from "zod";
import { currentScope, transaction } from "./database.ts";
import { Refusal } from "./boundary.ts";
import { previewText, maxFileBytes } from "./preview.ts";
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
		bucket !== "everyfield-dev" ||
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
export async function uploadIntent(
	db: Database,
	auth: PlatformAuth,
	headers: Headers,
	input: z.infer<typeof uploadInput>,
) {
	const session = await getSession(auth, headers);
	return transaction(db, async (tx) => {
		const scope = await currentScope(tx, session, input.ownerId);
		const id = randomUUID();
		await tx.insert(tables.proof_object).values({
			id: id,
			owner_id: scope.owner.id,
			object_key: randomUUID(),
			format: input.format,
			checksum: input.checksum,
			bytes: input.bytes,
		});
		return { id };
	});
}
export async function finalizeObject(
	db: Database,
	auth: PlatformAuth,
	headers: Headers,
	storage: Storage,
	owner: string,
	id: string,
	bytes: Uint8Array,
) {
	const session = await getSession(auth, headers);
	// Validate bytes before external storage; no client key or content-type is trusted.
	const object = await transaction(db, async (tx) => {
		await currentScope(tx, session, owner);
		const result = await tx
			.select({
				object_key: tables.proof_object.object_key,
				format: tables.proof_object.format,
				checksum: tables.proof_object.checksum,
				bytes: tables.proof_object.bytes,
			})
			.from(tables.proof_object)
			.where(
				and(
					and(eq(tables.proof_object.id, id), eq(tables.proof_object.owner_id, owner)),
					eq(tables.proof_object.state, "pending"),
				),
			);
		const row = result[0];
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
		await currentScope(tx, session, owner);
		const result = await tx
			.update(tables.proof_object)
			.set({ state: "ready", preview: text })
			.where(
				and(
					and(eq(tables.proof_object.id, id), eq(tables.proof_object.owner_id, owner)),
					eq(tables.proof_object.state, "pending"),
				),
			)
			.returning({ id: tables.proof_object.id });
		if (result.length !== 1) throw new Refusal("conflict", 409);
		return { id, preview: text };
	});
}
export async function authorizedDownload(
	db: Database,
	auth: PlatformAuth,
	headers: Headers,
	storage: Storage,
	owner: string,
	id: string,
	ttl = 60,
) {
	if (!Number.isInteger(ttl) || ttl < 1 || ttl > 60) throw new Refusal("invalid_input", 422);
	const session = await getSession(auth, headers);
	return transaction(db, async (tx) => {
		await currentScope(tx, session, owner);
		const result = await tx
			.select({ object_key: tables.proof_object.object_key })
			.from(tables.proof_object)
			.where(
				and(
					and(eq(tables.proof_object.id, id), eq(tables.proof_object.owner_id, owner)),
					eq(tables.proof_object.state, "ready"),
				),
			)
			.for("share");
		const row = result[0];
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
