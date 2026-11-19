import { getReads, type ReadResult } from "../../components/get-reads.ts";
import type { ReadRefusal } from "../../server/platform/reads.ts";
import type { GET } from "./read.ts";

const get = getReads<typeof GET>("/launch/read");
const refusedByRead = <T>(r: ReadResult<T, string>): r is ReadRefusal<string> =>
	typeof r === "object" && r !== null && "code" in r;

async function settled<T>(read: Promise<ReadResult<T, string>>) {
	const r = await read;
	return refusedByRead(r) ? ({ status: "lost" } as const) : r;
}

export const readGatheringOffers = () => settled(get("offers"));
export const suggestGuests = (query: string) => settled(get("guests", { query }));
export const readLaunchHistory = () => settled(get("history"));
