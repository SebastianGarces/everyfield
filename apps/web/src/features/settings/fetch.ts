import { getReads, type ReadResult } from "../../components/get-reads.ts";
import type { GetSectionRequest, Locality, SuggestBrandColors } from "./port";
import type { GET } from "./read.ts";

const get = getReads<typeof GET>("/settings/read");

async function value<T>(read: Promise<ReadResult<{ status: "ok"; value: T }, string>>): Promise<T> {
	const r = await read;
	if (r.status !== "ok") throw new Error(`settings read ${r.status}`);
	return r.value;
}

export const getSection = (request: GetSectionRequest) => value(get("section", request));
export const getBrand = () => value(get("brand"));
export const suggestColors = (request: SuggestBrandColors) => value(get("colors", request));
export const readRegion = () => value(get("region"));
export const suggestRegion = (raw: Locality) => value(get("regions", raw));
