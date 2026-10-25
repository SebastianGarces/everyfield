"use client";

import { motionValue } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { out, P, rise } from "@/components/motion/curves";
import { FxProvider } from "@/components/motion/fx";
import { PanelClockProvider, useReduced, useTicker } from "@/components/motion/scene";

// Timing of "The vision, down to this week" (VisionZoom renders the markup on the server). The levels land one after
// another, from Launch Sunday down to this week's tasks, and the line between them grows down as each one lands.
// Transform and opacity only: every element already holds its final place, so nothing shifts.

/** When each node lands (ms): Launch Sunday, the phase, the launch milestone, the week card, then the three tasks. */
const N = [0, 380, 760, 1140, 1420, 1600, 1780] as const;
const END = 2300;
const at = (n: number) => N[Math.max(0, Math.min(n, N.length - 1))]!;
const gap = (n: number) => at(n + 1) - at(n);
const scaleY = (p: number) => "scaleY(" + p.toFixed(4) + ")";

const FX = {
	/** The four level cards rise in (the week card is level 3). */
	"vision.card": (t: number, k: number) => rise(t, at(k)),
	/** A task row inside the week card. */
	"vision.task": (t: number, k: number) => rise(t, at(4 + k)),
	/** The line from node n down to the next one: the part inside node n (from its icon to its bottom edge) ... */
	"vision.out": (t: number, n: number) => scaleY(out(P(t, at(n) + 0.35 * gap(n), 0.45 * gap(n)))),
	/** ... and the part inside the next node (from its top edge to its icon). */
	"vision.in": (t: number, n: number) => scaleY(out(P(t, at(n - 1) + 0.8 * gap(n - 1), 0.35 * gap(n - 1)))),
	/** The committed adults count rises once the phase has landed. */
	"vision.count": (t: number) => 34 * out(P(t, 560, 1000)),
	/** The launch milestone: its first task's segment fills. */
	"vision.ms": (t: number) => "scaleX(" + out(P(t, 940, 600)).toFixed(4) + ")",
};

/**
 * The clock of the zoom. The server renders the settled end state, so the first paint is complete without JavaScript.
 * The first IntersectionObserver report decides: a zoom already on screen stays settled; one below the fold goes to its
 * first frame and plays once when it scrolls in. The report carries the geometry, so nothing reads layout. Reduced
 * motion: nothing moves and the end state stays; turned on later (before or during the entrance), it jumps to the end
 * state at once and the zoom never plays again, even if reduced motion is turned off afterwards.
 */
export function VisionScene({ className, children }: { className?: string; children: ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);
	const [t] = useState(() => motionValue(END));
	const clock = useMemo(() => ({ t, since: t, stagger: 0 }), [t]);
	const [run, setRun] = useState(false);
	const reduced = useReduced();
	const settled = useRef(false);

	// Reduced motion stops the clock; the effect below puts it at the end, so a later resume finishes on its first step.
	useTicker(run && !reduced, (dt) => {
		const v = Math.min(t.get() + dt, END);
		t.set(v);
		if (v >= END) setRun(false);
	});

	useEffect(() => {
		if (!reduced) return;
		settled.current = true;
		t.set(END);
	}, [reduced, t]);

	useEffect(() => {
		const el = ref.current;
		if (!el || reduced || settled.current) return;
		const margin = 0.15;
		let first = true;
		const io = new IntersectionObserver(
			([e]) => {
				if (!e) return;
				if (first) {
					first = false;
					const vh = e.rootBounds ? e.rootBounds.bottom / (1 - margin) : 0;
					if (e.boundingClientRect.top < vh) {
						io.disconnect();
						return;
					}
					t.set(0);
					return;
				}
				if (e.isIntersecting) {
					io.disconnect();
					setRun(true);
				}
			},
			{ rootMargin: `0px 0px -${margin * 100}% 0px` },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [t, reduced]);

	return (
		<div ref={ref} className={className}>
			<FxProvider fx={FX}>
				<PanelClockProvider clock={clock}>{children}</PanelClockProvider>
			</FxProvider>
		</div>
	);
}
