"use client";

import { observeSize } from "@everyfield/ui/foundations";
import type { ReactNode } from "react";

const SHELL_GAP_BELOW_FRAME = 24;
const MIN_FRAME_HEIGHT = 320;

const fitToViewport = observeSize<HTMLDivElement>(
	(el) => {
		const top = el.getBoundingClientRect().top + window.scrollY;
		el.style.setProperty(
			"--frame-h",
			`${Math.max(window.innerHeight - top - SHELL_GAP_BELOW_FRAME, MIN_FRAME_HEIGHT)}px`,
		);
	},
	{ also: () => [document.body], viewport: true },
);

export function FixedFrame({ fixed, className, children }: { fixed: boolean; className: string; children: ReactNode }) {
	return (
		<div ref={fixed ? fitToViewport : undefined} className={fixed ? className : undefined}>
			{children}
		</div>
	);
}
