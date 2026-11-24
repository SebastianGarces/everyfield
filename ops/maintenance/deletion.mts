import { sql } from "../../packages/db/src/query.ts";
import type { Database } from "../../packages/db/src/client.ts";
import { readCopies, type BucketCopy } from "./backup.mts";
import type { BackupBucket } from "./bucket.mts";
import type { FileSource } from "./source.mts";

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SEVEN_DAYS = 7 * 86_400_000;
const KEPT: Record<string, string> = {
	tenant: "true",
	record: "true",
	lifecycle_witness: "true",
	feature_flag: "true",
	plant: "t.name='Removed workspace' AND num_nonnulls(t.street,t.description,t.city,t.state_province,t.country)=0",
	job: "t.kind='lifecycle_purge'",
	file_object: "t.state='purged'",
};

export type DeletionCheck = {
	subject: string;
	checked_at: string;
	state: "none" | "pending_deletion" | "purging" | "purged" | "cancelled";
	requested_at: string | null;
	cancel_until: string | null;
	cancel_allowed: boolean;
	live_purged_at: string | null;
	copy_expires_at: string | null;
	copy_expiry_within_7_days: boolean;
	remaining_rows: Record<string, number>;
	remaining_files: number;
	copies_before_purge: Pick<BucketCopy, "location" | "expires_at">[] | null;
	verdict: "purged" | "not_purged";
};

type Witness = {
	state: "pending_deletion" | "purging" | "purged" | "cancelled";
	requested_at: string | null;
	cancel_until: string | null;
	live_purged_at: string | null;
	copy_expires_at: string | null;
	at: string;
};
const instant = (value: string | null) => (value ? new Date(value).toISOString() : null);

export async function checkDeletion(
	deps: { db: Database; schema: string; files: FileSource; bucket?: BackupBucket },
	subject: string,
): Promise<DeletionCheck> {
	if (!IDENTIFIER.test(deps.schema) || !UUID.test(subject)) throw Error("subject_invalid");
	const read = await deps.db.transaction(
		async (tx) => {
			await tx.execute(sql.raw(`SET LOCAL search_path TO ${deps.schema}, pg_catalog, pg_temp`));
			const [witness] = (
				await tx.execute<Witness>(sql`SELECT state, requested_at::text, cancel_until::text, live_purged_at::text,
					copy_expires_at::text, now()::text AS at FROM lifecycle_witness
					WHERE kind='plant' AND opaque_subject_id=${subject}::uuid`)
			).rows;
			const columns = (
				await tx.execute<{ table: string; column: string }>(sql`SELECT c.relname AS table, a.attname AS column
					FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
					WHERE n.nspname=${deps.schema} AND c.relkind IN ('r','p') AND NOT c.relispartition
					AND a.atttypid='uuid'::regtype AND a.attnum>0 AND NOT a.attisdropped ORDER BY 1, 2`)
			).rows;
			const byTable = Map.groupBy(columns, (c) => c.table);
			const remaining: Record<string, number> = {};
			for (const [table, of] of byTable) {
				const names = [table, ...of.map((c) => c.column)];
				if (!names.every((name) => IDENTIFIER.test(name))) throw Error("schema_invalid");
				const where = of.map((c) => `t."${c.column}"='${subject}'::uuid`).join(" OR ");
				const kept = KEPT[table];
				const [row] = (
					await tx.execute<{ n: number }>(
						sql.raw(
							`SELECT count(*)::int AS n FROM "${table}" t WHERE (${where})${kept ? ` AND (${kept}) IS NOT TRUE` : ""}`,
						),
					)
				).rows;
				if (row!.n > 0) remaining[table] = row!.n;
			}
			const keys = (
				await tx.execute<{ opaque_key: string }>(
					sql`SELECT opaque_key FROM file_object WHERE tenant_id=${subject}::uuid`,
				)
			).rows.map((r) => r.opaque_key);
			return { witness, remaining, keys };
		},
		{ isolationLevel: "repeatable read", accessMode: "read only" },
	);
	const stored = new Set(await deps.files.keys(`private/${subject}/`));
	for (const key of read.keys) if (!stored.has(key) && (await deps.files.read(key))) stored.add(key);
	const w = read.witness;
	const purgedAt = w?.live_purged_at ? Date.parse(w.live_purged_at) : null;
	const expiresAt = w?.copy_expires_at ? Date.parse(w.copy_expires_at) : null;
	const withinSeven = purgedAt !== null && expiresAt !== null && expiresAt - purgedAt <= SEVEN_DAYS;
	const now = w ? new Date(w.at) : new Date();
	const copies =
		deps.bucket && purgedAt !== null
			? (await readCopies(deps.bucket, now))
					.filter((c) => c.created_at === null || Date.parse(c.created_at) <= purgedAt)
					.map(({ location, expires_at }) => ({ location, expires_at }))
			: null;
	const copiesEnd = (copies ?? []).every((c) => expiresAt !== null && Date.parse(c.expires_at) <= expiresAt);
	const purged =
		w?.state === "purged" &&
		withinSeven &&
		copiesEnd &&
		stored.size === 0 &&
		Object.keys(read.remaining).length === 0;
	return {
		subject,
		checked_at: now.toISOString(),
		state: w?.state ?? "none",
		requested_at: instant(w?.requested_at ?? null),
		cancel_until: instant(w?.cancel_until ?? null),
		cancel_allowed: w?.state === "pending_deletion" && w.cancel_until !== null && now < new Date(w.cancel_until),
		live_purged_at: instant(w?.live_purged_at ?? null),
		copy_expires_at: instant(w?.copy_expires_at ?? null),
		copy_expiry_within_7_days: withinSeven,
		remaining_rows: read.remaining,
		remaining_files: stored.size,
		copies_before_purge: copies,
		verdict: purged ? "purged" : "not_purged",
	};
}
