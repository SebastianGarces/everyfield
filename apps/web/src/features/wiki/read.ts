import "server-only";
import { call, wikiActor } from "./server.ts";
import type { Outcome } from "./server.ts";

// GET /wiki/read: one wiki read after the session check. A GET handler, not a server action, so a read never waits
// for a write. Each read checks the live session inside its statement (C13). Personal responses are not stored.

const answer = (body: Outcome<unknown>) => Response.json(body, { headers: { "cache-control": "private, no-store" } });

export async function GET(request: Request) {
	const actor = await wikiActor();
	if (!actor) return answer({ status: "refused", code: "access_denied" });
	const p = new URL(request.url).searchParams;
	switch (p.get("what")) {
		case "list":
			return answer(await call(({ db, producer }) => producer.listArticles(db, actor, { page: 1 })));
		case "article":
			return answer(await call(({ db, producer }) => producer.getArticle(db, actor, { articleId: p.get("id") })));
		case "search":
			return answer(await call(({ db, producer }) => producer.search(db, actor, { query: p.get("q") ?? "" })));
		case "bookmarks":
			return answer(await call(({ db, producer }) => producer.bookmarksList(db, actor, { page: 1 })));
		case "stats":
			return answer(await call(({ db, producer }) => producer.readingStats(db, actor, {})));
		default:
			return answer({ status: "refused", code: "invalid_input" });
	}
}
