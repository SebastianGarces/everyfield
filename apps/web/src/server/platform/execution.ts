import "server-only";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { transaction } from "./database.ts";

export type Claim = { id: string; generation: string; worker: string; subject: string; revision: string };
// One bounded claim per invocation. A missed wake never removes the durable row.
export async function claimJob(db: Pool): Promise<Claim | null> {
  const worker = randomUUID();
  return transaction(db, async tx => {
    const result = await tx.query<{ id: string; generation: string; subject: string; revision: string }>(`
      WITH candidate AS (
        SELECT id FROM proof_job WHERE kind='document_render' AND attempts<3
        AND (state IN ('ready','retry_wait') OR (state='claimed' AND lease_until<clock_timestamp()))
        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE proof_job j SET state='claimed',generation=generation+1,worker=$1,
        lease_until=clock_timestamp()+interval '2 seconds',attempts=attempts+1
      FROM candidate c WHERE j.id=c.id
      RETURNING j.id,j.generation::text,j.subject,j.revision::text`, [worker]);
    const row = result.rows[0]; return row ? { ...row, worker } : null;
  });
}
export async function publishJob(db: Pool, claim: Claim): Promise<boolean> {
  return transaction(db, async tx => {
    const subject = await tx.query('SELECT revision FROM proof_subject WHERE id=$1 AND active AND revision=$2 FOR SHARE', [claim.subject, claim.revision]);
    if (subject.rowCount !== 1) return false;
    const result = await tx.query(`UPDATE proof_job SET state='succeeded',checkpoint='rendered'
      WHERE id=$1 AND generation=$2 AND worker=$3 AND state='claimed' AND lease_until>clock_timestamp() RETURNING id`, [claim.id, claim.generation, claim.worker]);
    if (result.rowCount !== 1) return false;
    await tx.query('INSERT INTO proof_job_receipt(job_id) VALUES($1)', [claim.id]); return true;
  });
}
// Unknown provider acceptance is deliberately never eligible for claimJob.
export async function reconcileJob(db: Pool, claim: Claim): Promise<boolean> {
  const result = await db.query(`UPDATE proof_job SET state='reconcile' WHERE id=$1 AND generation=$2 AND worker=$3 AND state='claimed' AND lease_until>clock_timestamp()`, [claim.id, claim.generation, claim.worker]);
  return result.rowCount === 1;
}
