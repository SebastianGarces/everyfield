import type { Database, Transaction } from "@everyfield/db/client";
import { eq, sql, type SQL } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { transaction } from "./transaction.ts";

const jobKind = z.enum([
	"mail",
	"notification",
	"digest",
	"object_cleanup",
	"lifecycle_purge",
	"assistant_turn",
	"people_import",
	"evry_effect",
	"feedback_publication",
	"assessment",
]);
export type JobKind = z.infer<typeof jobKind>;
export const DEFAULT_LEASE_SECONDS = 300;
const leaseDuration = z.number().int().min(1).max(DEFAULT_LEASE_SECONDS);
export const claimSchema = z.object({
	id: z.uuid(),
	tenant_id: z.uuid(),
	kind: jobKind,
	subject_record_id: z.uuid().nullable(),
	producer_key: z.string(),
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
const jobRowsSchema = z.object({ kind: jobKind, maxAttempts: z.number().int().min(1).max(10).default(4) });
const onConflict = {
	fail: sql``,
	skip: sql` ON CONFLICT DO NOTHING`,
	skipSameKey: sql` ON CONFLICT (kind, subject_record_id, producer_key) DO NOTHING`,
	reopen: sql` ON CONFLICT (kind, subject_record_id, producer_key) DO UPDATE SET state = 'ready',
  eligible_at = excluded.eligible_at, source_revision = excluded.source_revision,
  attempt_count = CASE WHEN job.state IN ('superseded', 'cancelled') THEN 0 ELSE job.attempt_count END,
  finished_at = NULL, error_code = NULL, next_attempt_at = NULL, lease_owner = NULL, lease_until = NULL,
  claim_generation = job.claim_generation + 1, revision = job.revision + 1
 WHERE job.state IN ('ready', 'retry_wait', 'claimed', 'superseded', 'cancelled')`,
} as const;
export type JobRows = z.input<typeof jobRowsSchema> & {
	tenant: SQL;
	subject: SQL;
	key: SQL;
	id?: SQL;
	revision?: SQL;
	eligibleAt?: SQL;
	conflict: keyof typeof onConflict;
	returning?: boolean;
};

export function queueJobsFor(source: SQL, rows: JobRows) {
	const v = jobRowsSchema.parse({ kind: rows.kind, maxAttempts: rows.maxAttempts });
	return sql`INSERT INTO job (${rows.id ? sql`id, ` : sql``}tenant_id, kind, subject_record_id, producer_key, source_revision, state,
  eligible_at, attempt_count, max_attempts, claim_generation)
 SELECT ${rows.id ? sql`${rows.id}, ` : sql``}${rows.tenant}, ${v.kind}::text, ${rows.subject}, ${rows.key}, ${rows.revision ?? sql`NULL::bigint`},
  'ready', ${rows.eligibleAt ?? sql`clock_timestamp()`}, 0, ${v.maxAttempts}::int, 0 ${source}${onConflict[rows.conflict]}${rows.returning ? sql` RETURNING id` : sql``}`;
}
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
  lease_owner='${owner}',lease_until=clock_timestamp()+make_interval(secs=>${config.lease}),revision=revision+1
  FROM due WHERE j.id=due.id RETURNING j.*`)) as { rows: unknown[] }[];
	const [, claimed] = results;
	if (!claimed) throw Error("The claim batch returned no claimed rows result");
	return claimed.rows.map((row) => claimSchema.parse(row));
}
export async function lockClaim(tx: Transaction, claim: Claim): Promise<boolean> {
	const r =
		await tx.execute(sql`SELECT id FROM job WHERE id=${claim.id} AND tenant_id=${claim.tenant_id} AND state='claimed'
    AND claim_generation=${claim.claim_generation} AND lease_owner=${claim.lease_owner} AND source_revision IS NOT DISTINCT FROM ${claim.source_revision}::bigint AND lease_until>clock_timestamp() FOR UPDATE`);
	return r.rowCount === 1;
}
const JOB_CODES = [
	"stale",
	"passed",
	"suppressed",
	"notification_failed",
	"import_interrupted",
	"digest_failed",
	"feedback_removed",
	"github_unknown",
	"not_current",
	"removal_unconfirmed",
	"conflict",
	"deadline_passed",
	"purge_unavailable",
	"authority_changed",
	"idempotency_expired",
	"provider_unknown",
	"provider_refused",
	"nothing_to_delete",
] as const;
type JobCode = (typeof JOB_CODES)[number];
export type JobResult =
	| { state: "succeeded" | "cancelled" | "superseded" | "failed" | "reconcile"; code?: JobCode }
	| { state: "retry_wait"; retryAfterSeconds?: number; code: JobCode };
const literal = (value: string) =>
	`'${z
		.string()
		.regex(/^[^\0]*$/)
		.parse(value)
		.replaceAll("'", "''")}'`;
function finishStatement(claim: Claim, result: JobResult) {
	const c = claimSchema
		.extend({ claim_generation: z.string().regex(/^\d+$/), source_revision: z.string().regex(/^\d+$/).nullable() })
		.parse(claim);
	const state = z
		.enum(["succeeded", "cancelled", "superseded", "failed", "reconcile", "retry_wait"])
		.parse(result.state);
	const terminal = state !== "retry_wait" && state !== "reconcile";
	const after = z
		.number()
		.finite()
		.min(0)
		.parse(result.state === "retry_wait" ? (result.retryAfterSeconds ?? 0) : 0);
	const exhausted = "attempt_count>=max_attempts";
	const code = result.code === undefined ? "NULL" : literal(z.enum(JOB_CODES).parse(result.code));
	const set =
		state === "retry_wait"
			? `state=CASE WHEN ${exhausted} THEN 'failed' ELSE 'retry_wait' END,error_code=${code},lease_owner=NULL,lease_until=NULL,
  next_attempt_at=CASE WHEN ${exhausted} THEN NULL ELSE clock_timestamp()+make_interval(secs=>GREATEST((ARRAY[300,600,1200])[LEAST(GREATEST(attempt_count,1),3)],${after})) END,
  finished_at=CASE WHEN ${exhausted} THEN clock_timestamp() ELSE NULL END`
			: `state='${state}',error_code=${code},lease_owner=NULL,lease_until=NULL,next_attempt_at=NULL,
  finished_at=${terminal ? "clock_timestamp()" : "NULL"}`;
	return `UPDATE job SET ${set},revision=revision+1
  WHERE id='${c.id}' AND tenant_id='${c.tenant_id}' AND state='claimed' AND claim_generation=${c.claim_generation}
  AND lease_owner=${literal(c.lease_owner)} AND source_revision IS NOT DISTINCT FROM ${c.source_revision ?? "NULL"}::bigint
  AND lease_until>clock_timestamp()`;
}
export async function finishClaim(tx: Transaction, claim: Claim, result: JobResult): Promise<boolean> {
	return (await tx.execute(sql.raw(finishStatement(claim, result)))).rowCount === 1;
}
export async function finishJob(db: Database, claim: Claim, result: JobResult): Promise<boolean> {
	const pool = (db as Database & { $client: { query(text: string): Promise<unknown> } }).$client;
	const results = (await pool.query(`SET LOCAL statement_timeout = '5s';\n${finishStatement(claim, result)}`)) as {
		rowCount: number | null;
	}[];
	const [, finished] = results;
	if (!finished) throw Error("The finish batch returned no finish result");
	return finished.rowCount === 1;
}

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
