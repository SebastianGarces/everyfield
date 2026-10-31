import { sql } from "@everyfield/db/query";
import type { Database, Transaction } from "@everyfield/db/client";
import { putPrivateObject, type PrivateStorage, type ResourceAuthorizer } from "@everyfield/db/schema";
import "server-only";
import { liveRead } from "../access/session.ts";
import { deny, type PlantViewer } from "./access.ts";

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
