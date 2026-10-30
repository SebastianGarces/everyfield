import * as c from "@everyfield/contracts/branding";
import type { Database } from "@everyfield/db/client";
import { eq, and, sql } from "@everyfield/db/query";
import {
	processBrandAsset,
	putPrivateObject,
	readAuthorizedObject,
	type PrivateStorage,
	type ResourceAuthorizer,
} from "@everyfield/db/schema";
import * as t from "@everyfield/db/tables";
import { createHash } from "node:crypto";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../access/session.ts";
import { deny, parse, scopeOf, settle, type Scope } from "./access.ts";
import { SLOT_ID_COLUMNS, stagedUpload } from "./kit.ts";

/**
 * Reads asset bytes only while the kit references the file now. The settings read needs an Owner or Admin seat; the
 * theme read accepts any active seat. Both check the live session and seat in the same statement as the reference.
 */
function brandAssetReader(scope: Scope, mode: "settings" | "theme"): ResourceAuthorizer {
	return async (tx, file, intent) => {
		if (intent !== "read" || file.tenant_id !== scope.plantId || file.purpose !== "brand_asset") return null;
		const live = mode === "settings" ? scope.admin : scope.seat;
		const { rows } = await tx.execute(sql`SELECT ${live} AS ok, EXISTS(
			SELECT FROM church_brand_kit k WHERE k.tenant_id = ${scope.plantId}::uuid
			AND ${file.id}::uuid IN (${sql.join(
				SLOT_ID_COLUMNS.map((column) => sql`k.${column}`),
				sql`, `,
			)})) AS referenced`);
		const found = z.object({ ok: z.boolean().nullable(), referenced: z.boolean() }).parse(rows[0]);
		return found.ok === true && found.referenced ? { kind: "account", actorId: scope.accountId } : null;
	};
}

/** A byte upload may put only its own pending file, for a live Owner or Admin seat. */
function uploadPutter(scope: Scope): ResourceAuthorizer {
	return async (tx, file, intent) => {
		if (intent !== "put" || file.tenant_id !== scope.plantId || file.purpose !== "brand_asset") return null;
		const { rows } = await tx.execute(sql`SELECT ${scope.admin} AS ok`);
		return rows[0]?.ok === true ? { kind: "account", actorId: scope.accountId } : null;
	};
}

const pending = z.object({
	ok: z.boolean().nullable(),
	upload_key: z.string().nullable(),
	media_type: z.string().nullable(),
});

/**
 * Stores the bytes of a requested upload. The bytes are checked against the staged type and size, decoded under a pixel
 * and time limit, trimmed (not the cover photo) and rasterized. The stored file is the processed raster with its own
 * byte count and SHA-256. Invalid bytes get `invalid_file` and leave no ready file.
 */
export async function uploadBrandAsset(
	db: Database,
	storage: PrivateStorage | null,
	authority: RequestActor,
	raw: { uploadId: string; bytes: Uint8Array },
) {
	return settle(async () => {
		const scope = scopeOf(authority);
		const uploadId = parse(z.uuid(), raw.uploadId);
		if (!storage) deny();
		// One statement: the live Owner or Admin seat's own pending upload.
		const { rows } = await db.execute(sql`SELECT g.ok, f.upload_key, f.media_type
			FROM (SELECT ${scope.admin} AS ok) g
			LEFT JOIN file_object f ON g.ok AND f.id = ${uploadId}::uuid AND f.tenant_id = ${scope.plantId}::uuid
				AND f.purpose = 'brand_asset' AND f.state = 'pending' AND f.expires_at > clock_timestamp()`);
		const staged = pending.parse(rows[0]);
		if (staged.ok !== true) deny("access_denied");
		const request = staged.upload_key ? stagedUpload(staged.upload_key) : null;
		if (!request) deny();
		// The bytes must be the type and size the request named.
		if (raw.bytes.length !== request.byteLength) deny("invalid_file");
		const processed = await processBrandAsset(raw.bytes, request.mediaType, c.isTrimmedSlot(request.slot)).catch(() =>
			deny("invalid_file"),
		);
		const sha256 = createHash("sha256").update(processed.bytes).digest("hex");
		const updated = await db
			.update(t.file_object)
			.set({
				byte_count: String(processed.bytes.length),
				sha256,
			})
			.where(
				and(
					eq(t.file_object.id, uploadId),
					eq(t.file_object.purpose, "brand_asset"),
					eq(t.file_object.state, "pending"),
					eq(t.file_object.media_type, processed.mediaType),
					sql`${t.file_object.tenant_id} = ${scope.plantId}::uuid AND ${scope.admin}`,
				),
			)
			.returning({ uploadKey: t.file_object.upload_key });
		const file = updated[0];
		if (!file) deny();
		await putPrivateObject(db, storage, uploadPutter(scope), {
			tenantId: scope.plantId,
			purpose: "brand_asset",
			mediaType: processed.mediaType,
			bytes: processed.bytes,
			uploadKey: file.uploadKey,
		}).catch(() => deny());
		return c.uploadedAsset.parse({ uploadId, byteCount: processed.bytes.length, sha256 });
	});
}

/** A stored asset's bytes and media type, if the kit references the file now. */
export async function readBrandAsset(
	db: Database,
	storage: PrivateStorage | null,
	authority: RequestActor,
	fileId: string,
	mode: "settings" | "theme" = "settings",
) {
	return settle(async () => {
		const scope = scopeOf(authority);
		if (!storage) deny();
		const bytes = await readAuthorizedObject(db, storage, brandAssetReader(scope, mode), parse(z.uuid(), fileId)).catch(
			() => deny(),
		);
		return { bytes, mediaType: bytes[0] === 0x89 ? ("image/png" as const) : ("image/jpeg" as const) };
	});
}
