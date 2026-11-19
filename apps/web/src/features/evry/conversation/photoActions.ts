"use server";

import { getViewer } from "@/server/request-context";
import { requestAvatarUpload } from "../../settings/actions";

export async function stagePhoto(request: unknown) {
	const v = await getViewer();
	if (!v || v.status !== "active") return null;
	const staged = await requestAvatarUpload(request);
	return staged.status === "ok" ? { accountId: v.accountId, versionId: staged.value.uploadId } : null;
}
