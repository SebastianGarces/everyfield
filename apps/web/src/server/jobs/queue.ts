import { and, asc, eq, isNull, or, sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import "server-only";
import { randomUUID } from "node:crypto";
import type { Database, Transaction } from "@everyfield/db/client";
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
export async function enqueueJob(tx: Transaction, input: JobInput): Promise<string> {
	const v = enqueueSchema.parse(input);
	const result = await tx
		.insert(tables.job)
		.values({
			tenant_id: v.tenant,
			kind: v.kind,
			subject_record_id: v.subject,
			producer_key: v.key,
			source_revision: sql`${v.revision}`,
			state: "ready",
			eligible_at: sql`${v.eligibleAt}`,
			attempt_count: 0,
			max_attempts: v.maxAttempts,
			claim_generation: "0",
		})
		.onConflictDoNothing()
		.returning({ id: tables.job.id });
	if (result[0]) return result[0].id;
	const old = await tx
		.select({
			id: tables.job.id,
			tenant_id: tables.job.tenant_id,
			source_revision: sql<string>`(${tables.job.source_revision})::text`,
		})
		.from(tables.job)
		.where(
			and(
				and(eq(tables.job.kind, v.kind), eq(tables.job.producer_key, v.key)),
				or(
					and(eq(tables.job.subject_record_id, sql`${v.subject}`), eq(tables.job.tenant_id, v.tenant)),
					and(
						and(isNull(tables.job.subject_record_id), isNull(sql<string>`(${v.subject})::uuid`)),
						eq(tables.job.tenant_id, v.tenant),
					),
				),
			),
		);
	const row = old[0];
	if (!row || row.tenant_id !== v.tenant || row.source_revision !== v.revision)
		throw new Error("job_identity_conflict");
	return row.id;
}

// The duration override applies to ordinary jobs; assessment claims always use 120 seconds.
export async function claimDue(
	db: Database,
	kinds: readonly JobKind[],
	limit = 1,
	leaseSeconds = DEFAULT_LEASE_SECONDS,
): Promise<Claim[]> {
	const config = z
		.object({ kinds: z.array(jobKind).min(1).max(10), limit: z.number().int().min(1).max(100), lease: leaseDuration })
		.parse({ kinds, limit, lease: leaseSeconds });
	return transaction(db, async (tx) => {
		const result = await tx.execute(sql`WITH due AS (
      SELECT id FROM job WHERE kind=ANY(${sql.param(config.kinds)}::text[]) AND state IN ('ready','retry_wait')
      AND attempt_count<max_attempts AND eligible_at<=clock_timestamp()
      AND (next_attempt_at IS NULL OR next_attempt_at<=clock_timestamp())
      ORDER BY eligible_at,id FOR UPDATE SKIP LOCKED LIMIT ${config.limit}
    ) UPDATE job j SET state='claimed',attempt_count=attempt_count+1,claim_generation=claim_generation+1,
      lease_owner=${randomUUID()},lease_until=clock_timestamp()+make_interval(secs=>CASE WHEN j.kind='assessment' THEN ${ASSESSMENT_LEASE_SECONDS}::int ELSE ${config.lease}::int END),revision=revision+1
      FROM due WHERE j.id=due.id RETURNING j.*`);
		return result.rows.map((row) => claimSchema.parse(row));
	});
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
		const rows = await tx.execute(sql`WITH expired AS (SELECT id FROM job WHERE state='claimed'
      AND lease_until<=clock_timestamp() ORDER BY lease_until,id FOR UPDATE SKIP LOCKED LIMIT ${limit})
      UPDATE job j SET state=CASE WHEN checkpoint_key='external' THEN 'reconcile'
      WHEN attempt_count>=max_attempts THEN 'failed' ELSE 'retry_wait' END,
      error_code='lease_expired',lease_owner=NULL,lease_until=NULL,
      next_attempt_at=clock_timestamp()+interval '5 minutes',
      finished_at=CASE WHEN checkpoint_key IS DISTINCT FROM 'external' AND attempt_count>=max_attempts THEN clock_timestamp() ELSE NULL END,
      claim_generation=claim_generation+1,revision=revision+1
      FROM expired WHERE j.id=expired.id RETURNING j.id,j.kind,j.subject_record_id,j.state`);
		for (const row of rows.rows) {
			if (row.kind === "mail" && row.state === "reconcile") {
				await tx
					.update(tables.mail)
					.set({ state: "unknown" })
					.where(and(eq(tables.mail.id, sql`${row.subject_record_id}`), eq(tables.mail.state, "dispatched")));
				await tx.execute(sql`UPDATE mail_attempt a SET outcome='unknown',safe_error='lease_expired',completed_at=clock_timestamp()
          FROM mail_request_member m WHERE m.mail_id=${row.subject_record_id} AND m.request_id=a.request_id AND a.outcome='in_flight'`);
			}
		}
		return rows.rowCount ?? 0;
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
export async function jobVisibility(db: Database) {
	const r = await db
		.select({
			kind: tables.job.kind,
			state: tables.job.state,
			count: sql<number>`(count(*))::int`,
			lag_seconds: sql<number>`(greatest(0, extract(epoch FROM (clock_timestamp() - min(${tables.job.eligible_at})))))::float8`,
		})
		.from(tables.job)
		.groupBy(tables.job.kind, tables.job.state)
		.orderBy(asc(tables.job.kind), asc(tables.job.state));
	return z.array(z.object({ kind: jobKind, state: z.string(), count: z.number(), lag_seconds: z.number() })).parse(r);
}

// Owed-tail scans commit each processed page and cursor together. No provider work here.
export async function scanPage(
	tx: Transaction,
	claim: Claim,
	config: {
		size: number;
		load: (tx: Transaction, after: string | null, limit: number) => Promise<string[]>;
		process: (tx: Transaction, id: string) => Promise<void>;
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
