import type { Pool } from 'pg';
import { z } from 'zod';
const fixture = z.strictObject({ account: z.uuid(), user: z.uuid(), email: z.email().regex(/@example\.test$/), password: z.string().min(16).max(128) });
const config = z.strictObject({ enabled: z.boolean(), environment: z.enum(['development','preview']),
  target: z.strictObject({ database: z.string().min(1), role: z.string().min(1), schema: z.string().regex(/^(wp050_|evf_fixture_)[a-f0-9]{32}$/) }),
  fixtures: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,40}$/), fixture) });
export type FixtureConfig = z.infer<typeof config>;
// Local/managed-development transport only. A trusted host adapter supplies this
// allowlist from its fresh synthetic seed. No client role/environment is accepted.
// This module is absent from the production HTTP import graph.
export function createFixtureSwitcher(db: Pool, input: FixtureConfig,
  signIn: (credentials: { email: string; password: string }) => Promise<Response>) {
  const c = config.parse(input);
  return async (command: unknown): Promise<Response> => {
    const denied = () => Response.json({ code: 'unavailable' }, { status: 404, headers: { 'cache-control': 'private, no-store' } });
    if (!c.enabled || process.env.EVERYFIELD_FIXTURES_ENABLED !== '1' || process.env.EVERYFIELD_ENVIRONMENT !== c.environment || process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') return denied();
    const parsed = z.strictObject({ fixture: z.string() }).safeParse(command);
    if (!parsed.success) return denied();
    const selected = c.fixtures[parsed.data.fixture];
    if (!selected) return denied();
    const identity = await db.query('SELECT current_database() AS database,current_user AS role,current_schema() AS schema');
    const actual = identity.rows[0];
    if (actual?.database !== c.target.database || actual?.role !== c.target.role || actual?.schema !== c.target.schema) return denied();
    const current = await db.query(`SELECT a.id FROM account a JOIN auth_user u ON u.id=a.auth_user_id
      WHERE a.id=$1 AND u.id=$2 AND u.email=$3 AND a.registration_state='active'
      AND NOT EXISTS(SELECT 1 FROM lifecycle_witness w WHERE w.kind='account' AND w.opaque_subject_id=a.id AND w.state IN ('pending_deletion','purging','purged'))`,
    [selected.account, selected.user, selected.email]);
    if (current.rowCount !== 1) return denied();
    const result = await signIn({ email: selected.email, password: selected.password });
    if (!result.ok) return denied();
    const headers = new Headers({ 'cache-control': 'private, no-store' });
    for (const cookie of result.headers.getSetCookie()) headers.append('set-cookie', cookie);
    // Never forward the auth provider's token/user body through the fixture action.
    return Response.json({ switched: true }, { headers });
  };
}
