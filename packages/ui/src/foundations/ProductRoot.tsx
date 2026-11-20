"use client";

import { MotionConfig } from "motion/react";
import { createContext, use, useCallback, useMemo, useRef, useState, type ReactNode, type AnimationEvent } from "react";
import { prefersReducedMotion, useHydrated } from "./browser";
import { notePress } from "./focus";
import { THEME_COOKIE, type ProductTheme } from "./theme";

type ThemeState = { theme: ProductTheme; setTheme: (next: ProductTheme) => void };
const ThemeContext = createContext<ThemeState | null>(null);

export function useProductTheme(): ThemeState {
	const state = use(ThemeContext);
	if (!state) throw new Error("useProductTheme needs a ProductRoot above it.");
	return state;
}

const YEAR = 60 * 60 * 24 * 365;

function endThemeFade(event: AnimationEvent<HTMLDivElement>) {
	if (event.target === event.currentTarget && event.animationName.startsWith("ef-theme-fade"))
		event.currentTarget.removeAttribute("data-theme-fade");
}

function fadeTo(el: HTMLDivElement, next: ProductTheme) {
	if (el.dataset.theme === next || prefersReducedMotion()) {
		el.removeAttribute("data-theme-fade");
		return;
	}
	el.setAttribute("data-theme-fade", el.getAttribute("data-theme-fade") === "a" ? "b" : "a");
}

let chosen: ProductTheme | null = null;

export function ProductRoot({ initialTheme, children }: { initialTheme: ProductTheme; children: ReactNode }) {
	const [theme, setThemeState] = useState(() => chosen ?? initialTheme);
	const root = useRef<HTMLDivElement>(null);
	const hydrated = useHydrated();

	const setTheme = useCallback((next: ProductTheme) => {
		chosen = next;
		document.cookie = `${THEME_COOKIE}=${next}; Path=/; Max-Age=${YEAR}; SameSite=Lax`;
		const el = root.current;
		if (el) fadeTo(el, next);
		setThemeState(next);
	}, []);

	const themed = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);

	return (
		<ThemeContext value={themed}>
			<MotionConfig reducedMotion="user">
				<div
					ref={root}
					data-product-root=""
					data-theme={theme}
					data-hydrated={hydrated ? "" : undefined}
					onAnimationEnd={endThemeFade}
					onPointerDownCapture={notePress}
					className="min-h-dvh bg-frame font-sans text-md text-text"
				>
					{children}
				</div>
			</MotionConfig>
		</ThemeContext>
	);
}
