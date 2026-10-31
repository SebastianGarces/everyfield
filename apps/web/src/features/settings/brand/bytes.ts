import { brandError } from "@everyfield/contracts/branding";
import type { BrandReply } from "../port";

// The client side of the byte route (app/api/brand/assets/[id]): the production port's uploadBytes and assetSrc.

/** The authenticated delivery route for one stored asset. */
export const assetSrc = (fileId: string) => `/api/brand/assets/${fileId}`;

/** Sends the bytes of a staged upload. A refusal body names the code and the reference; anything else is unavailable. */
export async function uploadBytes(uploadId: string, file: Blob): Promise<BrandReply<null>> {
	const response = await fetch(`/api/brand/assets/${uploadId}`, {
		method: "PUT",
		headers: { "Content-Type": file.type || "application/octet-stream" },
		body: file,
	});
	if (response.ok) return { status: "ok", value: null };
	const body = (await response.json().catch(() => null)) as { code?: string; correlationId?: string } | null;
	const code = ["invalid_file", "access_denied", "unavailable"].includes(body?.code ?? "")
		? body!.code!
		: "unavailable";
	return {
		status: "refused",
		error: brandError.parse({
			code,
			details: {},
			correlationId: body?.correlationId ?? crypto.randomUUID(),
			retry: "never",
		}),
	};
}
