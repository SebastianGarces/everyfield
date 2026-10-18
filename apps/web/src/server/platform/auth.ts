import "server-only";
import { betterAuth } from "better-auth";
import { randomUUID } from "node:crypto";
import type { Database } from "@everyfield/db/client";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { authStorage } from "@everyfield/db/auth-storage";
import { auth_user, auth_account, auth_session, auth_verification } from "./tables.ts";

// WP-005 supplies application routes, domain acceptance and security outcome writes.
// A supported credential change cannot be rolled back by a failed app audit write.
export function createPlatformAuth(
	db: Database,
	origin: string,
	secret: string,
	resetDelivery: (message: { user: { id: string }; token: string; url: string }) => Promise<void>,
	basePath = "/api/auth",
) {
	if (secret.length < 32) throw new Error("Auth secret required");
	return betterAuth({
		database: drizzleAdapter(db, {
			provider: "pg",
			schema: { auth_user, auth_account, auth_session, auth_verification },
			transaction: true,
		}),
		baseURL: origin,
		basePath,
		secret,
		trustedOrigins: [new URL(origin).origin],
		...authStorage,
		session: { ...authStorage.session, expiresIn: 30 * 86400, updateAge: 15 * 86400, cookieCache: { enabled: false } },
		emailAndPassword: {
			enabled: true,
			minPasswordLength: 8,
			maxPasswordLength: 1024,
			resetPasswordTokenExpiresIn: 3600,
			revokeSessionsOnPasswordReset: true,
			sendResetPassword: resetDelivery,
		},
		advanced: { database: { generateId: () => randomUUID() }, trustedProxyHeaders: false },
		// The proof never logs credentials or reset delivery. Production mail is downstream.
		logger: { disabled: true },
	});
}
export type PlatformAuth = ReturnType<typeof createPlatformAuth>;
