import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isIP } from 'node:net';
import type { Pool, PoolClient } from 'pg';
import { verifyPassword } from 'better-auth/crypto';
import { z } from 'zod';
import { registrationRequest, registrationStatus, sessionResult, signInRequest, passwordRecoveryRequest, recoverPasswordRequest,
  identityError, verifyEmailRequest, selfSessionRequest, resumeRegistrationRequest, safeReturn, invalidSessionReturn, registrationOptions } from '@everyfield/contracts/identity';
import { identityAuth } from './auth.ts';
import { attemptBudget, IdentityRefusal, transaction } from './budget.ts';

export type IdentityMail = { accountId: string; address: string; purpose: 'password_reset' | 'email_verification'; logicalKey: string; subject: string; text: string };
export type IdentityConfig = {
  db: Pool; authDb: Pool; origin: string; secret: string;
  // The host adapter must overwrite ingress headers. Null means no trustworthy IP.
  trustedIp: (request: Request) => string | null;
  enqueueMail: (tx: PoolClient, mail: IdentityMail) => Promise<string>;
  diagnostic: (value: { correlationId: string; outcome: 'unknown' | 'reporting_pending' | 'delivery_failed' }) => void;
  registrationMode?: 'open' | 'invitation_only' | 'closed';
};
const userRow = z.object({ id: z.uuid(), auth_user_id: z.uuid(), registration_state: z.enum(['pending_domain', 'active']), registration_kind: z.string(), registration_digest: z.string().nullable() });
const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function createIdentityService(config: IdentityConfig) {
  const origin = new URL(config.origin).origin;
  if (origin !== config.origin) throw Error('canonical_origin_required');
  const budget = attemptBudget(config.db, config.secret);
  const auth = identityAuth({ db: config.authDb, origin, secret: config.secret, deliver });

  async function account(authUser: string) {
    const rows = await config.db.query('SELECT * FROM account WHERE auth_user_id=$1', [authUser]);
    if (!rows.rowCount) return null;
    const a = userRow.parse(rows.rows[0]);
    const blocked = await config.db.query(`SELECT id FROM lifecycle_witness WHERE opaque_subject_id=$1 AND state IN ('pending_deletion','purging','purged','revoked')`, [a.id]);
    return blocked.rowCount ? null : a;
  }
  async function pending(authUser: string, kind: string, intent: string | null) {
    return transaction(config.db, async tx => {
      await tx.query(`INSERT INTO account(auth_user_id,registration_state,registration_kind,registration_digest)
        VALUES($1,'pending_domain',$2,$3) ON CONFLICT(auth_user_id) DO NOTHING`, [authUser, kind, intent]);
      const row = await tx.query('SELECT * FROM account WHERE auth_user_id=$1', [authUser]);
      return userRow.parse(row.rows[0]);
    });
  }
  async function deliver(user: { id: string; email: string }, purpose: IdentityMail['purpose'], token: string) {
    const correlationId = randomUUID();
    try {
      const a = await account(user.id);
      if (!a) throw Error('account_unavailable');
      const url = new URL(purpose === 'password_reset' ? '/reset-password' : '/verify-email', origin);
      url.searchParams.set('token', token);
      const subject = purpose === 'password_reset' ? 'Reset your password' : 'Verify your email';
      await transaction(config.db, tx => config.enqueueMail(tx, { accountId: a.id, address: user.email, purpose,
        logicalKey: `${purpose}/${digest(token)}`, subject, text: `${subject}\n\n${url.href}\n\nIf you did not request this, you can ignore this email.` }));
    } catch { config.diagnostic({ correlationId, outcome: 'delivery_failed' }); }
  }
  async function call(request: Request, path: string, body?: unknown) {
    const h = new Headers({ origin, 'content-type': 'application/json' });
    const cookie = request.headers.get('cookie'); if (cookie) h.set('cookie', cookie);
    return auth.handler(new Request(`${origin}/api/auth/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: h,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  }
  async function session(request: Request) {
    // The handler propagates renewal cookies. Never forward its user/token payload.
    const response = await call(request, 'get-session');
    if (!response.ok) throw new IdentityRefusal('unavailable', 503);
    const raw: unknown = await response.json();
    if (!raw) return { response, authUser: null, value: sessionResult.parse({ status: 'unauthenticated' }) };
    const s = z.object({ user: z.object({ id: z.uuid() }), session: z.object({ id: z.uuid(), expiresAt: z.coerce.date() }) }).parse(raw);
    const a = await account(s.user.id);
    if (!a) return { response, authUser: s.user.id, value: sessionResult.parse({ status: 'unauthenticated' }) };
    return { response, authUser: s.user.id, value: sessionResult.parse({ status: a.registration_state, accountId: a.id, sessionId: s.session.id, expiresAt: s.session.expiresAt.toISOString() }) };
  }
  function cookies(result: Response, source: Response) {
    for (const value of source.headers.getSetCookie()) result.headers.append('set-cookie', value);
    return result;
  }
  async function boundedBody(request: Request): Promise<unknown> {
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new IdentityRefusal('invalid_input', 422);
    const reader = request.body?.getReader(); if (!reader) throw new IdentityRefusal('invalid_input', 422);
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length;
      if (size > 24576) throw new IdentityRefusal('invalid_input', 413); chunks.push(part.value); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (e) { if (e instanceof IdentityRefusal) throw e; throw new IdentityRefusal('invalid_input', 422); }
    finally { await reader.cancel(); }
  }
  async function handle(request: Request): Promise<Response> {
    const correlationId = randomUUID();
    try {
      const url = new URL(request.url), path = url.pathname.replace(/^\/api\/auth\//, '');
      if (url.origin !== origin || request.headers.get('host') && request.headers.get('host') !== new URL(origin).host) throw new IdentityRefusal('origin_denied', 403);
      const gets = ['get-session', 'registration-status', 'registration-options', 'recover-invalid-session'];
      const posts = ['register', 'sign-in/email', 'sign-out', 'request-password-reset', 'reset-password', 'verify-email', 'send-verification-email', 'revoke-other-sessions', 'resume-registration'];
      if (!(request.method === 'GET' ? gets : request.method === 'POST' ? posts : []).includes(path)) return json({ code: 'unavailable' }, 404);
      if (request.method === 'GET') {
        if (path === 'registration-options') return json(registrationOptions.parse({ mode: config.registrationMode ?? 'open', kinds: ['plant_precreation', 'discovery', 'sending_church', 'sending_network'], invitation: { status: 'unavailable' } }));
        if (path === 'recover-invalid-session') return json({ next: invalidSessionReturn(url.searchParams.get('returnTo')) });
        const s = await session(request);
        if (path === 'registration-status') {
          if (s.value.status === 'unauthenticated') throw new IdentityRefusal('unauthenticated', 401);
          return cookies(json(registrationStatus.parse({ status: s.value.status, accountId: s.value.accountId })), s.response);
        }
        return cookies(json(s.value), s.response);
      }
      if (request.headers.get('origin') !== origin) throw new IdentityRefusal('origin_denied', 403);
      const suppliedIp = config.trustedIp(request), ip = suppliedIp && isIP(suppliedIp) ? suppliedIp : null;
      // Registration charges even malformed, duplicate and closed-mode submissions.
      const registration = path === 'register' ? await budget.reserve('registration', null, ip) : null;
      const input = await boundedBody(request);
      if (path === 'register') {
        const v = registrationRequest.parse(input);
        if ((config.registrationMode ?? 'open') !== 'open' || v.kind === 'invitation') return json({ status: 'continue_identity_proof' });
        const kind = v.kind === 'plant_precreation' ? 'planter' : v.kind === 'sending_network' ? 'network' : v.kind;
        const intent = digest(JSON.stringify({ kind: v.kind, name: v.name, ...('organizationName' in v ? { organizationName: v.organizationName } : {}) }));
        if (registration) await budget.rememberRegistration(registration.id, v.email, kind, intent);
        const result = await call(request, 'sign-up/email', { email: v.email, name: v.name, password: v.password });
        // No caller credential, email equality, synthetic BA ID or returned cookie grants domain access.
        // Querying this credential is safe only to create a pending, unprivileged app row.
        if (result.ok) {
          const row = await config.authDb.query('SELECT id FROM auth_user WHERE email=$1', [v.email]);
          if (row.rows[0]) { try { await pending(z.uuid().parse(row.rows[0].id), kind, intent); } catch { config.diagnostic({ correlationId, outcome: 'reporting_pending' }); } }
        } else config.diagnostic({ correlationId, outcome: 'unknown' });
        if (registration) await budget.finish(registration, true);
        return json({ status: 'continue_identity_proof' });
      }
      if (path === 'sign-in/email') {
        const v = signInRequest.parse(input), reservation = await budget.reserve('login', v.email, ip);
        const result = await call(request, path, { email: v.email, password: v.password });
        await budget.finish(reservation, result.ok);
        if (!result.ok) throw new IdentityRefusal('invalid_credentials', 401);
        const resultBody = z.object({ user: z.object({ id: z.uuid() }) }).parse(await result.json());
        // Repairs interruption after credential creation. Authentication is the proof; no grants are created.
        if (!await account(resultBody.user.id)) {
          const exists = await config.db.query('SELECT id FROM account WHERE auth_user_id=$1', [resultBody.user.id]);
          if (exists.rowCount) throw new IdentityRefusal('unauthenticated', 401);
          const native = await config.authDb.query('SELECT email,created_at FROM auth_user WHERE id=$1', [resultBody.user.id]);
          const u = z.object({email:z.email(),created_at:z.date()}).parse(native.rows[0]);
          const saved = await budget.registrationIntent(u.email,u.created_at);
          if (!saved) throw new IdentityRefusal('admission_unavailable',503);
          const intent = z.object({kind:z.enum(['planter','discovery','sending_church','network']),intent:z.string().regex(/^[a-f0-9]{64}$/)}).parse(JSON.parse(saved));
          await pending(resultBody.user.id, intent.kind, intent.intent);
        }
        return cookies(json({ status: 'signed_in', returnTo: safeReturn(v.returnTo) }), result);
      }
      if (path === 'request-password-reset' || path === 'send-verification-email') {
        const v = passwordRecoveryRequest.parse(input), started = performance.now();
        const reservation = await budget.reserve('reset', v.email, ip);
        try { const result = await call(request, path, { email: v.email, ...(path === 'request-password-reset' ? { redirectTo: `${origin}/reset-password` } : { callbackURL: '/' }) }); if (!result.ok) config.diagnostic({ correlationId, outcome: 'delivery_failed' }); }
        catch { config.diagnostic({ correlationId, outcome: 'delivery_failed' }); }
        await budget.finish(reservation, true);
        // Fixed response floor bounds identifier/provider timing in the same public latency class.
        await new Promise(resolve => setTimeout(resolve, Math.max(0, 1000 - (performance.now() - started))));
        return json({ status: 'accepted' });
      }
      if (path === 'reset-password') {
        const v = recoverPasswordRequest.parse(input);
        const proof = await config.authDb.query(`SELECT value FROM auth_verification WHERE identifier=$1 AND expires_at>clock_timestamp()`, [`reset-password:${v.proof}`]);
        if (!proof.rowCount) throw new IdentityRefusal('invalid_proof', 400);
        const authUser = z.uuid().parse(proof.rows[0].value), a = await account(authUser);
        if (!a) throw new IdentityRefusal('invalid_proof', 400);
        const credential = await config.authDb.query("SELECT password_hash FROM auth_account WHERE user_id=$1 AND provider_id='credential'", [authUser]);
        const hash = z.string().parse(credential.rows[0]?.password_hash);
        if (await verifyPassword({ hash, password: v.newPassword })) throw new IdentityRefusal('invalid_input', 422);
        // A durable content-free attempt survives a failure to append the later outcome.
        await event(a.id, correlationId, 'identity.credential_observed');
        let result: Response;
        try { result = await call(request, path, { token: v.proof, newPassword: v.newPassword }); }
        catch { config.diagnostic({ correlationId, outcome: 'unknown' }); throw new IdentityRefusal('unavailable', 503); }
        if (!result.ok) throw new IdentityRefusal('invalid_proof', 400);
        try {
          const user = await config.authDb.query('SELECT email FROM auth_user WHERE id=$1', [authUser]);
          await transaction(config.db, async tx => {
            await event(a.id, `${correlationId}/success`, 'identity.credential_changed', tx);
            await config.enqueueMail(tx, { accountId: a.id, address: z.email().parse(user.rows[0]?.email), purpose: 'password_reset',
              logicalKey: `password_reset/outcome/${correlationId}`, subject: 'Your password was reset', text: 'Your EveryField password was reset. Sign in with your new password. If this was not you, request password recovery.' });
          });
        } catch { config.diagnostic({ correlationId, outcome: 'reporting_pending' }); }
        return json({ status: 'password_reset', next: 'sign_in' });
      }
      if (path === 'verify-email') {
        const v = verifyEmailRequest.parse(input), response = await call(request, `verify-email?token=${encodeURIComponent(v.proof)}`);
        if (!response.ok) throw new IdentityRefusal('invalid_proof', 400);
        return json({ status: 'email_verified' });
      }
      if (path === 'sign-out') {
        selfSessionRequest.parse(input);
        const response = await call(request, path, {});
        if (!response.ok) throw new IdentityRefusal('unavailable', 503);
        return cookies(json({ status: 'signed_out' }), response);
      }
      const s = await session(request);
      if (s.value.status === 'unauthenticated') throw new IdentityRefusal('unauthenticated', 401);
      if (path === 'revoke-other-sessions') {
        selfSessionRequest.parse(input);
        const response = await call(request, path, {});
        if (!response.ok) throw new IdentityRefusal('unauthenticated', 401);
        return cookies(json({ status: 'other_sessions_revoked' }), s.response);
      }
      const v = resumeRegistrationRequest.parse(input);
      // WP-008/009 supply invitation/tenant acceptance. This adapter resumes self only.
      if (v.invitationProof) throw new IdentityRefusal('unavailable', 503);
      return cookies(json(registrationStatus.parse({ status: s.value.status, accountId: s.value.accountId })), s.response);
    } catch (error) {
      const refusal = error instanceof IdentityRefusal ? error : error instanceof z.ZodError ? new IdentityRefusal('invalid_input', 422) : new IdentityRefusal('unavailable', 503);
      if (refusal.code === 'unavailable') config.diagnostic({ correlationId, outcome: 'unknown' });
      const code = refusal.code === 'origin_denied' ? 'access_denied' : refusal.code;
      return json(identityError.parse({ code, details: code === 'rate_limited' ? { retryAt: new Date(Date.now()+3600_000).toISOString() } : {}, correlationId, retry: code === 'rate_limited' || code === 'admission_unavailable' ? 'same_request' : 'never' }), refusal.status);
    }
  }
  async function event(id: string, key: string, action: 'identity.credential_observed' | 'identity.credential_changed', tx?: PoolClient) {
    const result = await (tx ?? config.db).query(`INSERT INTO event(tenant_id,target_record_id,actor_id,kind,occurred_at,recorded_at,event_key,action)
      VALUES($1,$1,$1,'outcome',clock_timestamp(),clock_timestamp(),$2,$3) RETURNING id`, [id, key, action]);
    return z.uuid().parse(result.rows[0]?.id);
  }
  return { handle };
}
