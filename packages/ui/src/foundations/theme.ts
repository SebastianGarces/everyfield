/** The two product themes. Light is the default (foundations.md). Marketing pages have no theme: they are light only. */
export type ProductTheme = "light" | "dark";

/** The cookie that keeps the person's product theme. The server reads it, so the first paint already has the theme. */
export const THEME_COOKIE = "ef-theme";

/** Reads the cookie value at the request boundary. Anything except "dark" is the default light theme. */
export function parseTheme(value: string | undefined): ProductTheme {
	return value === "dark" ? "dark" : "light";
}
