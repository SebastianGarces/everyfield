"use client";

import { observeSize } from "@everyfield/ui/foundations";
import type { ReactNode } from "react";
import { stopCurve, stopLeft } from "../sections/stop-curve";

const drawPath = observeSize<HTMLDivElement>(
	(band) => {
		const c = [...band.querySelectorAll("li")].map((li) => ({ x: li.offsetLeft, y: li.offsetTop }));
		band.querySelector("svg")!.setAttribute("viewBox", `0 0 ${band.clientWidth} ${band.clientHeight}`);
		band.querySelector("path")!.setAttribute("d", stopCurve(c, band.clientWidth).join(""));
	},
	{ fonts: true },
);

/**
 * "Raise the next planters." (OPS-82 prototype, pathBand without a walker): four brand-green stops on one dotted path.
 * The band is a picture, not a control: the list under it names the four stops. The line is drawn again when the band
 * resizes or the fonts arrive. It never moves, so it needs no reduced-motion or hidden-tab case.
 */
export function StopPath({ icons }: { icons: ReactNode[] }) {
	const n = icons.length;

	return (
		<div
			ref={drawPath}
			aria-hidden="true"
			className="relative mt-[clamp(24px,3vw,40px)] h-[clamp(240px,22vw,320px)] [--hi:52%] [--ic:clamp(64px,7.2vw,108px)] [--lo:70%] max-mk-cx:h-[220px] max-mk-cx:[--hi:46%]"
		>
			<svg className="pointer-events-none absolute inset-0 size-full overflow-visible">
				<path
					fill="none"
					strokeLinecap="round"
					className="stroke-mk-cream-90 [stroke-dasharray:.1_12] [stroke-width:4]"
				/>
			</svg>
			<ol className="m-0 list-none p-0">
				{icons.map((icon, i) => (
					<li key={i} className="absolute top-(--lo) -translate-1/2 even:top-(--hi)" style={{ left: stopLeft(i, n) }}>
						<span className="relative grid size-(--ic) place-items-center bg-green-500 text-ink shadow-mk-stop">
							<span className="absolute top-1 left-1.5 type-mk-pic-xs font-semibold tracking-[.06em] text-ink">
								{String(i + 1).padStart(2, "0")}
							</span>
							{icon}
						</span>
					</li>
				))}
			</ol>
		</div>
	);
}
