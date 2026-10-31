"use client";

import { useReduced } from "@/components/motion/scene";
import { ArrowRight02Icon } from "@hugeicons/core-free-icons";
import { useInView } from "motion/react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/components/cn";
import { Icon } from "@/components/Icon";
import { PlaybackGlyph } from "@/components/kit/kit";
import { Backdrop } from "../photo/Backdrop";
import type { PhotoName } from "../photo/photos";

type Props = {
	/** The whole sentence for screen readers ("Sent by a church, a network through a church or a network. Seen in one place."). */
	sentence: string;
	lead: string;
	tail: string;
	phrases: string[];
	/** Per state: the text pane, the product card (server-rendered) and the photo behind the card. */
	panes: ReactNode[];
	apps: ReactNode[];
	photos: PhotoName[];
};

/* Revision 28: one timer moves the phrase and the card together every STEP ms, only while 30 % of the block is on screen
   and the tab is visible. */
const STEP = 5500;
const EASE = "cubic-bezier(.65,0,.35,1)";

/**
 * The /oversight sending paths: "Sent by <phrase>. Seen in one place." over one large card. The phrase rolls up one line,
 * its highlight takes the new phrase's width, the line stays centred, and the card crossfades, all over .7 s.
 *
 * No layout shift (the prototype animated the highlight's width, which moved the whole line ~50 times a roll): the
 * phrase slot always has the width of the widest phrase, so nothing is laid out again. Every moving part is a transform
 * transition on the same .7 s curve, so the roll runs on the compositor and paints nothing:
 * - The line is recentred and the period moves with translateX.
 * - The highlight's visible width wk is a window: the slot is a rounded window at the widest width, and an inner rounded
 *   window of the same size slides left by (widest - wk) while its content slides back by the same amount. Their
 *   intersection is the prototype's clip, inset(0 (widest - wk) 0 0 round .2em), at every frame.
 * - Each phrase is centred in the painted highlight: its offset is (wk - its width) / 2, also linear in wk.
 * Phrase widths are measured once per resize. Reduced motion: no auto advance and no transitions; the control shows
 * the next state.
 */
export function PathsCycle({ sentence, lead, tail, phrases, panes, apps, photos }: Props) {
	const reduced = useReduced();
	const run = useRef<HTMLDivElement>(null);
	const items = useRef<(HTMLSpanElement | null)[]>([]);
	const dot = useRef<HTMLSpanElement>(null);
	const [k, setK] = useState(0);
	const [paused, setPaused] = useState(false);
	const [w, setW] = useState<{ items: number[]; max: number; dot: number } | null>(null);
	const seen = useInView(run, { amount: 0.3 });
	const n = phrases.length;

	const measure = useCallback(() => {
		const ws = items.current.map((e) => e?.offsetWidth ?? 0);
		const next = {
			items: ws,
			max: Math.max(...ws),
			dot: dot.current?.offsetWidth ?? 0,
		};
		setW((c) => (c && c.max === next.max && c.dot === next.dot && c.items.join() === next.items.join() ? c : next));
	}, []);
	useEffect(() => {
		const r = run.current;
		if (!r) return;
		const ro = new ResizeObserver(measure);
		ro.observe(r);
		void document.fonts.ready.then(measure);
		return () => ro.disconnect();
	}, [measure]);

	// A hidden tab stops the timer, as in the prototype; a full step starts again when the tab shows.
	const [hidden, setHidden] = useState(false);
	useEffect(() => {
		const onVis = () => setHidden(document.hidden);
		onVis();
		document.addEventListener("visibilitychange", onVis);
		return () => document.removeEventListener("visibilitychange", onVis);
	}, []);

	useEffect(() => {
		if (!seen || paused || reduced || hidden) return;
		const id = setTimeout(() => setK((c) => (c + 1) % n), STEP);
		return () => clearTimeout(id);
	}, [seen, paused, reduced, hidden, k, n]);

	const wk = w ? w.items[k]! : 0;
	// Before the first measurement (server HTML) the slot shows the widest phrase with its full highlight and the period after it.
	const vars = (
		w
			? {
					"--dx": (w.max - wk - w.dot) / 2 + "px",
					"--wk": wk + "px",
					"--cut": w.max - wk + "px",
					"--dotx": wk - w.max + "px",
				}
			: {}
	) as CSSProperties;
	const t = reduced ? "none" : `transform .7s ${EASE}`;
	return (
		<div ref={run} className="relative">
			<h2
				className="mk-display font-display mx-auto mb-[clamp(32px,3.8vw,56px)] max-w-[1100px] overflow-x-clip text-center type-title-lg mk-sm:type-display-sm mk-lg:type-display-md leading-[1.14]"
				style={vars}
			>
				<span className="sr-only">{sentence}</span>
				<span aria-hidden="true">
					<span
						className="inline-block [transform:translateX(var(--dx,0px))] max-mk-sm:[transform:none]"
						style={{ transition: t }}
					>
						{lead}
					</span>{" "}
					<br className="hidden max-mk-sm:inline" />
					<span className="relative inline-block [transform:translateX(var(--dx,0px))]" style={{ transition: t }}>
						<span className="relative inline-block h-[1.14em] overflow-hidden rounded-[.2em] align-bottom">
							<span
								className="block h-full overflow-hidden rounded-[.2em] [transform:translateX(calc(var(--cut,0px)*-1))]"
								style={{ transition: t }}
							>
								<span className="block [transform:translateX(var(--cut,0px))]" style={{ transition: t }}>
									<span className="absolute top-0 left-0 -z-1 h-[1.14em] w-full bg-mk-mint" />
									<span
										className="flex flex-col items-start [transform:translateY(calc(var(--k)*-1.14em))]"
										style={{ "--k": k, transition: t } as CSSProperties}
									>
										{phrases.map((p, i) => (
											<span
												key={p}
												ref={(el) => {
													items.current[i] = el;
												}}
												className="block h-[1.14em] w-max flex-none px-[.12em] leading-[1.14em] whitespace-nowrap [transform:translateX(calc((var(--wk,0px)-var(--wi,0px))/2))]"
												style={{ "--wi": w ? w.items[i] + "px" : undefined, transition: t } as CSSProperties}
											>
												{p}
											</span>
										))}
									</span>
								</span>
							</span>
						</span>
						<span
							ref={dot}
							className="absolute top-0 left-full [transform:translateX(var(--dotx,0px))]"
							style={{ transition: t }}
						>
							.
						</span>
					</span>
					<br />
					{tail}
				</span>
			</h2>
			<div className="relative mx-auto grid h-[304px] max-w-[1200px] grid-cols-[minmax(0,5fr)_minmax(0,7fr)] overflow-hidden border border-mk-ink-06 bg-white shadow-mk-card max-mk-cx:h-auto max-mk-cx:grid-cols-[minmax(0,1fr)]">
				<div className="grid items-center px-[clamp(28px,3.4vw,52px)] max-mk-cx:px-6 max-mk-cx:pt-7 max-mk-cx:pb-2 max-mk-sm:px-5 max-mk-sm:pt-[22px] max-mk-sm:pb-1">
					{panes.map((p, i) => (
						<Fade key={i} on={i === k} reduced={reduced}>
							{p}
						</Fade>
					))}
				</div>
				<div
					aria-hidden="true"
					className="ef-ui relative isolate m-2 grid grid-cols-[minmax(0,1fr)] place-items-center overflow-hidden px-6 py-4 max-mk-cx:min-h-[300px] max-mk-cx:pb-[52px] max-mk-sm:m-1.5 max-mk-sm:min-h-0 max-mk-sm:px-3 max-mk-sm:pt-7"
				>
					{photos.map((photo, i) => (
						<Backdrop
							key={photo}
							bg={photo}
							sizes="(max-width: 900px) 100vw, 700px"
							className={cn("absolute inset-0 z-0", i === k ? "opacity-100" : "opacity-0")}
							style={{ transition: reduced ? "none" : `opacity .7s ${EASE}` }}
						/>
					))}
					{apps.map((a, i) => (
						<Fade key={i} on={i === k} reduced={reduced} center>
							{a}
						</Fade>
					))}
				</div>
				<button
					type="button"
					aria-label={
						reduced ? "Show the next sending path" : paused ? "Play the sending paths" : "Pause the sending paths"
					}
					onClick={() => (reduced ? setK((c) => (c + 1) % n) : setPaused((p) => !p))}
					// 34 px as in the prototype; the ring around it (before:) makes the hit area 44 px.
					className="absolute right-4 bottom-4 z-2 grid size-[34px] cursor-pointer place-items-center rounded-full border-0 bg-mk-ink-46 text-cream before:absolute before:-inset-[5px] before:content-[''] hover:bg-mk-ink-66 focus-visible:outline-cream max-mk-sm:right-3 max-mk-sm:bottom-3"
				>
					{reduced ? <Icon icon={ArrowRight02Icon} size={14} /> : <PlaybackGlyph paused={paused} />}
				</button>
			</div>
		</div>
	);
}

/** Revision 28 crossfade: out over the first 40 % (.28 s ease-in), in over the last 50 % (.35 s ease-out after .35 s). */
function Fade({
	on,
	reduced,
	center,
	children,
}: {
	on: boolean;
	reduced: boolean;
	center?: boolean;
	children: ReactNode;
}) {
	return (
		<div
			className={cn(
				"relative z-[1] col-start-1 row-start-1 min-w-0",
				center && "grid w-full grid-cols-[minmax(0,1fr)] justify-items-center",
				on ? "visible opacity-100" : "invisible opacity-0",
			)}
			style={{
				transition: reduced
					? "none"
					: on
						? "opacity .35s ease-out .35s, visibility 0s"
						: "opacity .28s ease-in, visibility 0s linear .28s",
			}}
		>
			{children}
		</div>
	);
}
