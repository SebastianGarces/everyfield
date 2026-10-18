import { z } from "zod";
import {
	accountId,
	correlationId,
	defineSafeError,
	eventId,
	operationId,
	owner,
	recordId,
	safeError,
	sessionId,
} from "../common/values.ts";
import { instant } from "../common/time.ts";
import { accountKind } from "./requests.ts";

export const identityError = z.discriminatedUnion("code", [
	...safeError.options,
	defineSafeError("unauthenticated", {}, "never"),
	defineSafeError("invalid_credentials", {}, "never"),
	defineSafeError("invalid_proof", {}, "never"),
	defineSafeError("rate_limited", { retryAt: instant }, "same_request"),
	defineSafeError("admission_unavailable", {}, "same_request"),
	defineSafeError("idempotency_conflict", {}, "never"),
]);
// Mail failure and unknown/missing accounts have the same public recovery result.
export const passwordRecoveryResult = z.strictObject({ status: z.literal("accepted") });
export const recoveryCompletedResult = z.strictObject({
	status: z.literal("password_reset"),
	next: z.literal("sign_in"),
});
export const emailVerifiedResult = z.strictObject({ status: z.literal("email_verified") });
export const signedOutResult = z.strictObject({ status: z.literal("signed_out") });
export const otherSessionsRevokedResult = z.strictObject({ status: z.literal("other_sessions_revoked") });
export const registrationResult = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("continue_identity_proof") }),
	z.strictObject({ status: z.literal("pending_domain"), accountId }),
	z.strictObject({ status: z.literal("active"), accountId, operationId }),
]);
// Only actual native self authentication may produce these bounded projections.
export const registrationStatus = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("pending_domain"), accountId }),
	z.strictObject({ status: z.literal("active"), accountId }),
]);
export const sessionResult = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("unauthenticated") }),
	z.strictObject({ status: z.literal("pending_domain"), accountId, sessionId, expiresAt: instant }),
	z.strictObject({ status: z.literal("active"), accountId, sessionId, expiresAt: instant }),
]);
export type SessionResult = z.infer<typeof sessionResult>;

export const registrationContext = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("unavailable") }),
	z.strictObject({
		status: z.literal("invitation"),
		kind: accountKind,
		organizationName: z.string().min(1).max(200).nullable(),
	}),
]);
export const registrationOptions = z.strictObject({
	mode: z.enum(["open", "invitation_only", "closed"]),
	kinds: z.array(accountKind),
	invitation: registrationContext,
});

// Adapter-only outcome metadata. The supported credential call happens first.
// Reporting failure preserves the committed credential result; unknown calls are
// investigated without a saved password, cookie, reset token or blind replay.
export const credentialOutcome = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("refused"), correlationId }),
	z.strictObject({ status: z.literal("unknown"), correlationId }),
	z.strictObject({
		status: z.literal("succeeded"),
		correlationId,
		accountId,
		action: z.enum(["password_reset", "password_changed", "email_changed"]),
		reporting: z.discriminatedUnion("status", [
			z.strictObject({ status: z.literal("recorded"), eventId, mailIntentId: recordId }),
			z.strictObject({ status: z.literal("pending_investigation") }),
		]),
	}),
]);
export type CredentialOutcome = z.infer<typeof credentialOutcome>;

// Removed authors retain no login identifier, credential or inferred ownership.
export const retainedAttribution = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("account"), accountId }),
	z.strictObject({ kind: z.literal("removed_account") }),
]);
export const retainedHistoryReference = z.strictObject({
	owner: owner.transform((value, ctx) => {
		if (value.kind === "plant" || value.kind === "organization") return value;
		ctx.addIssue({ code: "custom", message: "Expected a plant or organization owner" });
		return z.NEVER;
	}),
	attribution: retainedAttribution,
});
// An incomplete purge has no completion timestamp. These are status contracts,
// not permission to purge, an ownership classifier or a physical erasure claim.
export const identityPurgeStatus = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("purging") }),
	z
		.strictObject({ status: z.literal("purged"), livePurgedAt: instant, copyExpiresAt: instant })
		.refine(
			(v) =>
				Date.parse(v.copyExpiresAt) >= Date.parse(v.livePurgedAt) &&
				Date.parse(v.copyExpiresAt) <= Date.parse(v.livePurgedAt) + 7 * 86400_000,
		),
]);
