import type { Database } from "@everyfield/db/client";
import { RequestActor } from "../access/session.ts";
import {
	cancelTaskReminders,
	publishWikiUpstream,
	readAssociationAudience,
	readAssociationReceipt,
	readMeetingAudience,
} from "./audience.ts";
import { readOversightDigest, readPlanterDigest } from "./digest.ts";
import { markAllVisibleRead, markRead, markSelectedRead, readFeed, readUnreadCount } from "./feed.ts";
import { emailOptOut, type OptOutKeyRing } from "./opt-out.ts";
import {
	getPreferences,
	setDigestCadence,
	setOversightDigestCadence,
	setPreference,
	setPreferences,
} from "./preferences.ts";

export type NotificationConfig = { optOutKey?: Buffer; optOutKeys?: OptOutKeyRing; now?: () => Date };

function optOutRing(config: NotificationConfig): OptOutKeyRing {
	const ring = config.optOutKeys ?? (config.optOutKey ? { current: config.optOutKey, previous: [] } : null);
	if (!ring || ring.current.length !== 32 || (ring.previous ?? []).some((key) => key.length !== 32))
		throw new Error("opt_out_key");
	return ring;
}

export function createNotificationProducer(config: NotificationConfig) {
	const keys = optOutRing(config);
	const now = () => config.now?.() ?? new Date();
	return {
		readFeed,
		readUnreadCount,
		getPreferences,
		describeEmailOptOut: (database: Database, _authority: RequestActor, raw: unknown) =>
			emailOptOut(database, keys, now, raw, "describe"),
		readOversightDigest,
		readPlanterDigest: (database: Database, authority: RequestActor, raw: unknown) =>
			readPlanterDigest(database, authority, raw, now),
		readAssociationReceipt,
		readAssociationAudience,
		readMeetingAudience,
		setPreference,
		setPreferences,
		setDigestCadence,
		setOversightDigestCadence,
		markRead,
		markAllVisibleRead,
		markSelectedRead,
		applyEmailOptOut: (database: Database, raw: unknown) => emailOptOut(database, keys, now, raw, "disable"),
		undoEmailOptOut: (database: Database, raw: unknown) => emailOptOut(database, keys, now, raw, "undo"),
		cancelTaskReminders,
		publishWikiUpstream,
	};
}

export { issueEmailOptOutToken } from "./opt-out.ts";
export { nextDigestInstant } from "./digest.ts";
