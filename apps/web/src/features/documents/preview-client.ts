import { MIME, fileName, type Format, type Resolved } from "./model.ts";

export type PreviewReply =
	| { status: "ok"; value: Resolved & { artifact: string | null; brandKit: boolean } }
	| { status: "refused"; code: string; path?: string }
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

async function postPreview(
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

const renders = new Map<string, Promise<PreviewReply>>();
const KEPT = 24;

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

export const RENDER_FAILED = "This file did not render. Nothing was saved.";
