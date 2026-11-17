"use client";

import { frame, useTransform, type MotionValue } from "motion/react";
import { useReducedMotion } from "@everyfield/ui/foundations";
import { createContext, useCallback, useContext, type ReactNode } from "react";
import { transformOf, type Frame } from "./curves";

export function useTo(t: MotionValue<number>, f: (t: number) => Frame) {
	const transform = useTransform(t, (v) => {
		const [x, y, s] = f(v);
		return transformOf(x, y, s);
	});
	const opacity = useTransform(t, (v) => +f(v)[3].toFixed(3));
	return { transform, opacity };
}

export function useText(t: MotionValue<number>, f: (t: number) => string) {
	return useTransform(t, f);
}

export type PanelClock = { t: MotionValue<number>; since: MotionValue<number>; stagger: number };
const PanelContext = createContext<PanelClock | null>(null);
export function PanelClockProvider({ clock, children }: { clock: PanelClock; children: ReactNode }) {
	return <PanelContext value={clock}>{children}</PanelContext>;
}
export function usePanelClock() {
	const c = useContext(PanelContext);
	if (!c) throw new Error("a panel must render inside a chapter (PanelClockProvider)");
	return c;
}

export function MText({
	value,
	className,
	...rest
}: {
	value: MotionValue<string>;
	className?: string;
	"data-n"?: string;
}) {
	const follow = useCallback(
		(el: HTMLSpanElement | null) => {
			if (!el) return;
			el.textContent = value.get();
			return value.on("change", (v) =>
				frame.render(() => {
					el.textContent = v;
				}),
			);
		},
		[value],
	);
	return (
		<span ref={follow} className={className} {...rest} suppressHydrationWarning>
			{value.get()}
		</span>
	);
}

export const useReduced = useReducedMotion;
