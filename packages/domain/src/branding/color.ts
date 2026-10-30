import type { ContrastBadge, HexColor } from "@everyfield/contracts/branding";

/** WCAG 2.x relative luminance of `#RRGGBB`. */
function luminance(hex: string): number {
	const channel = (offset: number) => {
		const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
/** Contrast ratio of a color against the white page `#FFFFFF`. */
export const contrastOnWhite = (hex: string) => 1.05 / (luminance(hex) + 0.05);
/** Needs 4.5:1 for text, 3:1 for large text. A color under 3:1 is never text. */
export const badgeFor = (ratio: number): ContrastBadge =>
	ratio >= 4.5 ? "passes_text" : ratio >= 3 ? "large_text_only" : "fails_text";
/** The text color to set on a fill: `#000000` or `#FFFFFF`, whichever contrasts more. Always reaches 4.5:1. */
export function textOn(hex: string): "#000000" | "#FFFFFF" {
	const l = luminance(hex);
	return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? "#000000" : "#FFFFFF";
}
export function colorView(hex: HexColor) {
	const ratio = contrastOnWhite(hex);
	return { hex, contrast: Math.round(ratio * 100) / 100, badge: badgeFor(ratio), textColor: textOn(hex) };
}
