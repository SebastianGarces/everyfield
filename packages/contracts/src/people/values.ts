import { z } from "zod";
import { instant, localDate } from "../common/time.ts";
import { owner, personId, recordId, revision } from "../common/values.ts";

export const plantOwner = owner.transform((value, ctx) => {
	if (value.kind === "plant") return value;
	ctx.addIssue({ code: "custom", message: "Expected a plant owner" });
	return z.NEVER;
});
export { organizationOwner, tenantOwner } from "../access/results.ts";
export const stage = z.enum([
	"prospect",
	"attendee",
	"following_up",
	"interviewed",
	"core_group",
	"launch_team",
	"leader",
]);
export const recruitmentSource = z.enum([
	"personal_referral",
	"social_media",
	"vision_meeting",
	"website",
	"event",
	"partner_church",
	"meeting_guest_list",
	"other",
]);
export const adultClassification = z.enum(["adult", "child", "unknown"]);
/** Where the effective adult or child value comes from: the birth date, a recorded value or nothing yet. */
export const adultClassificationSource = z.enum(["birth_date", "recorded", "not_recorded"]);
export const pipelineColumn = z.enum(["prospect", "attendee", "following_up", "interviewed", "core_group"]);
export const displayName = z.string().trim().min(1).max(255);
export const shortText = z.string().trim().max(255);
export const noteBody = z.string().trim().min(1).max(5000);
export const reason = noteBody;
export const contactFields = {
	displayName,
	firstName: shortText.nullable().optional(),
	lastName: shortText.nullable().optional(),
	email: z.string().trim().pipe(z.email().max(320)).nullable().optional(),
	phone: shortText.nullable().optional(),
	street: shortText.nullable().optional(),
	city: shortText.nullable().optional(),
	stateProvince: shortText.nullable().optional(),
	postalCode: shortText.nullable().optional(),
	country: shortText.nullable().optional(),
};
export const personLifecycle = z.discriminatedUnion("state", [
	z.strictObject({ state: z.literal("live") }),
	z.strictObject({ state: z.literal("retired"), retiredAt: instant }),
	z.strictObject({ state: z.literal("merged"), retiredAt: instant, survivorId: personId }),
]);
// Current commitment and genuine first acquisition are separate observations.
// Neither stage, household, account linkage nor classification creates evidence.
export const currentCommitment = z.discriminatedUnion("state", [
	z.strictObject({ state: z.literal("unknown") }),
	z.strictObject({
		state: z.enum(["active", "withdrawn"]),
		evidenceId: recordId,
		kind: z.enum(["core_group", "launch_team"]),
		occurredOn: localDate,
		revision,
	}),
]);
export const firstAcquisition = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("unknown") }),
	z.strictObject({ status: z.literal("none") }),
	z.strictObject({ status: z.literal("known"), occurredOn: localDate, evidenceId: recordId }),
]);
export const pageInput = {
	limit: z.int().min(1).max(100).default(24),
	// Page numbers in a stable order (D67). The server takes the church from the session.
	page: z.int().min(1).max(100_000).default(1),
};

// A pure disposition only. The API must read/lock current lifecycle before use;
// a restore never restores seats, account consent or private author identity.
export function ordinaryRestoreDecision(
	lifecycle: z.infer<typeof personLifecycle>,
): "noop" | "restore" | "use_reviewed_unmerge" {
	switch (lifecycle.state) {
		case "live":
			return "noop";
		case "retired":
			return "restore";
		case "merged":
			return "use_reviewed_unmerge";
	}
}
