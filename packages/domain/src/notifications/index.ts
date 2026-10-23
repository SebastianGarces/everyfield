import type { Database } from "@everyfield/db/client";
import { RequestActor } from "../access/session.ts";
import {
	cancelTaskReminders,
	publishWikiUpstream,
	readAssociationAudience,
	readAssociationReceipt,
	readMeetingAudience,
	readProducers,
} from "./audience.ts";
import { readOversightDigest, readPlanterDigest } from "./digest.ts";
import { markAllVisibleRead, markRead, markSelectedRead, readFeed, readUnreadCount } from "./feed.ts";
import { emailOptOut } from "./opt-out.ts";
import {
	getPreferences,
	setDigestCadence,
	setOversightDigestCadence,
	setPreference,
	setPreferences,
} from "./preferences.ts";

export type NotificationConfig = { optOutKey: Buffer; now?: () => Date };

export function createNotificationProducer(config: NotificationConfig) {
	if (config.optOutKey.length !== 32) throw new Error("opt_out_key");
	const now = () => config.now?.() ?? new Date();
	return {
		readFeed,
		readUnreadCount,
		getPreferences,
		describeEmailOptOut: (database: Database, _authority: RequestActor, raw: unknown) =>
			emailOptOut(database, config.optOutKey, now, raw, "describe"),
		readOversightDigest,
		readPlanterDigest,
		readAssociationReceipt,
		readAssociationAudience,
		readMeetingAudience,
		readProducers: (_database: Database, _authority: RequestActor, raw: unknown) => readProducers(raw),
		setPreference,
		setPreferences,
		setDigestCadence,
		setOversightDigestCadence,
		markRead,
		markAllVisibleRead,
		markSelectedRead,
		applyEmailOptOut: (database: Database, raw: unknown) =>
			emailOptOut(database, config.optOutKey, now, raw, "disable"),
		undoEmailOptOut: (database: Database, raw: unknown) => emailOptOut(database, config.optOutKey, now, raw, "undo"),
		cancelTaskReminders,
		publishWikiUpstream,
	};
}

export { issueEmailOptOutToken } from "./opt-out.ts";
export { nextDigestInstant } from "./digest.ts";
