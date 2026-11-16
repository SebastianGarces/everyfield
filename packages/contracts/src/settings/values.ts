import { z } from "zod";
import { timeZone } from "../common/time.ts";
import { revision } from "../common/values.ts";
import { sharingChoices } from "../organizations/subjects.ts";

export const settingsName = z.string().trim().min(1).max(200);
const locality = z.string().trim().max(200).nullable();
export const plantProfile = z.strictObject({
	name: settingsName,
	street: z.string().trim().max(500).nullable(),
	city: locality,
	stateProvince: locality,
	country: locality,
	description: z.string().trim().max(5000).nullable(),
});
export const inactivity = z
	.strictObject({ warningDays: z.int().min(1), alertDays: z.int().max(365) })
	.refine((v) => v.warningDays < v.alertDays, { message: "warning_must_precede_alert" });
export const digestSchedule = z.discriminatedUnion("cadence", [
	z.strictObject({ cadence: z.literal("off") }),
	z.strictObject({ cadence: z.literal("daily"), hour: z.int().min(0).max(23) }),
	z.strictObject({ cadence: z.literal("weekly"), weekday: z.int().min(0).max(6), hour: z.int().min(0).max(23) }),
]);
export const plantSettings = z.strictObject({ profile: plantProfile, timeZone, inactivity, digest: digestSchedule });
export const timezonePreference = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("unconfirmed") }),
	z.strictObject({ status: z.literal("confirmed"), timeZone, revision }),
]);
export const affiliationPatch = z
	.strictObject({
		people: z.boolean().optional(),
		meetings: z.boolean().optional(),
		tasks: z.boolean().optional(),
		teams: z.boolean().optional(),
		wiki: z.boolean().optional(),
		activityPush: z.boolean().optional(),
		shared_findings: z.boolean().optional(),
	})
	.refine((v) => Object.values(v).some((x) => x !== undefined));
export function applyAffiliationPatch(
	stored: z.infer<typeof sharingChoices>,
	patch: z.infer<typeof affiliationPatch>,
): z.infer<typeof sharingChoices> {
	return {
		people: patch.people ?? stored.people,
		meetings: patch.meetings ?? stored.meetings,
		tasks: patch.tasks ?? stored.tasks,
		ministry_teams: patch.teams ?? stored.ministry_teams,
		wiki: patch.wiki ?? stored.wiki,
		activity: patch.activityPush ?? stored.activity,
		shared_findings: patch.shared_findings ?? stored.shared_findings,
	};
}
export const notificationCategory = z.enum([
	"task_due",
	"task_overdue",
	"meeting_announcement",
	"meeting_reminder",
	"planter_digest",
	"oversight_digest",
	"relationship_milestone",
	"sharing_milestone",
	"phase_milestone",
	"launch_milestone",
	"wiki_upstream_review",
	"scheduled_email_unsubscribe",
	"residency_confirmation",
	"residency_feedback",
	"answer_review",
]);
export const residencyCategories = ["residency_confirmation", "residency_feedback"] as const;
export const organizationCategories = ["oversight_digest", "answer_review"] as const;
export const inAppOnlyCategories = ["wiki_upstream_review", "scheduled_email_unsubscribe"] as const;
export function notificationChannels(category: z.infer<typeof notificationCategory>): readonly ("email" | "in_app")[] {
	return (inAppOnlyCategories as readonly string[]).includes(category) ? ["in_app"] : ["email", "in_app"];
}
export function defaultChannelEnabled(category: z.infer<typeof notificationCategory>, channel: "email" | "in_app") {
	if (category === "planter_digest") return channel === "email";
	if (category === "oversight_digest") return channel === "in_app";
	return true;
}
export const defaultDigestCadence = { planter_digest: "weekly", oversight_digest: "daily" } as const;
export const notificationChoice = z.union([
	z.strictObject({
		category: notificationCategory.exclude(inAppOnlyCategories),
		channel: z.enum(["email", "in_app"]),
		enabled: z.boolean(),
	}),
	z.strictObject({ category: z.enum(inAppOnlyCategories), channel: z.literal("in_app"), enabled: z.boolean() }),
]);
export const notificationPatch = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("channel"), choice: notificationChoice }),
	z.strictObject({ kind: z.literal("planter_cadence"), cadence: z.enum(["daily", "weekly"]) }),
	z.strictObject({ kind: z.literal("oversight_cadence"), cadence: z.enum(["daily", "weekly"]) }),
]);
export const notificationSettings = z.strictObject({
	choices: z
		.array(notificationChoice)
		.refine((v) => new Set(v.map((c) => `${c.category}:${c.channel}`)).size === v.length),
	planterCadence: z.enum(["daily", "weekly"]).nullable(),
	oversightCadence: z.enum(["daily", "weekly"]).nullable(),
	suppression: z.enum(["clear", "suppressed", "unavailable"]),
});
