import { z } from "zod";
import { recordId, revision } from "../common/values.ts";
import {
	ASSET_MAX_BYTES,
	altText,
	assetMediaType,
	assetSlot,
	documentClass,
	fontId,
	hexColor,
	letterheadFields,
	LETTERHEAD_KEYS,
	type LetterheadKey,
} from "./values.ts";

export const getRequest = z.strictObject({});

const letterheadPatch = Object.fromEntries(
	LETTERHEAD_KEYS.map((key) => [key, letterheadFields[key].nullable().optional()]),
) as { [K in LetterheadKey]: z.ZodOptional<z.ZodNullable<(typeof letterheadFields)[K]>> };

/** One patch of closed fields. A missing field stays; null clears it. The primary color cannot be cleared. */
export const settingsPatch = z
	.strictObject({
		primaryColor: hexColor.optional(),
		accentColor: hexColor.nullable().optional(),
		headingFont: fontId.optional(),
		bodyFont: fontId.optional(),
		...letterheadPatch,
		/** Only null is accepted: it removes the asset and its alt text. An upload attaches a new one. */
		assets: z.strictObject(Object.fromEntries(assetSlot.options.map((s) => [s, z.null().optional()]))).optional(),
	})
	.refine((patch) => Object.values(patch).some((value) => value !== undefined), "Name at least one field to change.");
export const saveSettingsRequest = z.strictObject({ expectedRevision: revision, patch: settingsPatch });

export const uploadRequest = z.strictObject({
	slot: assetSlot,
	mediaType: assetMediaType,
	byteLength: z.int().min(1).max(ASSET_MAX_BYTES),
	altText,
});
export const finalizeUploadRequest = z.strictObject({
	uploadId: recordId,
	slot: assetSlot,
	altText,
	expectedRevision: revision,
});
export const suggestColorsRequest = z.strictObject({ assetKind: assetSlot });
export const resetRequest = z.strictObject({ expectedRevision: revision });
export const resolveThemeRequest = z.strictObject({
	documentClass,
	useChurchBranding: z.boolean().default(true),
});
