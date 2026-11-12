import { z } from "zod";
import { notificationCategory } from "../settings/values.ts";

// The feed category is the preference category stored in logical_key, not the
// coarse notice.category column. Wiki has no email channel.
export { notificationCategory };
export const digestCadence = z.enum(["daily", "weekly"]);
export const digestPeriod = z.enum(["current", "owed_catchup"]);
export const optOutPurpose = z.enum(["disable", "undo"]);

export const feedCursor = z
	.string()
	.regex(
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
	);
