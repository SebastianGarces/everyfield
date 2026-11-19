import { getReads } from "../../components/get-reads.ts";
import type { Feed, FeedPage, FeedQuery, Outcome, UnreadCount } from "./model.ts";
import type { GET } from "./read.ts";

const get = getReads<typeof GET>("/notifications/read");

export const readUnreadCount = (account: string): Promise<Outcome<UnreadCount>> => get("count", { account });
export const readFirstPage = (query: FeedQuery): Promise<Outcome<FeedPage>> => get("page", query);
export const readMore = (query: FeedQuery, cursor: string): Promise<Outcome<Feed>> => get("more", { ...query, cursor });
export const readRevision = (): Promise<Outcome<{ revision: string }>> => get("revision");
