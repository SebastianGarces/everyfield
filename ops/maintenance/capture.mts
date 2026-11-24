import { createHash, randomUUID } from "node:crypto";
import { sql } from "../../packages/db/src/query.ts";
import type { Database } from "../../packages/db/src/client.ts";
import { schemaVersion, type Snapshot } from "./restore.mts";
import type { FileSource } from "./source.mts";

const DAY = 86_400_000;
const EXPIRY_SLACK = 2 * 3_600_000;
export const KEEP_MS = 7 * DAY - EXPIRY_SLACK;
const ROWS_PER_READ = 500;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export type CaptureDeps = { db: Database; schema: string; files: FileSource; sourceCommit: string };
export class CaptureRefused extends Error {}

export async function captureSnapshot(deps: CaptureDeps): Promise<Snapshot> {
	if (!IDENTIFIER.test(deps.schema)) throw new CaptureRefused("schema_invalid");
	const read = await deps.db.transaction(
		async (tx) => {
			await tx.execute(sql.raw(`SET LOCAL search_path TO ${deps.schema}, pg_catalog, pg_temp`));
			const [point] = (
				await tx.execute<{ at: string; lsn: string; checkpoint: string }>(
					sql`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
						pg_current_wal_insert_lsn()::text AS lsn,
						(SELECT coalesce(sum(witness_checkpoint), 0)::text FROM lifecycle_witness) AS checkpoint`,
				)
			).rows;
			const names = (
				await tx.execute<{ name: string }>(sql`SELECT c.relname AS name FROM pg_class c
					JOIN pg_namespace n ON n.oid=c.relnamespace
					WHERE n.nspname=${deps.schema} AND c.relkind IN ('r','p') AND NOT c.relispartition
					AND c.relname<>'schema_migration' ORDER BY 1`)
			).rows.map((r) => r.name);
			const tables: string[] = [];
			for (const name of names) {
				if (!IDENTIFIER.test(name)) throw new CaptureRefused("schema_invalid");
				const rows: string[] = [];
				await tx.execute(
					sql.raw(`DECLARE capture_rows NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS row FROM "${name}" t`),
				);
				for (;;) {
					const page = await tx.execute<{ row: string }>(sql.raw(`FETCH ${ROWS_PER_READ} FROM capture_rows`));
					rows.push(...page.rows.map((r) => r.row));
					if (page.rows.length < ROWS_PER_READ) break;
				}
				await tx.execute(sql.raw("CLOSE capture_rows"));
				tables.push(`${JSON.stringify(name)}:[${rows.join(",")}]`);
			}
			const ready = (
				await tx.execute<{ id: string; opaque_key: string; sha256: string; byte_count: string }>(
					sql`SELECT id, opaque_key, sha256, byte_count::text FROM file_object WHERE state='ready' ORDER BY id`,
				)
			).rows;
			return { point: point!, tables, ready };
		},
		{ isolationLevel: "repeatable read", accessMode: "read only" },
	);
	const image = Buffer.from(`{"version":1,"tables":{${read.tables.join(",")}}}`);
	const objects = new Map<string, Uint8Array>();
	const listed: { id: string; sha256: string; bytes: number; version: string }[] = [];
	for (const file of read.ready) {
		const found = await deps.files.read(file.opaque_key);
		if (!found) throw new CaptureRefused("file_missing");
		if (found.bytes.length !== Number(file.byte_count) || sha256(found.bytes) !== file.sha256)
			throw new CaptureRefused("file_mismatch");
		objects.set(file.id, found.bytes);
		listed.push({ id: file.id, sha256: file.sha256, bytes: found.bytes.length, version: found.version });
	}
	const createdAt = read.point.at;
	return {
		image,
		objects,
		manifest: {
			version: 1,
			source: deps.sourceCommit,
			schema: await schemaVersion(),
			createdAt,
			expiresAt: new Date(Date.parse(createdAt) + KEEP_MS).toISOString(),
			database: { id: randomUUID(), sha256: sha256(image), bytes: image.length, version: `lsn:${read.point.lsn}` },
			objects: listed,
			keyVersion: randomUUID(),
			witnessCheckpoint: read.point.checkpoint,
			subjects: [],
		},
	};
}
