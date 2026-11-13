"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";

/**
 * A page region that fills the space below its own top, down to the layout's bottom margin. It reads its own top, so a
 * banner or card above it never pushes the page into a scroll, and no shell size is fixed here. `className` holds the
 * width-gated classes that use `--frame-h` (wiki/layout.ts, meetings/MeetingScreen.tsx); they apply only while `fixed`.
 */
export function FixedFrame({ fixed, className, children }: { fixed: boolean; className: string; children: ReactNode }) {
	const frame = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const el = frame.current;
		if (!el || !fixed) return;
		const fit = () => {
			// The shell leaves 96px under the page; the frame's -72px margin leaves 24px.
			const top = el.getBoundingClientRect().top + window.scrollY;
			el.style.setProperty("--frame-h", `${Math.max(window.innerHeight - top - 24, 320)}px`);
		};
		fit();
		const watch = new ResizeObserver(fit);
		watch.observe(document.body);
		window.addEventListener("resize", fit);
		return () => {
			watch.disconnect();
			window.removeEventListener("resize", fit);
		};
	}, [fixed]);
	return (
		<div ref={frame} className={fixed ? className : undefined}>
			{children}
		</div>
	);
}
