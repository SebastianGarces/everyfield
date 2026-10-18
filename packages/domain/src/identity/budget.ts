import 'server-only';
import { createHmac, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export class IdentityRefusal extends Error {
  constructor(readonly code: 'invalid_input' | 'invalid_credentials' | 'invalid_proof' | 'unauthenticated' | 'unavailable' | 'admission_unavailable' | 'rate_limited' | 'origin_denied' | 'idempotency_conflict', readonly status: number) { super(code); }
}
export async function transaction<T>(db: Pool, body: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try { await tx.query('BEGIN'); await tx.query("SET LOCAL statement_timeout='10s'"); const value = await body(tx); await tx.query('COMMIT'); return value; }
  catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
}
export function attemptBudget(db: Pool, key: string) {
  const hash = (value: string) => createHmac('sha256', key).update(value).digest('hex');
  async function reserve(kind: 'login' | 'reset' | 'registration', identifier: string | null, ip: string | null) {
    if (kind === 'registration' && !ip) throw new IdentityRefusal('admission_unavailable', 503);
    const identifierHash = identifier ? hash(identifier) : null, ipHash = ip ? hash(ip) : null;
    const [minutes, identifierLimit, ipLimit] = kind === 'login' ? [15, 5, 20] : kind === 'reset' ? [60, 3, 10] : [60, 0, 3];
    try {
      return await transaction(db, async tx => {
        for (const axis of [identifierHash && `${kind}/id/${identifierHash}`, ipHash && `${kind}/ip/${ipHash}`].filter((v): v is string => !!v).sort()) {
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,505))', [axis]);
        }
        await tx.query('DELETE FROM admission_attempt WHERE expires_at<=clock_timestamp()');
        const counts = await tx.query<{ identifiers: number; ips: number }>(`SELECT count(*) FILTER(WHERE identifier_hash=$2 AND state<>'cleared')::int AS identifiers,
          count(*) FILTER(WHERE trusted_ip_hash=$3)::int AS ips FROM admission_attempt WHERE kind=$1
          AND reserved_at>clock_timestamp()-make_interval(mins=>$4)`, [kind, identifierHash, ipHash, minutes]);
        const count = counts.rows[0];
        if (!count) throw new Error('budget_unavailable');
        if ((identifierHash && identifierLimit && count.identifiers >= identifierLimit) || (ipHash && count.ips >= ipLimit)) throw new IdentityRefusal('rate_limited', 429);
        const id = randomUUID();
        await tx.query(`INSERT INTO admission_attempt(id,kind,identifier_hash,trusted_ip_hash,reserved_at,state,expires_at)
          VALUES($1,$2,$3,$4,clock_timestamp(),'reserved',clock_timestamp()+interval '24 hours')`, [id, kind, identifierHash, ipHash]);
        return { id, kind, identifierHash };
      });
    } catch (error) { if (error instanceof IdentityRefusal) throw error; throw new IdentityRefusal('admission_unavailable', 503); }
  }
  async function finish(reservation: Awaited<ReturnType<typeof reserve>>, success: boolean) {
    await transaction(db, async tx => {
      const r = reservation;
      if (success && r.kind === 'login') {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,505))', [`${r.kind}/id/${r.identifierHash}`]);
        // In-flight attempts keep their reservation. Another request's later failure is not cleared.
        await tx.query(`UPDATE admission_attempt SET state='cleared' WHERE kind=$1 AND identifier_hash=$2 AND state='failed'
          AND reserved_at>clock_timestamp()-interval '15 minutes'`, [r.kind, r.identifierHash]);
      }
      await tx.query('UPDATE admission_attempt SET state=$2,trusted_ip_hash=CASE WHEN $3 THEN NULL ELSE trusted_ip_hash END WHERE id=$1', [r.id, success && r.kind === 'login' ? 'cleared' : r.kind === 'login' ? 'failed' : 'counted', success && r.kind === 'login']);
    });
  }
  async function rememberRegistration(id: string, email: string, kind: string, intent: string) {
    await db.query("UPDATE admission_attempt SET identifier_hash=$2,workspace_key=$3 WHERE id=$1 AND kind='registration'",
      [id, hash(email), JSON.stringify({kind,intent})]);
  }
  async function registrationIntent(email: string, createdAt: Date) {
    const row = await db.query("SELECT workspace_key FROM admission_attempt WHERE kind='registration' AND identifier_hash=$1 AND reserved_at<=$2 AND workspace_key IS NOT NULL ORDER BY reserved_at DESC LIMIT 1", [hash(email), createdAt]);
    return row.rows[0]?.workspace_key;
  }
  return { reserve, finish, rememberRegistration, registrationIntent };
}
