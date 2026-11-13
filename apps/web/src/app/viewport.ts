import type { ProductTheme } from "@everyfield/ui/foundations";
import type { Viewport } from "next";

/**
 * The browser chrome colour and color-scheme for each product theme, sent on the first response. Light is the
 * marketing canvas, which the root layout gives every marketing page. Dark is the product's dark page frame,
 * `--ef-frame` under `[data-theme="dark"]` in design/handoff/tokens.css.
 */
export const THEME_VIEWPORT = {
	light: { themeColor: "#FCFBF8", colorScheme: "light" },
	dark: { themeColor: "#0F1115", colorScheme: "dark" },
} as const satisfies Record<ProductTheme, Viewport>;
