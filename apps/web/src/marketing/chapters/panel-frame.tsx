"use client";

import { useMotionValue, useTransform, type MotionValue } from "motion/react";
import { m } from "@/components/motion/m";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	type ReactNode,
	type RefObject,
} from "react";
import { cn } from "@/components/cn";
import { bump, inOut, out, P, sine, transformOf } from "@/components/motion/curves";
import { TargetProvider } from "@/components/motion/fx";
import { PanelClockProvider, useTo, type PanelClock } from "@/components/motion/scene";
import { SCENES, type PanelKind } from "../scene-data";

/**
 * Where a panel is shown and how its chapter moves it. A desktop panel (chapter or auto list) crossfades with the others
 * in one grid cell, so the chapter hands it a card style. A phone panel of the week chapter is always shown.
 */
export type PanelSlot = PanelClock & {
	place: "vis" | "mob" | "auto";
	card?: { transform: MotionValue<string>; opacity: MotionValue<number>; visibility: MotionValue<string> };
	/** Without JavaScript this desktop card is shown (the week chapter's first card, at its still frame). */
	noScript?: boolean;
};
const SlotContext = createContext<PanelSlot | null>(null);
export function PanelSlotProvider({ slot, children }: { slot: PanelSlot; children: ReactNode }) {
	// The geometry belongs to the slot, so a panel can register its targets before its card renders.
	const els = useRef<Record<string, HTMLElement | null>>({});
	const boxes = useRef<Record<string, Box>>({});
	const measured = useMotionValue(0);
	const target = useCallback(
		(name: string) => (el: HTMLElement | null) => {
			els.current[name] = el;
		},
		[],
	);
	const geo = useMemo(() => ({ els, boxes, measured, target }), [measured, target]);
	return (
		<SlotContext value={slot}>
			<GeoContext value={geo}>
				<TargetProvider value={target}>
					<PanelClockProvider clock={slot}>{children}</PanelClockProvider>
				</TargetProvider>
			</GeoContext>
		</SlotContext>
	);
}
function useSlot() {
	const s = useContext(SlotContext);
	if (!s) throw new Error("a panel must render inside a chapter");
	return s;
}

/* Geometry inside a card (cursor targets, the moving chip of the teams panel, the draft height). It is read in the card's
   ResizeObserver callback and after the fonts load, where layout is already clean, and never in a frame. */
export type Box = { x: number; y: number; w: number; h: number };
type Geo = {
	els: RefObject<Record<string, HTMLElement | null>>;
	boxes: RefObject<Record<string, Box>>;
	measured: MotionValue<number>;
	target: (name: string) => (el: HTMLElement | null) => void;
};
const GeoContext = createContext<Geo | null>(null);
export function useGeo() {
	const g = useContext(GeoContext);
	if (!g) throw new Error("useGeo needs a PanelCard");
	return g;
}

export type CardVariant =
	{ kind: "card" } | { kind: "insight"; tone: "sage" | "rose" | "sky" } | { kind: "evry" } | { kind: "clip" };
const INSIGHT_TONE = { sage: "g-sage", rose: "g-rose", sky: "g-sky" } as const;

/**
 * The white product card a chapter shows (or a gradient InsightCard, the Evry chat, or the follow-up card whose shell
 * grows). It carries the cursor that clicks through the scene.
 */
export function PanelCard({
	kind,
	variant = { kind: "card" },
	className,
	children,
}: {
	kind: PanelKind;
	variant?: CardVariant;
	className?: string;
	children: ReactNode;
}) {
	const slot = useSlot();
	const ref = useRef<HTMLDivElement>(null);
	const { els, boxes, measured } = useGeo();

	useEffect(() => {
		const card = ref.current;
		if (!card) return;
		const measure = () => {
			const W = card.offsetWidth,
				H = card.offsetHeight;
			if (!W) return;
			const b: Record<string, Box> = { card: { x: 0, y: 0, w: W, h: H } };
			for (const [name, el] of Object.entries(els.current))
				if (el) b[name] = { ...offsetIn(el, card), w: el.offsetWidth, h: el.offsetHeight };
			boxes.current = b;
			measured.set(measured.get() + 1);
		};
		const ro = new ResizeObserver(measure);
		ro.observe(card);
		void document.fonts.ready.then(measure);
		return () => ro.disconnect();
	}, [els, boxes, measured]);

	const v = variant.kind;
	const style = slot.card ?? undefined;
	return (
		<m.div
			ref={ref}
			data-k={kind}
			className={cn(
				"relative z-[2] col-start-1 row-start-1 rounded-[22px] will-change-[transform,opacity]",
				slot.place === "vis"
					? "w-[min(400px,calc(100%-48px))] opacity-0"
					: slot.place === "mob"
						? "w-[min(400px,100%)]"
						: "w-[min(400px,calc(100%-48px))] opacity-0 max-mk-cx:w-[min(400px,100%)]",
				v === "insight"
					? cn(
							"mk-gsurf flex flex-col px-6 py-[22px] text-[var(--on)] shadow-mk-insight max-mk-sm:p-[18px]",
							INSIGHT_TONE[variant.tone],
						)
					: v === "evry"
						? "flex flex-col gap-2.5 border border-line bg-white p-4 shadow-mk-panel-flat"
						: v === "clip"
							? "bg-transparent px-5 pt-[18px] pb-5 max-mk-sm:px-4 max-mk-sm:pt-4 max-mk-sm:pb-[18px]"
							: "bg-white px-5 pt-[18px] pb-5 shadow-mk-panel max-mk-sm:px-4 max-mk-sm:pt-4 max-mk-sm:pb-[18px]",
				// No JavaScript: the inline style keeps the card hidden; the root has no data-js, so this shows it.
				slot.noScript &&
					"[html:not([data-js])_&]:visible! [html:not([data-js])_&]:opacity-100! [html:not([data-js])_&]:transform-none!",
				className,
			)}
			style={style}
		>
			{children}
			<Cursor kind={kind} />
		</m.div>
	);
}

function offsetIn(el: HTMLElement | null, stop: HTMLElement) {
	let x = 0,
		y = 0;
	while (el && el !== stop) {
		x += el.offsetLeft;
		y += el.offsetTop;
		el = el.offsetParent as HTMLElement | null;
	}
	return { x, y };
}

/** Cursor: glides between the measured target points with the hero's in-out curve, presses, and leaves a short ripple. */
function Cursor({ kind }: { kind: PanelKind }) {
	const { t } = useSlot();
	const { boxes, measured } = useGeo();
	const S = SCENES[kind];
	const at = (v: number) => {
		const b = boxes.current,
			c = b.card;
		if (!c) return null;
		const pt = (k: string): { x: number; y: number } => {
			if (k === "mid") return { x: c.w * 0.62, y: c.h * 0.55 };
			const e = k === ".cx-t0" ? b.t0 : k === ".cx-t1" ? b.t1 : undefined;
			return e ? { x: e.x + Math.min(e.w * 0.5, e.w - 18), y: e.y + e.h * 0.55 } : { x: c.w * 0.8, y: c.h - 18 };
		};
		const path = S.cur;
		let { x, y } = pt(path[0]![1]);
		for (let i = 0; i < path.length - 1; i++) {
			if (v < path[i]![0]) break;
			const a = pt(path[i]![1]),
				z = pt(path[i + 1]![1]),
				p = inOut(P(v, path[i]![0], path[i + 1]![0] - path[i]![0]));
			x = a.x + (z.x - a.x) * p;
			y = a.y + (z.y - a.y) * p;
		}
		let pr = 0;
		for (const c0 of S.clicks) pr = Math.max(pr, bump(v, c0, 200));
		return { x, y, s: 1 - 0.12 * pr, o: out(P(v, 250, 300)) * (1 - sine(P(v, S.L - 420, 300))) };
	};
	const transform = useTransform([t, measured], ([v]: number[]) => {
		const f = at(v!);
		return f ? transformOf(f.x, f.y, f.s) : "none";
	});
	const opacity = useTransform([t, measured], ([v]: number[]) => {
		const f = at(v!);
		return f ? +f.o.toFixed(3) : 0;
	});
	const ripple = useTo(t, (v) => {
		let rp = -1;
		for (const c0 of S.clicks) if (v >= c0 && v < c0 + 520) rp = P(v, c0, 520);
		return [0, 0, 0.4 + 1.1 * out(Math.max(rp, 0)), rp >= 0 ? 0.9 * (1 - rp) : 0];
	});
	return (
		<m.span
			aria-hidden="true"
			className="pointer-events-none absolute top-0 left-0 z-8 -mt-[3px] -ml-[5px] size-[22px] origin-[5px_3px] opacity-0 will-change-[transform,opacity]"
			style={{ transform, opacity }}
		>
			<m.i className="absolute -top-[11px] -left-[9px] size-7 rounded-full bg-mk-ink-18 opacity-0" style={ripple} />
			<svg
				viewBox="0 0 24 24"
				className="relative z-1 size-[22px] fill-ink stroke-white stroke-[1.4] drop-shadow-mk-cursor"
			>
				<path d="M5.5 3.5v15.2c0 .6.7.9 1.1.5l3.6-3.5 2.5 5.6c.2.4.7.6 1.1.4l1.9-.9c.4-.2.6-.7.4-1.1l-2.5-5.5 5-.3c.6 0 .8-.7.4-1.1L6.6 2.9c-.4-.4-1.1-.1-1.1.6z" />
			</svg>
		</m.span>
	);
}
