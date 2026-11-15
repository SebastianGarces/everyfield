"use client";

import { MotionConfig } from "motion/react";
import { createContext, use, useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { prefersReducedMotion } from "./browser";
import { THEME_COOKIE, type ProductTheme } from "./theme";

type ThemeState = { theme: ProductTheme; setTheme: (next: ProductTheme) => void };
const ThemeContext = createContext<ThemeState | null>(null);

export function useProductTheme(): ThemeState {
	const state = use(ThemeContext);
	if (!state) throw new Error("useProductTheme needs a ProductRoot above it.");
	return state;
}

const YEAR = 60 * 60 * 24 * 365;

let chosen: ProductTheme | null = null;

export function ProductRoot({ initialTheme, children }: { initialTheme: ProductTheme; children: ReactNode }) {
	const [theme, setThemeState] = useState(() => chosen ?? initialTheme);
	const root = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		const html = document.documentElement;
		html.setAttribute("data-theme", theme);
		return () => html.removeAttribute("data-theme");
	}, [theme]);

	const setTheme = useCallback((next: ProductTheme) => {
		chosen = next;
		document.cookie = `${THEME_COOKIE}=${next}; Path=/; Max-Age=${YEAR}; SameSite=Lax`;
		const el = root.current;
		if (el && el.dataset.theme !== next && !prefersReducedMotion()) el.setAttribute("data-theme-fade", "");
		setThemeState(next);
	}, []);

	return (
		<ThemeContext value={{ theme, setTheme }}>
			<MotionConfig reducedMotion="user">
				<div
					ref={root}
					data-product-root=""
					data-theme={theme}
					onTransitionEnd={(event) => {
						if (event.target === event.currentTarget && event.propertyName === "background-color")
							event.currentTarget.removeAttribute("data-theme-fade");
					}}
					className="min-h-dvh bg-frame font-sans text-md text-text"
				>
					{children}
				</div>
			</MotionConfig>
		</ThemeContext>
	);
}
