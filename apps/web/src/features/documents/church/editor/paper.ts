import type { DocBrand } from "@everyfield/contracts/documents";
import type { CSSProperties } from "react";

/** What each color token of the format paints on the paper page: the PDF's palette for this document. */
export function paletteVars(palette: DocBrand["palette"]): CSSProperties {
	return {
		"--tok-ink": palette.ink,
		"--tok-muted-text": palette.mutedText,
		"--tok-primary": palette.primary,
		"--tok-accent": palette.accent,
		"--tok-accent-line": palette.accentLine,
		"--tok-muted": palette.muted,
		"--tok-border": palette.border,
		"--on-ink": palette.on.ink,
		"--on-muted-text": palette.on["muted-text"],
		"--on-primary": palette.on.primary,
		"--on-accent": palette.on.accent,
		"--on-muted": palette.on.muted,
		"--on-border": palette.on.border,
	} as CSSProperties;
}
