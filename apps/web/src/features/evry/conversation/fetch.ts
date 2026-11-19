import { getReads } from "../../../components/get-reads.ts";
import type { GET } from "./read.ts";

const get = getReads<typeof GET>("/api/evry/photos");

export async function readRowPhotos(personIds: string[]): Promise<Record<string, string>> {
	const r = await get("photos", { personIds });
	if (r.status === "lost") throw new Error("row photos read lost");
	return r.status === "ok" ? r.value : {};
}
