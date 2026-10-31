"use client";

import { useTransform, type MotionValue } from "motion/react";
import { useEffect, useMemo, type ReactNode, type RefObject } from "react";
import { inOut, out, P, sine } from "@/components/motion/curves";
import { m } from "@/components/motion/m";
import { Backdrop } from "../photo/Backdrop";
import type { Backdrop as Bg } from "../photo/photos";
import { PanelSlotProvider, type PanelSlot } from "./panel-frame";

// The desktop panel parts of the auto-advancing chapters (AutoList): the panel crossfade, the step backgrounds and the
// step reveal.

export type Role = "active" | "prev" | "idle";
/** The shown step and the one fading out, packed in one number (active * 16 + prev + 1) so it can feed a multi-input
 *  transform. Set in the same call that restarts the switch clock, so a panel's style never waits for a React render
 *  to learn its new role. */
export const sel = (a: number, p: number) => a * 16 + p + 1;
const roleOf = (i: number, r: number): Role => (i === r >> 4 ? "active" : i === (r & 15) - 1 ? "prev" : "idle");
/** Panel crossfade (the hero's curves): the old card out 250 ms sine, 6 px up; the new card in after 150 ms, 380 ms ease-out, 8 px lift. */
function cardFrame(role: Role, s: number) {
	if (role === "active") {
		const pin = out(P(s, 150, 380));
		return { o: pin, y: (1 - pin) * 8 };
	}
	if (role === "prev") {
		const po = sine(P(s, 0, 250));
		return { o: 1 - po, y: -6 * po };
	}
	return { o: 0, y: 0 };
}
export function DeskPanel({
	sw,
	sel,
	i,
	t,
	since,
	children,
}: {
	sw: MotionValue<number>;
	sel: MotionValue<number>;
	i: number;
	t: MotionValue<number>;
	since: MotionValue<number>;
	children: ReactNode;
}) {
	const f = ([s, r]: number[]) => cardFrame(roleOf(i, r!), s!);
	const transform = useTransform([sw, sel], (v: number[]) => "translate3d(0px," + f(v).y.toFixed(2) + "px,0)");
	const opacity = useTransform([sw, sel], (v: number[]) => +f(v).o.toFixed(3));
	const visibility = useTransform([sw, sel], (v: number[]): string => (f(v).o > 0 ? "visible" : "hidden"));
	const slot = useMemo(
		(): PanelSlot => ({ t, since, stagger: 240, card: { transform, opacity, visibility } }),
		[t, since, transform, opacity, visibility],
	);
	return <PanelSlotProvider slot={slot}>{children}</PanelSlotProvider>;
}
/** The active step's background fades in over the previous one (500 ms in-out). Layers use z 0 to 2 (not negative):
 *  axe sorted a negative z-index gradient above the white card and reported false contrast failures. */
export function DeskBg({
	bg,
	sw,
	sel,
	i,
}: {
	bg: Bg;
	sw: MotionValue<number>;
	sel: MotionValue<number>;
	i: number;
}) {
	const opacity = useTransform([sw, sel], ([s, r]: number[]) => {
		const k = roleOf(i, r!);
		return +(k === "active" ? inOut(P(s!, 0, 500)) : k === "prev" ? 1 : 0).toFixed(3);
	});
	const zIndex = useTransform(sel, (r) => (r >> 4 === i ? 1 : 0));
	return (
		<m.span
			aria-hidden="true"
			className="absolute inset-0 opacity-0 will-change-[opacity]"
			style={{ opacity, zIndex }}
		>
			<Backdrop bg={bg} sizes="(max-width: 900px) 100vw, 50vw" className="absolute inset-0" />
		</m.span>
	);
}

/**
 * Steps below the fold rise in once (hero stagger, 75 ms apart). A step is marked data-rv="wait" only after the first
 * IntersectionObserver report says it is below 90 % of the viewport, and "in" when it enters; CSS does the rest.
 */
export function useStepReveal(lis: RefObject<(HTMLElement | null)[]>, reduced: boolean) {
	useEffect(() => {
		if (reduced) return;
		const ios: IntersectionObserver[] = [];
		lis.current.forEach((li) => {
			if (!li) return;
			let first = true;
			const io = new IntersectionObserver(
				([e]) => {
					if (!e) return;
					if (first) {
						first = false;
						const vh = e.rootBounds ? e.rootBounds.bottom / 0.9 : 0;
						if (e.boundingClientRect.top < vh * 0.9) {
							io.disconnect();
							return;
						}
						li.dataset.rv = "wait";
						return;
					}
					if (e.isIntersecting) {
						li.dataset.rv = "in";
						io.disconnect();
					}
				},
				{ rootMargin: "0px 0px -10% 0px", threshold: 0.05 },
			);
			io.observe(li);
			ios.push(io);
		});
		return () => ios.forEach((io) => io.disconnect());
	}, [lis, reduced]);
}
