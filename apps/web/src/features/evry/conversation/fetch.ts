import { readsFrom } from "../../../components/get-reads.ts";
import type { GET } from "./read.ts";

const get = readsFrom<typeof GET>("/api/evry/photos");

export async function readRowPhotos(personIds: string[]): Promise<Record<string, string>> {
	const r = await get("photos", { personIds });
	return r.status === "ok" ? r.value : {};
}
