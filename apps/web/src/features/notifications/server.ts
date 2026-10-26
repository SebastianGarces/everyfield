import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import type { Database } from "@everyfield/db/client";
import type { RequestActor } from "@everyfield/domain/access";
import { createNotificationProducer } from "@everyfield/domain/notifications";
import { randomBytes } from "node:crypto";
import "server-only";
import type { FeedPage, FeedQuery, Outcome, Reply } from "./model.ts";

// The notification feed, bell and email opt-out reach the WP-030 producer here. The feed is the signed-in account's
// own: the producer reads the recipient from the verified session (REQ-NTF-003), so no screen names one.

type Producer = ReturnType<typeof createNotificationProducer>;
export type Mount = { db: Database; producer: Producer; optOut: boolean };

/**
 * NOTIFICATION_OPT_OUT_KEYS: comma-separated base64 keys of 32 bytes, the current key first, then older keys that
 * still open tokens issued before a rotation. Anything else counts as not configured, so opt-out fails closed.
 */
export function parseKeyRing(raw: string | undefined): { current: Buffer; previous: Buffer[] } | null {
	const keys = (raw ?? "")
		.split(",")
		.map((k) => k.trim())
		.filter(Boolean)
		.map((k) => Buffer.from(k, "base64"));
	const [current, ...previous] = keys;
	return current && keys.every((k) => k.length === 32) ? { current, previous } : null;
}

const MOUNT: unique symbol = Symbol.for("everyfield.web.notifications");
const slot = globalThis as { [MOUNT]?: { url: string; mount: Mount } };

/**
 * The producer for this server. Email opt-out needs its own key ring in NOTIFICATION_OPT_OUT_KEYS (REQ-NTF-012: a
 * dedicated key, never another secret). The producer refuses to start without a ring, also for the feed, which never
 * uses it; with no ring configured the feed gets a random key nobody holds and `optOut` stays false, so no token is
 * ever opened with it.
 */
export function notificationsMount(): Mount | null {
	const db = requestDatabase();
	const url = process.env.IDENTITY_DATABASE_URL;
	if (!db || !url) return null;
	if (slot[MOUNT]?.url !== url) {
		const ring = parseKeyRing(process.env.NOTIFICATION_OPT_OUT_KEYS);
		const producer = createNotificationProducer({ optOutKeys: ring ?? { current: randomBytes(32) } });
		slot[MOUNT] = { url, mount: { db, producer, optOut: ring !== null } };
	}
	return slot[MOUNT].mount;
}

/** The request's verified actor, or null when signed out. Any active account has a feed, with or without a seat. */
export async function notificationActor(): Promise<RequestActor | null> {
	return (await getViewer())?.authority ?? null;
}

const outcome = <T>(reply: Reply<T>): Outcome<T> =>
	reply.status === "ok" ? reply : { status: "refused", code: reply.error.code };

/** One producer call. A database failure reads as lost, never as an empty feed (REQ-NTF-003: empty is not unavailable). */
export async function call<T>(run: (m: Mount) => Promise<Reply<T>>): Promise<Outcome<T>> {
	const mount = notificationsMount();
	if (!mount) return { status: "lost" };
	try {
		return outcome(await run(mount));
	} catch (error) {
		console.error(JSON.stringify({ component: "notifications", outcome: "failed", error: String(error) }));
		return { status: "lost" };
	}
}

/**
 * One page of the feed, the unread count of the same filter and the account revision for marks, read together: three
 * statements (REQ-NTF-003).
 */
export function loadFeedPage(actor: RequestActor, query: FeedQuery): Promise<Outcome<FeedPage>> {
	const filter = query.category ? { category: query.category } : {};
	return call(async ({ db, producer }) => {
		const [feed, unread, account] = await Promise.all([
			producer.readFeed(db, actor, { ...filter, ...(query.unread ? { unread: true } : {}) }),
			producer.readUnreadCount(db, actor, filter),
			producer.getPreferences(db, actor),
		]);
		if (feed.status !== "ok") return feed;
		if (unread.status !== "ok") return unread;
		if (account.status !== "ok") return account;
		return { status: "ok", value: { feed: feed.value, unread: unread.value.count, revision: account.value.revision } };
	});
}
