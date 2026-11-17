import { z } from "zod";
import { defineSafeError, recordId, revision, sha256Text, type Reply } from "../common/values.ts";
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

export const brandError = z.discriminatedUnion("code", [
	defineSafeError("invalid_input", { issues: z.array(issue).max(50) }, "never"),
	defineSafeError("access_denied", {}, "never"),
	defineSafeError("unavailable", {}, "never"),
	defineSafeError("conflict", {}, "refresh"),
	defineSafeError("primary_required", {}, "never"),
	defineSafeError("unsupported_font", {}, "never"),
	defineSafeError("invalid_ein", {}, "never"),
	defineSafeError("alt_text_required", {}, "never"),
	defineSafeError("unsupported_media_type", {}, "never"),
	defineSafeError("invalid_file", {}, "never"),
]);
export type BrandError = z.infer<typeof brandError>;
export type BrandReply<T> = Reply<T, BrandError>;

export const colorView = z.strictObject({
	hex: hexColor,
	contrast: z.number().min(1).max(21),
	badge: contrastBadge,
	textColor: z.enum(["#000000", "#FFFFFF"]),
});

export const assetRef = z.strictObject({ fileId: recordId, alt: altText });
const assetsShape = Object.fromEntries(ASSET_SLOTS.map((slot) => [slot, assetRef.nullable()])) as Record<
	AssetSlot,
	z.ZodNullable<typeof assetRef>
>;
export const assetMap = z.strictObject(assetsShape);
const letterheadShape = Object.fromEntries(LETTERHEAD_KEYS.map((key) => [key, letterheadFields[key].nullable()])) as {
	[K in LetterheadKey]: z.ZodNullable<(typeof letterheadFields)[K]>;
};

export const brandKitData = z.strictObject({
	primaryColor: hexColor.nullable(),
	accentColor: hexColor.nullable(),
	headingFont: fontId,
	bodyFont: fontId,
	...letterheadShape,
	assets: assetMap,
});
export type BrandKitData = z.infer<typeof brandKitData>;

export const brandKit = brandKitData.extend({
	kitState: z.enum(["default", "saved"]),
	revision,
	colors: z.strictObject({ primary: colorView.nullable(), accent: colorView.nullable() }),
});
export type BrandKit = z.infer<typeof brandKit>;

export const uploadTicket = z.strictObject({ uploadId: recordId, expiresAt: z.iso.datetime() });
export const uploadedAsset = z.strictObject({
	uploadId: recordId,
	byteCount: z.int().min(1),
	sha256: sha256Text,
});
export const suggestedColors = z.strictObject({
	suggestedPrimary: hexColor,
	palette: z.array(hexColor).min(1).max(5),
	suggestedFrom: assetSlot,
});

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
	fallbackUsed: z.boolean(),
	fonts: z.strictObject({ heading: z.string().min(1).max(200), body: z.string().min(1).max(200) }),
	colors: z.strictObject({
		primary: hexColor.nullable(),
		accent: hexColor.nullable(),
		ink: hexColor,
		heading: hexColor,
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
