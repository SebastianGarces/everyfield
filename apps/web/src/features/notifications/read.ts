import { feedCursor, notificationCategory } from "@everyfield/contracts/notifications";
import "server-only";
import { z } from "zod";
import { defineReads } from "../../server/platform/reads.ts";
import { stamped, type Outcome, type UnreadCount } from "./model.ts";
import { call, loadFeedPage, notificationActor } from "./server.ts";

const feedQuery = z.strictObject({ unread: z.boolean(), category: notificationCategory.nullable() });

export const GET = defineReads(notificationActor, "access_denied", (get) => ({
	count: get(z.strictObject({ account: z.string().optional() }), async (actor, v): Promise<Outcome<UnreadCount>> =>
		v.account === undefined || v.account === actor.actor.accountId
			? stamped(await call(({ db, producer }) => producer.readUnreadCount(db, actor, {})), Date.now())
			: { status: "refused", code: "access_denied" },
	),
	revision: get(z.undefined(), (actor) =>
		call(async ({ db, producer }) => {
			const r = await producer.getPreferences(db, actor);
			return r.status === "ok" ? { status: "ok" as const, value: { revision: r.value.revision } } : r;
		}),
	),
	page: get(feedQuery, (actor, query) => loadFeedPage(actor, query)),
	more: get(feedQuery.extend({ cursor: feedCursor }), (actor, v) =>
		call(({ db, producer }) =>
			producer.readFeed(db, actor, {
				cursor: v.cursor,
				...(v.category ? { category: v.category } : {}),
				...(v.unread ? { unread: true } : {}),
			}),
		),
	),
}));
