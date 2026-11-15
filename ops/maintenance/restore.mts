// maintenance.restoreWithCurrentManifest: the restricted restore rehearsal (docs/architecture/recovery.md, "Coherent
// restore and targets"). It restores a snapshot (a database image and its object bytes, described by the external
// manifest validateCandidate checks) into a fresh schema of the throwaway Postgres and a fake object store. No app role
// can reach that schema, and nothing here sends mail, publishes an issue or runs a job. The current deletion and access
// witnesses, and the mail and issue receipts, come from outside the image (readCurrentManifest over the live schema) and
// win over the image's own rows; a missing, stale or unreadable witness refuses. Service never opens and the
// customer-data gate stays blocked: G-RECOVERY is open. Only the restricted CLI and tests import this file.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { deletionMachine, entryStates, fromStates } from "../../packages/contracts/src/machines/index.ts";
import { sql } from "../../packages/db/src/query.ts";
import { migrate, migrationArtifact } from "../../packages/db/src/schema/migrate.ts";
import type { Database } from "../../packages/db/src/client.ts";
import { validateCandidate } from "./recovery.mts";
const require = createRequire(new URL("../../packages/domain/package.json", import.meta.url));
const { z } = require("zod");

export const OPERATION = "maintenance.restoreWithCurrentManifest";
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const HOUR = 3_600_000;
/** The internal targets for an ordinary mistake with live providers: one hour lost, four hours to recover. */
const TARGET = { lossHours: 1, restoreHours: 4 };

const capability = z.strictObject({
	authority: z.literal("authorized_restricted_recovery_operator"),
	verified: z.literal(true),
	operation_ids: z.array(z.string()).refine((ids: string[]) => ids.includes(OPERATION)),
	environment: z.literal("isolated-test"),
});
const count = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]).transform(BigInt);
const witness = z.looseObject({
	id: z.uuid(),
	kind: z.enum(["account", "plant", "seat", "affiliation"]),
	opaque_subject_id: z.uuid(),
	state: z.enum(deletionMachine.states),
	request_id: z.uuid().nullable(),
	request_revision: count,
	witness_checkpoint: count,
	cancel_until: z.string().nullable(),
	copy_expires_at: z.string().nullable(),
});
/** The current facts outside the image: every lifecycle witness, and the mail and public issue receipts. */
const currentManifest = z.strictObject({
	version: z.literal(1),
	checkpoint: count,
	witnesses: z.array(witness),
	mail: z.array(
		z.strictObject({
			id: z.uuid(),
			state: z.string(),
			provider_message_id: z.string().nullable(),
			accepted_at: z.string().nullable(),
			sent_at: z.string().nullable(),
		}),
	),
	issues: z.array(z.looseObject({ id: z.uuid(), publication_state: z.string() })),
});
/** A database image: every table of the schema but its migration ledger, as rows. */
export const imageSchema = z.strictObject({
	version: z.literal(1),
	tables: z.record(z.string().regex(IDENTIFIER), z.array(z.record(z.string(), z.unknown()))),
});

export type Snapshot = { manifest: unknown; image: Buffer; objects: ReadonlyMap<string, Uint8Array> };
export type RestoreDeps = {
	/** The owner pool of the throwaway Postgres. */
	admin: Database;
	/** The live schema. Never a target. */
	source: string;
	/** A fresh schema name for the target. */
	targetSchema: string;
	/** The target's fake object store; verified bytes only, after the database restored. */
	objects: { put(key: string, bytes: Uint8Array): Promise<void> };
	/** The drill clock: read once at the start and once at the verified end. */
	clock: () => Date;
};
export type RestoreInput = {
	capability: unknown;
	target: unknown;
	snapshot: Snapshot;
	/** Reads the current manifest from outside the image; null when there is none. */
	current: () => Promise<unknown>;
	/** When the mistake happened, to measure the recovery point and time. */
	incidentAt?: Date;
};
export type Refusal =
	| "operator_unavailable"
	| "target_not_isolated"
	| "target_not_fresh"
	| "witness_missing"
	| "witness_stale"
	| "witness_unreadable"
	| "manifest_invalid"
	| "copy_expired_or_invalid"
	| "duplicate_manifest_identity"
	| "subject_expired_or_reset"
	| "database_mismatch"
	| "schema_mismatch"
	| "receipt_unreconciled"
	| "file_missing"
	| "file_mismatch"
	| "restore_failed";
export type RestoreSubject = {
	kind: string;
	id: string;
	state: string;
	cancel_until: string | null;
	copy_expiry: string | null;
};
export type RestoreResult = {
	restore_success: boolean;
	refusal: Refusal | null;
	/** The id of the file that failed, never its bytes. */
	file: string | null;
	/** The closed target schema, kept for inspection after a verified restore; null otherwise. */
	target: string | null;
	service_opened: false;
	customer_data_gate: "blocked";
	/** Deletion subjects as the current witness states them. */
	subjects: RestoreSubject[];
	observed_loss_hours: number | null;
	observed_restore_hours: number | null;
	internal_target_met: boolean;
	customer_SLA: null;
};

class Refused extends Error {
	code: Refusal;
	file: string | null;
	constructor(code: Refusal, file: string | null = null) {
		super(code);
		this.code = code;
		this.file = file;
	}
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const instant = (value: string | null) => (value ? new Date(value).toISOString().replace(/\.000Z$/, "Z") : null);
const MANIFEST_REFUSALS = new Set([
	"copy_expired_or_invalid",
	"duplicate_manifest_identity",
	"subject_expired_or_reset",
]);
/** Mail that may still reach a provider, and publications that may still reach the issue tracker. */
const OPEN_MAIL = sql.raw(`('pending','dispatched','unknown','accepted','scheduled')`);
const OPEN_ISSUE = sql.raw(`('pending','publishing','unknown')`);
const ids = (rows: { id: string }[]) =>
	sql`(SELECT x::uuid FROM json_array_elements_text(${JSON.stringify(rows.map((r) => r.id))}::json) x)`;

/** The current manifest of the live schema `db` is pinned to: witnesses with their checkpoint, and receipts. */
export async function readCurrentManifest(db: Database): Promise<unknown> {
	const { rows } = await db.execute(sql`SELECT json_build_object(
 'version', 1,
 'checkpoint', (SELECT coalesce(sum(witness_checkpoint), 0)::text FROM lifecycle_witness),
 'witnesses', (SELECT coalesce(json_agg(w), '[]') FROM lifecycle_witness w),
 'mail', (SELECT coalesce(json_agg(json_build_object('id', id, 'state', state, 'provider_message_id', provider_message_id,
   'accepted_at', accepted_at, 'sent_at', sent_at)), '[]') FROM mail),
 'issues', (SELECT coalesce(json_agg(json_build_object('id', id, 'publication_state', publication_state,
   'held_reason', held_reason, 'publication_payload', publication_payload, 'publication_hash', publication_hash,
   'repository_id', repository_id, 'repository_name', repository_name, 'issue_number', issue_number,
   'issue_url', issue_url, 'published_at', published_at)), '[]') FROM feedback)) AS current`);
	return rows[0]?.current ?? null;
}

/** The schema version a manifest names: the hash of the ordered migration files. */
export async function schemaVersion() {
	return sha256(Buffer.from(JSON.stringify(await migrationArtifact())));
}

export async function restoreWithCurrentManifest(deps: RestoreDeps, input: RestoreInput): Promise<RestoreResult> {
	let subjects: RestoreSubject[] = [];
	const refuse = (refusal: Refusal, file: string | null = null): RestoreResult => ({
		restore_success: false,
		refusal,
		file,
		target: null,
		service_opened: false,
		customer_data_gate: "blocked",
		subjects,
		observed_loss_hours: null,
		observed_restore_hours: null,
		internal_target_met: false,
		customer_SLA: null,
	});
	// Authority and target first: a refusal here reads and writes nothing.
	if (!capability.safeParse(input.capability).success) return refuse("operator_unavailable");
	const target = deps.targetSchema;
	if (input.target !== "isolated" || !IDENTIFIER.test(target) || target === deps.source)
		return refuse("target_not_isolated");
	const startedAt = deps.clock();

	// The current witnesses, from outside the image. Never the image's own lifecycle rows.
	let current: ReturnType<typeof currentManifest.parse>;
	try {
		const raw = await input.current();
		if (raw === null || raw === undefined) return refuse("witness_missing");
		current = currentManifest.parse(raw);
	} catch {
		return refuse("witness_unreadable");
	}
	subjects = current.witnesses
		.filter((w) => w.request_id !== null)
		.map((w) => ({
			kind: w.kind,
			id: w.opaque_subject_id,
			state: w.state,
			cancel_until: instant(w.cancel_until),
			copy_expiry: instant(w.copy_expires_at),
		}));

	// The copy: valid, unexpired, and no subject expiry later than the current witness's original one.
	const originalExpiries = new Map(
		current.witnesses.filter((w) => w.copy_expires_at).map((w) => [w.opaque_subject_id, w.copy_expires_at!]),
	);
	let manifest;
	try {
		manifest = validateCandidate(input.snapshot.manifest, startedAt, originalExpiries).manifest;
	} catch (error) {
		const code = error instanceof Error ? error.message : "";
		return refuse(MANIFEST_REFUSALS.has(code) ? (code as Refusal) : "manifest_invalid");
	}
	const image = input.snapshot.image;
	if (image.length !== manifest.database.bytes || sha256(image) !== manifest.database.sha256)
		return refuse("database_mismatch", manifest.database.id);
	if (manifest.schema !== (await schemaVersion())) return refuse("schema_mismatch");
	let tables: Record<string, Record<string, unknown>[]>;
	try {
		tables = imageSchema.parse(JSON.parse(image.toString("utf8"))).tables;
	} catch {
		return refuse("database_mismatch", manifest.database.id);
	}

	// The current journal must have seen at least what the copy saw, subject by subject.
	if (current.checkpoint < BigInt(manifest.witnessCheckpoint)) return refuse("witness_stale");
	const live = new Map(current.witnesses.map((w) => [`${w.kind}/${w.opaque_subject_id}`, w]));
	for (const old of tables.lifecycle_witness ?? []) {
		const now = live.get(`${old.kind}/${old.opaque_subject_id}`);
		if (!now) return refuse("witness_missing");
		if (now.witness_checkpoint < BigInt(String(old.witness_checkpoint))) return refuse("witness_stale");
	}

	const { admin } = deps;
	try {
		await admin.execute(sql.raw(`CREATE SCHEMA ${target}`));
	} catch {
		return refuse("target_not_fresh");
	}
	try {
		await pinClock(admin, target, startedAt);
		await migrate(admin, target);
		// Users and jobs off: no app login can reach the target at all.
		await admin.execute(
			sql.raw(`REVOKE ALL ON SCHEMA ${target} FROM PUBLIC, everyfield_runtime, everyfield_auth, everyfield_cleanup`),
		);
		const files = await admin.transaction(async (tx) => {
			await tx.execute(sql.raw(`SET LOCAL search_path TO ${target}, pg_catalog, pg_temp`));
			await tx.execute(sql`SET LOCAL session_replication_role = replica`);
			await load(tx, target, tables);
			await reconcile(tx, current);
			await applyWitnesses(tx, current.witnesses);
			await unreconciled(tx, current);
			// Every ready file the restored database points at needs its exact bytes in the copy.
			const ready = await tx.execute<{ id: string; opaque_key: string; sha256: string; byte_count: string }>(
				sql`SELECT id, opaque_key, sha256, byte_count::text FROM file_object WHERE state='ready' ORDER BY id`,
			);
			const listed = new Map(manifest.objects.map((o) => [o.id, o]));
			return ready.rows.map((file) => {
				const entry = listed.get(file.id);
				if (!entry || entry.sha256 !== file.sha256) throw new Refused("file_mismatch", file.id);
				const bytes = input.snapshot.objects.get(file.id);
				if (!bytes) throw new Refused("file_missing", file.id);
				if (bytes.length !== Number(file.byte_count) || sha256(bytes) !== file.sha256)
					throw new Refused("file_mismatch", file.id);
				return { key: file.opaque_key, bytes };
			});
		});
		for (const file of files) await deps.objects.put(file.key, file.bytes);
	} catch (error) {
		await admin.execute(sql.raw(`DROP SCHEMA IF EXISTS ${target} CASCADE`)).catch(() => {});
		return error instanceof Refused ? refuse(error.code, error.file) : refuse("restore_failed");
	}

	const completedAt = deps.clock();
	const loss = input.incidentAt ? (input.incidentAt.getTime() - Date.parse(manifest.createdAt)) / HOUR : null;
	const restore = input.incidentAt ? (completedAt.getTime() - input.incidentAt.getTime()) / HOUR : null;
	return {
		...refuse("restore_failed"),
		restore_success: true,
		refusal: null,
		target,
		observed_loss_hours: loss,
		observed_restore_hours: restore,
		internal_target_met:
			loss !== null && restore !== null && loss <= TARGET.lossHours && restore <= TARGET.restoreHours,
	};
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** The target's database clock reads the drill clock, still advancing (as test-database.mts pins a test schema). */
async function pinClock(admin: Database, target: string, at: Date) {
	const { rows } = await admin.execute<{ shift: string }>(
		sql`SELECT (${at.toISOString()}::timestamptz - pg_catalog.clock_timestamp())::text AS shift`,
	);
	for (const [fn, volatility] of [
		["clock_timestamp", "VOLATILE"],
		["statement_timestamp", "STABLE"],
		["transaction_timestamp", "STABLE"],
		["now", "STABLE"],
	])
		await admin.execute(
			sql.raw(`CREATE FUNCTION ${target}.${fn}() RETURNS timestamptz LANGUAGE sql ${volatility} PARALLEL SAFE
				AS $$ SELECT pg_catalog.${fn}() + '${rows[0]!.shift}'::interval $$`),
		);
}

/** Replaces every table of the migrated target with the image's rows, triggers and foreign keys off. */
async function load(tx: Tx, target: string, tables: Record<string, Record<string, unknown>[]>) {
	const present = (
		await tx.execute<{ name: string }>(sql`SELECT c.relname AS name FROM pg_class c
			JOIN pg_namespace n ON n.oid=c.relnamespace
			WHERE n.nspname=${target} AND c.relkind IN ('r','p') AND NOT c.relispartition AND c.relname<>'schema_migration'
			ORDER BY 1`)
	).rows.map((r) => r.name);
	if (JSON.stringify(present) !== JSON.stringify(Object.keys(tables).sort())) throw new Refused("schema_mismatch");
	await tx.execute(sql.raw(`TRUNCATE ${present.map((name) => `"${name}"`).join(",")}`));
	for (const name of present) {
		const rows = tables[name]!;
		if (rows.length === 0) continue;
		const columns = (
			await tx.execute<{ name: string }>(sql`SELECT attname AS name FROM pg_attribute
				WHERE attrelid=${`${target}."${name}"`}::regclass AND attnum>0 AND NOT attisdropped AND attgenerated=''
				ORDER BY attnum`)
		).rows.map((r) => `"${r.name}"`);
		const list = columns.join(",");
		await tx.execute(sql`INSERT INTO ${sql.raw(`"${name}"`)} (${sql.raw(list)}) OVERRIDING SYSTEM VALUE
			SELECT ${sql.raw(list)} FROM json_populate_recordset(NULL::${sql.raw(`"${name}"`)}, ${JSON.stringify(rows)}::json)`);
	}
}

/** Open mail and issue rows take the current receipt: a send or issue that already happened is never replayed. */
async function reconcile(tx: Tx, current: ReturnType<typeof currentManifest.parse>) {
	await tx.execute(sql`UPDATE mail m SET state=r.state, provider_message_id=r.provider_message_id,
		accepted_at=r.accepted_at, sent_at=r.sent_at
		FROM json_to_recordset(${JSON.stringify(current.mail)}::json)
			AS r(id uuid, state text, provider_message_id text, accepted_at timestamptz, sent_at timestamptz)
		WHERE m.id=r.id AND m.state IN ${OPEN_MAIL}`);
	await tx.execute(sql`UPDATE feedback f SET publication_state=r.publication_state, held_reason=r.held_reason,
		publication_payload=r.publication_payload, publication_hash=r.publication_hash, repository_id=r.repository_id,
		repository_name=r.repository_name, issue_number=r.issue_number, issue_url=r.issue_url, published_at=r.published_at
		FROM json_populate_recordset(NULL::feedback, ${JSON.stringify(current.issues)}::json) r
		WHERE f.id=r.id AND f.publication_state IN ${OPEN_ISSUE}`);
}

/**
 * The current witnesses replace the image's, then take effect the way the live system applies them: a pending subject
 * is suspended, and a purging or purged one is purged again in the target, its files marked purged, before its witness
 * returns to the current purge and copy-expiry instants.
 */
async function applyWitnesses(tx: Tx, witnesses: ReturnType<typeof witness.parse>[]) {
	const purging = witnesses.filter((w) => w.state === "purging" || w.state === "purged");
	const rows = witnesses.map((w) => ({
		...w,
		request_revision: String(w.request_revision),
		witness_checkpoint: String(w.witness_checkpoint),
		...(purging.includes(w)
			? { state: "purging", cleanup_state: "in_progress", live_purged_at: null, copy_expires_at: null }
			: {}),
	}));
	await tx.execute(sql`DELETE FROM lifecycle_witness`);
	if (rows.length)
		await tx.execute(sql`INSERT INTO lifecycle_witness
			SELECT * FROM json_populate_recordset(NULL::lifecycle_witness, ${JSON.stringify(rows)}::json) r
			WHERE r.state = ANY(${sql.param(entryStates(deletionMachine, OPERATION))}::text[])`);
	await tx.execute(sql`SET LOCAL session_replication_role = origin`);
	for (const w of witnesses.filter((w) => w.state === "pending_deletion"))
		await tx.execute(sql`SELECT settings_suspend_subject(${w.id}::uuid, ${w.request_id}::uuid)`);
	for (const w of purging) {
		await tx.execute(
			sql`SELECT settings_purge_content(${w.id}::uuid, ${w.request_id}::uuid, ${String(w.request_revision)}::bigint)`,
		);
		// As the live cleanup moves a file: ready or failed to cleanup, then purged.
		for (const state of ["cleanup", "purged"])
			await tx.execute(sql`UPDATE file_object SET state=${state},
				purged_at=CASE WHEN ${state}='purged' THEN coalesce(purged_at, clock_timestamp()) END
				WHERE tenant_id=${w.opaque_subject_id}::uuid AND state<>'purged'`);
	}
	await tx.execute(sql`SET LOCAL session_replication_role = replica`);
	for (const w of purging)
		await tx.execute(sql`UPDATE lifecycle_witness SET state=${w.state}, cleanup_state=${String(w.cleanup_state)},
			live_purged_at=${w.live_purged_at as string | null}::timestamptz, copy_expires_at=${w.copy_expires_at}::timestamptz
			WHERE id=${w.id}::uuid
			AND state = ANY(${sql.param(fromStates(deletionMachine, OPERATION, w.state, { kind: w.kind, copy: true }))}::text[])`);
}

/** After the witnesses, no open mail or publication may remain that the current receipts do not account for. */
async function unreconciled(tx: Tx, current: ReturnType<typeof currentManifest.parse>) {
	const { rows } = await tx.execute<{ open: boolean }>(sql`SELECT
		EXISTS(SELECT FROM mail WHERE state IN ${OPEN_MAIL} AND id NOT IN ${ids(current.mail)})
		OR EXISTS(SELECT FROM feedback WHERE publication_state IN ${OPEN_ISSUE} AND id NOT IN ${ids(current.issues)}) AS open`);
	if (rows[0]?.open) throw new Refused("receipt_unreconciled");
}
