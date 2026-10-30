import {
	DEFAULT_BODY_FONT,
	DEFAULT_HEADING_FONT,
	FONTS,
	type BrandKitData,
	type DocumentClass,
	type DocumentTheme,
	type HexColor,
	type ThemeLayout,
} from "@everyfield/contracts/branding";
import { contrastOnWhite, textOn } from "./color.ts";

/** Body text in every class and theme. Never a brand color. */
const INK = "#1A1A1A";
const NEUTRAL_RULE = "#9CA3AF";
const NEUTRAL_FILL = "#E5E7EB";
const SERIF_STACK = "Georgia, 'Times New Roman', serif";
const SANS_STACK = "Arial, Helvetica, sans-serif";

export type ThemeChurch = { name: string; kit: BrandKitData | null };
type Colors = { primary: HexColor | null; accent: HexColor | null; heading: HexColor; rule: HexColor; fill: HexColor };

const stackOf = (id: string) => (FONTS.find((font) => font.id === id)?.style === "serif" ? SERIF_STACK : SANS_STACK);

function layoutFor(documentClass: DocumentClass, name: string, kit: BrandKitData | null, fill: HexColor): ThemeLayout {
	const asset = (slot: keyof BrandKitData["assets"]) => kit?.assets[slot] ?? null;
	const fillText = textOn(fill);
	switch (documentClass) {
		case "formal/legal":
			return {
				documentClass,
				headerLogo: asset("full_logo"),
				headerLogoHeightMm: 14,
				footer: { name: kit?.legalName ?? name, address: kit?.address ?? null, ein: kit?.ein ?? null },
				signature: { image: asset("signature"), name: kit?.signerName ?? null, title: kit?.signerTitle ?? null },
				pageNumbers: true,
			};
		case "outward-facing":
			return {
				documentClass,
				coverLogo: asset("full_logo"),
				coverLogoHeightMm: 40,
				coverPhoto: asset("cover_photo"),
				tagline: kit?.tagline ?? null,
				contact: {
					address: kit?.address ?? null,
					website: kit?.website ?? null,
					phone: kit?.phone ?? null,
					email: kit?.email ?? null,
				},
			};
		case "operational":
			return {
				documentClass,
				mark: asset("mark"),
				markHeightMm: 10,
				tableHeader: { fill, text: fillText },
				checkbox: { fill, text: fillText },
			};
		case "email":
			return {
				documentClass,
				headerLogo: asset("full_logo"),
				logoMaxWidthPx: 200,
				button: { fill: "#1F4E79", text: "#FFFFFF" },
				footer: { churchName: name, address: kit?.address ?? null },
			};
	}
}

/**
 * The one place that picks the church theme or the Everyfield-neutral theme. Pure: no I/O. The neutral theme sets the
 * church plant name in type, has no logo and uses the same fixed slot sizes. A brand color under 3:1 against the white
 * page never colors text: neutral ink replaces it, and the color appears only on rules and fills with the derived text
 * color on the fill.
 */
export function resolveDocumentTheme(
	church: ThemeChurch,
	documentClass: DocumentClass,
	options: { useChurchBranding?: boolean } = {},
): DocumentTheme {
	const kit = church.kit;
	const primary = kit?.primaryColor ?? null;
	const brand = (options.useChurchBranding ?? true) && kit !== null && primary !== null;
	const email = documentClass === "email";
	const headingFont = brand ? kit.headingFont : DEFAULT_HEADING_FONT;
	const bodyFont = brand ? kit.bodyFont : DEFAULT_BODY_FONT;
	const colors: Colors = brand
		? {
				primary,
				accent: kit.accentColor ?? primary,
				heading: contrastOnWhite(primary) >= 3 ? primary : INK,
				rule: primary,
				fill: kit.accentColor ?? primary,
			}
		: { primary: null, accent: null, heading: INK, rule: NEUTRAL_RULE, fill: NEUTRAL_FILL };
	return {
		kind: brand ? "church" : "everyfield-neutral",
		churchName: church.name,
		fallbackUsed: email || !brand,
		fonts: email
			? { heading: stackOf(headingFont), body: stackOf(bodyFont) }
			: { heading: headingFont, body: bodyFont },
		colors: { primary: colors.primary, accent: colors.accent, ink: INK, heading: colors.heading, rule: colors.rule },
		layout: layoutFor(documentClass, church.name, brand ? kit : null, colors.fill),
	};
}
