import type { Database, Transaction } from "@everyfield/db/client";
import { runLockedWrite } from "./core.ts";
import { RequestActor } from "../access/session.ts";
import {
	cancelTaskReminders,
	publishWikiUpstream,
	readAssociationAudience,
	readAssociationReceipt,
	readMeetingAudience,
} from "./audience.ts";
import { previewPlanterDigest, readOversightDigest, readPlanterDigest } from "./digest.ts";
import {
	markAllVisibleRead,
	markAllVisibleReadCommand,
	markRead,
	markSelectedRead,
	markSelectedReadCommand,
	readFeed,
	readFeedPage,
	readUnreadCount,
} from "./feed.ts";
import { emailOptOut, type OptOutKeyRing } from "./opt-out.ts";
import {
	getPreferences,
	setDigestCadence,
	setOversightDigestCadence,
	setDigestCadenceCommand,
	setPreference,
	setPreferences,
	setPreferencesCommand,
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
		readFeed: (database: Database, authority: RequestActor, raw: unknown) => readFeed(database, authority, raw, now),
		readFeedPage: (database: Database, authority: RequestActor, raw: unknown) =>
			readFeedPage(database, authority, raw, now),
		readUnreadCount,
		getPreferences,
		describeEmailOptOut: (database: Database, raw: unknown) => emailOptOut(database, keys, now, raw, "describe"),
		readOversightDigest,
		readPlanterDigest: (database: Database, authority: RequestActor, raw: unknown) =>
			readPlanterDigest(database, authority, raw, now),
		previewPlanterDigest: (database: Database, authority: RequestActor, raw: unknown) =>
			previewPlanterDigest(database, authority, raw, now),
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

export { issueEmailOptOutToken, issueMailOptOutToken, parseKeyRing, type OptOutKeyRing } from "./opt-out.ts";
export {
	compileOversightDigest,
	compilePlanterDigest,
	digestRecipientLive,
	nextDigestInstant,
	owedPeriod,
	previewPlanterDigest,
	renderOversightDigest,
	renderPlanterDigest,
} from "./digest.ts";

/**
 * The notification writes inside a caller's transaction whose write gate holds the approving session (an approved Evry
 * review, packages/evry). Each one changes only that session's own account and writes its own audit row.
 */
export const lockedNotificationWrites = {
	markSelectedRead: (tx: Transaction, raw: unknown) => runLockedWrite(tx, raw, markSelectedReadCommand),
	markAllVisibleRead: (tx: Transaction, raw: unknown) => runLockedWrite(tx, raw, markAllVisibleReadCommand),
	setPreferences: (tx: Transaction, raw: unknown) => runLockedWrite(tx, raw, setPreferencesCommand),
	setDigestCadence: (tx: Transaction, raw: unknown) => runLockedWrite(tx, raw, setDigestCadenceCommand),
};
export { readFeedPage, readUnreadCount } from "./feed.ts";
export { getPreferences } from "./preferences.ts";
/** The signed-in account (`me`) and the notices it may see and mark: the bell's own rule, for an Evry review. */
export { noticeVisible, selfSql } from "./core.ts";
