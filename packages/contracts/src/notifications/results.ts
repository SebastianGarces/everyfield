import { z } from "zod";
import { safeError } from "../common/values.ts";
import { instant, timeZone } from "../common/time.ts";
import { notificationSettings } from "../settings/values.ts";
import { digestCadence, digestPeriod, notificationCategory, optOutPurpose } from "./values.ts";

export const notificationError = safeError;
export type NotificationError = z.infer<typeof notificationError>;
export type NotificationReply<T> = { status: "ok"; value: T } | { status: "refused"; error: NotificationError };

export const feedItem = z.strictObject({
	id: z.uuid(),
	category: notificationCategory,
	title: z.string(),
	body: z.string().nullable(),
	eligibleAt: instant,
	read: z.boolean(),
	dueLocalDate: z.iso.date().nullable(),
	overdue: z.boolean(),
});
export const feedResult = z.strictObject({
	items: z.array(feedItem).max(50),
	nextCursor: z.string().nullable(),
});
export const unreadCountResult = z.strictObject({ count: z.number().int().nonnegative() });
export const preferenceResult = notificationSettings.extend({
	revision: z.string(),
	explicitEmail: z.array(notificationCategory),
});
export const preferenceWriteResult = z.strictObject({
	revision: z.string(),
	changed: z.boolean(),
	cadence: digestCadence.nullable(),
});
export const markResult = z.strictObject({ markedIds: z.array(z.uuid()) });
export const emailOptOutResult = z.strictObject({
	category: notificationCategory,
	purpose: optOutPurpose,
	expired: z.boolean(),
	changed: z.boolean(),
	emailEnabled: z.boolean(),
	inAppEnabled: z.boolean(),
	undoToken: z.string().nullable(),
});
export const oversightDigestResult = z.strictObject({
	timezone: timeZone,
	period: digestPeriod,
	lines: z.array(z.strictObject({ date: z.iso.date(), count: z.number().int().positive() })),
	plants: z.array(z.uuid()),
});
export const planterDigestResult = z.strictObject({
	sendAt: instant,
	inAppDigest: z.boolean(),
});
export const associationAudienceResult = z.strictObject({
	recipientIds: z.array(z.uuid()),
});
export const associationReceiptResult = z.strictObject({
	recipients: z.array(z.strictObject({ accountId: z.uuid(), state: z.string() })),
});
export const meetingAudienceResult = z.strictObject({ recipientIds: z.array(z.uuid()) });
export const cancelRemindersResult = z.strictObject({ cancelledIds: z.array(z.uuid()) });
export const wikiPublishResult = z.strictObject({
	noticeIds: z.array(z.uuid()),
	recipientIds: z.array(z.uuid()),
});
