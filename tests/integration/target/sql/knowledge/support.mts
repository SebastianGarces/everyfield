// Shared setup for the WP-092 knowledge cases. Each case runs at the exact instant its JSON names, so a suite opens its
// schema with `clock` (test-database.mts installs schema-local clock functions before the migrations) and `freezeClock`
// then holds that clock still at one instant. Every query of the schema, its column defaults and its SECURITY DEFINER
// functions read the frozen value; the host clock and pg_catalog-qualified calls do not move.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { schemaVersion } from "../../../../../ops/maintenance/restore.mts";
import type { Snapshot } from "../../../../../ops/maintenance/restore.mts";
import { sql } from "../../../../../packages/db/src/query.ts";
import type { Database } from "../../../../support/test-database.mts";

/** Holds the schema's database clock at `at`: now(), transaction_timestamp(), statement_timestamp() and clock_timestamp(). */
export async function freezeClock(admin: Database, schema: string, at: Date) {
	const instant = at.toISOString();
	for (const [fn, volatility] of [
		["clock_timestamp", "VOLATILE"],
		["statement_timestamp", "STABLE"],
		["transaction_timestamp", "STABLE"],
		["now", "STABLE"],
	])
		await admin.execute(
			sql.raw(`CREATE OR REPLACE FUNCTION ${schema}.${fn}() RETURNS timestamptz LANGUAGE sql ${volatility} PARALLEL SAFE
				AS $$ SELECT '${instant}'::timestamptz $$`),
		);
}

// The restore rehearsal (maintenance.restoreWithCurrentManifest). A snapshot is what a backup would hold: the schema's
// rows as one image, the ready files' bytes, and the external manifest that describes both.

/** The verified restricted-operator capability the cases give, for the isolated test environment. */
export const operator = {
	authority: "authorized_restricted_recovery_operator",
	verified: true,
	operation_ids: ["maintenance.restoreWithCurrentManifest"],
	environment: "isolated-test",
} as const;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const DAY = 86_400_000;

/** The private object store as a map from opaque key to bytes. */
export type Store = Map<string, Uint8Array>;
export const objectStore = (store: Store) => ({
	put: async (key: string, bytes: Uint8Array) => void store.set(key, bytes),
});

/**
 * A snapshot of `admin`'s schema as it stands now: every table but the migration ledger, the bytes `store` holds for
 * each ready file, and a manifest dated `createdAt` (expiring seven days later unless `expiresAt` says) that lists
 * `subjects` with their original copy expiry.
 */
export async function snapshot(
	admin: Database,
	store: Store,
	{
		createdAt,
		expiresAt,
		subjects = [],
	}: { createdAt: Date; expiresAt?: Date; subjects?: { id: string; expiresAt: string }[] },
): Promise<Snapshot & { manifest: Record<string, any> }> {
	const names = (
		await admin.execute<{ name: string }>(sql`SELECT c.relname AS name FROM pg_class c
			JOIN pg_namespace n ON n.oid=c.relnamespace
			WHERE n.nspname=current_schema() AND c.relkind IN ('r','p') AND NOT c.relispartition AND c.relname<>'schema_migration'
			ORDER BY 1`)
	).rows.map((r) => r.name);
	const tables: Record<string, unknown[]> = {};
	for (const name of names)
		tables[name] = (
			await admin.execute<{ rows: unknown[] }>(sql.raw(`SELECT coalesce(json_agg(t), '[]') AS rows FROM "${name}" t`))
		).rows[0]!.rows;
	const image = Buffer.from(JSON.stringify({ version: 1, tables }));
	const ready = (
		await admin.execute<{ id: string; opaque_key: string; sha256: string; byte_count: string }>(
			sql`SELECT id, opaque_key, sha256, byte_count::text FROM file_object WHERE state='ready' ORDER BY id`,
		)
	).rows;
	const objects = new Map<string, Uint8Array>();
	for (const file of ready) if (store.has(file.opaque_key)) objects.set(file.id, store.get(file.opaque_key)!);
	const [{ checkpoint }] = (
		await admin.execute<{ checkpoint: string }>(
			sql`SELECT coalesce(sum(witness_checkpoint), 0)::text AS checkpoint FROM lifecycle_witness`,
		)
	).rows as [{ checkpoint: string }];
	return {
		image,
		objects,
		manifest: {
			version: 1,
			source: randomBytes(20).toString("hex"),
			schema: await schemaVersion(),
			createdAt: createdAt.toISOString(),
			expiresAt: (expiresAt ?? new Date(createdAt.getTime() + 7 * DAY)).toISOString(),
			database: { id: randomUUID(), sha256: sha256(image), bytes: image.length, version: "image" },
			objects: ready.map((f) => ({ id: f.id, sha256: f.sha256, bytes: Number(f.byte_count), version: "v1" })),
			keyVersion: randomUUID(),
			witnessCheckpoint: checkpoint,
			subjects,
		},
	};
}

/** A ready private file of `tenant` with `bytes` in `store`; returns its id and opaque key. */
export async function readyFile(
	admin: Database,
	store: Store,
	tenant: string,
	bytes: Uint8Array,
	purpose = "generated",
) {
	const id = randomUUID(),
		key = `private/${tenant}/${randomUUID()}`;
	await admin.execute(sql`INSERT INTO file_object (id, tenant_id, purpose, opaque_key, media_type, max_bytes, byte_count,
		sha256, state, upload_key, claim_generation)
		VALUES (${id}::uuid, ${tenant}::uuid, ${purpose}, ${key}, 'application/pdf', 8388608, ${bytes.length}, ${sha256(bytes)},
		'ready', ${"upload-" + id}, 0)`);
	store.set(key, bytes);
	return { id, key };
}

/** Whether the schema exists at all. */
export const schemaExists = async (admin: Database, name: string) =>
	(await admin.execute(sql`SELECT EXISTS(SELECT FROM pg_namespace WHERE nspname=${name}) AS found`)).rows[0]!.found ===
	true;
export const dropTarget = (admin: Database, name: string) =>
	admin.execute(sql.raw(`DROP SCHEMA IF EXISTS ${name.replace(/[^a-z0-9_]/g, "")} CASCADE`));

/** Whether `pool`'s login is refused the target schema outright (insufficient privilege), as every app login is. */
export async function closedTo(pool: Database, target: string) {
	try {
		await pool.execute(sql.raw(`SELECT count(*) FROM ${target}.auth_session`));
		return false;
	} catch (error) {
		return (error as { cause?: { code?: string } }).cause?.code === "42501";
	}
}
