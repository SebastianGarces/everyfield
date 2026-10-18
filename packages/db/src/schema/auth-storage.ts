import "server-only";
// Supported Better Auth field mappings for the baseline's app-owned physical tables.
// WP-005 supplies credential policy, delivery and app-domain acceptance.
export const authStorage = {
  user: { modelName: "auth_user", fields: { createdAt: "created_at", updatedAt: "updated_at", emailVerified: "email_verified" } },
  account: { modelName: "auth_account", fields: { createdAt: "created_at", updatedAt: "updated_at", userId: "user_id", providerId: "provider_id", accountId: "provider_account_id", password: "password_hash", accessToken: "access_token", refreshToken: "refresh_token", idToken: "id_token", accessTokenExpiresAt: "access_token_expires_at", refreshTokenExpiresAt: "refresh_token_expires_at", scope: "provider_scope" } },
  verification: { modelName: "auth_verification", fields: { createdAt: "created_at", updatedAt: "updated_at", expiresAt: "expires_at" } },
  session: { modelName: "auth_session", cookieCache: { enabled: false }, fields: { createdAt: "created_at", updatedAt: "updated_at", userId: "user_id", expiresAt: "expires_at", ipAddress: "ip_address", userAgent: "user_agent" } },
} as const;
