"use client";

import { MotionConfig } from "motion/react";
import { createContext, use, useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { THEME_COOKIE, type ProductTheme } from "./theme";

type ThemeState = { theme: ProductTheme; setTheme: (next: ProductTheme) => void };
const ThemeContext = createContext<ThemeState | null>(null);

export function useProductTheme(): ThemeState {
	const state = use(ThemeContext);
	if (!state) throw new Error("useProductTheme needs a ProductRoot above it.");
	return state;
}

const YEAR = 60 * 60 * 24 * 365;
const FADE_MS = 300;

let chosen: ProductTheme | null = null;

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
