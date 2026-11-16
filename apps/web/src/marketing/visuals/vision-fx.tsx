"use client";

import { prefersReducedMotion } from "@everyfield/ui/foundations";
import { motionValue, type MotionValue } from "motion/react";
import { useMemo, useState, type ReactNode } from "react";
import { out, P, rise } from "@/components/motion/curves";
import { FxProvider } from "@/components/motion/fx";
import { PanelClockProvider } from "@/components/motion/scene";
import { onPageStateChange, runFrames } from "../playback";

const N = [0, 380, 760, 1140, 1420, 1600, 1780] as const;
const END = 2300;
const at = (n: number) => N[Math.max(0, Math.min(n, N.length - 1))]!;
const gap = (n: number) => at(n + 1) - at(n);
const scaleY = (p: number) => "scaleY(" + p.toFixed(4) + ")";

const FX = {
	"vision.card": (t: number, k: number) => rise(t, at(k)),
	"vision.task": (t: number, k: number) => rise(t, at(4 + k)),
	"vision.out": (t: number, n: number) => scaleY(out(P(t, at(n) + 0.35 * gap(n), 0.45 * gap(n)))),
	"vision.in": (t: number, n: number) => scaleY(out(P(t, at(n - 1) + 0.8 * gap(n - 1), 0.35 * gap(n - 1)))),
	"vision.count": (t: number) => 34 * out(P(t, 560, 1000)),
	"vision.ms": (t: number) => "scaleX(" + out(P(t, 940, 600)).toFixed(4) + ")",
};

export function VisionScene({ className, children }: { className?: string; children: ReactNode }) {
	const [t] = useState(() => motionValue(END));
	const clock = useMemo(() => ({ t, since: t, stagger: 0 }), [t]);
	const scene = useMemo(() => playOnce(t), [t]);

	return (
		<div ref={scene} className={className}>
			<FxProvider fx={FX}>
				<PanelClockProvider clock={clock}>{children}</PanelClockProvider>
			</FxProvider>
		</div>
	);
}

function playOnce(t: MotionValue<number>) {
	let settled = false;
	return (el: HTMLDivElement | null) => {
		if (!el) return;
		if (settled || prefersReducedMotion()) {
			settled = true;
			return;
		}
		let stop: (() => void) | undefined;
		let release: (() => void) | undefined;
		const end = () => {
			observer.disconnect();
			release?.();
			release = undefined;
			stop?.();
			stop = undefined;
		};
		const settle = () => {
			if (!prefersReducedMotion()) return;
			settled = true;
			end();
			t.set(END);
		};
		const margin = 0.15;
		let first = true;
		const observer = new IntersectionObserver(
			([e]) => {
				if (!e) return;
				if (first) {
					first = false;
					if (prefersReducedMotion()) {
						settle();
						return;
					}
					const vh = e.rootBounds ? e.rootBounds.bottom / (1 - margin) : 0;
					if (e.boundingClientRect.top < vh) {
						observer.disconnect();
						return;
					}
					t.set(0);
					release = onPageStateChange(settle);
					return;
				}
				if (e.isIntersecting) {
					observer.disconnect();
					stop = runFrames((dt) => {
						const v = Math.min(t.get() + dt, END);
						t.set(v);
						if (v >= END) end();
					});
				}
			},
			{ rootMargin: `0px 0px -${margin * 100}% 0px` },
		);
		observer.observe(el);
		return end;
	};
}
