export type ProductTheme = "light" | "dark";

export const THEME_COOKIE = "ef-theme";

export function parseTheme(value: string | undefined): ProductTheme {
	return value === "dark" ? "dark" : "light";
}
