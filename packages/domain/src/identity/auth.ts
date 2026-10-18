import 'server-only';
import { betterAuth } from 'better-auth';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { authStorage } from '@everyfield/db/schema';

export function identityAuth(config: { db: Pool; origin: string; secret: string;
  deliver: (user: { id: string; email: string }, purpose: 'password_reset' | 'email_verification', token: string) => Promise<void> }) {
  if (config.secret.length < 32) throw Error('identity_secret_required');
  return betterAuth({
    database: config.db, baseURL: config.origin, basePath: '/api/auth', secret: config.secret,
    trustedOrigins: [config.origin],
    ...authStorage,
    session: { ...authStorage.session, expiresIn: 30 * 86400, updateAge: 15 * 86400 },
    emailAndPassword: { enabled: true, autoSignIn: false, minPasswordLength: 8, maxPasswordLength: 1024,
      resetPasswordTokenExpiresIn: 3600, revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }) => config.deliver(user, 'password_reset', token) },
    emailVerification: { sendOnSignUp: false, autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, token }) => config.deliver(user, 'email_verification', token) },
    advanced: { database: { generateId: () => randomUUID() }, trustedProxyHeaders: false },
    // All exposed calls pass the shared SQL budget before reaching this instance.
    rateLimit: { enabled: false }, logger: { disabled: true },
  });
}
