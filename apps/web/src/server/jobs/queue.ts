import "server-only";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "../platform/database.ts";

export const jobKind = z.enum([
	"mail",
	"notification",
	"digest",
	"assessment",
	"reference_generation",
	"feedback_publication",
	"object_cleanup",
	"lifecycle_purge",
	"assistant_turn",
	"document_render",
]);
export type JobKind = z.infer<typeof jobKind>;
export const DEFAULT_LEASE_SECONDS = 300;
const ASSESSMENT_LEASE_SECONDS = 120;
const leaseDuration = z.number().int().min(1).max(DEFAULT_LEASE_SECONDS);
export const claimSchema = z.object({
	id: z.uuid(),
	tenant_id: z.uuid(),
	kind: jobKind,
	subject_record_id: z.uuid().nullable(),
	source_revision: z.string().nullable(),
	claim_generation: z.string(),
	lease_owner: z.string(),
	attempt_count: z.number().int(),
	max_attempts: z.number().int(),
	checkpoint_key: z.string().nullable(),
});
export type Claim = z.infer<typeof claimSchema>;
const enqueueSchema = z.strictObject({
	tenant: z.uuid(),
	kind: jobKind,
	subject: z.uuid().nullable(),
	key: z.string().min(1).max(512),
	revision: z
		.string()
		.regex(/^[1-9]\d*$/)
		.nullable(),
	eligibleAt: z.iso.datetime(),
	maxAttempts: z.number().int().min(1).max(10).default(4),
});
export type JobInput = z.input<typeof enqueueSchema>;

// Called on the producer's existing transaction, alongside its facts and receipt.
export async function enqueueJob(tx: PoolClient, input: JobInput): Promise<string> {
	const v = enqueueSchema.parse(input);
	const result = await tx.query<{ id: string }>(
		`INSERT INTO job(tenant_id,kind,subject_record_id,producer_key,
    source_revision,state,eligible_at,attempt_count,max_attempts,claim_generation)
    VALUES($1,$2,$3,$4,$5,'ready',$6,0,$7,0) ON CONFLICT DO NOTHING RETURNING id`,
		[v.tenant, v.kind, v.subject, v.key, v.revision, v.eligibleAt, v.maxAttempts],
	);
	if (result.rows[0]) return result.rows[0].id;
	const old = await tx.query<{ id: string; tenant_id: string; source_revision: string | null }>(
		`SELECT id,tenant_id,source_revision::text FROM job WHERE kind=$1 AND producer_key=$2
    AND ((subject_record_id=$3 AND tenant_id=$4) OR (subject_record_id IS NULL AND $3::uuid IS NULL AND tenant_id=$4))`,
		[v.kind, v.key, v.subject, v.tenant],
	);
	const row = old.rows[0];
	if (!row || row.tenant_id !== v.tenant || row.source_revision !== v.revision)
		throw new Error("job_identity_conflict");
	return row.id;
}

// The duration override applies to ordinary jobs; assessment claims always use 120 seconds.
export async function claimDue(
	db: Pool,
	kinds: readonly JobKind[],
	limit = 1,
	leaseSeconds = DEFAULT_LEASE_SECONDS,
): Promise<Claim[]> {
	const config = z
		.object({ kinds: z.array(jobKind).min(1).max(10), limit: z.number().int().min(1).max(100), lease: leaseDuration })
		.parse({ kinds, limit, lease: leaseSeconds });
	return transaction(db, async (tx) => {
		const result = await tx.query(
			`WITH due AS (
      SELECT id FROM job WHERE kind=ANY($1::text[]) AND state IN ('ready','retry_wait')
      AND attempt_count<max_attempts AND eligible_at<=clock_timestamp()
      AND (next_attempt_at IS NULL OR next_attempt_at<=clock_timestamp())
      ORDER BY eligible_at,id FOR UPDATE SKIP LOCKED LIMIT $2
    ) UPDATE job j SET state='claimed',attempt_count=attempt_count+1,claim_generation=claim_generation+1,
      lease_owner=$3,lease_until=clock_timestamp()+make_interval(secs=>CASE WHEN j.kind='assessment' THEN $5::int ELSE $4::int END),revision=revision+1
      FROM due WHERE j.id=due.id RETURNING j.*`,
			[config.kinds, config.limit, randomUUID(), config.lease, ASSESSMENT_LEASE_SECONDS],
		);
		return result.rows.map((row) => claimSchema.parse(row));
	});
}
export async function lockClaim(tx: PoolClient, claim: Claim): Promise<boolean> {
	const r = await tx.query(
		`SELECT id FROM job WHERE id=$1 AND tenant_id=$2 AND state='claimed'
    AND claim_generation=$3 AND lease_owner=$4 AND source_revision IS NOT DISTINCT FROM $5::bigint AND lease_until>clock_timestamp() FOR UPDATE`,
		[claim.id, claim.tenant_id, claim.claim_generation, claim.lease_owner, claim.source_revision],
	);
	return r.rowCount === 1;
}
export async function extendLease(db: Pool, claim: Claim, seconds: number): Promise<boolean> {
	leaseDuration.parse(seconds);
	const r = await db.query(
		`UPDATE job SET lease_until=clock_timestamp()+make_interval(secs=>CASE WHEN kind='assessment' THEN $7::int ELSE $5::int END)
    WHERE id=$1 AND tenant_id=$2 AND claim_generation=$3 AND lease_owner=$4
    AND state='claimed' AND lease_until>clock_timestamp() AND source_revision IS NOT DISTINCT FROM $6::bigint`,
		[
			claim.id,
			claim.tenant_id,
			claim.claim_generation,
			claim.lease_owner,
			seconds,
			claim.source_revision,
			ASSESSMENT_LEASE_SECONDS,
		],
	);
	return r.rowCount === 1;
}
export type JobResult =
	| { state: "succeeded" | "cancelled" | "superseded" | "failed" | "reconcile"; code?: string }
	| { state: "retry_wait"; retryAfterSeconds?: number; code: string };
export async function finishClaim(tx: PoolClient, claim: Claim, result: JobResult): Promise<boolean> {
	if (!(await lockClaim(tx, claim))) return false;
	const terminal = result.state !== "retry_wait" && result.state !== "reconcile";
	const exhausted = result.state === "retry_wait" && claim.attempt_count >= claim.max_attempts;
	const delay =
		result.state === "retry_wait"
			? Math.max([300, 600, 1200][Math.min(claim.attempt_count - 1, 2)] ?? 1200, result.retryAfterSeconds ?? 0)
			: 0;
	await tx.query(
		`UPDATE job SET state=$2,error_code=$3,lease_owner=NULL,lease_until=NULL,
    next_attempt_at=CASE WHEN $4::boolean THEN clock_timestamp()+make_interval(secs=>$5) ELSE NULL END,
    finished_at=CASE WHEN $6::boolean THEN clock_timestamp() ELSE NULL END,revision=revision+1 WHERE id=$1`,
		[
			claim.id,
			exhausted ? "failed" : result.state,
			result.code ?? null,
			result.state === "retry_wait" && !exhausted,
			delay,
			terminal || exhausted,
		],
	);
	return true;
}

// A crash after the external marker cannot turn into a new external effect.
export async function recoverLease(db: Pool, limit = 100): Promise<number> {
	z.number().int().min(1).max(100).parse(limit);
	return transaction(db, async (tx) => {
		const rows = await tx.query(
			`WITH expired AS (SELECT id FROM job WHERE state='claimed'
      AND lease_until<=clock_timestamp() ORDER BY lease_until,id FOR UPDATE SKIP LOCKED LIMIT $1)
      UPDATE job j SET state=CASE WHEN checkpoint_key='external' THEN 'reconcile'
      WHEN attempt_count>=max_attempts THEN 'failed' ELSE 'retry_wait' END,
      error_code='lease_expired',lease_owner=NULL,lease_until=NULL,
      next_attempt_at=clock_timestamp()+interval '5 minutes',
      finished_at=CASE WHEN checkpoint_key IS DISTINCT FROM 'external' AND attempt_count>=max_attempts THEN clock_timestamp() ELSE NULL END,
      claim_generation=claim_generation+1,revision=revision+1
      FROM expired WHERE j.id=expired.id RETURNING j.id,j.kind,j.subject_record_id,j.state`,
			[limit],
		);
		for (const row of rows.rows) {
			if (row.kind === "mail" && row.state === "reconcile") {
				await tx.query("UPDATE mail SET state='unknown' WHERE id=$1 AND state='dispatched'", [row.subject_record_id]);
				await tx.query(
					`UPDATE mail_attempt a SET outcome='unknown',safe_error='lease_expired',completed_at=clock_timestamp()
          FROM mail_request_member m WHERE m.mail_id=$1 AND m.request_id=a.request_id AND a.outcome='in_flight'`,
					[row.subject_record_id],
				);
			}
		}
		return rows.rowCount ?? 0;
	});
}
export async function checkpoint(tx: PoolClient, claim: Claim, key: string): Promise<boolean> {
	z.string().min(1).max(256).parse(key);
	if (!(await lockClaim(tx, claim))) return false;
	await tx.query("UPDATE job SET checkpoint_key=$2,revision=revision+1 WHERE id=$1", [claim.id, key]);
	return true;
}
export async function jobVisibility(db: Pool) {
	const r = await db.query(`SELECT kind,state,count(*)::int AS count,
    greatest(0,extract(epoch FROM clock_timestamp()-min(eligible_at)))::float8 AS lag_seconds
    FROM job GROUP BY kind,state ORDER BY kind,state`);
	return z
		.array(z.object({ kind: jobKind, state: z.string(), count: z.number(), lag_seconds: z.number() }))
		.parse(r.rows);
}

// Owed-tail scans commit each processed page and cursor together. No provider work here.
export async function scanPage(
	tx: PoolClient,
	claim: Claim,
	config: {
		size: number;
		load: (tx: PoolClient, after: string | null, limit: number) => Promise<string[]>;
		process: (tx: PoolClient, id: string) => Promise<void>;
	},
) {
	z.number().int().min(1).max(100).parse(config.size);
	if (!(await lockClaim(tx, claim))) return false;
	const cursor = claim.checkpoint_key ? z.uuid().parse(claim.checkpoint_key) : null;
	const ids = z
		.array(z.uuid())
		.max(config.size)
		.parse(await config.load(tx, cursor, config.size));
	let previous = cursor;
	for (const id of ids) {
		if (previous !== null && id <= previous) throw Error("scan_cursor_unordered");
		previous = id;
	}
	if (ids.length === 0) return finishClaim(tx, claim, { state: "succeeded" });
	for (const id of ids) await config.process(tx, id);
	// Progress begins a fresh retry budget for the next chunk, never for a failed chunk.
	await tx.query(
		`UPDATE job SET checkpoint_key=$2,state='ready',attempt_count=0,
    lease_owner=NULL,lease_until=NULL,revision=revision+1 WHERE id=$1`,
		[claim.id, ids.at(-1)],
	);
	return true;
}
