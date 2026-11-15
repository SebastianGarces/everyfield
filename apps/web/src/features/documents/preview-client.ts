import { MIME, churchValues, fileName, type Format, type Resolved } from "./model.ts";

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

function remember(key: string, reply: Promise<PreviewReply>) {
	renders.set(key, reply);
	for (const old of renders.keys()) {
		if (renders.size <= KEPT) break;
		renders.delete(old);
	}
	void reply.then((settled) => {
		if (renders.get(key) === reply && (settled.status !== "ok" || !settled.value.artifact)) renders.delete(key);
	});
}

export type PreviewAlias = { key: string; church: Record<string, string> };

const sorted = (values: Record<string, string>) =>
	JSON.stringify(Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1)));

const printed = (reply: PreviewReply, church: Record<string, string>) =>
	reply.status === "ok" && sorted(churchValues(reply.value)) === sorted(church);

export function sharedPreview(
	key: string,
	templateId: string,
	format: Format,
	overrides: Record<string, string>,
	alias: PreviewAlias | null = null,
): Promise<PreviewReply> {
	const known = renders.get(key);
	if (known) return known;
	const earlier = alias ? renders.get(alias.key) : undefined;
	const reply = earlier
		? earlier.then((settled) =>
				alias && printed(settled, alias.church) ? settled : postPreview(templateId, format, overrides),
			)
		: postPreview(templateId, format, overrides);
	remember(key, reply);
	if (alias && !earlier) remember(alias.key, reply);
	return reply;
}

export const RENDER_FAILED = "This file did not render. Nothing was saved.";
