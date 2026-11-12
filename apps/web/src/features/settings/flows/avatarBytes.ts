import { avatarRoute, settingsError } from "@everyfield/contracts/settings";
import type { AvatarReference, Reply } from "../port";

// The client side of the avatar version route (app/api/accounts/[accountId]/avatar/[versionId]): the production
// port's uploadAvatarBytes. A staged upload's id is the version it becomes, so the bytes go to that version's address.

/**
 * Sends the bytes of a staged upload. The route answers 413 (empty or too large) and 422 (not a JPG, PNG or WebP)
 * as invalid_input; anything else that is not a success is unavailable.
 */
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
