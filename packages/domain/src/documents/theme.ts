import type { DocumentClass } from "@everyfield/contracts/branding";
import type { Token } from "@everyfield/contracts/documents";
import { hash } from "../operations/canonical.ts";
import { legible, MIN_BODY, MIN_NONTEXT, textOn } from "./contrast.ts";

export type RenderClass = Exclude<DocumentClass, "email">;

type DocumentFont = "DM Sans" | "DM Serif Display";

export type ThemeImage = {
	bytes: Uint8Array;
	mediaType: "image/svg+xml" | "image/png" | "image/jpeg";
	alt: string;
	aspect: number;
};
export type Letterhead = {
	legalName?: string;
	address?: string;
	ein?: string;
	phone?: string;
	email?: string;
	web?: string;
};

export type RenderTheme = {
	name: string;
	primary: string;
	accent: string;
	headingFont?: DocumentFont;
	bodyFont?: DocumentFont;
	logo?: ThemeImage;
	tagline?: string;
	photo?: ThemeImage;
	images?: { logo?: ThemeImage; mark?: ThemeImage; photo?: ThemeImage };
	letterhead?: Letterhead;
};

export const NEUTRAL_THEME: RenderTheme = {
	name: "everyfield-neutral",
	primary: "#181D19",
	accent: "#026B40",
	headingFont: "DM Serif Display",
	bodyFont: "DM Sans",
};

const px = (n: number) => +(n * 0.75).toFixed(2);

const TOKENS = {
	ink: "#181D19",
	white: "#FFFFFF",
	muted: "#EDF0F4",
	mutedText: "#4D5361",
	border: "#DEE0E4",
	fieldBorder: "#666C78",
	size: { xs: px(12), sm: px(13), base: px(14), lg: px(16), h3: px(18), h2: px(22), h1: px(40) },
	space: { 1: px(4), 2: px(8), 3: px(12), 4: px(16), 5: px(20), 6: px(24), 8: px(32), 10: px(40) },
	families: { body: "DM Sans", figures: "EF Figures", display: "DM Serif Display" },
} as const;
export const FONT = TOKENS.families;
export const SIZE = TOKENS.size;
export const SP = TOKENS.space;

export type Palette = {
	ink: string;
	white: string;
	muted: string;
	mutedText: string;
	border: string;
	fieldBorder: string;
	primary: string;
	accent: string;
	onPrimary: string;
	onAccent: string;
	primaryText: string;
	accentLine: string;
	brand: boolean;
};

export function makePalette(theme: RenderTheme): Palette {
	const { ink, white, muted, mutedText, border, fieldBorder } = TOKENS;
	return {
		ink,
		white,
		muted,
		mutedText,
		border,
		fieldBorder,
		primary: theme.primary,
		accent: theme.accent,
		onPrimary: textOn(theme.primary, ink),
		onAccent: textOn(theme.accent, ink),
		primaryText: legible(theme.primary, white, ink, MIN_BODY),
		accentLine: legible(theme.accent, white, ink, MIN_NONTEXT),
		brand: theme.name !== NEUTRAL_THEME.name,
	};
}

export function tokenColor(p: Palette, token: Token): string | null {
	switch (token) {
		case "none":
			return null;
		case "ink":
			return p.ink;
		case "muted-text":
			return p.mutedText;
		case "primary":
			return p.primary;
		case "accent":
			return p.accent;
		case "muted":
			return p.muted;
		case "border":
			return p.border;
	}
}

export function themeTokensDigest() {
	return hash({ tokens: TOKENS, neutral: NEUTRAL_THEME });
}
