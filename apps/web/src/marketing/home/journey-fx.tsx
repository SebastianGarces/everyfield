"use client";

import { useInView, useMotionValue } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { EvryBot } from "@/components/kit/EvryBot";
import { useReduced } from "@/components/motion/scene";
import { stopCurve, stopLeft, type Pt } from "../sections/stop-curve";

// The journey path (OPS-82 prototype, pthLayout to pthGo). One smooth curve runs through the six stop centres. EvryBot
// eases along it from stop to stop and says one line at each stop. While the band is on screen it moves on every
// STEP ms; hover, focus, a hidden tab and reduced motion pause it, and a click or an arrow key stops it for good.
// Reduced motion shows the first stop and its line, with no motion. There is no play or pause control.

const STEP = 4200;
/** The app's EvryBot "lg" size; the walker scales it to the band's bot size (44 to 62 px). */
const BOT = 40;

export type JourneyStep = { title: string; body: string; say: string; icon: ReactNode };
/** Measured path: stop centres and sizes, the length at each stop, the walker's length L and x, and the stop it is on. */
type Geo = { c: (Pt & { s: number })[]; at: number[]; len: number; L: number; wx: number; k: number };

const num = (i: number) => String(i + 1).padStart(2, "0");
const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

export function JourneyPath({
	label,
	steps,
	head,
	photo,
	note,
}: {
	label: string;
	steps: JourneyStep[];
	head: ReactNode;
	photo: ReactNode;
	note: ReactNode;
}) {
	const n = steps.length;
	const band = useRef<HTMLDivElement>(null);
	const svg = useRef<SVGSVGElement>(null);
	const trail = useRef<SVGPathElement>(null);
	const walked = useRef<SVGPathElement>(null);
	const walker = useRef<HTMLDivElement>(null);
	const bot = useRef<HTMLSpanElement>(null);
	const bubble = useRef<HTMLParagraphElement>(null);
	const stops = useRef<(HTMLButtonElement | null)[]>([]);
	const geo = useRef<Geo>({ c: [], at: [], len: 0, L: 0, wx: 0, k: 0 });
	const raf = useRef(0);
	const moodTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const mood = useMotionValue("idle");

	const [k, setK] = useState(0);
	const [say, setSay] = useState(0);
	const [hover, setHover] = useState(false);
	const [focus, setFocus] = useState(false);
	const [user, setUser] = useState(false);
	const [hidden, setHidden] = useState(false);
	const reduced = useReduced();
	const vis = useInView(band, { amount: 0.45 });
	const running = vis && !hover && !focus && !user && !hidden && reduced === false;

	/** The walker rides above the line at length L; the walked line ends under it. */
	const put = useCallback((L: number) => {
		const g = geo.current,
			p = trail.current!.getPointAtLength(L),
			bs = bot.current!.offsetWidth;
		g.wx = p.x - bs / 2;
		g.L = L;
		const wy = p.y - g.c[0]!.s / 2 - bs - 8;
		walker.current!.style.transform = `translate(${g.wx.toFixed(1)}px,${wy.toFixed(1)}px)`;
		walked.current!.style.strokeDashoffset = (100 - (L / g.len) * 100).toFixed(2);
	}, []);

	/** The bubble sits over the walker and stays inside the band; its tail points at the walker. */
	const place = useCallback(() => {
		const b = bubble.current!,
			bs = bot.current!.offsetWidth,
			W = band.current!.clientWidth,
			bw = b.offsetWidth,
			x = geo.current.wx;
		const L = Math.max(10, Math.min(W - bw - 10, x + bs / 2 - bw / 2));
		b.style.setProperty("--bx", (L - x).toFixed(1) + "px");
		b.style.setProperty("--tx", Math.max(16, Math.min(bw - 16, x + bs / 2 - L)).toFixed(1) + "px");
	}, []);

	/** One curve through the stop centres, with horizontal tangents; at[i] is the length along it at stop i. */
	const layout = useCallback(() => {
		const B = band.current,
			T = trail.current;
		if (!B || !T || !bot.current) return;
		const W = B.clientWidth,
			H = B.clientHeight;
		bot.current.firstElementChild?.setAttribute("style", `transform:scale(${bot.current.offsetWidth / BOT})`);
		const g = geo.current;
		g.c = stops.current.map((s) => {
			const li = s!.closest("li")!;
			return { x: li.offsetLeft, y: li.offsetTop, s: s!.offsetWidth };
		});
		const segs = stopCurve(g.c, W);
		g.at = [];
		for (let i = 0; i < n; i++) {
			T.setAttribute("d", segs.slice(0, i + 2).join(""));
			g.at.push(T.getTotalLength());
		}
		const d = segs.join("");
		svg.current!.setAttribute("viewBox", `0 0 ${W} ${H}`);
		T.setAttribute("d", d);
		walked.current!.setAttribute("d", d);
		g.len = T.getTotalLength();
	}, [n]);

	const arrive = useCallback(
		(i: number, quiet?: boolean) => {
			setSay(i);
			bubble.current!.removeAttribute("data-swap");
			clearTimeout(moodTimer.current);
			if (quiet || reduced) return;
			mood.set("talking");
			moodTimer.current = setTimeout(() => {
				mood.set(/task/.test(steps[i]!.say) ? "happy" : "idle");
				moodTimer.current = setTimeout(() => mood.set("idle"), 1600);
			}, 1300);
		},
		[mood, reduced, steps],
	);

	const walk = useCallback(
		(i: number) => {
			cancelAnimationFrame(raf.current);
			const g = geo.current,
				from = g.L,
				to = g.at[i]!,
				dist = Math.abs(to - from);
			if (dist < 1 || reduced) {
				put(to);
				arrive(i);
				return;
			}
			const dur = Math.min(1700, Math.max(700, dist * 2.2)),
				t0 = performance.now();
			// The line fades out while the walker moves; the next one fades in on arrival.
			bubble.current!.setAttribute("data-swap", "");
			mood.set("idle");
			bot.current!.animate([{ translate: "0 0" }, { translate: "0 -16px", offset: 0.45 }, { translate: "0 0" }], {
				duration: dur,
				easing: "cubic-bezier(.4,0,.4,1)",
			});
			const frame = (now: number) => {
				const u = Math.min(1, (now - t0) / dur);
				put(from + (to - from) * ease(u));
				if (u < 1) raf.current = requestAnimationFrame(frame);
				else arrive(i);
			};
			raf.current = requestAnimationFrame(frame);
		},
		[arrive, mood, put, reduced],
	);

	const go = useCallback(
		(i: number) => {
			geo.current.k = i;
			setK(i);
			walk(i);
		},
		[walk],
	);
	const pick = (i: number) => {
		setUser(true);
		go(i);
	};
	const onKey = (i: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
		const step =
			e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
		if (!step) return;
		e.preventDefault();
		const j = (i + step + n) % n;
		stops.current[j]?.focus();
		pick(j);
	};

	// First layout, and again when the band resizes or the fonts arrive: the walker stays on its stop.
	useLayoutEffect(() => {
		const relayout = () => {
			layout();
			cancelAnimationFrame(raf.current);
			put(geo.current.at[geo.current.k]!);
			place();
			bubble.current!.removeAttribute("data-swap");
			// Hidden until the first layout puts it on its stop.
			walker.current!.style.visibility = "visible";
		};
		relayout();
		const ro = new ResizeObserver(relayout);
		ro.observe(band.current!);
		void document.fonts.ready.then(relayout);
		return () => {
			ro.disconnect();
			cancelAnimationFrame(raf.current);
			clearTimeout(moodTimer.current);
		};
	}, [layout, place, put]);

	// The bubble takes its new line, then finds its place over the walker.
	useLayoutEffect(place, [say, place]);

	useEffect(() => {
		const onVis = () => setHidden(document.hidden);
		onVis();
		document.addEventListener("visibilitychange", onVis);
		return () => document.removeEventListener("visibilitychange", onVis);
	}, []);

	// Auto-advance: each arrival starts a new STEP wait while nothing pauses the band.
	useEffect(() => {
		if (!running) return;
		const id = setTimeout(() => go((k + 1) % n), STEP);
		return () => clearTimeout(id);
	}, [running, k, n, go]);

	return (
		<section
			id="week"
			aria-labelledby="week-title"
			className="relative py-section"
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => setHover(false)}
			onFocus={() => setFocus(true)}
			onBlur={(e) => {
				if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(false);
			}}
		>
			<div className="mx-auto max-w-mk px-page">
				{head}
				<div
					ref={band}
					className="relative isolate h-[clamp(340px,32vw,460px)] [--hi:60%] [--ic:clamp(46px,6vw,92px)] [--lo:72%] max-mk-cx:[--hi:64%] max-mk-cx:[--lo:78%]"
				>
					{photo}
					<svg ref={svg} aria-hidden="true" className="pointer-events-none absolute inset-0 size-full overflow-visible">
						<path
							ref={trail}
							fill="none"
							strokeLinecap="round"
							className="stroke-mk-cream-78 [stroke-dasharray:.1_12] [stroke-width:3]"
						/>
						<path
							ref={walked}
							fill="none"
							strokeLinecap="round"
							pathLength={100}
							className="stroke-cream [stroke-dasharray:100_100] [stroke-dashoffset:100] [stroke-width:4]"
						/>
					</svg>
					<ol aria-label={label} className="m-0 list-none p-0">
						{steps.map((s, i) => (
							<li
								key={s.title}
								className="absolute top-(--lo) -translate-1/2 even:top-(--hi)"
								style={{ left: stopLeft(i, n) }}
							>
								{/* The number sits outside the button, so the button's name is its title alone (label in name). */}
								<div className="group relative size-(--ic) transition-[translate,scale] duration-400 ease-[cubic-bezier(.3,1.4,.5,1)] hover:not-has-aria-pressed:-translate-y-[3px] has-aria-pressed:scale-[1.08]">
									<span
										aria-hidden="true"
										className="pointer-events-none absolute top-1 left-1.5 z-1 type-mk-pic-xs font-semibold tracking-[.06em] text-mk-ink-62 group-has-aria-pressed:text-ink"
									>
										{num(i)}
									</span>
									<button
										ref={(el) => {
											stops.current[i] = el;
										}}
										type="button"
										aria-pressed={i === k}
										aria-label={s.title}
										onClick={() => pick(i)}
										onKeyDown={onKey(i)}
										className="grid size-full cursor-pointer place-items-center border-0 bg-mk-canvas-92 p-0 text-ink shadow-mk-stop transition-colors duration-250 focus-visible:outline-cream aria-pressed:bg-green-500"
									>
										{s.icon}
									</button>
								</div>
							</li>
						))}
					</ol>
					<div
						ref={walker}
						aria-hidden="true"
						className="pointer-events-none invisible absolute top-0 left-0 z-2 will-change-transform"
					>
						<p
							ref={bubble}
							className="absolute bottom-[calc(100%+12px)] left-(--bx,0px) m-0 w-max max-w-[min(320px,calc(100vw-64px))] bg-mk-canvas px-[15px] py-[11px] type-lg leading-[1.4] text-ink shadow-mk-say transition-[opacity,translate] duration-250 after:absolute after:top-full after:left-(--tx,20px) after:-ml-[7px] after:border-[7px] after:border-transparent after:border-t-mk-canvas after:content-[''] data-swap:translate-y-1 data-swap:opacity-0 max-mk-cx:max-w-[250px] max-mk-cx:px-3 max-mk-cx:py-[9px] max-mk-cx:type-md"
						>
							{steps[say]!.say}
						</p>
						<span ref={bot} className="block size-[clamp(44px,4.2vw,62px)]">
							<span className="block origin-top-left">
								<EvryBot size="lg" mood={mood} />
							</span>
						</span>
					</div>
				</div>
				<ol className="mt-7 grid list-none grid-cols-3 gap-4 p-0 max-mk-cx:grid-cols-1 max-mk-cx:gap-3">
					{steps.map((s, i) => (
						<li
							key={s.title}
							data-on={i === k ? "" : undefined}
							onClick={() => pick(i)}
							className="group relative cursor-pointer bg-white px-6 pt-[22px] pb-[26px] shadow-[var(--shadow-mk-card),inset_0_3px_0_transparent] transition-shadow duration-300 hover:shadow-[var(--shadow-mk-card),inset_0_3px_0_var(--color-mk-line-strong)] data-on:shadow-[var(--shadow-mk-card),inset_0_3px_0_var(--color-ink)] max-mk-cx:px-5 max-mk-cx:pt-[18px] max-mk-cx:pb-5"
						>
							<span
								aria-hidden="true"
								className="mb-2.5 block type-xs font-semibold tracking-[.06em] text-text-3 group-data-on:text-green-600"
							>
								{num(i)}
							</span>
							<h3 className="mk-display font-title type-title-sm leading-[1.15] mk-cx:type-title-md">{s.title}</h3>
							<p className="mt-2 type-lg leading-[1.5] text-text-2">{s.body}</p>
						</li>
					))}
				</ol>
				{note}
			</div>
		</section>
	);
}
