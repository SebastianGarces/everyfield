import { readsFrom, refusalAs } from "../../../components/get-reads.ts";
import type { GET } from "./read.ts";

const get = readsFrom<typeof GET>("/organization/pipeline/read");

export const readGoals = () => get("goals");
export const readBoard = (query: unknown) => get("board", query);
export const readPerson = (personId: string) => get("person", { personId });
export const reviewMerge = (pair: { sourceId: string; survivorId: string }) =>
	refusalAs(get("merge", pair), (r) => ({ status: "refused", error: { code: r.code } }) as const);
