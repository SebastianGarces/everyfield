import type { AppAssetPath } from "@everyfield/contracts/common";
import { readsFrom } from "../../../components/get-reads.ts";
import type { GET } from "./read.ts";

const get = readsFrom<typeof GET>("/api/evry/photos");

export async function readOwnPhoto(): Promise<{ src: AppAssetPath | null }> {
	const r = await get("ownPhoto");
	return { src: r.status === "ok" ? r.value : null };
}

export async function readRowPhotos(personIds: string[]): Promise<Record<string, AppAssetPath>> {
	const r = await get("photos", { personIds });
	return r.status === "ok" ? r.value : {};
}
