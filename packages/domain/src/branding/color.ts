import type { ContrastBadge, HexColor } from "@everyfield/contracts/branding";

export function luminance(hex: string): number {
	const channel = (offset: number) => {
		const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
export const contrastOnWhite = (hex: string) => 1.05 / (luminance(hex) + 0.05);
export const badgeFor = (ratio: number): ContrastBadge =>
	ratio >= 4.5 ? "passes_text" : ratio >= 3 ? "large_text_only" : "fails_text";
export const ratio = (a: string, b: string) => {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
};
export const DOCUMENT_INK = "#181D19";
export function textOn<Ink extends string = "#000000">(bg: string, ink?: Ink, white = "#FFFFFF") {
	const dark = ink ?? "#000000";
	const best = ratio(white, bg) >= ratio(dark, bg) ? white : dark;
	return (ratio(best, bg) >= 4.5 ? best : "#000000") as Ink | "#000000" | "#FFFFFF";
}
export function colorView(hex: HexColor) {
	const ratio = contrastOnWhite(hex);
	return { hex, contrast: Math.round(ratio * 100) / 100, badge: badgeFor(ratio), textColor: textOn(hex) };
}
