"use client";

import { MotionConfig } from "motion/react";
import { createContext, use, useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { THEME_COOKIE, type ProductTheme } from "./theme";

type ThemeState = { theme: ProductTheme; setTheme: (next: ProductTheme) => void };
const ThemeContext = createContext<ThemeState | null>(null);

/** The current product theme and its setter. Only components inside ProductRoot can use it. */
export function useProductTheme(): ThemeState {
	const state = use(ThemeContext);
	if (!state) throw new Error("useProductTheme needs a ProductRoot above it.");
	return state;
}

const YEAR = 60 * 60 * 24 * 365;
const FADE_MS = 300;

/**
 * The theme chosen in this document, if the person switched it. The router can restore a cached product page with
 * the theme its server render had (Back after a visit to a marketing page), so a remount must prefer the last
 * choice. Module state lives as long as the document; a full load starts again from the server's cookie value.
 */
let chosen: ProductTheme | null = null;

/**
 * The root of every product page. Marketing pages never render it, so they stay light under every browser and system
 * setting: the dark tokens in tokens.css apply only under an element with data-theme="dark", and only this component
 * sets that attribute.
 *
 * The server passes the theme from the cookie, so the first paint is already correct and no inline script is needed.
 * While a product page is mounted, the attribute is mirrored to <html> so overlays portalled to <body> and the page
 * scrollbar use the same theme. The mirror is a layout effect: React removes it in the same commit that unmounts the
 * product tree, before the browser paints the next page, so a client navigation to a marketing page never shows dark.
 */
export function ProductRoot({ initialTheme, children }: { initialTheme: ProductTheme; children: ReactNode }) {
	const [theme, setThemeState] = useState(() => chosen ?? initialTheme);
	const root = useRef<HTMLDivElement>(null);
	const fadeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

	useLayoutEffect(() => {
		const html = document.documentElement;
		html.setAttribute("data-theme", theme);
		return () => html.removeAttribute("data-theme");
	}, [theme]);

	const setTheme = useCallback((next: ProductTheme) => {
		chosen = next;
		document.cookie = `${THEME_COOKIE}=${next}; Path=/; Max-Age=${YEAR}; SameSite=Lax`;
		const el = root.current;
		// The theme switch cross-fades colors for 0.3s (foundations.md, Motion), except under reduced motion.
		if (el && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
			el.setAttribute("data-theme-fade", "");
			clearTimeout(fadeTimer.current);
			fadeTimer.current = setTimeout(() => el.removeAttribute("data-theme-fade"), FADE_MS);
		}
		setThemeState(next);
	}, []);

	return (
		<ThemeContext value={{ theme, setTheme }}>
			<MotionConfig reducedMotion="user">
				<div
					ref={root}
					data-product-root=""
					data-theme={theme}
					className="min-h-dvh bg-frame font-sans text-md text-text"
				>
					{children}
				</div>
			</MotionConfig>
		</ThemeContext>
	);
}
