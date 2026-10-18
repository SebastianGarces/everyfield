"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { cn } from "../cn";

/**
 * A block that rises 18 px and fades in once when it scrolls into view (transform and opacity, CSS transition).
 * Blocks already on screen when the page opens are never hidden, so the first paint is complete without JavaScript;
 * a block below the fold is hidden only after the first IntersectionObserver report says it is off screen. The
 * report carries the geometry, so nothing reads layout. Reduced motion: nothing happens.
 * up: the block after the phases rail rises further (28 px over .5 s) and also shows once it has been scrolled past.
 */
export function useReveal(ref: RefObject<HTMLElement | null>, up?: boolean) {
	useEffect(() => {
		const el = ref.current;
		if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		const margin = up ? 0.12 : 0.08;
		let first = true;
		const io = new IntersectionObserver(
			([e]) => {
				if (!e) return;
				if (first) {
					first = false;
					const vh = e.rootBounds ? e.rootBounds.bottom / (1 - margin) : 0;
					if (e.boundingClientRect.top < vh * 0.92) {
						io.disconnect();
						return;
					}
					el.dataset.rv = "wait";
					return;
				}
				if (e.isIntersecting || (up && e.boundingClientRect.bottom < 0)) {
					el.dataset.rv = "in";
					io.disconnect();
				}
			},
			{ rootMargin: `0px 0px -${margin * 100}% 0px`, threshold: up ? 0 : 0.08 },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [ref, up]);
}

/** Classes and style of a revealed block. delay: start delay in ms (siblings stagger 70 ms apart, at most 280 ms). */
export function revealProps(delay = 0, up?: boolean) {
	return {
		className: cn(
			"data-[rv=wait]:opacity-0 data-[rv=wait]:[transform:translateY(var(--rv-y))] motion-reduce:[transition:none]",
			up
				? "[--rv-y:28px] [transition:opacity_.5s_var(--ease-mk),transform_.5s_var(--ease-mk)]"
				: "[--rv-y:18px] [transition:opacity_.4s_var(--ease-mk),transform_.4s_var(--ease-mk)] [transition-delay:var(--rv-d)]",
		),
		style: { "--rv-d": delay + "ms" } as CSSProperties,
	};
}

type Props = { children: ReactNode; className?: string; delay?: number; up?: boolean };

/** A div that rises in once (see useReveal). */
export function Reveal({ children, className, delay = 0, up }: Props) {
	const ref = useRef<HTMLDivElement>(null);
	useReveal(ref, up);
	const r = revealProps(delay, up);
	return (
		<div ref={ref} className={cn(r.className, className)} style={r.style}>
			{children}
		</div>
	);
}
