import { feedCursor } from "@everyfield/contracts/notifications";
import "server-only";
import { parseQuery, stamped, type Outcome } from "./model.ts";
import { call, loadFeedPage, notificationActor } from "./server.ts";

const answer = (body: Outcome<unknown>) => Response.json(body, { headers: { "cache-control": "private, no-store" } });

export async function GET(request: Request) {
	const actor = await notificationActor();
	if (!actor) return answer({ status: "refused", code: "access_denied" });
	const p = new URL(request.url).searchParams;
	const query = parseQuery(p);
	switch (p.get("what")) {
		case "count":
			if (p.has("account") && p.get("account") !== actor.actor.accountId)
				return answer({ status: "refused", code: "access_denied" });
			return answer(stamped(await call(({ db, producer }) => producer.readUnreadCount(db, actor, {}))));
		case "revision":
			return answer(
				await call(async ({ db, producer }) => {
					const r = await producer.getPreferences(db, actor);
					return r.status === "ok" ? { status: "ok", value: { revision: r.value.revision } } : r;
				}),
			);
		case "page":
			return answer(await loadFeedPage(actor, query));
		case "more": {
			const cursor = feedCursor.safeParse(p.get("cursor"));
			if (!cursor.success) return answer({ status: "refused", code: "invalid_input" });
			return answer(
				await call(({ db, producer }) =>
					producer.readFeed(db, actor, {
						cursor: cursor.data,
						...(query.category ? { category: query.category } : {}),
						...(query.unread ? { unread: true } : {}),
					}),
				),
			);
		}
		default:
			return answer({ status: "refused", code: "invalid_input" });
	}
}
