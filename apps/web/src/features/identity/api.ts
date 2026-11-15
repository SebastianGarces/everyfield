import {
	emailVerifiedResult,
	identityError,
	otherSessionsRevokedResult,
	passwordRecoveryResult,
	recoveryCompletedResult,
	registrationOptions,
	registrationResult,
	signedOutResult,
} from "@everyfield/contracts/identity";
import { z } from "zod";

export type Refusal = { code: z.infer<typeof identityError>["code"]; retryAt: string | null };
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: Refusal };

const signedInResult = z.strictObject({ status: z.literal("signed_in"), returnTo: z.string().nullable() });

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
	registrationOptions: () => call("registration-options", registrationOptions),
	signIn: (input: { email: string; password: string; returnTo?: string }) =>
		call("sign-in/email", signedInResult, input),
	register: (input: Record<string, string>) => call("register", registrationResult, input),
	requestPasswordRecovery: (email: string) => call("request-password-reset", passwordRecoveryResult, { email }),
	sendVerification: (email: string) => call("send-verification-email", passwordRecoveryResult, { email }),
	recoverPassword: (input: { proof: string; newPassword: string; confirmPassword: string }) =>
		call("reset-password", recoveryCompletedResult, input),
	verifyEmail: (proof: string) => call("verify-email", emailVerifiedResult, { proof }),
	signOut: () => call("sign-out", signedOutResult, {}),
	revokeOtherSessions: () => call("revoke-other-sessions", otherSessionsRevokedResult, {}),
};

export function loadPage(path: string): void {
	window.location.assign(new URL(path, window.location.origin));
}
