import "server-only";
import { betterAuth } from "better-auth";
import { randomUUID } from "node:crypto";
import type { Database } from "@everyfield/db/client";
import { auth_user, auth_account, auth_session, auth_verification } from "@everyfield/db/tables";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { authStorage } from "@everyfield/db/auth-storage";

export function identityAuth(config: {
	db: Database;
	origin: string;
	secret: string;
	emailChange?: boolean;
	deliver: (
		user: { id: string; email: string },
		purpose: "password_reset" | "email_verification",
		token: string,
	) => Promise<void>;
}) {
	if (config.secret.length < 32) throw Error("identity_secret_required");
	return betterAuth({
		database: drizzleAdapter(config.db, {
			provider: "pg",
			schema: { auth_user, auth_account, auth_session, auth_verification },
			transaction: true,
		}),
		baseURL: config.origin,
		basePath: "/api/auth",
		secret: config.secret,
		trustedOrigins: [config.origin],
		...authStorage,
		user: { ...authStorage.user, ...(config.emailChange ? { changeEmail: { enabled: true } } : {}) },
		session: {
			...authStorage.session,
			...(config.emailChange ? { freshAge: 300 } : {}),
			expiresIn: 30 * 86400,
			updateAge: 15 * 86400,
		},
		emailAndPassword: {
			enabled: true,
			autoSignIn: false,
			minPasswordLength: 8,
			maxPasswordLength: 1024,
			resetPasswordTokenExpiresIn: 3600,
			revokeSessionsOnPasswordReset: true,
			sendResetPassword: async ({ user, token }) => config.deliver(user, "password_reset", token),
		},
		emailVerification: {
			...(config.emailChange ? { expiresIn: 86400 } : {}),
			sendOnSignUp: false,
			autoSignInAfterVerification: false,
			sendVerificationEmail: async ({ user, token }) => config.deliver(user, "email_verification", token),
		},
		advanced: { database: { generateId: () => randomUUID() }, trustedProxyHeaders: false },
		// All exposed calls pass the shared SQL budget before reaching this instance.
		rateLimit: { enabled: false },
		logger: { disabled: true },
	});
}
