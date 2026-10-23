import type { Database, Transaction } from "@everyfield/db/client";
import { eq, sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { randomUUID } from "node:crypto";
import "server-only";
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
	"people_import",
	"evry_effect",
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

/** The job rows as one insert a producer queues into its own write statement (D70). A known key inserts nothing. */
export function queueJobs(tx: Transaction, inputs: readonly JobInput[]) {
	const values = inputs.map((input) => enqueueSchema.parse(input));
	return tx
		.insert(tables.job)
		.values(
			values.map((v) => ({
				tenant_id: v.tenant,
				kind: v.kind,
				subject_record_id: v.subject,
				producer_key: v.key,
				source_revision: v.revision,
				state: "ready" as const,
				eligible_at: new Date(v.eligibleAt),
				attempt_count: 0,
				max_attempts: v.maxAttempts,
				claim_generation: "0",
			})),
		)
		.onConflictDoNothing();
}
// Called on the producer's existing transaction, alongside its facts and receipt.
export async function enqueueJobs(tx: Transaction, inputs: readonly JobInput[]): Promise<string[]> {
	const values = inputs.map((input) => enqueueSchema.parse(input));
	if (!values.length) return [];
	const inserted = await queueJobs(tx, values).returning({
		id: tables.job.id,
		tenant: tables.job.tenant_id,
		kind: tables.job.kind,
		subject: tables.job.subject_record_id,
		key: tables.job.producer_key,
		revision: tables.job.source_revision,
	});
	let rows = inserted;
	if (rows.length !== values.length) {
		const input = values.map((v, n) => ({ n, tenant: v.tenant, kind: v.kind, subject: v.subject, key: v.key }));
		const result = await tx.execute(
			sql`SELECT j.id,j.tenant_id AS tenant,j.kind,j.subject_record_id AS subject,j.producer_key AS key,j.source_revision::text AS revision FROM job j JOIN jsonb_to_recordset(${JSON.stringify(input)}::jsonb) i(n int,tenant uuid,kind text,subject uuid,key text) ON j.kind=i.kind AND j.subject_record_id IS NOT DISTINCT FROM i.subject AND j.producer_key=i.key AND (i.subject IS NOT NULL OR j.tenant_id=i.tenant)`,
		);
		rows = z
			.array(
				z.object({
					id: z.uuid(),
					tenant: z.uuid(),
					kind: jobKind,
					subject: z.uuid().nullable(),
					key: z.string(),
					revision: z.string().nullable(),
				}),
			)
			.parse(result.rows);
	}
	return values.map((v) => {
		const row = rows.find(
			(r) =>
				r.kind === v.kind &&
				r.subject === v.subject &&
				r.key === v.key &&
				(v.subject !== null || r.tenant === v.tenant),
		);
		if (!row || row.tenant !== v.tenant || row.revision !== v.revision) throw Error("job_identity_conflict");
		return row.id;
	});
}
export async function enqueueJob(tx: Transaction, input: JobInput): Promise<string> {
	const [id] = await enqueueJobs(tx, [input]);
	if (!id) throw Error("job_identity_conflict");
	return id;
}

// The duration override applies to ordinary jobs; assessment claims always use 120 seconds.
/**
 * Claims up to `limit` due jobs of these kinds, oldest first, skipping rows another claim holds. One round trip: the
 * claim and its 5-second statement bound are one simple-protocol message, which Postgres runs as one implicit
 * transaction, so `SET LOCAL statement_timeout` bounds the claim exactly as the transaction wrapper did. The values are
 * inlined because that protocol takes no parameters; each is parsed first (kind names, integers, a random UUID).
 * `maxAgeSeconds` leaves older jobs to their kind's own recovery, for kinds whose unclaimed jobs expire (Evry's).
 */
export async function claimDue(
	db: Database,
	kinds: readonly JobKind[],
	limit = 1,
	leaseSeconds = DEFAULT_LEASE_SECONDS,
	maxAgeSeconds?: number,
): Promise<Claim[]> {
	const config = z
		.object({
			kinds: z.array(jobKind).min(1).max(10),
			limit: z.number().int().min(1).max(100),
			lease: leaseDuration,
			maxAge: z.number().int().min(1).max(86_400).optional(),
		})
		.parse({ kinds, limit, lease: leaseSeconds, maxAge: maxAgeSeconds });
	const owner = z.uuid().parse(randomUUID());
	// The pool runs a text without parameters as a simple query and answers one result per statement.
	const pool = (db as Database & { $client: { query(text: string): Promise<unknown> } }).$client;
	const results = (await pool.query(`SET LOCAL statement_timeout = '5s';
WITH due AS (
  SELECT id FROM job WHERE kind IN (${config.kinds.map((kind) => `'${kind}'`).join(",")}) AND state IN ('ready','retry_wait')
  AND attempt_count<max_attempts AND eligible_at<=clock_timestamp()
  AND (next_attempt_at IS NULL OR next_attempt_at<=clock_timestamp())${
		config.maxAge
			? `
  AND eligible_at>clock_timestamp()-make_interval(secs=>${config.maxAge})`
			: ""
	}
  ORDER BY eligible_at,id FOR UPDATE SKIP LOCKED LIMIT ${config.limit}
) UPDATE job j SET state='claimed',attempt_count=attempt_count+1,claim_generation=claim_generation+1,
  lease_owner='${owner}',lease_until=clock_timestamp()+make_interval(secs=>CASE WHEN j.kind='assessment' THEN ${ASSESSMENT_LEASE_SECONDS} ELSE ${config.lease} END),revision=revision+1
  FROM due WHERE j.id=due.id RETURNING j.*`)) as { rows: unknown[] }[];
	return results[1]!.rows.map((row) => claimSchema.parse(row));
}
export async function lockClaim(tx: Transaction, claim: Claim): Promise<boolean> {
	const r =
		await tx.execute(sql`SELECT id FROM job WHERE id=${claim.id} AND tenant_id=${claim.tenant_id} AND state='claimed'
    AND claim_generation=${claim.claim_generation} AND lease_owner=${claim.lease_owner} AND source_revision IS NOT DISTINCT FROM ${claim.source_revision}::bigint AND lease_until>clock_timestamp() FOR UPDATE`);
	return r.rowCount === 1;
}
export async function extendLease(db: Database, claim: Claim, seconds: number): Promise<boolean> {
	leaseDuration.parse(seconds);
	const r =
		await db.execute(sql`UPDATE job SET lease_until=clock_timestamp()+make_interval(secs=>CASE WHEN kind='assessment' THEN ${ASSESSMENT_LEASE_SECONDS}::int ELSE ${seconds}::int END)
    WHERE id=${claim.id} AND tenant_id=${claim.tenant_id} AND claim_generation=${claim.claim_generation} AND lease_owner=${claim.lease_owner}
    AND state='claimed' AND lease_until>clock_timestamp() AND source_revision IS NOT DISTINCT FROM ${claim.source_revision}::bigint`);
	return r.rowCount === 1;
}
export type JobResult =
	| { state: "succeeded" | "cancelled" | "superseded" | "failed" | "reconcile"; code?: string }
	| { state: "retry_wait"; retryAfterSeconds?: number; code: string };
export async function finishClaim(tx: Transaction, claim: Claim, result: JobResult): Promise<boolean> {
	if (!(await lockClaim(tx, claim))) return false;
	const terminal = result.state !== "retry_wait" && result.state !== "reconcile";
	const exhausted = result.state === "retry_wait" && claim.attempt_count >= claim.max_attempts;
	const delay =
		result.state === "retry_wait"
			? Math.max([300, 600, 1200][Math.min(claim.attempt_count - 1, 2)] ?? 1200, result.retryAfterSeconds ?? 0)
			: 0;
	await tx.execute(sql`UPDATE job SET state=${exhausted ? "failed" : result.state},error_code=${result.code ?? null},lease_owner=NULL,lease_until=NULL,
    next_attempt_at=CASE WHEN ${result.state === "retry_wait" && !exhausted}::boolean THEN clock_timestamp()+make_interval(secs=>${delay}) ELSE NULL END,
    finished_at=CASE WHEN ${terminal || exhausted}::boolean THEN clock_timestamp() ELSE NULL END,revision=revision+1 WHERE id=${claim.id}`);
	return true;
}

// A crash after the external marker cannot turn into a new external effect.
export async function recoverLease(db: Database, limit = 100): Promise<number> {
	z.number().int().min(1).max(100).parse(limit);
	return transaction(db, async (tx) => {
		const rows = await tx.execute(sql`WITH expired AS (
 SELECT id FROM job WHERE state='claimed' AND lease_until<=clock_timestamp()
 ORDER BY lease_until,id FOR UPDATE SKIP LOCKED LIMIT ${limit}
), recovered AS (
 UPDATE job j SET state=CASE WHEN checkpoint_key='external' THEN 'reconcile'
 WHEN attempt_count>=max_attempts THEN 'failed' ELSE 'retry_wait' END,
 error_code='lease_expired',lease_owner=NULL,lease_until=NULL,
 next_attempt_at=clock_timestamp()+interval '5 minutes',
 finished_at=CASE WHEN checkpoint_key IS DISTINCT FROM 'external' AND attempt_count>=max_attempts THEN clock_timestamp() ELSE NULL END,
 claim_generation=claim_generation+1,revision=revision+1 FROM expired WHERE j.id=expired.id
 RETURNING j.id,j.kind,j.subject_record_id,j.state
), unknown_mail AS (
 UPDATE mail m SET state='unknown' FROM recovered r
 WHERE r.kind='mail' AND r.state='reconcile' AND m.id=r.subject_record_id AND m.state='dispatched' RETURNING m.id
), unknown_attempt AS (
 UPDATE mail_attempt a SET outcome='unknown',safe_error='lease_expired',completed_at=clock_timestamp()
 FROM mail_request_member m, recovered r WHERE r.kind='mail' AND r.state='reconcile'
 AND m.mail_id=r.subject_record_id AND m.request_id=a.request_id AND a.outcome='in_flight' RETURNING a.id
) SELECT count(*)::int AS count FROM recovered`);
		return z.number().parse(rows.rows[0]?.count);
	});
}
export async function checkpoint(tx: Transaction, claim: Claim, key: string): Promise<boolean> {
	z.string().min(1).max(256).parse(key);
	if (!(await lockClaim(tx, claim))) return false;
	await tx
		.update(tables.job)
		.set({ checkpoint_key: key, revision: sql<unknown>`(${tables.job.revision} + 1)` })
		.where(eq(tables.job.id, claim.id));
	return true;
}

// Owed-tail scans commit each processed page and cursor together. No provider work here.
export async function scanPage(
	tx: Transaction,
	claim: Claim,
	config: {
		size: number;
		load: (tx: Transaction, after: string | null, limit: number) => Promise<string[]>;
		process: (tx: Transaction, ids: readonly string[]) => Promise<void>;
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
	await config.process(tx, ids);
	// Progress begins a fresh retry budget for the next chunk, never for a failed chunk.
	await tx
		.update(tables.job)
		.set({
			checkpoint_key: ids.at(-1),
			state: "ready",
			attempt_count: 0,
			lease_owner: null,
			lease_until: null,
			revision: sql<unknown>`(${tables.job.revision} + 1)`,
		})
		.where(eq(tables.job.id, claim.id));
	return true;
}
