import * as c from "@everyfield/contracts/documents";
import { sql } from "@everyfield/db/query";
import type { Database, Transaction } from "@everyfield/db/client";
import { putPrivateObject, type PrivateStorage, type ResourceAuthorizer } from "@everyfield/db/schema";
import "server-only";
import { liveRead } from "../access/session.ts";
import { deny, type PlantViewer } from "./access.ts";

export const PAGE = 100;
export const ARTIFACT_MAX = 8 * 1024 * 1024;
export const MEDIA = {
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;

export type Scope = {
	kind: "account" | "plant";
	tenantId: string;
	accountId: string;
	access: Parameters<typeof liveRead>[0];
};

export function postgresCode(error: unknown) {
	let current: unknown = error;
	for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}

export function gateSql(scope: Scope, admin: boolean) {
	if (!admin || scope.kind === "account") return liveRead(scope.access, false);
	return sql`${liveRead(scope.access, false)} AND ${scope.access.role ?? ""} <> 'member'`;
}

export function plantScope(viewer: PlantViewer): Scope {
	return { kind: "plant", tenantId: viewer.plantId, accountId: viewer.accountId, access: viewer.access };
}

export function iso(value: unknown) {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
	deny();
}

export async function rowsOf<T>(db: Pick<Database, "execute"> | Transaction, query: ReturnType<typeof sql>) {
	const found = await db.execute(query);
	return found.rows as T[];
}

export function sameRevision(left: string, right: string) {
	return BigInt(left) === BigInt(right);
}

export function refuseStorage(error: unknown): never {
	if (
		error instanceof Error &&
		["unavailable", "invalid_file", "private_bucket_required", "invalid_upload_key"].includes(error.message)
	)
		deny();
	throw error;
}

export async function storeBytes(
	db: Database,
	storage: PrivateStorage | null,
	scope: Scope,
	purpose: "generated" | "native_import",
	mediaType: string,
	bytes: Uint8Array,
	uploadKey: string,
) {
	if (!storage) deny();
	const authorize: ResourceAuthorizer = async (tx, file, intent) => {
		if (intent !== "put" || file.tenant_id !== scope.tenantId || file.purpose !== purpose) return null;
		const found = await rowsOf<{ ok: boolean }>(tx, sql`SELECT ${gateSql(scope, purpose === "native_import")} AS ok`);
		if (found[0]?.ok !== true) return null;
		return { kind: "account", actorId: scope.accountId };
	};
	try {
		return await putPrivateObject(db, storage, authorize, {
			tenantId: scope.tenantId,
			purpose,
			mediaType,
			bytes,
			uploadKey,
		});
	} catch (error) {
		return refuseStorage(error);
	}
}

/** One generated-document record, as the history and the export calls return it. */
export function generatedFrom(
	row: {
		id: string;
		template_version: string;
		saved_template_name: string;
		format: "pdf" | "docx" | "xlsx";
		download_name: string;
		generated_at: Date | string;
		creator_account_id: string | null;
		revision: string;
		sha256: string;
		byte_count: string | number;
		source_document_id?: string | null;
		source_revision_id?: string | null;
		source_number?: number | string | null;
		source_title?: string | null;
		theme_kind?: "church" | "everyfield-neutral" | null;
		theme_primary?: string | null;
	},
	plantId: string,
	templateId: string,
) {
	return c.generatedDocument.parse({
		id: row.id,
		plantId,
		templateId,
		templateVersion: row.template_version,
		savedTemplateName: row.saved_template_name,
		format: row.format,
		digest: row.sha256,
		byteCount: Number(row.byte_count),
		downloadName: row.download_name,
		generatedAt: iso(row.generated_at),
		creatorAccountId: row.creator_account_id,
		revision: row.revision,
		source: row.source_document_id
			? {
					documentId: row.source_document_id,
					revisionId: row.source_revision_id,
					revision: Number(row.source_number),
					title: row.source_title,
				}
			: null,
		theme: row.theme_kind ? { kind: row.theme_kind, primary: row.theme_primary ?? null } : null,
	});
}

export async function historyRows(db: Database, scope: Scope, documentId: string | null) {
	const found = await rowsOf<
		Parameters<typeof generatedFrom>[0] & { ok: boolean; template_id: string; present: boolean }
	>(
		db,
		sql`SELECT g.ok, gd.id, gd.template_id, gd.template_version, gd.saved_template_name, gd.format, gd.download_name,
			gd.generated_at, gd.creator_account_id, gd.revision::text AS revision, f.sha256, f.byte_count,
			gd.source_document_id, gd.source_revision_id, gd.theme_kind, gd.theme_primary, sr.version_number AS source_number, sd.title AS source_title,
			gd.id IS NOT NULL AS present
		FROM (SELECT ${gateSql(scope, false)} AS ok) g
		LEFT JOIN generated_document gd ON g.ok AND gd.tenant_id = ${scope.tenantId}::uuid
			AND (${documentId}::uuid IS NULL OR gd.id = ${documentId}::uuid)
		LEFT JOIN file_object f ON f.id = gd.object_id AND f.tenant_id = gd.tenant_id AND f.state = 'ready'
		LEFT JOIN document_revision sr ON sr.id = gd.source_revision_id AND sr.tenant_id = gd.tenant_id
		LEFT JOIN document sd ON sd.id = gd.source_document_id AND sd.tenant_id = gd.tenant_id
		WHERE f.id IS NOT NULL OR gd.id IS NULL
		ORDER BY gd.generated_at DESC NULLS LAST
		LIMIT ${PAGE}`,
	);
	if (found[0]?.ok !== true && found.length > 0) deny();
	if (found.length === 0) deny();
	return found.filter((row) => row.present);
}
