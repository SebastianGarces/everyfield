import { z } from "zod";
import { accountId, recordId, revision, safeError, defineSafeError, sameOwner } from "../common/values.ts";
import { instant, localDate, timeZone } from "../common/time.ts";
import { receipt } from "../common/transaction.ts";
import { normalizedEmail } from "../identity/requests.ts";
import { organizationOwner, plantOwner } from "../organizations/subjects.ts";
import { organizationProfileResult, sharingResult } from "../organizations/results.ts";
import { notificationSettings, plantSettings, settingsName, timezonePreference } from "./values.ts";

// Application delivery resolves version to a private server key and checks live
// self authority. No signed bearer URL, raw key or original filename crosses it.
export const avatarReference = z.strictObject({ accountId, versionId: recordId });
export function avatarRoute(value: z.infer<typeof avatarReference>): string {
	return `/api/accounts/${value.accountId}/avatar/${value.versionId}`;
}
export const avatarResult = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("absent") }),
	z.strictObject({ status: z.literal("available"), avatar: avatarReference }),
]);
export const avatarUploadResult = z.strictObject({ uploadId: recordId, expiresAt: instant });
export const sectionResult = z.discriminatedUnion("section", [
	z.strictObject({
		section: z.literal("account"),
		accountId,
		revision,
		name: settingsName,
		email: normalizedEmail,
		avatar: avatarResult,
		personalTimezone: timezonePreference.default({ status: "unconfirmed" }),
	}),
	z.strictObject({ section: z.literal("notifications"), accountId, revision, values: notificationSettings }),
	z.strictObject({ section: z.literal("plant"), plant: plantOwner, revision, values: plantSettings }),
	z.strictObject({ section: z.literal("teams"), plant: plantOwner, teamId: recordId, revision, name: settingsName }),
	z.strictObject({ section: z.literal("organization"), values: organizationProfileResult }),
	z.strictObject({ section: z.literal("affiliations"), values: sharingResult }),
]);
const savedCurrentSection = z.discriminatedUnion("section", [
	sectionResult.options[0],
	sectionResult.options[1],
	sectionResult.options[2],
	sectionResult.options[3],
	z.strictObject({ section: z.literal("organization"), values: organizationProfileResult.options[1] }),
	z.strictObject({ section: z.literal("affiliations"), values: sharingResult.options[1] }),
]);
export const savedSectionResult = z.strictObject({ receipt, current: savedCurrentSection }).refine((v) => {
	const current = v.current;
	switch (current.section) {
		case "account":
		case "notifications":
			return sameOwner(v.receipt.request.owner, { kind: "account", id: current.accountId });
		case "plant":
		case "teams":
			return sameOwner(v.receipt.request.owner, current.plant);
		case "organization":
			return sameOwner(v.receipt.request.owner, current.values.organization);
		case "affiliations":
			return sameOwner(v.receipt.request.owner, current.values.plant);
		default: {
			const exhaustive: never = current;
			return exhaustive;
		}
	}
});
const changedInstant = z.strictObject({ id: recordId, before: instant, after: instant });
export const plantTimezonePreview = z
	.strictObject({
		previewId: recordId,
		plant: plantOwner,
		expectedRevision: revision,
		asOf: instant,
		expiresAt: instant,
		oldZone: timeZone,
		newZone: timeZone,
		meetings: z.array(changedInstant).max(100),
		digests: z.array(changedInstant).max(100),
		reminders: z.array(changedInstant).max(100),
		preservedTaskDates: z.array(z.strictObject({ id: recordId, date: localDate })).max(100),
		completeness: z.enum(["complete", "bounded"]),
		warnings: z.array(z.enum(["dst_fold_earlier", "dst_gap_shifted", "more_results"])).max(3),
	})
	.refine((v) => v.expiresAt > v.asOf);
const savedPlantTimezone = { plant: plantOwner, timeZone, revision };
export const plantTimezoneResult = z.discriminatedUnion("status", [
	z.strictObject({
		status: z.literal("changed"),
		...savedPlantTimezone,
		replanIntentId: recordId,
		receipt: receipt.safeExtend({ outcome: z.literal("changed") }),
	}),
	z.strictObject({
		status: z.literal("noop"),
		...savedPlantTimezone,
		receipt: receipt.safeExtend({ outcome: z.literal("noop") }),
	}),
]);
export const settingsError = z.discriminatedUnion("code", [
	...safeError.options,
	defineSafeError("stale_preview", {}, "refresh"),
	defineSafeError("proof_invalid", {}, "never"),
	defineSafeError("deadline_passed", {}, "never"),
	defineSafeError("manual_owner_exception_required", {}, "never"),
]);
// The actual organization helper commits sharing with relationship/consent
// revisions, history, audit, receipt and required intents in one transaction.
export type SectionResult = z.infer<typeof sectionResult>;
export type SettingsError = z.infer<typeof settingsError>;
export { organizationOwner };
