import { getReads } from "../../components/get-reads.ts";
import type { ExportResult, GuideResult, OrderRead, SearchResult } from "./actions.ts";
import type { GET } from "./read.ts";

const get = getReads<typeof GET>("/api/wiki/read");

export async function searchWiki(
	query: string,
	phase: number | null,
	page: number,
	source: string | null,
): Promise<SearchResult> {
	const r = await get("search", { query, phase, page, source });
	return r.status === "refused" ? { status: "lost" } : r;
}

export async function loadGuide(route: string): Promise<GuideResult> {
	const r = await get("guide", { route });
	return r.status === "refused" || r.status === "lost" ? { status: "unavailable" } : r;
}

export async function readSourceOrder(): Promise<OrderRead> {
	const r = await get("order");
	return r.status === "refused" ? { status: "lost" } : r;
}

async function exported(read: ReturnType<typeof get<"pdf" | "print">>): Promise<ExportResult> {
	const r = await read;
	return r.status === "refused" ? { status: "lost" } : r;
}

export const downloadPdf = (articleId: string, source: string | null) => exported(get("pdf", { articleId, source }));
export const printCopy = (articleId: string, source: string | null) => exported(get("print", { articleId, source }));
