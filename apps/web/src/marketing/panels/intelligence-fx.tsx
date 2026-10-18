"use client";

import { useTransform } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "@/components/cn";
import { FxProvider, useTarget } from "@/components/motion/fx";
import { m } from "@/components/motion/m";
import { back, out, P, pop, press, reset, rise } from "@/components/motion/curves";
import { usePanelClock } from "@/components/motion/scene";
import { KNOB, SWITCH } from "./classes";

// Timing of the home Plant Intelligence panels (intelligence.tsx renders their markup on the server). The prototype's
// numbers, unchanged.

const R_FACTS = (t: number) => reset(t, 6000);
const KV = [24, 17, 7] as const;
const R_EVRY = (t: number) => reset(t, 7800);
const R_SHARE = (t: number) => reset(t, 6000);

const FX = {
	"facts.R": R_FACTS,
	"facts.pct": (t: number) => 71 * out(P(t, 300, 1100)) * R_FACTS(t),
	"facts.kv": (t: number, k: number) => KV[k]! * out(P(t, 300 + k * 90, 900)) * R_FACTS(t),
	"facts.name": (t: number, k: number) => pop(t, 2500 + k * 120, R_FACTS(t)),
	"evry.mood": (t: number) => (t >= 2050 && t < 3700 ? "talking" : t >= 5300 && t < 6400 ? "happy" : "idle"),
	"evry.R": R_EVRY,
	"evry.q": (t: number) => P(t, 450, 1300),
	"evry.a": (t: number) => P(t, 2150, 1500),
	"evry.aIn": (t: number) => rise(t, 1950, R_EVRY(t)),
	"evry.card": (t: number) => rise(t, 3750, R_EVRY(t)),
	"share.swap": (t: number) => out(P(t, 2600, 380)) * R_SHARE(t),
};

export function IntelligenceFx({ children }: { children: ReactNode }) {
	return <FxProvider fx={FX}>{children}</FxProvider>;
}

/** The facts ring keeps stroke-dashoffset: a paint-only change on a 64 px SVG (no layout), and the round line caps stay right. */
export function FactsRing() {
	const dash = useTransform(usePanelClock().t, (v) =>
		(169.65 * (1 - 0.71 * out(P(v, 300, 1100)) * R_FACTS(v))).toFixed(2),
	);
	return (
		<m.circle
			cx="32"
			cy="32"
			r="27"
			className="fill-none stroke-amber-500 stroke-7 [stroke-dasharray:169.65] [stroke-linecap:round]"
			style={{ strokeDashoffset: dash }}
		/>
	);
}

/** The findings switch the cursor turns on. */
export function ShareSwitch() {
	const t = usePanelClock().t;
	const ref = useTarget("t0");
	const on = (v: number) => P(v, 2300, 380) * R_SHARE(v);
	const pressT = useTransform(t, (v) => press(v, 2200, 0.08));
	const fill = useTransform(t, (v) => +out(on(v)).toFixed(3));
	const knob = useTransform(t, (v) => "translate3d(" + (14 * back(on(v))).toFixed(2) + "px,0,0)");
	return (
		<m.span ref={ref} className={cn(SWITCH, "will-change-transform")} style={{ transform: pressT }}>
			<m.b className="absolute inset-0 rounded-full bg-green-500 opacity-0" style={{ opacity: fill }} />
			<m.i className={KNOB} style={{ transform: knob }} />
		</m.span>
	);
}
