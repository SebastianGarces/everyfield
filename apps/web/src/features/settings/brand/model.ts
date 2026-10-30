import {
	LETTERHEAD_KEYS,
	hexColor,
	letterheadFields,
	type BrandKitData,
	type ContrastBadge,
	type DocumentClass,
	type FontId,
	type LetterheadKey,
} from "@everyfield/contracts/branding";
import { colorView } from "@everyfield/domain/branding/color";
import { resolveDocumentTheme } from "@everyfield/domain/branding/theme";
import type { BrandError, BrandKit, SaveBrandRequest } from "../port";

// Pure brand kit rules for the screen: the form a kit becomes, its validation (the contract's own schemas), the patch a
// save sends and the theme the preview resolves. No imports from React or the server.

/** Text inputs hold strings; an empty optional field saves as null (clearing a field saves it as cleared). */
export type BrandForm = {
	primaryColor: string;
	accentColor: string;
	headingFont: FontId;
	bodyFont: FontId;
} & Record<LetterheadKey, string>;

export function formOf(kit: BrandKit): BrandForm {
	return {
		primaryColor: kit.primaryColor ?? "",
		accentColor: kit.accentColor ?? "",
		headingFont: kit.headingFont,
		bodyFont: kit.bodyFont,
		...(Object.fromEntries(LETTERHEAD_KEYS.map((key) => [key, kit[key] ?? ""])) as Record<LetterheadKey, string>),
	};
}

/**
 * A color field keeps the letters upper case and the leading #, as the server stores them, so typing the saved color
 * is not a change.
 */
export function normalizeHex(value: string): string {
	const text = value.trim().toUpperCase();
	return text === "" || text.startsWith("#") ? text : `#${text}`;
}

const isHex = (value: string) => hexColor.safeParse(value).success;

export type Errors = Partial<Record<keyof BrandForm, string>>;

const LETTERHEAD_ERROR: Partial<Record<LetterheadKey, string>> = {
	ein: "Use the format 12-3456789.",
	website: "Start with https://, for example https://example.org.",
	email: "Enter a full email address.",
};

/** The contract's own schema decides, so the client cannot accept what the server refuses. */
function letterheadError(key: LetterheadKey, value: string): string | undefined {
	const text = value.trim();
	if (text === "" || letterheadFields[key].safeParse(text).success) return undefined;
	return LETTERHEAD_ERROR[key] ?? "Shorten this text.";
}

/**
 * Field errors. A color that is not `#RRGGBB` and a malformed letterhead value always show. A missing primary color
 * shows only with `required` (after Save is pressed), so an empty form does not open in error.
 */
export function validate(form: BrandForm, { required }: { required: boolean }): Errors {
	const errors: Errors = {};
	if (form.primaryColor === "") {
		if (required) errors.primaryColor = "Choose a primary color.";
	} else if (!isHex(form.primaryColor)) errors.primaryColor = "Use the form #RRGGBB.";
	if (form.accentColor !== "" && !isHex(form.accentColor)) errors.accentColor = "Use the form #RRGGBB.";
	for (const key of LETTERHEAD_KEYS) {
		const problem = letterheadError(key, form[key]);
		if (problem) errors[key] = problem;
	}
	return errors;
}

/** Only the fields that differ from the saved form. A cleared optional field is null. */
export function patchOf(form: BrandForm, saved: BrandForm): SaveBrandRequest["patch"] {
	const patch: Record<string, unknown> = {};
	if (form.primaryColor !== saved.primaryColor) patch.primaryColor = form.primaryColor;
	if (form.accentColor !== saved.accentColor) patch.accentColor = form.accentColor === "" ? null : form.accentColor;
	if (form.headingFont !== saved.headingFont) patch.headingFont = form.headingFont;
	if (form.bodyFont !== saved.bodyFont) patch.bodyFont = form.bodyFont;
	for (const key of LETTERHEAD_KEYS) {
		const next = form[key].trim();
		if (next !== saved[key]) patch[key] = next === "" ? null : next;
	}
	return patch as SaveBrandRequest["patch"];
}

/** The draft as the saved-kit shape the theme resolver reads. A value that would not save is left out. */
function draftKit(form: BrandForm): BrandKitData {
	const color = (value: string) => (isHex(value) ? hexColor.parse(value) : null);
	const letterhead = Object.fromEntries(
		LETTERHEAD_KEYS.map((key) => [
			key,
			letterheadError(key, form[key]) || form[key].trim() === "" ? null : form[key].trim(),
		]),
	) as Record<LetterheadKey, never>;
	return {
		primaryColor: color(form.primaryColor),
		accentColor: color(form.accentColor),
		headingFont: form.headingFont,
		bodyFont: form.bodyFont,
		...letterhead,
		assets: { full_logo: null, full_logo_dark: null, mark: null, mark_dark: null, cover_photo: null, signature: null },
	};
}

/** The preview's theme: the same function the server resolves with, over the unsaved draft. */
export const themeOf = (churchName: string, form: BrandForm, documentClass: DocumentClass) =>
	resolveDocumentTheme({ name: churchName, kit: draftKit(form) }, documentClass);

/** The WCAG view of a typed color, or null while it is empty or not `#RRGGBB`. Same function as the server's. */
export const colorOf = (value: string) => (isHex(value) ? colorView(hexColor.parse(value)) : null);

/** The derived text color on a brand color, in words. */
export const textColorName = (textColor: string) => (textColor.endsWith("FFFFFF") ? "White" : "Black");

/**
 * The kit as a save of this form will leave it, shown at once while the save runs (REQ: update the screen
 * optimistically). The revision stays until the server confirms. Contrast comes from the server's own function.
 */
export function optimisticKit(kit: BrandKit, form: BrandForm): BrandKit {
	const data = draftKit(form);
	const primary = data.primaryColor;
	return {
		...data,
		assets: kit.assets,
		kitState: "saved",
		revision: kit.revision,
		colors: {
			primary: primary ? colorView(primary) : null,
			accent: primary ? colorView(data.accentColor ?? primary) : null,
		},
	};
}

export const BADGE_WORDS: Record<ContrastBadge, string> = {
	passes_text: "passes text",
	large_text_only: "large text only",
	fails_text: "fails text",
};
export const formatRatio = (contrast: number) => `${contrast.toFixed(2)}:1`;

/** What the person reads for each refusal (criterion 13). `invalid_ein` also marks the EIN field. */
export const BRAND_ERROR_TEXT: Record<BrandError["code"], string> = {
	invalid_input: "Some values are not valid. Check the fields marked in red.",
	access_denied: "You no longer have access to the brand kit. Ask an Owner or Admin of your church.",
	unavailable: "The brand kit is not available right now. Try again.",
	conflict:
		"Someone else saved the brand kit after you opened it. Load the latest version, then make your change again.",
	primary_required: "Choose a primary color before you save.",
	unsupported_font: "That font is not in the list. Choose another font.",
	invalid_ein: "The EIN is not valid. The kit is unchanged. Use the format 12-3456789.",
	alt_text_required: "Add a description for the image.",
	unsupported_media_type: "That file type is not supported.",
	invalid_file: "That file could not be used.",
};
