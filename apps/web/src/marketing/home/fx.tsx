"use client";

import type { ReactNode } from "react";
import { FxProvider } from "@/components/motion/fx";
import { out, P, pop, press, reset, rise } from "@/components/motion/curves";

// Timing of the two home-only Plant Intelligence panels (panels.tsx renders their markup on the server). The
// curves follow the live focus panel (intelligence-fx.tsx) so the chapter keeps one rhythm.

const R_FOCUS = (t: number) => reset(t, 6200);
const ready = (t: number) => 4 * out(P(t, 300, 1200)) * R_FOCUS(t);
const focusSwap = (t: number) => out(P(t, 2550, 380)) * R_FOCUS(t);
const R_READY = (t: number) => reset(t, 5800);

const FX = {
	"focus.n": ready,
	// The bar fills to today's core group (34 on a 40 scale); the marker at 38 is the group if all four commit.
	"focus.fill": (t: number) =>
		"translate3d(" + (-(1 - (34 * out(P(t, 300, 1200)) * R_FOCUS(t)) / 40) * 100).toFixed(2) + "%,0,0)",
	"focus.text": (t: number) => [0, -6 * focusSwap(t), 1, 1 - focusSwap(t)],
	"focus.fact": (t: number, k: number) => rise(t, 2640 + k * 75, R_FOCUS(t)),
	"focus.press": (t: number) => press(t, 2400, 0.05),
	"ready.R": R_READY,
	"ready.met": (t: number) =>
		Math.min(
			4,
			[0, 1, 2, 3].reduce((a, k) => a + (t >= 700 + k * 260 ? 1 : 0), 0),
		) * R_READY(t),
	"ready.check": (t: number, k: number) => pop(t, 700 + k * 260, R_READY(t)),
};

export function HomeFx({ children }: { children: ReactNode }) {
	return <FxProvider fx={FX}>{children}</FxProvider>;
}
