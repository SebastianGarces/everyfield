import type { Attachment } from "./model.ts";

const MB = 1024 * 1024;
export const ATTACH = {
	bytes: 10 * MB,
	photoBytes: 5 * MB,
	avatarBytes: 3 * MB,
	perMessage: 10,
	accept: ".csv,text/csv",
	photos: "image/jpeg,image/png,image/webp",
	photoName: /\.(jpe?g|png|webp)$/i,
} as const;

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

export function refusal(file: { name: string; size: number }, count: number): string | null {
	if (!/\.csv$/i.test(file.name))
		return "Evry can use CSV files and JPG, PNG or WebP photos. Save the file as one of those and attach it again.";
	if (file.size === 0) return `${file.name} is empty.`;
	if (file.size > ATTACH.bytes) return `${file.name} is larger than 10 MB. Split it into smaller files.`;
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
