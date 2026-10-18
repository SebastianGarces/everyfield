import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { inTransaction } from './atomic.ts';
export const operatorOperation = z.enum(['ops.readiness', 'jobs.inspectLag', 'security.inspectAudit', 'ops.errorCorrelation']);
export type OperatorOperation = z.infer<typeof operatorOperation>;
export const operatorScope = z.strictObject({ principal: z.uuid(), tenant: z.uuid(),
  purpose: z.enum(['incident', 'recovery_drill', 'delivery_reconciliation']), operations: z.array(operatorOperation).min(1).max(4), expiresAt: z.date() });
export type OperatorScope = z.infer<typeof operatorScope>;
// Trusted host/session adapter, never a request DTO or tenant-role assertion. It must
// lock/recheck its independently established immutable principal and exact grant.
export type AuthenticateOperator = (tx: PoolClient) => Promise<OperatorScope | null>;
export function operatorOperations(db: Pool, authenticate: AuthenticateOperator) {
  async function run<T>(operation: OperatorOperation, read: (tx: PoolClient, scope: OperatorScope) => Promise<T>) {
    return inTransaction(db, async tx => {
      const found = await authenticate(tx);
      if (!found) throw Error('unavailable');
      const scope = operatorScope.parse(found);
      const r = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const now = z.date().parse(r.rows[0]?.now);
      if (scope.expiresAt <= now || !scope.operations.includes(operation)) throw Error('unavailable');
      const result = await read(tx, scope);
      await tx.query(`INSERT INTO event(tenant_id,target_record_id,actor_id,kind,occurred_at,recorded_at,event_key,action)
        VALUES($1,$1,$2,'read',clock_timestamp(),clock_timestamp(),$3,$4)`,
      [scope.tenant, scope.principal, randomUUID(), operation === 'security.inspectAudit' ? 'security.audit_inspected' : 'security.operator_accessed']);
      return result;
    });
  }

  return {
    withReadiness<T>(read: () => Promise<T>) { return run('ops.readiness', () => read()); },
    inspectLag() {
      return run('jobs.inspectLag', async (tx, scope) => {
        const r = await tx.query(`SELECT kind,state,count(*)::int AS count,
          greatest(0,extract(epoch FROM clock_timestamp()-min(eligible_at)))::float8 AS lag_seconds
          FROM job WHERE tenant_id=$1 GROUP BY kind,state ORDER BY kind,state LIMIT 80`, [scope.tenant]);
        return z.array(z.object({ kind: z.enum(['mail','notification','digest','assessment','reference_generation','feedback_publication','object_cleanup','lifecycle_purge','assistant_turn','document_render']),
          state: z.enum(['ready','claimed','retry_wait','reconcile','succeeded','failed','cancelled','superseded']), count: z.number().int(), lag_seconds: z.number().nonnegative() })).parse(r.rows);
      });
    },
    inspectAudit(input: unknown) {
      const v = z.strictObject({ target: z.uuid(), limit: z.number().int().min(1).max(100).default(25) }).parse(input);
      return run('security.inspectAudit', async (tx, scope) => {
        // No body, diff, reason, contact values, raw error, model usage or care tables.
        const r = await tx.query(`SELECT id,action,operation_id,effect_id,occurred_at,before_revision::text,after_revision::text
          FROM event WHERE tenant_id=$1 AND target_record_id=$2 AND action IS NOT NULL
          ORDER BY occurred_at DESC,id DESC LIMIT $3`, [scope.tenant, v.target, v.limit]);
        return r.rows;
      });
    },
    errorCorrelation(input: unknown) {
      const id = z.uuid().parse(input);
      return run('ops.errorCorrelation', async (tx, scope) => {
        const r = await tx.query(`SELECT id,state,outcome,completed_at FROM operation WHERE tenant_id=$1 AND id=$2`, [scope.tenant,id]);
        return r.rows[0] ?? null;
      });
    },
  };
}
