import { readsFrom, type ReadFailure } from "../../components/get-reads.ts";
import type { ExportResult, GuideResult, OrderRead, SearchResult } from "./actions.ts";
import type { GET } from "./read.ts";
import { FailedRead } from "../../components/read-failed.ts";

const get = readsFrom<typeof GET>("/api/wiki/read");

export async function searchWiki(
	query: string,
	phase: number | null,
	page: number,
	source: string | null,
): Promise<SearchResult | ReadFailure> {
	const r = await get("search", { query, phase, page, source });
	return r.status === "refused" ? { status: "lost" } : r;
}

export async function loadGuide(route: string): Promise<GuideResult | ReadFailure> {
	const r = await get("guide", { route });
	return r.status === "refused" || r.status === "lost" ? { status: "unavailable" } : r;
}

export async function readSourceOrder(): Promise<OrderRead> {
	const r = await get("order");
	if (r.status === "failed") throw new FailedRead("wiki order");
	return r.status === "refused" ? { status: "lost" } : r;
}

async function exported(read: ReturnType<typeof get<"pdf" | "print">>): Promise<ExportResult | ReadFailure> {
	const r = await read;
	return r.status === "refused" ? { status: "lost" } : r;
}

export const downloadPdf = (articleId: string, source: string | null) => exported(get("pdf", { articleId, source }));
export const printCopy = (articleId: string, source: string | null) => exported(get("print", { articleId, source }));
