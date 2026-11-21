import type { Attachment } from "./model.ts";

export const ATTACH = { bytes: 10 * 1024 * 1024, perMessage: 10, accept: ".csv,text/csv" } as const;

export type Picked = {
	key: string;
	name: string;
	size: number;
	conversationId: string | null;
	state: "uploading" | "ready" | "failed";
	attachment: Attachment | null;
};

export const fileSize = (bytes: number) =>
	bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function refusal(file: { name: string; size: number }, count: number): string | null {
	if (!/\.csv$/i.test(file.name))
		return "Evry can check CSV files only. Save the spreadsheet as CSV and attach it again.";
	if (file.size === 0) return `${file.name} is empty.`;
	if (file.size > ATTACH.bytes) return `${file.name} is larger than 10 MB. Split it into smaller files.`;
	if (count >= ATTACH.perMessage) return "You can attach up to 10 files to one message.";
	return null;
}

export const FILE_REFUSED: Record<string, string> = {
	access_denied: "Only an Owner or Admin can attach files here.",
	not_found: "This conversation is no longer available.",
};

export const putFile = async (url: string, headers: Record<string, string>, file: File) => {
	const put = await fetch(url, { method: "PUT", headers, body: file }).catch(() => null);
	return put?.ok === true;
};
