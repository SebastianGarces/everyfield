import * as tables from "./tables.ts";
import { and, eq, gt, sql } from "@everyfield/db/query";
import "server-only";
import { randomUUID } from "node:crypto";
import type { Database } from "@everyfield/db/client";
import { transaction } from "./database.ts";

export type Claim = { id: string; generation: string; worker: string; subject: string; revision: string };
// One bounded claim per invocation. A missed wake never removes the durable row.
export async function claimJob(db: Database): Promise<Claim | null> {
  const worker = randomUUID();
  return transaction(db, async tx => {
    const result = await tx.execute<{ id: string; generation: string; subject: string; revision: string }>(sql`
      WITH candidate AS (
        SELECT id FROM proof_job WHERE kind='document_render' AND attempts<3
        AND (state IN ('ready','retry_wait') OR (state='claimed' AND lease_until<clock_timestamp()))
        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE proof_job j SET state='claimed',generation=generation+1,worker=${sql.param(worker)},
        lease_until=clock_timestamp()+interval '2 seconds',attempts=attempts+1
      FROM candidate c WHERE j.id=c.id
      RETURNING j.id,j.generation::text,j.subject,j.revision::text`);
    const row = result.rows[0]; return row ? { ...row, worker } : null;
  });
}
export async function publishJob(db: Database, claim: Claim): Promise<boolean> {
  return transaction(db, async tx => {
    const subject = await tx.select({ "revision": tables.proof_subject.revision }).from(tables.proof_subject).where(and(and(eq(tables.proof_subject.id, claim.subject), tables.proof_subject.active), eq(tables.proof_subject.revision, claim.revision))).for("share");
    if (subject.length !== 1) return false;
    const result = await tx.update(tables.proof_job).set({ "state": "succeeded", "checkpoint": "rendered" }).where(and(and(and(and(eq(tables.proof_job.id, claim.id), eq(tables.proof_job.generation, claim.generation)), eq(tables.proof_job.worker, claim.worker)), eq(tables.proof_job.state, "claimed")), gt(tables.proof_job.lease_until, sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value))))).returning({ "id": tables.proof_job.id });
    if (result.length !== 1) return false;
    await tx.insert(tables.proof_job_receipt).values({ "job_id": claim.id }); return true;
  });
}
// Unknown provider acceptance is deliberately never eligible for claimJob.
export async function reconcileJob(db: Database, claim: Claim): Promise<boolean> {
  const result = await db.update(tables.proof_job).set({ "state": "reconcile" }).where(and(and(and(and(eq(tables.proof_job.id, claim.id), eq(tables.proof_job.generation, claim.generation)), eq(tables.proof_job.worker, claim.worker)), eq(tables.proof_job.state, "claimed")), gt(tables.proof_job.lease_until, sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)))));
  return result.rowCount === 1;
}
