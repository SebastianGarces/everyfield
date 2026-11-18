import type { ProductTheme } from "@everyfield/ui/foundations";
import type { Viewport } from "next";

export const THEME_VIEWPORT = {
	light: { themeColor: "#FCFBF8", colorScheme: "light" },
	dark: { themeColor: "#0F1115", colorScheme: "dark" },
} as const satisfies Record<ProductTheme, Viewport>;
