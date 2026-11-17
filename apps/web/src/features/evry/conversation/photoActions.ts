"use server";

import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import { listPhotoRoute } from "@everyfield/contracts/people";
import { PeopleReadContext, readPersonPhotos } from "@everyfield/domain/people";
import { requestAvatarUpload } from "../../settings/actions";

export async function readRowPhotos(personIds: unknown): Promise<Record<string, string>> {
	const v = await getViewer();
	const db = requestDatabase();
	if (!v?.people || !db) return {};
	try {
		const reply = await readPersonPhotos(db, new PeopleReadContext(v.people.authority), { personIds });
		if (reply.status !== "ok") return {};
		return Object.fromEntries(reply.value.photos.map((p) => [p.personId, listPhotoRoute(p.photo)]));
	} catch (error) {
		console.error(JSON.stringify({ component: "evry", outcome: "row_photos_failed", error: String(error) }));
		return {};
	}
}

export async function stagePhoto(request: { mime: string; byteLength: number }) {
	const v = await getViewer();
	if (!v || v.status !== "active") return null;
	const staged = await requestAvatarUpload(request as Parameters<typeof requestAvatarUpload>[0]);
	return staged.status === "ok" ? { accountId: v.accountId, versionId: staged.value.uploadId } : null;
}
