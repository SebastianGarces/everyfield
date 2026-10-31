import { MIME, fileName, type Format, type Resolved } from "./model.ts";

// The browser side of the preview route. One POST returns the exact bytes; the preview, the thumbnail and the
// download all use them, so the three agree by construction (DOC-002, DOC-003).

export type PreviewReply =
	| { status: "ok"; value: Resolved & { artifact: string | null } }
	| { status: "refused"; code: string; problem?: string }
	| { status: "lost" };

export function bytesOf(encoded: string) {
	const binary = atob(encoded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export function downloadBytes(name: string, format: Format, encoded: string) {
	const url = URL.createObjectURL(new Blob([bytesOf(encoded)], { type: MIME[format] }));
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName(name, format);
	document.body.append(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
}

/** One JSON post. The preview route skips the server-action flight, which was the slow part. */
export async function postPreview(
	templateId: string,
	format: Format,
	overrides: Record<string, string>,
): Promise<PreviewReply> {
	try {
		const response = await fetch("/documents/preview", {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify({ templateId, format, overrides }),
		});
		const body: unknown = await response.json();
		if (!body || typeof body !== "object" || !("status" in body)) return { status: "lost" };
		const status = (body as { status: unknown }).status;
		if (status === "lost") return { status: "lost" };
		if (status === "refused") {
			const code = (body as { code?: unknown }).code;
			const problem = (body as { problem?: unknown }).problem;
			if (typeof code !== "string") return { status: "lost" };
			return typeof problem === "string" ? { status: "refused", code, problem } : { status: "refused", code };
		}
		if (status !== "ok") return { status: "lost" };
		const value = (body as { value?: unknown }).value;
		if (!value || typeof value !== "object") return { status: "lost" };
		const artifact = (value as { artifact?: unknown }).artifact;
		if (typeof artifact !== "string" && artifact !== null) return { status: "lost" };
		return { status: "ok", value: value as Resolved & { artifact: string | null } };
	} catch {
		return { status: "lost" };
	}
}
