"use server";

import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import { listPhotoRoute } from "@everyfield/contracts/people";
import { PeopleReadContext, readPersonPhotos } from "@everyfield/domain/people";
import { requestAvatarUpload } from "../../settings/actions";

// The current photos of the people Evry's result cards show (REQ-IDN-006). The panel asks for them here, apart from
// Evry: a photo never enters a saved conversation, a tool result or the model's context, and each read sees the
// photos as they are now. A photo the user attaches is staged here as their own account photo upload.

/** Each person's photo route, by person id. A person without a photo, a refused read or a failure has no entry. */
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

/**
 * Stages one photo the user attaches in the panel as their own account photo upload, through the same Settings
 * command the Account section uses (requestAvatarUpload). The bytes then go to the upload's own address
 * (uploadAvatarBytes). Only a review the user approves makes it their photo (account.finalizeAvatar). Null when the
 * server refused or has no photo storage.
 */
export async function stagePhoto(request: { mime: string; byteLength: number }) {
	const v = await getViewer();
	if (!v || v.status !== "active") return null;
	const staged = await requestAvatarUpload(request as Parameters<typeof requestAvatarUpload>[0]);
	return staged.status === "ok" ? { accountId: v.accountId, versionId: staged.value.uploadId } : null;
}
