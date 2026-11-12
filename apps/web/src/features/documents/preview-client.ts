import { MIME, fileName, type Format, type Resolved } from "./model.ts";

// The browser side of the preview route. One POST returns the exact bytes; the preview, the thumbnail and the
// download all use them, so the three agree by construction (DOC-002, DOC-003).

export type PreviewReply =
	| { status: "ok"; value: Resolved & { artifact: string | null; brandKit: boolean } }
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
		const body = (await response.json()) as PreviewReply | null;
		return body?.status === "ok" || body?.status === "refused" ? body : { status: "lost" };
	} catch {
		return { status: "lost" };
	}
}

// The renders of this visit, by render key (model.ts). A thumbnail and the preview of the same template and values
// share one request. A failed render is not kept, and only the newest few are, so the bytes do not pile up.
const renders = new Map<string, Promise<PreviewReply>>();
const KEPT = 24;

/** The preview for `key`, posted once: a later call with the same key gets the same reply. */
export function sharedPreview(
	key: string,
	templateId: string,
	format: Format,
	overrides: Record<string, string>,
): Promise<PreviewReply> {
	let known = renders.get(key);
	if (!known) {
		known = postPreview(templateId, format, overrides);
		renders.set(key, known);
		for (const old of renders.keys()) {
			if (renders.size <= KEPT) break;
			renders.delete(old);
		}
		void known.then((reply) => {
			if (reply.status !== "ok" || !reply.value.artifact) renders.delete(key);
		});
	}
	return known;
}

/** The one line every render failure shows. */
export const RENDER_FAILED = "This file did not render. Nothing was saved.";
