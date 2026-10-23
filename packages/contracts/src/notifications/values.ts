import { z } from "zod";
import { notificationCategory } from "../settings/values.ts";

// The feed category is the preference category stored in logical_key, not the
// coarse notice.category column. Wiki has no email channel.
export { notificationCategory };
export const preferenceChannel = z.enum(["email", "in_app"]);
export const digestCadence = z.enum(["daily", "weekly"]);
export const digestPeriod = z.enum(["current", "owed_catchup"]);
export const optOutPurpose = z.enum(["disable", "undo"]);

export const notificationProducers = [
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
] as const;
export const excludedNotificationHelpers = [
	"team_welcome",
	"team_health",
	"training",
	"communication",
	"assessment_ready",
	"snooze",
	"NeedsYou",
] as const;

export const feedCursor = z
	.string()
	.regex(
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
	);
