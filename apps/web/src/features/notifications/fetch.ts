import type { Feed, FeedPage, FeedQuery, Outcome } from "./model.ts";
import { querySearch } from "./model.ts";

// The browser side of read.ts. A network failure or a server error reads as lost, so the screen can offer a retry.
async function get<T>(params: URLSearchParams): Promise<Outcome<T>> {
	try {
		const r = await fetch(`/notifications/read?${params}`, { cache: "no-store" });
		return r.ok ? ((await r.json()) as Outcome<T>) : { status: "lost" };
	} catch {
		return { status: "lost" };
	}
}
const params = (what: string, query: FeedQuery, extra: Record<string, string> = {}) => {
	const p = new URLSearchParams(querySearch(query));
	p.set("what", what);
	for (const [k, v] of Object.entries(extra)) p.set(k, v);
	return p;
};

export const readUnreadCount = () => get<{ count: number }>(new URLSearchParams({ what: "count" }));
export const readFirstPage = (query: FeedQuery) => get<FeedPage>(params("page", query));
export const readMore = (query: FeedQuery, cursor: string) => get<Feed>(params("more", query, { cursor }));
export const readRevision = () => get<{ revision: string }>(new URLSearchParams({ what: "revision" }));
