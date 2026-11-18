"use client";

import { prefersReducedMotion } from "@everyfield/ui/foundations";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "../cn";

function revealOnceInView(up: boolean) {
	return (el: HTMLElement | null) => {
		if (!el || prefersReducedMotion()) return;
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
	};
}

const REVEAL = { rise: revealOnceInView(false), riseFurther: revealOnceInView(true) };

export const revealRef = (up?: boolean) => (up ? REVEAL.riseFurther : REVEAL.rise);

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

export function Reveal({ children, className, delay = 0, up }: Props) {
	const r = revealProps(delay, up);
	return (
		<div ref={revealRef(up)} className={cn(r.className, className)} style={r.style}>
			{children}
		</div>
	);
}
