import { avatarRoute, settingsError } from "@everyfield/contracts/settings";
import type { AvatarReference, Reply } from "../port";

export async function uploadAvatarBytes(target: AvatarReference, file: Blob): Promise<Reply<null>> {
	const response = await fetch(avatarRoute(target), {
		method: "PUT",
		headers: { "Content-Type": file.type || "application/octet-stream" },
		body: file,
	});
	if (response.ok) return { status: "ok", value: null };
	const invalid = response.status === 413 || response.status === 422;
	return {
		status: "refused",
		error: settingsError.parse({
			code: invalid ? "invalid_input" : "unavailable",
			details: {},
			correlationId: crypto.randomUUID(),
			retry: "never",
		}),
	};
}
