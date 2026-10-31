import {
	ASSET_MAX_BYTES,
	ASSET_MEDIA_TYPES,
	type AssetSlot,
	type BrandKitData,
	type HexColor,
} from "@everyfield/contracts/branding";
import type { BrandError, BrandKit, BrandPort, SuggestedColors } from "../port";
import { BRAND_ERROR_TEXT } from "./model.ts";

// The pure rules of the "Logos and images" group: the slots, the checks made before any request, the three-step
// upload and the one-patch removal. They call the port the screen uses, so the same code runs against the server and
// the fixture. No React.

export const SLOT_ORDER = ["full_logo", "full_logo_dark", "mark", "mark_dark", "cover_photo", "signature"] as const;

const TYPES = "SVG, PNG or WebP, up to 3 MB";
export const SLOT_INFO: Record<AssetSlot, { label: string; guidance: string; logo: boolean; dark: boolean }> = {
	full_logo: { label: "Full logo", guidance: `${TYPES}. About 3:1, wider than tall.`, logo: true, dark: false },
	full_logo_dark: {
		label: "Full logo (on dark)",
		guidance: `${TYPES}. About 3:1, light colors for dark backgrounds.`,
		logo: true,
		dark: true,
	},
	mark: { label: "Mark", guidance: `${TYPES}. Square.`, logo: true, dark: false },
	mark_dark: {
		label: "Mark (on dark)",
		guidance: `${TYPES}. Square, light colors for dark backgrounds.`,
		logo: true,
		dark: true,
	},
	cover_photo: {
		label: "Cover photo",
		guidance: `${TYPES}. Shown on outward-facing covers.`,
		logo: false,
		dark: false,
	},
	signature: {
		label: "Signature",
		guidance: `${TYPES}. The signer's signature on a plain background.`,
		logo: false,
		dark: false,
	},
};

/** Only these two slots feed brand.suggestColors (REQ-BRD-003). */
export const canSuggest = (slot: AssetSlot) => slot === "full_logo" || slot === "mark";

export const ACCEPT = ASSET_MEDIA_TYPES.join(",");

/** The check before any request (criterion 4). The message names the reason and the limit. */
export function fileProblem(file: { size: number; type: string }): string | null {
	if (!(ASSET_MEDIA_TYPES as readonly string[]).includes(file.type))
		return "That file type is not supported. Use an SVG, PNG or WebP image.";
	if (file.size === 0) return "That file is empty. Choose another image.";
	if (file.size > ASSET_MAX_BYTES) return "That file is over the 3 MB limit. Choose a smaller image.";
	return null;
}

/** The alt text rule of the contract: blank or whitespace-only text is refused before anything is sent. */
export const ALT_REQUIRED = "Add a description of the image.";
export const altProblem = (alt: string) => (alt.trim() === "" ? ALT_REQUIRED : null);

/** What the slot says for each refusal an upload step can return. */
export function assetMessage(error: BrandError): string {
	switch (error.code) {
		case "alt_text_required":
			return ALT_REQUIRED;
		case "invalid_input":
			return "The upload was not valid. Check the file and the description, then try again.";
		case "access_denied":
			return "You no longer have access to upload images. Ask an Owner or Admin of your church.";
		case "unavailable":
			return "The image could not be uploaded right now. Try again.";
		default:
			return BRAND_ERROR_TEXT[error.code];
	}
}

export type UploadOutcome =
	| { ok: true; kit: BrandKit }
	| { ok: false; error: BrandError }
	/** The reply never arrived, so a step may or may not have been applied. */
	| { ok: false; error: null };

/**
 * requestUpload, the byte upload and finalizeUpload, in that order, with the revision read when the last step starts.
 * The first refusal ends it and names the step's own error.
 */
export async function uploadAsset(
	port: BrandPort,
	input: { slot: AssetSlot; file: File; altText: string; revision: () => string },
): Promise<UploadOutcome> {
	try {
		const { slot, file, altText } = input;
		const ticket = await port.requestUpload({
			slot,
			mediaType: file.type as (typeof ASSET_MEDIA_TYPES)[number],
			byteLength: file.size,
			altText,
		});
		if (ticket.status === "refused") return { ok: false, error: ticket.error };
		const sent = await port.uploadBytes(ticket.value.uploadId, file);
		if (sent.status === "refused") return { ok: false, error: sent.error };
		const done = await port.finalizeUpload({
			uploadId: ticket.value.uploadId,
			slot,
			altText,
			expectedRevision: input.revision(),
		});
		return done.status === "ok" ? { ok: true, kit: done.value } : { ok: false, error: done.error };
	} catch {
		return { ok: false, error: null };
	}
}

/** The kit with one slot emptied, shown at once while the removal runs. */
export const withoutAsset = (kit: BrandKit, slot: AssetSlot): BrandKit => ({
	...kit,
	assets: { ...kit.assets, [slot]: null } as BrandKitData["assets"],
});

/** One brand.saveSettings with `assets: { <slot>: null }` and the revision read now. */
export async function removeAsset(port: BrandPort, slot: AssetSlot, revision: string): Promise<UploadOutcome> {
	try {
		const reply = await port.save({ expectedRevision: revision, patch: { assets: { [slot]: null } } });
		return reply.status === "ok" ? { ok: true, kit: reply.value } : { ok: false, error: reply.error };
	} catch {
		return { ok: false, error: null };
	}
}

/** The suggestion for a slot, or null when the call is refused or lost; a missing suggestion is never an error. */
export async function suggestFor(port: BrandPort, slot: AssetSlot): Promise<SuggestedColors | null> {
	try {
		const reply = await port.suggestColors({ assetKind: slot });
		return reply.status === "ok" ? reply.value : null;
	} catch {
		return null;
	}
}

export type SwatchBackground = { name: "Light" | "Dark" | "Brand"; color: string; note?: string };

const LIGHT = "white";
const DARK = "var(--color-ink-fixed)";
/**
 * The three swatches a logo shows on. The brand swatch uses the draft primary color, else the theme's neutral ink
 * with a note.
 */
export function backgrounds(primary: HexColor | null, neutralInk: string): SwatchBackground[] {
	return [
		{ name: "Light", color: LIGHT },
		{ name: "Dark", color: DARK },
		primary
			? { name: "Brand", color: primary }
			: { name: "Brand", color: neutralInk, note: "No primary color yet, so this shows neutral ink." },
	];
}
