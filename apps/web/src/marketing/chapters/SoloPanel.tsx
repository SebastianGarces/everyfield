"use client";

import { motionValue } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useReduced, useTicker } from "@/components/motion/scene";
import { DeskBg, DeskPanel, sel } from "../chapters/ScrollChapter";
import { SCENES, type PanelKind } from "../scene-data";

/**
 * One product panel on its gradient frame, outside a chapter (the Evry section). It plays once to its end when it first
 * comes on screen and holds there, as a step of an auto list does. Reduced motion shows the still frame. The panel is a
 * picture (aria-hidden); the section's text carries the meaning.
 */
export function SoloPanel({ kind, tone, children }: { kind: PanelKind; tone: string; children: ReactNode }) {
	const reduced = useReduced();
	const root = useRef<HTMLDivElement>(null);
	const [c] = useState(() => ({
		sw: motionValue(0),
		sel: motionValue(sel(0, -1)),
		t: motionValue(0),
		since: motionValue(1e6),
	}));
	const [on, setOn] = useState(false);
	const seen = useRef(false);

	useEffect(() => {
		if (!reduced) return;
		c.sw.set(1e6);
		c.since.set(1e6);
		c.t.set(SCENES[kind].still);
	}, [reduced, c, kind]);

	useEffect(() => {
		const r = root.current;
		if (!r) return;
		const io = new IntersectionObserver(
			(es) => {
				const e = es[es.length - 1]!;
				if (e.isIntersecting && !seen.current && !reduced) {
					seen.current = true;
					c.sw.set(0);
					c.since.set(0);
					c.t.set(0);
				}
				setOn(e.isIntersecting);
			},
			{ threshold: 0 },
		);
		io.observe(r);
		return () => io.disconnect();
	}, [c, reduced]);

	useTicker(on && !reduced, (dt) => {
		const S = SCENES[kind];
		c.sw.set(c.sw.get() + dt);
		c.since.set(c.sw.get());
		c.t.set(Math.min(c.t.get() + dt, S.end ?? S.L));
	});

	return (
		<div
			ref={root}
			data-idle={on && !reduced ? undefined : ""}
			className="ef-ui relative isolate grid h-[560px] place-items-center overflow-hidden rounded-frame shadow-mk-frame max-mk-cx:h-auto max-mk-cx:grid-cols-[minmax(0,1fr)] max-mk-cx:rounded-card max-mk-cx:px-4 max-mk-cx:pt-11 max-mk-cx:pb-7"
		>
			<DeskBg tone={tone} sw={c.sw} sel={c.sel} i={0} />
			<div aria-hidden="true" className="contents">
				<DeskPanel sw={c.sw} sel={c.sel} i={0} t={c.t} since={c.since} place="auto">
					{children}
				</DeskPanel>
			</div>
		</div>
	);
}
