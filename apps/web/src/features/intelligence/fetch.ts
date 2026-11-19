import { getReads, type ReadResult } from "../../components/get-reads.ts";
import type { ReadRefusal } from "../../server/platform/reads.ts";
import type { GET } from "./read.ts";

const get = getReads<typeof GET>("/me/check-in/read");
const refusedByRead = <T>(r: ReadResult<T, string>): r is ReadRefusal<string> =>
	typeof r === "object" && r !== null && "code" in r;

export async function readCheckInHistory(page: number) {
	const r = await get("history", { page });
	return refusedByRead(r) ? ({ status: "lost" } as const) : r;
}
