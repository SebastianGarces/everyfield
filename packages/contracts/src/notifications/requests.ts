import { z } from "zod";
import { commandEnvelope } from "../common/writes.ts";
import { organizationKind } from "../common/values.ts";
import { instant, localDateTime, timeZone } from "../common/time.ts";
import { notificationChoice } from "../settings/values.ts";
import { digestCadence, digestPeriod, feedCursor, notificationCategory } from "./values.ts";

const page = z.strictObject({
	category: notificationCategory.optional(),
	cursor: feedCursor.optional(),
	asOf: instant.optional(),
});
export const readFeedRequest = page.extend({
	unread: z.boolean().optional(),
});
export const readUnreadCountRequest = page.omit({ cursor: true });
export const setPreferenceRequest = commandEnvelope(z.strictObject({ choice: notificationChoice }));
export const setPreferencesRequest = commandEnvelope(
	z.strictObject({
		choices: z
			.array(notificationChoice)
			.min(1)
			.max(21)
			.refine((v) => new Set(v.map((c) => `${c.category}:${c.channel}`)).size === v.length),
	}),
);
export const setDigestCadenceRequest = commandEnvelope(z.strictObject({ plantId: z.uuid(), cadence: digestCadence }));
export const setOversightDigestCadenceRequest = commandEnvelope(
	z.strictObject({ organizationId: z.uuid(), organizationKind, cadence: digestCadence }),
);
export const markReadRequest = commandEnvelope(z.strictObject({ noticeId: z.uuid() }));
export const markSelectedReadRequest = commandEnvelope(z.strictObject({ noticeIds: z.array(z.uuid()).min(1).max(50) }));
export const markAllVisibleReadRequest = commandEnvelope(z.strictObject({ cutoff: instant }));
export const emailOptOutRequest = z.strictObject({
	token: z.string().min(1).max(4000),
	oneClick: z.boolean().optional(),
});
export const readOversightDigestRequest = z.strictObject({
	organizationId: z.uuid(),
	organizationKind,
	period: digestPeriod,
});
export const readPlanterDigestRequest = z.strictObject({
	plantId: z.uuid(),
	wall: localDateTime.optional(),
	zone: timeZone.optional(),
});
export const readAssociationAudienceRequest = z.strictObject({
	organizationId: z.uuid(),
	discoveryAccountId: z.uuid(),
});
export const readAssociationReceiptRequest = z.strictObject({
	organizationId: z.uuid(),
	operationId: z.uuid(),
});
export const readMeetingAudienceRequest = z.strictObject({ plantId: z.uuid(), meetingId: z.uuid() });
export const cancelTaskRemindersRequest = commandEnvelope(z.strictObject({ plantId: z.uuid(), taskId: z.uuid() }));
export const publishWikiUpstreamRequest = commandEnvelope(
	z.strictObject({
		organizationId: z.uuid(),
		organizationKind,
		sourceId: z.uuid(),
		sourceRevision: z.string().regex(/^(0|[1-9]\d*)$/),
	}),
);
