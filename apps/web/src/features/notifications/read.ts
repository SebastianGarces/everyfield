import { feedCursor } from "@everyfield/contracts/notifications";
import "server-only";
import { parseQuery, type Outcome } from "./model.ts";
import { call, loadFeedPage, notificationActor } from "./server.ts";

// GET /notifications/read: the feed's and the bell's reads after the first paint. A GET handler, not a server action,
// so a read never waits for a mark or holds one up. Each read checks the live session inside its statement (C13).
//   ?what=count              the bell's unread count, one statement
//   ?what=page&show&category the first page, the unread count of that filter and the revision, three statements
//   ?what=more&cursor=…      the next page after `cursor`, one statement
//   ?what=revision           the account revision a mark carries, after a mark met a newer one, one statement

const answer = (body: Outcome<unknown>) => Response.json(body, { headers: { "cache-control": "private, no-store" } });

export async function GET(request: Request) {
	const actor = await notificationActor();
	if (!actor) return answer({ status: "refused", code: "access_denied" });
	const p = new URL(request.url).searchParams;
	const query = parseQuery(p);
	switch (p.get("what")) {
		case "count":
			return answer(await call(({ db, producer }) => producer.readUnreadCount(db, actor, {})));
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
