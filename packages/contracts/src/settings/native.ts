import { z } from "zod";
import { recordId, revision, sessionId, owner } from "../common/values.ts";
import { instant, timeZone } from "../common/time.ts";
import { commandEnvelope } from "../common/transaction.ts";
import { normalizedEmail } from "../identity/requests.ts";

import { timezonePreference } from "./values.ts";
export { changePasswordRequest } from "../identity/requests.ts";
export { retainedHistoryReference, retainedAttribution, credentialOutcome } from "../identity/results.ts";

// Native auth adapter only. Fresh own identity/mailbox proof and authenticated
// proof-owner matching are checked by Better Auth, never a durable command.
export const requestEmailChange = z.strictObject({ newEmail: normalizedEmail });
export const confirmEmailChange = z.strictObject({ proof: z.string().min(1).max(4096) });
export const deletionSubject = owner.transform((value, ctx) => {
	if (value.kind === "account" || value.kind === "plant") return value;
	ctx.addIssue({ code: "custom", message: "Expected account or plant deletion subject" });
	return z.NEVER;
});
const deletionRequest = {
	subject: deletionSubject,
	requestId: recordId,
	revision,
	requestedAt: instant,
	cancelUntil: instant,
};
export const deletionStatus = z
	.discriminatedUnion("status", [
		z.strictObject({ status: z.literal("active") }),
		z.strictObject({ status: z.literal("pending_deletion"), ...deletionRequest }),
		z.strictObject({ status: z.literal("cancelled"), ...deletionRequest, cancelledAt: instant }),
		z.strictObject({ status: z.literal("purging"), ...deletionRequest }),
		z.strictObject({ status: z.literal("purged"), ...deletionRequest, livePurgedAt: instant, copyExpiresAt: instant }),
	])
	.refine((v) => v.status === "active" || Date.parse(v.cancelUntil) === Date.parse(v.requestedAt) + 30 * 86400000, {
		message: "invalid_cancellation_deadline",
	})
	.refine((v) => v.status !== "cancelled" || (v.cancelledAt >= v.requestedAt && v.cancelledAt < v.cancelUntil), {
		message: "invalid_cancellation_time",
	})
	.refine(
		(v) =>
			v.status !== "purged" ||
			(v.livePurgedAt >= v.cancelUntil &&
				v.copyExpiresAt >= v.livePurgedAt &&
				Date.parse(v.copyExpiresAt) <= Date.parse(v.livePurgedAt) + 7 * 86400000),
		{ message: "invalid_purge_horizon" },
	);
// A restricted session binds original identity, exact request, current authority
// and purpose on the server. It cannot be used as an ordinary settings context.
export type RestrictedDeletionContext = { kind: "restricted_deletion"; handle: z.infer<typeof sessionId> };
export const getDeletionStatusRequest = z.strictObject({ subject: deletionSubject, requestId: recordId });
export const cancelDeletionRequest = commandEnvelope(getDeletionStatusRequest);
export const previewPersonalTimezoneRequest = z.strictObject({ timeZone });
export const setPersonalTimezoneRequest = commandEnvelope(
	z.strictObject({ timeZone, previewId: recordId, confirmed: z.literal(true) }),
);
// No private week/calendar/revision/existence data in the preference projection.
// WP-039's native author-only collaborator supplies its separate exact boundary
// preview before commit. It never enters this DTO, shared receipts or telemetry.
export const personalTimezonePreview = z
	.strictObject({
		previewId: recordId,
		preference: timezonePreference,
		expectedRevision: revision,
		newZone: timeZone,
		asOf: instant,
		expiresAt: instant,
	})
	.refine((v) => v.expiresAt > v.asOf);
export const personalTimezoneResult = z.strictObject({ preference: timezonePreference });
export type DeletionStatus = z.infer<typeof deletionStatus>;
