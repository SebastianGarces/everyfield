import { brandError } from "@everyfield/contracts/branding";
import type { BrandReply } from "../port";

export const assetSrc = (fileId: string) => `/api/brand/assets/${fileId}`;

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
