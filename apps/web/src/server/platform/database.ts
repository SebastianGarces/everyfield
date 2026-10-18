import "server-only";
import type { Pool, PoolClient } from "pg";
import { CommandScope } from "@everyfield/contracts/common/server";
import { accountId, sessionId, tenantId, instant } from "@everyfield/contracts/common";
import { Refusal } from "./boundary.ts";
import type { PlatformAuth } from "./auth.ts";

export async function transaction<T>(pool: Pool, body: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query("SET LOCAL statement_timeout = '5s'");
    const result = await body(tx); await tx.query("COMMIT"); return result;
  } catch (error) { await tx.query("ROLLBACK"); throw error; }
  finally { tx.release(); }
}
export async function currentScope(tx: PoolClient, auth: PlatformAuth, headers: Headers, ownerId: string) {
  const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
  if (!session) throw new Refusal("unavailable", 404);
  const owner = { kind: "plant" as const, id: tenantId.parse(ownerId) };
  const scope = await CommandScope.load(tx, sessionId.parse(session.session.id), owner, instant.parse(new Date().toISOString()), async () => {
    // Locks serialize grant revoke/lifecycle changes with this transaction's effect.
    const result = await tx.query<{ role: "owner" | "admin"; active: boolean }>(
      'SELECT role, active FROM proof_grant WHERE account_id=$1 AND owner_id=$2 AND active FOR SHARE', [session.user.id, owner.id]);
    const grant = result.rows[0]; if (!grant) return null;
    // Recheck the database session inside the mutation transaction, after locking grants.
    const live = await tx.query('SELECT id FROM auth_session WHERE id=$1 AND "expiresAt">clock_timestamp() FOR SHARE', [session.session.id]);
    if (live.rowCount !== 1) return null;
    return { accountId: accountId.parse(session.user.id), sessionId: session.session.id, sessionExpiresAt: session.session.expiresAt.toISOString(), accountActive: true,
      context: { kind: "seat", owner, role: grant.role, active: true } };
  });
  if (!scope) throw new Refusal("unavailable", 404);
  return scope;
}
