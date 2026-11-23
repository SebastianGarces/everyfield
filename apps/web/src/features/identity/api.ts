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
import type { Outcome as Shared } from "@everyfield/contracts/common";
import { z } from "zod";

export type Outcome<T> = Shared<T, z.infer<typeof identityError>["code"], { retryAt: string | null }>;
export type Refusal = Exclude<Outcome<unknown>, { status: "ok" }>;

const signedInResult = z.strictObject({ status: z.literal("signed_in"), returnTo: z.string().nullable() });

const UNAVAILABLE = { status: "refused", code: "unavailable", retryAt: null } as const;

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
		return { status: "lost" };
	}
	const raw: unknown = await response.json().catch(() => null);
	if (response.ok) {
		const value = schema.safeParse(raw);
		return value.success ? { status: "ok", value: value.data } : UNAVAILABLE;
	}
	const error = identityError.safeParse(raw);
	if (!error.success) return UNAVAILABLE;
	return {
		status: "refused",
		code: error.data.code,
		retryAt: error.data.code === "rate_limited" ? error.data.details.retryAt : null,
	};
}

export const identityApi = {
	registrationOptions: () => call("registration-options", registrationOptions),
	signIn: (input: { email: string; password: string; returnTo?: string }) =>
		call("sign-in/email", signedInResult, input),
	register: (input: Record<string, string>) => call("register", registrationResult, input),
	requestPasswordRecovery: (email: string) => call("request-password-reset", passwordRecoveryResult, { email }),
	sendVerification: (email: string) => call("send-verification-email", passwordRecoveryResult, { email }),
	recoverPassword: (input: { newPassword: string; confirmPassword: string }) =>
		call("reset-password", recoveryCompletedResult, input),
	verifyEmail: () => call("verify-email", emailVerifiedResult, {}),
	signOut: () => call("sign-out", signedOutResult, {}),
	revokeOtherSessions: () => call("revoke-other-sessions", otherSessionsRevokedResult, {}),
};

export function loadPage(path: string): void {
	window.location.assign(new URL(path, window.location.origin));
}
