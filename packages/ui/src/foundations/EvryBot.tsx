"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { cn } from "./cn";
import { restPaths, type EvryShape, type EyeMood } from "./evry-geo";
import { mountEvry, type EvryHandle, type EvryLifeOptions } from "./evry-life";

export type EvryBotSize = "xs" | "sm" | "md" | "lg" | "xl";
export type EvryMood = "idle" | "thinking" | "talking" | "happy";

/**
 * Evry's character, ported from the approved prototype (OPS-84): a brand-green shape with upright ink eyes in one inline
 * SVG. The shared life loop (evry-life.ts) morphs it between five shapes, moves the eyes and the body, blinks and runs the
 * moods; CSS in product.css adds the float, the happy bounce and the thinking dot. Reduced motion shows a still circle
 * (or `shape`). The server renders the first state: `shape` or the circle, with rest eyes.
 *
 * `talking` renders as `idle`: the prototype has no talking animation (WP-088 decision). `follow` turns the eyes toward
 * the pointer. `shape` sets the first shape, and with `hold` the only one. `blinkOffset` (0 to 1) staggers the float, so
 * several bots on one page do not bob together; blinks are random per bot.
 */
export function EvryBot({
	size,
	mood = "idle",
	blinkOffset = 0,
	className,
	follow = false,
	shape,
	hold = false,
}: {
	size: EvryBotSize;
	mood?: EvryMood;
	blinkOffset?: number;
	className?: string;
	follow?: boolean;
	shape?: EvryShape;
	hold?: boolean;
}) {
	const id = "eb" + useId().replace(/[^\w-]/g, "");
	const face: EyeMood = mood === "talking" ? "idle" : mood;
	// The loop owns the paths and data-shape after mount, so React renders them once and never writes them again.
	const [first] = useState(() => ({ shape: shape ?? "circle", ...restPaths(shape ?? "circle", face) }));
	const root = useRef<HTMLSpanElement>(null);
	const path = useRef<SVGPathElement>(null);
	const g = useRef<SVGGElement>(null);
	const eye0 = useRef<SVGPathElement>(null);
	const eye1 = useRef<SVGPathElement>(null);
	const hl = useRef<SVGRadialGradientElement>(null);
	const sh = useRef<SVGLinearGradientElement>(null);
	const life = useRef<EvryHandle | null>(null);
	const small = size !== "xl";
	const options: EvryLifeOptions = { small, mood: face, shape, hold, follow };
	const latest = useRef(options);
	latest.current = options;

	useEffect(() => {
		const handle = mountEvry(
			{
				root: root.current!,
				path: path.current!,
				g: g.current!,
				eyes: [eye0.current!, eye1.current!],
				hl: hl.current!,
				sh: sh.current!,
			},
			latest.current,
		);
		life.current = handle;
		return () => {
			handle.unmount();
			life.current = null;
		};
	}, []);
	useEffect(() => {
		life.current?.update({ small, mood: face, shape, hold, follow });
	}, [small, face, shape, hold, follow]);

	const style = {
		"--eb-float": `${(3 + blinkOffset * 1.2).toFixed(2)}s`,
		"--eb-float-at": `${(-blinkOffset * 4).toFixed(2)}s`,
	} as CSSProperties;
	return (
		<span
			ref={root}
			className={cn("evry-bot", className)}
			data-size={size}
			data-mood={face}
			data-shape={first.shape}
			data-hold={hold ? "" : undefined}
			data-follow={follow ? "" : undefined}
			style={style}
			aria-hidden="true"
		>
			<span className="eb-body">
				<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
					<defs>
						<path ref={path} id={`${id}p`} d={first.body} />
						<linearGradient ref={sh} id={`${id}s`} x1="0" y1="0" x2="0" y2="1">
							<stop offset=".5" stopColor="#013C22" stopOpacity="0" />
							<stop offset="1" stopColor="#013C22" stopOpacity=".22" />
						</linearGradient>
						<radialGradient ref={hl} id={`${id}h`} cx=".32" cy=".26" r=".46">
							<stop offset="0" stopColor="#fff" stopOpacity=".6" />
							<stop offset="1" stopColor="#fff" stopOpacity="0" />
						</radialGradient>
					</defs>
					<g ref={g} className="eb-g">
						<use href={`#${id}p`} className="eb-fill" />
						<use href={`#${id}p`} fill={`url(#${id}s)`} />
						<use href={`#${id}p`} fill={`url(#${id}h)`} />
						<path ref={eye0} className="eb-e" d={first.eyes[0]} />
						<path ref={eye1} className="eb-e" d={first.eyes[1]} />
					</g>
				</svg>
			</span>
		</span>
	);
}
