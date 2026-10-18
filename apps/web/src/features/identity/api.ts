import {
	emailVerifiedResult,
	identityError,
	otherSessionsRevokedResult,
	passwordRecoveryResult,
	recoveryCompletedResult,
	registrationOptions,
	registrationResult,
	sessionResult,
	signedOutResult,
} from "@everyfield/contracts/identity";
import { z } from "zod";

// The browser boundary of the WP-005 identity API (apps/web/src/server/identity). Every response is parsed here, so
// screens see either a contract value or one identity error, never raw JSON.

/** What a screen needs from a refusal: its code and, when rate limited, the time it can try again. */
export type Refusal = { code: z.infer<typeof identityError>["code"]; retryAt: string | null };
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: Refusal };

// The adapter returns this on sign-in; it is not a shared contract because only this screen reads it.
const signedInResult = z.strictObject({ status: z.literal("signed_in"), returnTo: z.string().nullable() });

// A network failure, an unexpected status or a body outside the contract all read as "unavailable".
const UNAVAILABLE: Refusal = { code: "unavailable", retryAt: null };

async function call<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<Outcome<T>> {
	let response: Response;
	try {
		response = await fetch(`/api/auth/${path}`, {
			method: body === undefined ? "GET" : "POST",
			credentials: "same-origin",
			cache: "no-store",
			...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
		});
	} catch {
		return { ok: false, error: UNAVAILABLE };
	}
	const raw: unknown = await response.json().catch(() => null);
	if (response.ok) {
		const value = schema.safeParse(raw);
		return value.success ? { ok: true, value: value.data } : { ok: false, error: UNAVAILABLE };
	}
	const error = identityError.safeParse(raw);
	if (!error.success) return { ok: false, error: UNAVAILABLE };
	return {
		ok: false,
		error: { code: error.data.code, retryAt: error.data.code === "rate_limited" ? error.data.details.retryAt : null },
	};
}

export const identityApi = {
	session: () => call("get-session", sessionResult),
	registrationOptions: () => call("registration-options", registrationOptions),
	signIn: (input: { email: string; password: string; returnTo?: string }) =>
		call("sign-in/email", signedInResult, input),
	register: (input: Record<string, string>) => call("register", registrationResult, input),
	requestPasswordRecovery: (email: string) => call("request-password-reset", passwordRecoveryResult, { email }),
	recoverPassword: (input: { proof: string; newPassword: string; confirmPassword: string }) =>
		call("reset-password", recoveryCompletedResult, input),
	verifyEmail: (proof: string) => call("verify-email", emailVerifiedResult, { proof }),
	signOut: () => call("sign-out", signedOutResult, {}),
	revokeOtherSessions: () => call("revoke-other-sessions", otherSessionsRevokedResult, {}),
};

/**
 * Leave with a full page load. Sign-in and sign-out change the session cookie, and a full load is the one way every
 * server component reads the new cookie. Same-origin only: callers pass a local path.
 */
export function loadPage(path: string): void {
	window.location.assign(new URL(path, window.location.origin));
}
