"use client";

import { useReduced } from "@/components/motion/scene";
import { observeSize, useMediaQuery } from "@everyfield/ui/foundations";
import { NativeAnimation, scroll } from "motion/react";
import {
	useCallback,
	useMemo,
	useRef,
	useState,
	type FocusEvent,
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode,
} from "react";
import { cn } from "@/components/cn";
import { clamp } from "@/components/motion/curves";

type Props = { id: string; headingId: string; head: ReactNode; children: ReactNode };

type Geo = { a: number; travel: number; stick: number; inset: number; vw: number; fh: number; pinTop: number };
const WIDE = "(min-width: 901px)";
const START = 0.55,
	LEAD = 1;

function driveRail(track: HTMLSpanElement | null, geo: Geo) {
	const list = track?.parentElement?.querySelector("ol");
	if (!track || !list) return;
	const anim = new NativeAnimation({
		element: list,
		name: "transform",
		keyframes: [`translate3d(${geo.a.toFixed(2)}px,0,0)`, `translate3d(${(geo.a - geo.travel).toFixed(2)}px,0,0)`],
		duration: 1000,
		ease: "linear",
	});
	const stop = scroll(anim, { target: track, offset: ["start start", "end end"] });
	return () => {
		stop();
		anim.cancel();
	};
}

const cardsOf = (list: HTMLOListElement | null) => [...(list?.children ?? [])] as HTMLElement[];
function stepOf(list: HTMLOListElement | null, rail: HTMLDivElement | null) {
	const c = cardsOf(list);
	return c.length > 1 ? c[1]!.offsetLeft - c[0]!.offsetLeft : (rail?.clientWidth ?? 0);
}

export function PinnedRail({ id, headingId, head, children }: Props) {
	const reduced = useReduced();
	const frame = useRef<HTMLDivElement>(null);
	const probe = useRef<HTMLSpanElement>(null);
	const rail = useRef<HTMLDivElement>(null);
	const list = useRef<HTMLOListElement>(null);
	const wide = useMediaQuery(WIDE);
	const [geo, setGeo] = useState<Geo | null>(null);
	const pinned = wide && !reduced;

	const cards = () => cardsOf(list.current);
	const step = () => stepOf(list.current, rail.current);

	const measured = useMemo(
		() =>
			observeSize<HTMLElement>(
				(R) => {
					const F = frame.current,
						Ra = rail.current,
						L = list.current,
						Pr = probe.current;
					if (!F || !Ra || !L || !Pr || !pinned) {
						setGeo(null);
						return;
					}
					const vw = R.clientWidth,
						vh = window.innerHeight;
					const inset = parseFloat(getComputedStyle(Ra).paddingLeft) || 0;
					const top = parseFloat(getComputedStyle(Pr).top) || 0;
					const fh = F.offsetHeight,
						stick = Math.min(top, vh - fh - 16);
					const a = Math.max(0, START * vw - inset - LEAD * stepOf(L, Ra)),
						z = Math.min(vw - 2 * inset - L.scrollWidth, a);
					const pinTop = R.getBoundingClientRect().top + window.scrollY;
					const next = { a, travel: Math.max(0, a - z), stick, inset, vw, fh, pinTop };
					setGeo((g) => (g && JSON.stringify(g) === JSON.stringify(next) ? g : next));
				},
				{ also: () => [document.body], fonts: true, viewport: true },
			),
		[pinned],
	);

	const drive = useMemo(() => (geo ? (track: HTMLSpanElement | null) => driveRail(track, geo) : undefined), [geo]);

	const progress = useCallback(
		(y: number) => (geo && geo.travel ? clamp((y - geo.pinTop + geo.stick) / geo.travel) : 0),
		[geo],
	);

	const onFocus = (e: FocusEvent) => {
		const c = (e.target as Element).closest<HTMLElement>("[data-card]");
		const section = e.currentTarget.closest("section");
		if (!c || !geo || !section) return;
		const cur = geo.a - geo.travel * progress(window.scrollY),
			l = geo.inset + cur + c.offsetLeft,
			r = l + c.offsetWidth;
		let nx = cur;
		if (l < geo.inset) nx = cur + (geo.inset - l);
		else if (r > geo.vw - geo.inset) nx = cur - (r - (geo.vw - geo.inset));
		const pt = section.getBoundingClientRect().top;
		if (nx === cur && pt <= geo.stick + 1 && pt >= geo.stick - geo.travel - 1) return;
		const p = geo.travel ? clamp((geo.a - nx) / geo.travel) : 0;
		window.scrollTo({ top: Math.round(window.scrollY + pt - geo.stick + p * geo.travel), behavior: "instant" });
	};
	const onKey = (e: KeyboardEvent) => {
		const all = cards(),
			k = all.indexOf(e.target as HTMLElement),
			n = all.length;
		if (k < 0) return;
		let dest = -1;
		if (e.key === "ArrowRight") dest = Math.min(n - 1, k + 1);
		else if (e.key === "ArrowLeft") dest = Math.max(0, k - 1);
		else if (e.key === "Home") dest = 0;
		else if (e.key === "End") dest = n - 1;
		if (dest < 0) return;
		e.preventDefault();
		all[dest]!.focus({ preventScroll: true });
		if (!geo && rail.current)
			rail.current.scrollTo({
				left: Math.max(0, Math.min(rail.current.scrollWidth - rail.current.clientWidth, dest * step())),
				behavior: reduced ? "auto" : "smooth",
			});
	};

	const drag = useRef<{ x: number; s: number; moved: boolean; id: number } | null>(null);
	const dragged = useRef(false);
	const [dragging, setDragging] = useState(false);
	const onDown = (e: PointerEvent) => {
		dragged.current = false;
		if (geo || e.pointerType !== "mouse" || e.button !== 0 || !rail.current) return;
		drag.current = { x: e.clientX, s: rail.current.scrollLeft, moved: false, id: e.pointerId };
	};
	const onMove = (e: PointerEvent) => {
		const d = drag.current,
			Ra = rail.current;
		if (!d || !Ra) return;
		const dx = e.clientX - d.x;
		if (!d.moved && Math.abs(dx) > 5) {
			d.moved = true;
			setDragging(true);
			try {
				Ra.setPointerCapture(d.id);
			} catch {}
		}
		if (d.moved) Ra.scrollLeft = d.s - dx;
	};
	const onUp = () => {
		const d = drag.current,
			Ra = rail.current;
		drag.current = null;
		if (!d?.moved || !Ra) return;
		const at = Ra.scrollLeft,
			s = step();
		setDragging(false);
		Ra.scrollLeft = at;
		Ra.scrollTo({
			left: Math.max(0, Math.min(Ra.scrollWidth - Ra.clientWidth, Math.round(at / s) * s)),
			behavior: reduced ? "auto" : "smooth",
		});
		dragged.current = true;
	};

	return (
		<section
			ref={measured}
			id={id}
			className="relative scroll-mt-[88px] py-section max-mk-sm:scroll-mt-[76px] [--phc-top:clamp(148px,2.5vw+126px,162px)]"
		>
			<span ref={probe} aria-hidden="true" className="pointer-events-none invisible absolute top-(--phc-top) size-0" />
			<div className="relative" style={geo ? { height: geo.fh + geo.travel } : undefined}>
				<span
					ref={drive}
					aria-hidden="true"
					className="pointer-events-none invisible absolute inset-x-0 w-px"
					style={geo ? { top: -geo.stick, height: `calc(${geo.travel}px + 100vh)` } : { top: 0, height: 0 }}
				/>
				<div ref={frame} className={cn(pinned && "sticky")} style={geo ? { top: geo.stick } : undefined}>
					{head}
					<div
						ref={rail}
						role="region"
						aria-roledescription="carousel"
						aria-labelledby={headingId}
						onKeyDown={onKey}
						onFocus={onFocus}
						onPointerDown={onDown}
						onPointerMove={onMove}
						onPointerUp={onUp}
						onPointerCancel={onUp}
						onClickCapture={(e) => {
							if (dragged.current) {
								dragged.current = false;
								e.preventDefault();
								e.stopPropagation();
							}
						}}
						className={cn(
							"[--phc-in:max(var(--spacing-page),calc((100%-var(--container-mk))/2+var(--spacing-page)))] px-(--phc-in) pt-1.5 pb-[22px]",
							pinned
								? "overflow-clip"
								: cn(
										"cursor-grab snap-x snap-mandatory scroll-px-(--phc-in) overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
										dragging && "cursor-grabbing select-none",
									),
						)}
					>
						<ol ref={list} className={cn("flex w-max gap-4", pinned && "will-change-transform")}>
							{children}
						</ol>
					</div>
				</div>
			</div>
		</section>
	);
}
