import "server-only";
import sharp from "sharp";

/** Largest input and output, in pixels (width times height). */
const PIXEL_LIMIT = 16_000_000;
/** Longest side of a stored logo, mark or signature, and of a stored cover photo. */
const LOGO_SIDE = 2000;
const COVER_SIDE = 2400;
const TIMEOUT_SECONDS = 5;

export type BrandAssetMedia = "image/svg+xml" | "image/png" | "image/webp";
export type ProcessedAsset = { bytes: Buffer; mediaType: "image/png" | "image/jpeg" };

const startsWith = (bytes: Uint8Array, ...prefix: number[]) => prefix.every((value, index) => bytes[index] === value);
/** True when the file starts with the signature of the media type the upload was staged for. */
export function matchesSignature(bytes: Uint8Array, mediaType: BrandAssetMedia): boolean {
	if (mediaType === "image/png") return startsWith(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
	if (mediaType === "image/webp")
		return (
			startsWith(bytes, 0x52, 0x49, 0x46, 0x46) && Buffer.from(bytes.subarray(8, 12)).toString("latin1") === "WEBP"
		);
	const head = Buffer.from(bytes.subarray(0, 4096)).toString("utf8").replace(/^﻿/, "");
	return /^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head);
}

/**
 * An SVG with a script, a `foreignObject`, an entity or a reference to any URL that is not a `data:` URI is refused.
 * A `#fragment` points inside the file and is allowed.
 */
export function svgIsSafe(source: string): boolean {
	if (/<script|<foreignObject|<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|@import|javascript:|\son[a-z]+\s*=/i.test(source))
		return false;
	const local = (value: string) => /^\s*(#|data:)/i.test(value);
	for (const match of source.matchAll(/(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gi))
		if (!local(match[2] ?? "")) return false;
	for (const match of source.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) if (!local(match[2] ?? "")) return false;
	return true;
}

/**
 * Decodes an upload under a pixel limit and a time limit and returns the stored raster. Logos, marks and the signature
 * are trimmed of empty margin and stored as PNG. The cover photo is resized, not trimmed, and stored as JPEG. Any
 * failure, including a file that is empty after trimming, throws `invalid_file`.
 */
export async function processBrandAsset(
	bytes: Uint8Array,
	mediaType: BrandAssetMedia,
	trim: boolean,
): Promise<ProcessedAsset> {
	try {
		if (!matchesSignature(bytes, mediaType)) throw Error("signature");
		if (mediaType === "image/svg+xml" && !svgIsSafe(Buffer.from(bytes).toString("utf8"))) throw Error("unsafe_svg");
		const input = sharp(bytes, {
			limitInputPixels: PIXEL_LIMIT,
			failOn: "warning",
			animated: false,
			...(mediaType === "image/svg+xml" ? { density: 144 } : {}),
		});
		const metadata = await input.metadata();
		if ((metadata.pages ?? 1) !== 1) throw Error("animated");
		if (!trim) {
			const jpeg = await input
				.flatten({ background: "#FFFFFF" })
				.resize({ width: COVER_SIDE, height: COVER_SIDE, fit: "inside", withoutEnlargement: true })
				.jpeg({ quality: 85 })
				.timeout({ seconds: TIMEOUT_SECONDS })
				.toBuffer();
			return { bytes: jpeg, mediaType: "image/jpeg" };
		}
		// Trim first at full size so the content keeps its exact proportions, then fit it inside the limit.
		const trimmed = await input.png().timeout({ seconds: TIMEOUT_SECONDS }).toBuffer();
		const png = await sharp(trimmed, { limitInputPixels: PIXEL_LIMIT })
			.trim({ threshold: 10 })
			.resize({ width: LOGO_SIDE, height: LOGO_SIDE, fit: "inside", withoutEnlargement: true })
			.png()
			.timeout({ seconds: TIMEOUT_SECONDS })
			.toBuffer();
		// A file with no visible pixel is not a logo.
		const alpha = (await sharp(png).stats()).channels[3];
		if (alpha && alpha.max === 0) throw Error("blank");
		return { bytes: png, mediaType: "image/png" };
	} catch {
		throw Error("invalid_file");
	}
}

const near = (r: number, g: number, b: number) => (r >= 240 && g >= 240 && b >= 240) || (r <= 24 && g <= 24 && b <= 24);
const hex = (r: number, g: number, b: number) =>
	"#" +
	[r, g, b]
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("")
		.toUpperCase();

/**
 * The most used colors of a stored asset, most used first, at most five. Transparent, near-white and near-black pixels
 * are ignored. Each entry is the most common exact color of a coarse bucket, so a flat color comes back unchanged.
 * Returns an empty list when no pixel counts.
 */
export async function dominantColors(bytes: Uint8Array): Promise<string[]> {
	const { data, info } = await sharp(bytes, { limitInputPixels: PIXEL_LIMIT })
		.resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true, kernel: "nearest" })
		.ensureAlpha()
		.raw()
		.timeout({ seconds: TIMEOUT_SECONDS })
		.toBuffer({ resolveWithObject: true });
	const buckets = new Map<number, { total: number; exact: Map<number, number> }>();
	for (let offset = 0; offset < data.length; offset += info.channels) {
		const r = data[offset] ?? 0;
		const g = data[offset + 1] ?? 0;
		const b = data[offset + 2] ?? 0;
		if ((data[offset + 3] ?? 0) < 200 || near(r, g, b)) continue;
		const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
		const bucket = buckets.get(key) ?? { total: 0, exact: new Map() };
		const exact = (r << 16) | (g << 8) | b;
		bucket.total++;
		bucket.exact.set(exact, (bucket.exact.get(exact) ?? 0) + 1);
		buckets.set(key, bucket);
	}
	return [...buckets.values()]
		.sort((left, right) => right.total - left.total)
		.slice(0, 5)
		.map((bucket) => {
			const [exact = 0] = [...bucket.exact.entries()].sort((left, right) => right[1] - left[1])[0] ?? [];
			return hex((exact >> 16) & 255, (exact >> 8) & 255, exact & 255);
		});
}
