"use client";

import { useReduced } from "@/components/motion/scene";
import { cn, observeSize, useMediaQuery } from "@everyfield/ui/foundations";
import { NativeAnimation, scroll } from "motion/react";
import {
	Children,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type FocusEvent,
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode,
} from "react";
import { clamp } from "@/components/motion/curves";

type Props = { id: string; headingId: string; head: ReactNode; children: ReactNode };

type Geo = { a: number; travel: number; stick: number; inset: number; vw: number };
const WIDE = "(min-width: 901px)";

function driveRail(track: HTMLSpanElement | null, geo: Geo) {
	const list = track?.parentElement?.querySelector("ol");
	if (!track || !list) return;
	const anim = new NativeAnimation({
		element: list,
		name: "transform",
		keyframes: ["translate3d(0,0,0)", `translate3d(${(-geo.travel).toFixed(2)}px,0,0)`],
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
	const [first, second] = cardsOf(list);
	return first && second ? second.offsetLeft - first.offsetLeft : (rail?.clientWidth ?? 0);
}

export function PinnedRail({ id, headingId, head, children }: Props) {
	const reduced = useReduced();
	const pin = useRef<HTMLDivElement>(null);
	const frame = useRef<HTMLDivElement>(null);
	const probe = useRef<HTMLSpanElement>(null);
	const rail = useRef<HTMLDivElement>(null);
	const list = useRef<HTMLOListElement>(null);
	const room = useRef<HTMLDivElement>(null);
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
						Pr = probe.current,
						Ro = room.current;
					if (!F || !Ra || !L || !Pr || !Ro || !pinned) {
						setGeo(null);
						return;
					}
					const vw = R.clientWidth,
						vh = window.innerHeight;
					const inset = parseFloat(getComputedStyle(Ra).paddingLeft) || 0;
					const top = parseFloat(getComputedStyle(Pr).top) || 0;
					const stick = Math.min(top, vh - F.offsetHeight - 16);
					const a = parseFloat(getComputedStyle(L).translate) || 0,
						travel = Ro.getBoundingClientRect().height;
					const next = { a, travel, stick, inset, vw };
					setGeo((g) => (g && JSON.stringify(g) === JSON.stringify(next) ? g : next));
				},
				{ also: () => [document.body], fonts: true, viewport: true },
			),
		[pinned],
	);

	const drive = useMemo(() => (geo ? (track: HTMLSpanElement | null) => driveRail(track, geo) : undefined), [geo]);

	const onFocus = (e: FocusEvent) => {
		const c = (e.target as Element).closest<HTMLElement>("[data-card]");
		if (!c || !geo || !pin.current) return;
		const pt = pin.current.getBoundingClientRect().top;
		const cur = geo.a - (geo.travel ? geo.travel * clamp((geo.stick - pt) / geo.travel) : 0),
			l = geo.inset + cur + c.offsetLeft,
			r = l + c.offsetWidth;
		let nx = cur;
		if (l < geo.inset) nx = cur + (geo.inset - l);
		else if (r > geo.vw - geo.inset) nx = cur - (r - (geo.vw - geo.inset));
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
		all[dest]?.focus({ preventScroll: true });
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
			style={{ "--cards": Children.count(children) } as CSSProperties}
			className="mk-rail relative scroll-mt-[88px] py-section max-mk-sm:scroll-mt-[76px]"
		>
			<span ref={probe} aria-hidden="true" className="pointer-events-none invisible absolute top-(--rail-top) size-0" />
			<div
				ref={pin}
				className="relative"
				style={geo ? ({ "--rail-stick": `${geo.stick}px` } as CSSProperties) : undefined}
			>
				<span
					ref={drive}
					aria-hidden="true"
					className="pointer-events-none invisible absolute inset-x-0 top-0 h-0 w-px mk-pinned:top-[calc(-1*var(--rail-stick))] mk-pinned:h-[calc(var(--rail-travel)+100vh)]"
				/>
				<div ref={frame} className="mk-pinned:sticky mk-pinned:top-(--rail-stick)">
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
							"snap-x snap-mandatory scroll-px-(--rail-inset) overflow-x-auto overflow-y-hidden overscroll-x-contain px-(--rail-inset) pt-1.5 pb-[22px] [scrollbar-width:none] max-mk-cx:cursor-grab motion-reduce:cursor-grab mk-pinned:overflow-clip [&::-webkit-scrollbar]:hidden",
							dragging && "select-none max-mk-cx:cursor-grabbing motion-reduce:cursor-grabbing",
						)}
					>
						<ol
							ref={list}
							className="flex w-max gap-(--rail-gap) mk-pinned:[translate:var(--rail-from)] mk-pinned:will-change-transform"
						>
							{children}
						</ol>
					</div>
				</div>
				<div ref={room} aria-hidden="true" className="hidden h-(--rail-travel) mk-pinned:block" />
			</div>
		</section>
	);
}
