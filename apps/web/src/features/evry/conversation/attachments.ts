import { IMPORT_BYTES_MAX, IMPORT_TOO_LARGE } from "@everyfield/contracts/documents";
import type { Attachment } from "./model.ts";

const MB = 1024 * 1024;
export const ATTACH = {
	bytes: IMPORT_BYTES_MAX,
	photoBytes: 5 * MB,
	avatarBytes: 3 * MB,
	perMessage: 10,
	accept: ".csv,.docx,.doc,.txt,.pdf,text/csv,text/plain,application/pdf",
	photos: "image/jpeg,image/png,image/webp",
	photoName: /\.(jpe?g|png|webp)$/i,
} as const;
export type Attaches = "church" | "documents" | "photo";
export const ACCEPTS: Record<Attaches, { accept: string; label: string; hint: string }> = {
	church: {
		accept: `${ATTACH.accept},${ATTACH.photos}`,
		label: "Attach a file",
		hint: "Attach a CSV, Word, text or PDF file, or a photo",
	},
	documents: { accept: ".docx,.doc,.txt,text/plain", label: "Attach a file", hint: "Attach a Word or text file" },
	photo: { accept: ATTACH.photos, label: "Attach a photo", hint: "Attach a photo" },
};
export const isCsv = (name: string) => /\.csv$/i.test(name);
export const isPdf = (name: string) => /\.pdf$/i.test(name);

export type Picked = {
	key: string;
	name: string;
	size: number;
	conversationId: string | null;
	state: "uploading" | "ready" | "failed";
	attachment: Attachment | null;
};

export const fileSize = (bytes: number) =>
	bytes < MB ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / MB).toFixed(1)} MB`;

export const looksLikePhoto = (file: { name: string; type: string }) =>
	file.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|heic|heif|avif|bmp|tiff?)$/i.test(file.name);

export const DOCUMENTS_ONLY =
	"Evry can take Word (.docx) and text (.txt) files here. Save the file as one of those and attach it again.";
const isWritten = (name: string) => /\.(docx|doc|txt)$/i.test(name);

export function refusal(file: { name: string; size: number }, count: number, attaches: Attaches): string | null {
	if (attaches === "documents" && !isWritten(file.name)) return DOCUMENTS_ONLY;
	if (!/\.(csv|docx|doc|txt|pdf)$/i.test(file.name))
		return "Evry can take CSV, Word (.docx), text (.txt) and PDF files and JPG, PNG or WebP photos. Save the file as one of those and attach it again.";
	if (file.size === 0) return `${file.name} is empty.`;
	if (file.size > ATTACH.bytes)
		return isCsv(file.name)
			? `${file.name} is larger than 10 MB. Split it into smaller files.`
			: isPdf(file.name)
				? `${file.name} is larger than 10 MB. Attach a file of 10 MB or less.`
				: IMPORT_TOO_LARGE;
	if (count >= ATTACH.perMessage) return "You can attach up to 10 files to one message.";
	return null;
}

export function photoRefusal(
	file: { name: string; type: string; size: number },
	church: boolean,
	count: number,
): string | null {
	if (!ATTACH.photos.split(",").includes(file.type) || !ATTACH.photoName.test(file.name))
		return "Evry can use JPG, PNG or WebP photos. Save the photo as one of those and attach it again.";
	if (file.size === 0) return `${file.name} is empty.`;
	const max = church ? ATTACH.photoBytes : ATTACH.avatarBytes;
	if (file.size > max) return `${file.name} is larger than ${max / MB} MB. Choose a smaller photo.`;
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
