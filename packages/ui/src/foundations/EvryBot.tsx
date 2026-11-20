"use client";

import { useCallback, useId, useRef, useState, type CSSProperties } from "react";
import { cn } from "./cn";
import { restPaths, type EvryShape, type EyeMood } from "./evry-geo";
import { mountEvry } from "./evry-life";

export type EvryBotSize = "xs" | "sm" | "md" | "lg" | "xl";
export type EvryMood = "idle" | "thinking" | "talking" | "happy";

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
	const [first] = useState(() => ({ shape: shape ?? "circle", ...restPaths(shape ?? "circle", face) }));
	const path = useRef<SVGPathElement>(null);
	const g = useRef<SVGGElement>(null);
	const eye0 = useRef<SVGPathElement>(null);
	const eye1 = useRef<SVGPathElement>(null);
	const hl = useRef<SVGRadialGradientElement>(null);
	const sh = useRef<SVGLinearGradientElement>(null);
	const live = useCallback((root: HTMLSpanElement | null) => {
		if (!root) return;
		const parts = {
			path: path.current,
			g: g.current,
			left: eye0.current,
			right: eye1.current,
			hl: hl.current,
			sh: sh.current,
		};
		if (!parts.path || !parts.g || !parts.left || !parts.right || !parts.hl || !parts.sh)
			throw Error("EvryBot mounted without its SVG parts");
		const handle = mountEvry({
			root,
			path: parts.path,
			g: parts.g,
			eyes: [parts.left, parts.right],
			hl: parts.hl,
			sh: parts.sh,
		});
		return () => handle.unmount();
	}, []);

	const style = {
		"--eb-float": `${(3 + blinkOffset * 1.2).toFixed(2)}s`,
		"--eb-float-at": `${(-blinkOffset * 4).toFixed(2)}s`,
	} as CSSProperties;
	return (
		<span
			ref={live}
			className={cn("evry-bot", className)}
			data-size={size}
			data-mood={face}
			data-shape={first.shape}
			data-want-shape={shape}
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
							<stop offset=".5" className="eb-s0" />
							<stop offset="1" className="eb-s1" />
						</linearGradient>
						<radialGradient ref={hl} id={`${id}h`} cx=".32" cy=".26" r=".46">
							<stop offset="0" className="eb-h0" />
							<stop offset="1" className="eb-h1" />
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
