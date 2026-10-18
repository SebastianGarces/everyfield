"use client";

import { useInView, useMotionValue, useTransform, type MotionValue } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { PlaybackGlyph } from "@/components/kit/kit";
import { back, bump, clamp, inOut, out, P, sine, transformOf } from "@/components/motion/curves";
import { DoneButton } from "@/components/motion/DoneButton";
import { FxProvider, TargetProvider, useT } from "@/components/motion/fx";
import { m } from "@/components/motion/m";
import { MText, PanelClockProvider, useReduced, useText, useTicker, useTo } from "@/components/motion/scene";
import { HA_DRAFT, HA_NAME } from "../demo-data";

/* ---------- Timing (Revision 8 table: the one place to tune the hero loop; ms) ----------
   Five cards share one grid cell and crossfade. Maria's chip glides from a hidden slot in each card to the next.
   Every style is a pure function of the loop time t. Reduced motion renders the final frame (STILL) once.
   HeroAnimation.tsx renders the cards on the server; this module runs the clock and the moving parts. */
const TM = {
	act: 1.5,
	hold: [1700, 1800, 1800, 1800, 3000],
	lead: [700, 450, 250, 500, 150],
	span: [1870, 380, 2800, 1130, 1220],
	cardIn: 380,
	cardOut: 250,
	gap: 150,
	moveAt: 50,
	move: 650,
	seam: 250,
	chipFade: 230,
};
const SC: [number, number][] = [],
	A: number[] = [],
	MOVES: [number, number, number, number][] = [];
let LOOP = 0;
{
	let a = -TM.seam;
	for (let i = 0; i < 5; i++) {
		const s = a + TM.lead[i]!,
			b = s + TM.span[i]! * TM.act + TM.hold[i]!;
		SC.push([a, b]);
		A.push(s);
		if (i < 4) MOVES.push([b + TM.moveAt, b + TM.moveAt + TM.move, i, i + 1]);
		a = b + TM.gap;
	}
	LOOP = SC[4]![1] + TM.seam;
}
const STILL = A[4]! + 1400 * TM.act; /* final frame: Maria in the core group, highlight on */
const at = (i: number, ms: number) => A[i]! + ms * TM.act;
const d = (ms: number) => ms * TM.act;
/** Card 0 also covers the loop seam. */
const seam = (i: number, v: number) => (i === 0 && v >= LOOP - 300 ? v - LOOP : v);
const join = (v: number) => inOut(P(v, at(4, 500), d(520)));
const ROWS = [41, 23, 34] as const;

const FX = {
	/** One scene card: in 380 ms ease-out with an 8 px lift, out 250 ms sine (6 px up). */
	card: (v: number, i: number) => {
		const u = seam(i, v),
			[a, b] = SC[i]!;
		const pin = out(P(u, a, TM.cardIn)),
			pout = sine(P(u, b, TM.cardOut));
		return [0, (1 - pin) * 8 - pout * 6, 1, pin * (1 - pout)];
	},
	/** A card child that staggers in: 90 ms after the card, then 75 ms apart. n = card * 10 + child. */
	st: (v: number, n: number) => {
		const i = Math.floor(n / 10),
			k = n % 10,
			p = out(P(seam(i, v), SC[i]![0] + 90 + k * 75, 420));
		return [0, (1 - p) * 8, 1, p];
	},
	add: (v: number) => "scale(" + (1 - 0.05 * bump(v, at(0, 1250), d(200))).toFixed(4) + ")",
	guests: (v: number) => inOut(P(v, at(1, 0), d(380))),
	join: join,
	mood: (v: number) =>
		v >= at(2, 0) && v < at(2, 1800) ? "talking" : v >= at(2, 2150) && v < SC[2]![1] + 200 ? "happy" : "idle",
	flipA: (v: number) => {
		const e = out(P(v, at(3, 750), d(380)));
		return [0, -7 * e, 1, 1 - e];
	},
	flipB: (v: number) => {
		const p = P(v, at(3, 750), d(380)),
			e = out(p);
		return [0, 7 * (1 - e), 0.85 + 0.15 * back(p), e];
	},
	check: (v: number, k: number) => {
		const p = P(v, at(3, k * 260), d(340));
		return [0, 0, 0.4 + 0.6 * back(p), clamp(p * 2.5)];
	},
	/** Scene 5: the bars fill, Maria joins the core group (one out of Following up, one into Core group). */
	meter: (v: number, k: number) => {
		const p = out(P(v, at(4, k * 90), d(650))),
			j = join(v);
		const val = (ROWS[k]! / 50) * p + (k === 2 ? j : k === 1 ? -j : 0) / 50;
		return "translate3d(" + (-100 + 100 * val).toFixed(2) + "%,0,0)";
	},
	hl: (v: number) => out(P(v, at(4, 400), d(300))) * (1 - sine(P(v, SC[4]![1] - 1500, d(600)))),
};

type Pos = { x: number; y: number };

/**
 * The home hero's stage: one clock for the five cards, the slot geometry for Maria's chip, and the pause button. The loop
 * runs only while the stage is on screen and not paused; reduced motion shows the last scene and no pause button.
 */
export function HeroStage({ label, chip, children }: { label: string; chip: ReactNode; children: ReactNode }) {
	const root = useRef<HTMLDivElement>(null);
	const stage = useRef<HTMLDivElement>(null);
	const slots = useRef<(HTMLElement | null)[]>([]);
	const t = useMotionValue(0);
	// Slot positions live in a ref; measured bumps a counter so the chip transform recomputes even while paused.
	const pos = useRef<Pos[]>([]);
	const measured = useMotionValue(0);
	const [paused, setPaused] = useState(false);
	const reduced = useReduced();
	const seen = useInView(stage);
	const run = seen && !paused && reduced === false;

	useEffect(() => {
		if (reduced) t.set(STILL);
	}, [reduced, t]);
	useTicker(run, (dt) => t.set((t.get() + dt) % LOOP));

	// Slot positions inside the stage, measured when the stage resizes and when the fonts arrive (never per frame).
	useEffect(() => {
		const st = stage.current;
		if (!st) return;
		const measure = () => {
			pos.current = slots.current.map((s) => offsetIn(s, st));
			measured.set(measured.get() + 1);
		};
		const ro = new ResizeObserver(measure);
		ro.observe(st);
		void document.fonts.ready.then(measure);
		return () => ro.disconnect();
	}, [measured]);

	const clock = useMemo(() => ({ t, since: t, stagger: 0 }), [t]);
	const register = useMemo(
		() => (name: string) => (el: HTMLElement | null) => {
			slots.current[+name.slice(1)] = el;
		},
		[],
	);

	return (
		<div ref={root} className="relative mx-auto max-w-[1180px]" data-idle={run ? undefined : ""}>
			<div
				ref={stage}
				role="img"
				aria-label={label}
				className="ef-ui relative isolate grid items-start justify-items-center overflow-hidden rounded-frame pt-6 pb-16 max-mk-sm:rounded-card max-mk-sm:pb-14"
			>
				<div aria-hidden="true" className="contents">
					<PanelClockProvider clock={clock}>
						<FxProvider fx={FX}>
							<TargetProvider value={register}>{children}</TargetProvider>
						</FxProvider>
					</PanelClockProvider>
					<Live t={t} pos={pos} measured={measured}>
						{chip}
					</Live>
				</div>
			</div>
			<button
				type="button"
				aria-label={paused ? "Play animation" : "Pause animation"}
				onClick={() => setPaused((p) => !p)}
				className="absolute bottom-3.5 left-1/2 z-7 -ml-[17px] grid size-[34px] cursor-pointer place-items-center rounded-full border-0 bg-transparent text-ink hover:bg-white/35 motion-reduce:hidden"
			>
				<PlaybackGlyph paused={paused} />
			</button>
		</div>
	);
}

/** Position of el inside stop, from the offset chain (layout is clean in a ResizeObserver callback). */
function offsetIn(el: HTMLElement | null, stop: HTMLElement): Pos {
	let x = 0,
		y = 0;
	while (el && el !== stop) {
		x += el.offsetLeft;
		y += el.offsetTop;
		el = el.offsetParent as HTMLElement | null;
	}
	return { x, y };
}

/** Scene 1: the name is typed, then fades as the chip pops out of the field. */
export function TypedName() {
	const t = useT();
	const text = useText(t, (v) => HA_NAME.slice(0, Math.floor(P(v, at(0, 0), d(1050)) * HA_NAME.length)));
	const opacity = useTransform(t, (v) => +(1 - P(v, at(0, 1550), d(220))).toFixed(3));
	return (
		<m.span style={{ opacity }}>
			<Caret t={t} show={(v) => v < at(0, 1500)} h={18}>
				<MText value={text} />
			</Caret>
		</m.span>
	);
}
/** Scene 3: Evry types the follow-up draft. */
export function Draft() {
	const t = useT();
	const text = useText(t, (v) => HA_DRAFT.slice(0, Math.floor(P(v, at(2, 350), d(1350)) * HA_DRAFT.length)));
	return (
		<Caret t={t} show={(v) => v > at(2, 200) && v < at(2, 1850)} h={15}>
			<MText value={text} />
		</Caret>
	);
}
/**
 * Typed text with its caret: a 1.5 px stripe drawn as a background at the end of the text (1 px after it). The text box
 * only grows from a fixed start, so typing moves nothing (an inline caret element moved with every letter: a layout
 * shift each time). The stripe blinks with a CSS animation; show() hides it. The stripe's padding is cancelled by an
 * equal negative margin, so the caret takes no line space and the text wraps exactly as the prototype's text did.
 */
function Caret({
	t,
	show,
	h,
	children,
}: {
	t: MotionValue<number>;
	show: (t: number) => boolean;
	h: number;
	children: ReactNode;
}) {
	const size = useTransform<number, string>(t, (v) => (show(v) ? `1.5px ${h}px` : "0px 0px"));
	return (
		<m.span
			className="[box-decoration-break:slice] bg-[linear-gradient(var(--color-ink),var(--color-ink))] bg-right bg-no-repeat -mr-[2.5px] pr-[2.5px] whitespace-pre-wrap animate-mk-caret motion-reduce:animate-none"
			style={{ backgroundSize: size }}
		>
			{children}
		</m.span>
	);
}

/** Scene 3's confirm button: the hero plays the confirm steps 1.5 times slower, with a longer press. */
export function ApproveButton() {
	return <DoneButton t={useT()} at={at(2, 1820)} scale={TM.act} press={330} label="Approve and send" done="Sent" />;
}

/** A two-number roll (the count changes by one): the column moves up half its height. p: fx id of the progress. */
export function Roll({ a, b, p }: { a: number; b: number; p: "guests" | "join" }) {
	const f = FX[p];
	const transform = useTransform(useT(), (v) => "translate3d(0," + (-50 * f(v)).toFixed(3) + "%,0)");
	return (
		<span className="inline-block h-[1.2em] overflow-hidden align-bottom leading-[1.2em] tabular-nums">
			<m.span className="block will-change-transform" style={{ transform }}>
				<i className="block not-italic">{a}</i>
				<i className="block not-italic">{b}</i>
			</m.span>
		</span>
	);
}

/** Maria's chip: pops in, then glides between the slots with a small lift, and fades at the loop seam. */
function Live({
	t,
	pos,
	measured,
	children,
}: {
	t: MotionValue<number>;
	pos: RefObject<Pos[]>;
	measured: MotionValue<number>;
	children: ReactNode;
}) {
	const frameOf = (v: number, P5: Pos[]) => {
		if (P5.length !== 5) return null;
		let x = P5[0]!.x,
			y = P5[0]!.y,
			s = 1,
			o = 0;
		const pp = P(v, at(0, 1450), d(420));
		if (v >= at(0, 1450)) {
			o = clamp(pp * 2);
			s = 0.6 + 0.4 * back(pp);
		}
		for (const mv of MOVES) {
			if (v < mv[0]) continue;
			const p = inOut(P(v, mv[0], mv[1] - mv[0])),
				from = P5[mv[2]]!,
				to = P5[mv[3]]!;
			x = from.x + (to.x - from.x) * p;
			y = from.y + (to.y - from.y) * p;
			s = 1 + 0.06 * Math.sin(Math.PI * p);
		}
		const fade = sine(P(v, SC[4]![1], TM.chipFade));
		return { x, y, s: s - 0.04 * fade, o: o * (1 - fade) };
	};
	const transform = useTransform([t, measured], ([v]: number[]) => {
		const f = frameOf(v!, pos.current);
		return f ? transformOf(f.x, f.y, f.s) : "none";
	});
	const opacity = useTransform([t, measured], ([v]: number[]) => {
		const f = frameOf(v!, pos.current);
		return f ? +f.o.toFixed(3) : 0;
	});
	const ring = useTo(t, (v) => {
		const r = P(v, at(4, 420), d(800));
		return [0, 0, 1 + 0.3 * out(r), r > 0 && r < 1 ? 0.8 * (1 - r) : 0];
	});
	return (
		<m.span
			className="pointer-events-none absolute top-0 left-0 z-6 inline-flex h-[30px] origin-center items-center gap-[7px] rounded-full bg-white pr-3 pl-1 text-[13px] font-semibold whitespace-nowrap text-ink opacity-0 shadow-mk-chip will-change-[transform,opacity]"
			style={{ transform, opacity }}
		>
			<m.span
				className="absolute -inset-px rounded-full opacity-0 shadow-[0_0_0_2px_var(--color-green-500)]"
				style={ring}
			/>
			{children}
		</m.span>
	);
}
