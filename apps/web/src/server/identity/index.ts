import 'server-only';
import { createHmac } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import { createIdentityService, trustedIdentityIp } from '@everyfield/domain/identity';
import { createMailService } from '../jobs/mail';

let service: ReturnType<typeof createIdentityService> | undefined;
export function identityHandler(request: Request): Promise<Response> {
  // Explicit credentials and keys are required. Never fall back to the operator DATABASE_URL.
  const env = z.object({ IDENTITY_DATABASE_URL: z.string().min(1), IDENTITY_AUTH_DATABASE_URL: z.string().min(1),
    IDENTITY_ORIGIN: z.url(), IDENTITY_SECRET: z.string().min(32),
    IDENTITY_MAIL_KEY: z.string().regex(/^[a-f0-9]{64}$/), IDENTITY_ADDRESS_KEY: z.string().regex(/^[a-f0-9]{64}$/),
    IDENTITY_MAIL_FROM: z.email() }).safeParse(process.env);
  if (!env.success) return Promise.resolve(Response.json({ code: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } }));
  if (!service) {
    const v = env.data, db = new pg.Pool({ connectionString: v.IDENTITY_DATABASE_URL, max: 5 }),
      authDb = new pg.Pool({ connectionString: v.IDENTITY_AUTH_DATABASE_URL, max: 5 });
    const mail = createMailService({ db, encryptionKey: Buffer.from(v.IDENTITY_MAIL_KEY, 'hex'), addressKey: Buffer.from(v.IDENTITY_ADDRESS_KEY, 'hex'), from: v.IDENTITY_MAIL_FROM,
      authorize: async (tx, m) => {
        if (m.recipient !== m.tenant || !['password_reset', 'email_verification'].includes(m.purpose)) return false;
        const row = await tx.query('SELECT auth_user_id FROM account WHERE id=$1', [m.tenant]);
        if (!row.rowCount) return false;
        const user = await authDb.query('SELECT email FROM auth_user WHERE id=$1', [row.rows[0]?.auth_user_id]);
        return user.rowCount === 1 && createHmac('sha256',Buffer.from(v.IDENTITY_ADDRESS_KEY,'hex')).update(z.email().parse(user.rows[0]?.email)).digest('hex') === m.addressHash;
      },
      // This mount issues intents only. WP-031 owns dispatch; no real provider is configured here.
      transport: { async send() { return { kind: 'refused', retryable: true }; }, async lookup() { return { kind: 'unknown' }; } },
    });
    service = createIdentityService({ db, authDb, origin: v.IDENTITY_ORIGIN, secret: v.IDENTITY_SECRET,
      trustedIp: request => trustedIdentityIp(request, process.env.VERCEL === '1'),
      enqueueMail: (tx, m) => mail.enqueue(tx, { owner: { kind: 'account', id: m.accountId }, purpose: m.purpose,
        logicalKey: m.logicalKey, recipient: m.accountId, address: m.address, content: { subject: m.subject, text: m.text },
        operation: null, notice: null, eligibleAt: new Date().toISOString() }),
      diagnostic: value => console.error(JSON.stringify({ component: 'identity', ...value })),
    });
  }
  return service.handle(request);
}
