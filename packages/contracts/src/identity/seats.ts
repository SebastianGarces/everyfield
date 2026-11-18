import { z } from "zod";
import { tenantOwner } from "../access/results.ts";
import { instant } from "../common/time.ts";
import { accountId, defineSafeError, recordId, revision, role, safeError } from "../common/values.ts";
import { commandEnvelope } from "../common/writes.ts";
import { avatarReference } from "../settings/results.ts";
import { ordinarySeatRole } from "./invitations.ts";

export const listSeatsRequest = z.strictObject({ workspace: tenantOwner, after: recordId.optional() });
const ordinaryTarget = z.strictObject({ seatId: recordId, expectedRole: ordinarySeatRole });
export const changeOrdinaryRoleRequest = commandEnvelope(ordinaryTarget.extend({ to: ordinarySeatRole }));
export const appointAdminRequest = commandEnvelope(ordinaryTarget.extend({ to: z.literal("admin") }));
export const demoteSeatRequest = commandEnvelope(
	ordinaryTarget.extend({ expectedRole: z.literal("admin"), to: z.literal("member") }),
);
export const MAX_REMOVAL_ITEMS = 2000;
const handoff = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("assign"),
		dutyId: recordId,
		expectedRevision: revision,
		recipientAccountId: accountId,
	}),
	z.strictObject({ kind: z.literal("needs_owner"), dutyId: recordId, expectedRevision: revision }),
]);
export const removeSeatRequest = commandEnvelope(
	ordinaryTarget.extend({
		handoffs: z
			.array(handoff)
			.max(MAX_REMOVAL_ITEMS)
			.refine((v) => new Set(v.map((d) => d.dutyId)).size === v.length),
	}),
);
export const readRemovalRequest = z.strictObject({ seatId: recordId });
const removalDuty = z.strictObject({
	dutyId: recordId,
	expectedRevision: revision,
	kind: z.enum(["task", "follow_up", "evaluation", "pipeline_person", "program"]),
	label: z.string().trim().min(1).max(500),
	needsRecipient: z.boolean(),
});
export const removalReviewResult = z.strictObject({
	seatId: recordId,
	expectedRevision: revision,
	expectedRole: ordinarySeatRole,
	duties: z.array(removalDuty).max(MAX_REMOVAL_ITEMS),
	recipients: z
		.array(z.strictObject({ accountId, displayName: z.string().trim().min(1).max(200) }))
		.max(MAX_REMOVAL_ITEMS),
});
export const seatJoinedProvenance = z.discriminatedUnion("source", [
	z.strictObject({ source: z.literal("accepted_invitation"), invitationId: recordId, at: instant }),
	z.strictObject({ source: z.literal("original_account_fallback"), at: instant }),
]);
const seatProjection = z
	.strictObject({
		seatId: recordId,
		displayName: z.string().trim().min(1).max(200),
		role,
		revision,
		status: z.enum(["active", "removed"]),
		isSelf: z.boolean(),
		avatar: avatarReference.nullable(),
		joined: seatJoinedProvenance,
		allowedActions: z
			.array(z.enum(["appoint_admin", "demote", "remove"]))
			.max(3)
			.refine((v) => new Set(v).size === v.length),
	})
	.refine((v) => v.role !== "owner" || v.allowedActions.length === 0);
export const seatListResult = z.strictObject({
	workspace: tenantOwner,
	items: z.array(seatProjection).max(100),
	next: recordId.nullable(),
	completeness: z.enum(["complete", "partial"]),
});
export const currentMembershipResult = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("unavailable") }),
	z.strictObject({ status: z.literal("seatless") }),
	z.strictObject({ status: z.literal("active"), workspace: tenantOwner, seatId: recordId, role, revision }),
]);
const dutyOutcome = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("moved"), dutyId: recordId, recipientAccountId: accountId }),
	z.strictObject({ status: z.literal("needs_owner"), dutyId: recordId }),
	z.strictObject({ status: z.literal("remaining"), dutyId: recordId }),
]);
export const seatMutationResult = z
	.strictObject({
		seatId: recordId,
		revision,
		outcome: z.enum(["changed", "noop", "partial"]),
		duties: z
			.array(dutyOutcome)
			.max(MAX_REMOVAL_ITEMS)
			.refine((v) => new Set(v.map((d) => d.dutyId)).size === v.length),
	})
	.refine((v) => v.outcome === "partial" || v.duties.every((d) => d.status !== "remaining"));
export const seatError = z.discriminatedUnion("code", [
	...safeError.options,
	defineSafeError("protected_owner", {}, "never"),
	defineSafeError("removal_too_large", {}, "never"),
	defineSafeError("required_write_failed", {}, "same_request"),
]);
