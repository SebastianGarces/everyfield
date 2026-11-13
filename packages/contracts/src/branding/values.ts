import { z } from "zod";

/** `#RRGGBB`. Any letter case is accepted; the parsed value is upper case. */
export const hexColor = z
	.string()
	.regex(/^#[0-9A-Fa-f]{6}$/)
	.transform((value) => value.toUpperCase());
export type HexColor = z.output<typeof hexColor>;

/** One curated list of open-license (OFL) fonts. No operation accepts a font file. */
export const FONTS = [
	{ id: "DM Serif Display", style: "serif" },
	{ id: "Playfair Display", style: "serif" },
	{ id: "Lora", style: "serif" },
	{ id: "Merriweather", style: "serif" },
	{ id: "Source Serif 4", style: "serif" },
	{ id: "DM Sans", style: "sans" },
	{ id: "Inter", style: "sans" },
	{ id: "Source Sans 3", style: "sans" },
	{ id: "Work Sans", style: "sans" },
	{ id: "Nunito Sans", style: "sans" },
] as const;
export type FontId = (typeof FONTS)[number]["id"];
export const fontId = z.enum(FONTS.map((font) => font.id) as [FontId, ...FontId[]]);
export const DEFAULT_HEADING_FONT: FontId = "DM Serif Display";
export const DEFAULT_BODY_FONT: FontId = "DM Sans";

export const ASSET_SLOTS = ["full_logo", "full_logo_dark", "mark", "mark_dark", "cover_photo", "signature"] as const;
export const assetSlot = z.enum(ASSET_SLOTS);
export type AssetSlot = z.infer<typeof assetSlot>;
/** The cover photo is resized, not trimmed. Every other slot is trimmed of empty margin. */
export const isTrimmedSlot = (slot: AssetSlot) => slot !== "cover_photo";

export const ASSET_MEDIA_TYPES = ["image/svg+xml", "image/png", "image/webp"] as const;
export const assetMediaType = z.enum(ASSET_MEDIA_TYPES);
/** The most bytes one upload may carry before processing. */
export const ASSET_MAX_BYTES = 3 * 1024 * 1024;

export const documentClass = z.enum(["formal/legal", "outward-facing", "operational", "email"]);
export type DocumentClass = z.infer<typeof documentClass>;

export const altText = z.string().trim().min(1).max(300);

const text = (max: number) => z.string().trim().min(1).max(max);
export const einText = z.string().regex(/^\d{2}-\d{7}$/);
export const websiteUrl = z.url({ protocol: /^https$/ }).max(300);

/** The letterhead and signature fields, each cleared with null. */
export const letterheadFields = {
	legalName: text(200),
	address: text(500),
	website: websiteUrl,
	phone: text(40),
	email: z.email().max(200),
	ein: einText,
	tagline: text(200),
	signerName: text(120),
	signerTitle: text(120),
} as const;
export const LETTERHEAD_KEYS = [
	"legalName",
	"address",
	"website",
	"phone",
	"email",
	"ein",
	"tagline",
	"signerName",
	"signerTitle",
] as const;
export type LetterheadKey = (typeof LETTERHEAD_KEYS)[number];

export const contrastBadge = z.enum(["passes_text", "large_text_only", "fails_text"]);
export type ContrastBadge = z.infer<typeof contrastBadge>;
