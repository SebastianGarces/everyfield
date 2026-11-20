"use client";

import { useReduced } from "@/components/motion/scene";
import { ArrowRight02Icon } from "@hugeicons/core-free-icons";
import { cn, observeSize } from "@everyfield/ui/foundations";
import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { PlaybackGlyph } from "@/components/kit/kit";
import { Backdrop } from "../photo/Backdrop";
import type { PhotoName } from "../photo/photos";
import { createAutoplay, joinRefs } from "../playback";

type Props = {
	sentence: string;
	lead: string;
	tail: string;
	phrases: string[];
	panes: ReactNode[];
	apps: ReactNode[];
	photos: PhotoName[];
};

const STEP = 5500;
const EASE = "cubic-bezier(.65,0,.35,1)";

export function PathsCycle({ sentence, lead, tail, phrases, panes, apps, photos }: Props) {
	const reduced = useReduced();
	const items = useRef<(HTMLSpanElement | null)[]>([]);
	const dot = useRef<HTMLSpanElement>(null);
	const [k, setK] = useState(0);
	const [paused, setPaused] = useState(false);
	const [w, setW] = useState<{ items: number[]; max: number; dot: number } | null>(null);
	const [autoplay] = useState(() => createAutoplay(STEP));
	const n = phrases.length;

	const run = useCallback(
		(node: HTMLDivElement | null) =>
			joinRefs<HTMLDivElement>(
				observeSize(
					() => {
						const ws = items.current.map((e) => e?.offsetWidth ?? 0);
						const next = {
							items: ws,
							max: Math.max(...ws),
							dot: dot.current?.offsetWidth ?? 0,
						};
						setW((c) =>
							c && c.max === next.max && c.dot === next.dot && c.items.join() === next.items.join() ? c : next,
						);
					},
					{ fonts: true },
				),
				autoplay.observe(() => {
					setK((c) => (c + 1) % n);
					autoplay.restart();
				}, 0.3),
			)(node),
		[autoplay, n],
	);

	const wk = w ? w.items[k]! : 0;
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
					onClick={() => {
						if (reduced) {
							setK((c) => (c + 1) % n);
							return;
						}
						setPaused(!paused);
						autoplay.hold("paused", !paused);
					}}
					className="absolute right-4 bottom-4 z-2 grid size-[34px] place-items-center rounded-full border-0 bg-mk-ink-46 text-cream before:absolute before:-inset-[5px] before:content-[''] hover:bg-mk-ink-66 focus-visible:outline-cream max-mk-sm:right-3 max-mk-sm:bottom-3"
				>
					{reduced ? <Icon icon={ArrowRight02Icon} size={14} /> : <PlaybackGlyph paused={paused} />}
				</button>
			</div>
		</div>
	);
}

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
