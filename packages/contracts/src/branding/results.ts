import { z } from "zod";
import { correlationId, recordId, revision } from "../common/values.ts";
import {
	ASSET_SLOTS,
	altText,
	assetSlot,
	contrastBadge,
	fontId,
	hexColor,
	LETTERHEAD_KEYS,
	letterheadFields,
	type AssetSlot,
	type LetterheadKey,
} from "./values.ts";

const issue = z.strictObject({ path: z.string().max(200), problem: z.string().max(200) });
const error = <C extends string, D extends z.ZodRawShape>(code: C, details: D, retry: "never" | "refresh") =>
	z.strictObject({ code: z.literal(code), details: z.strictObject(details), correlationId, retry: z.literal(retry) });

/** Every refusal a brand operation returns. */
export const brandError = z.discriminatedUnion("code", [
	error("invalid_input", { issues: z.array(issue).max(50) }, "never"),
	error("access_denied", {}, "never"),
	error("unavailable", {}, "never"),
	error("conflict", {}, "refresh"),
	error("primary_required", {}, "never"),
	error("unsupported_font", {}, "never"),
	error("invalid_ein", {}, "never"),
	error("alt_text_required", {}, "never"),
	error("unsupported_media_type", {}, "never"),
	error("invalid_file", {}, "never"),
]);
export type BrandError = z.infer<typeof brandError>;
export type BrandReply<T> = { status: "ok"; value: T } | { status: "refused"; error: BrandError };

export const colorView = z.strictObject({
	hex: hexColor,
	/** WCAG 2.x contrast against the white page, to two decimals. */
	contrast: z.number().min(1).max(21),
	badge: contrastBadge,
	/** `#000000` or `#FFFFFF`, whichever contrasts more with the color. */
	textColor: z.enum(["#000000", "#FFFFFF"]),
});

/** A ready asset a reader can fetch through the brand asset authorizer. */
export const assetRef = z.strictObject({ fileId: recordId, alt: altText });
const assetsShape = Object.fromEntries(ASSET_SLOTS.map((slot) => [slot, assetRef.nullable()])) as Record<
	AssetSlot,
	z.ZodNullable<typeof assetRef>
>;
export const assetMap = z.strictObject(assetsShape);
const letterheadShape = Object.fromEntries(LETTERHEAD_KEYS.map((key) => [key, letterheadFields[key].nullable()])) as {
	[K in LetterheadKey]: z.ZodNullable<(typeof letterheadFields)[K]>;
};

/** The saved values of a kit. The pure theme resolver reads this shape. */
export const brandKitData = z.strictObject({
	primaryColor: hexColor.nullable(),
	accentColor: hexColor.nullable(),
	headingFont: fontId,
	bodyFont: fontId,
	...letterheadShape,
	assets: assetMap,
});
export type BrandKitData = z.infer<typeof brandKitData>;

/** What `brand.get`, `brand.saveSettings`, `brand.uploadAsset` finalize and `brand.reset` return. */
export const brandKit = brandKitData.extend({
	kitState: z.enum(["default", "saved"]),
	revision,
	/** The primary color, and the accent color or else the primary. Null until a primary color is saved. */
	colors: z.strictObject({ primary: colorView.nullable(), accent: colorView.nullable() }),
});
export type BrandKit = z.infer<typeof brandKit>;

export const uploadTicket = z.strictObject({ uploadId: recordId, expiresAt: z.iso.datetime() });
export const uploadedAsset = z.strictObject({
	uploadId: recordId,
	byteCount: z.int().min(1),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const suggestedColors = z.strictObject({
	suggestedPrimary: hexColor,
	palette: z.array(hexColor).min(1).max(5),
	suggestedFrom: assetSlot,
});

// --- Document theme --------------------------------------------------------------------------------------------------
// There is no field for an Everyfield logo, so a theme cannot carry one.
const themeLogo = z.strictObject({ fileId: recordId, alt: altText });
const lines = z.string().max(500).nullable();
const formalLayout = z.strictObject({
	documentClass: z.literal("formal/legal"),
	headerLogo: themeLogo.nullable(),
	headerLogoHeightMm: z.literal(14),
	footer: z.strictObject({ name: z.string().min(1).max(200), address: lines, ein: z.string().max(10).nullable() }),
	signature: z.strictObject({ image: themeLogo.nullable(), name: lines, title: lines }),
	pageNumbers: z.literal(true),
});
const outwardLayout = z.strictObject({
	documentClass: z.literal("outward-facing"),
	coverLogo: themeLogo.nullable(),
	coverLogoHeightMm: z.literal(40),
	coverPhoto: themeLogo.nullable(),
	tagline: lines,
	contact: z.strictObject({ address: lines, website: lines, phone: lines, email: lines }),
});
const operationalLayout = z.strictObject({
	documentClass: z.literal("operational"),
	mark: themeLogo.nullable(),
	markHeightMm: z.literal(10),
	tableHeader: z.strictObject({ fill: hexColor, text: hexColor }),
	checkbox: z.strictObject({ fill: hexColor, text: hexColor }),
});
const emailLayout = z.strictObject({
	documentClass: z.literal("email"),
	headerLogo: themeLogo.nullable(),
	logoMaxWidthPx: z.literal(200),
	button: z.strictObject({ fill: hexColor, text: z.enum(["#000000", "#FFFFFF"]) }),
	footer: z.strictObject({ churchName: z.string().min(1).max(200), address: lines }),
});
export const themeLayout = z.discriminatedUnion("documentClass", [
	formalLayout,
	outwardLayout,
	operationalLayout,
	emailLayout,
]);
const themeBase = {
	churchName: z.string().min(1).max(200),
	/** True when the brand fonts were replaced (email uses web-safe stacks), or when the neutral theme is in use. */
	fallbackUsed: z.boolean(),
	fonts: z.strictObject({ heading: z.string().min(1).max(200), body: z.string().min(1).max(200) }),
	colors: z.strictObject({
		/** The brand color, null in the neutral theme. */
		primary: hexColor.nullable(),
		accent: hexColor.nullable(),
		/** Body text. Always neutral ink. */
		ink: hexColor,
		/** Heading text. The primary color only when it reaches 3:1 against white, else neutral ink. */
		heading: hexColor,
		/** Rules and fills may use any brand color. */
		rule: hexColor,
	}),
	layout: themeLayout,
};
export const documentTheme = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("church"), ...themeBase }),
	z.strictObject({ kind: z.literal("everyfield-neutral"), ...themeBase }),
]);
export type DocumentTheme = z.infer<typeof documentTheme>;
export type ThemeLayout = z.infer<typeof themeLayout>;
