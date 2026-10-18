"use client";

import { useId, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../foundations";
import { HUE, SOLID, type Tone } from "./tone";

/**
 * Charts are small owned components (WP-088 R1, Q-CHARTS): no chart library. Each one draws with the tokens and the
 * hatch utility (hatch: planned or history, solid: measured or current) and carries a screen-reader table or list
 * with the same numbers, so no value lives only in a shape or a hue.
 */

function share(value: number, max: number): number {
	if (!(max > 0)) return 0;
	return Math.min(1, Math.max(0, value / max));
}

/** Arrow keys move through points, Home and End jump to the ends. Returns the next index or null for other keys. */
function stepIndex(e: KeyboardEvent, index: number, count: number): number | null {
	const next =
		e.key === "ArrowRight" || e.key === "ArrowDown"
			? Math.min(count - 1, index + 1)
			: e.key === "ArrowLeft" || e.key === "ArrowUp"
				? Math.max(0, index - 1)
				: e.key === "Home"
					? 0
					: e.key === "End"
						? count - 1
						: null;
	if (next !== null) e.preventDefault();
	return next;
}

export type BarDatum = {
	/** The axis label: "Oct 12". */
	label: string;
	value: number;
	/** The tooltip line after the label: "47 attended · 9 new". Defaults to the value. */
	detail?: string;
};

/**
 * BarChart (components.md): Bar, TargetLine and Axis. History bars are hatched and the last bar, the current one, is
 * solid with its value on top. Pointer hover and keyboard focus (arrow keys, Home, End) show the same tooltip.
 */
export function BarChart({
	label,
	data,
	target,
	tone = "blue",
	height = 150,
	className,
}: {
	/** The chart's accessible name: "Vision meeting attendance, last 10 meetings". */
	label: string;
	data: BarDatum[];
	target?: { value: number; label: string };
	tone?: Extract<Tone, "blue" | "green">;
	height?: number;
	className?: string;
}) {
	const [active, setActive] = useState<number | null>(null);
	const [focused, setFocused] = useState(false);
	const tipId = useId();
	const max = Math.max(1, target?.value ?? 0, ...data.map((d) => d.value)) * 1.08;
	const last = data.length - 1;
	const shown = active ?? (focused ? last : null);
	const tip = shown === null ? null : data[shown];
	const solid = tone === "green" ? "bg-green-500" : "bg-blue-500";
	return (
		<figure className={cn("relative m-0", className)}>
			<div
				role="group"
				aria-label={label}
				aria-roledescription="bar chart"
				aria-describedby={tip ? tipId : undefined}
				tabIndex={data.length ? 0 : -1}
				onFocus={(e) => setFocused(e.currentTarget.matches(":focus-visible"))}
				onBlur={() => {
					setFocused(false);
					setActive(null);
				}}
				onKeyDown={(e) => {
					const next = stepIndex(e, shown ?? last, data.length);
					if (next !== null) setActive(next);
					if (e.key === "Escape") setActive(null);
				}}
				onPointerLeave={() => setActive(null)}
				className="relative rounded-md pt-8 outline-offset-4"
				style={{ height: height + 32 }}
			>
				{target ? (
					<div
						aria-hidden="true"
						className="absolute inset-x-0 border-t-[1.5px] border-dashed border-ink-2"
						style={{ bottom: `${share(target.value, max) * height}px` }}
					>
						<span className="absolute -top-[22px] right-0 text-sm text-text-2">{target.label}</span>
					</div>
				) : null}
				<div aria-hidden="true" className="flex h-full items-end gap-2.5 max-app-sm:gap-1.5">
					{data.map((d, i) => (
						<div
							key={i}
							onPointerEnter={() => setActive(i)}
							className={cn(
								"relative flex-1 rounded-t-[6px] rounded-b-[3px] transition-opacity duration-150",
								i === last ? solid : "hatch",
								shown !== null && shown !== i && "opacity-55",
							)}
							style={{ height: `${share(d.value, max) * 100}%`, ["--hatch" as string]: HUE[tone] } as CSSProperties}
						>
							{i === last ? (
								<span className="absolute -top-[22px] left-1/2 -translate-x-1/2 text-[13px] font-semibold text-ink tabular-nums">
									{d.value}
								</span>
							) : null}
						</div>
					))}
				</div>
				{tip ? (
					<span
						id={tipId}
						role="status"
						className="pointer-events-none absolute top-0 z-10 inline-flex -translate-x-1/2 items-center gap-2 rounded-full bg-surface-raised px-3 py-1.5 text-sm whitespace-nowrap text-ink shadow-pop"
						style={{ left: `clamp(60px, ${((shown! + 0.5) / data.length) * 100}%, calc(100% - 60px))` }}
					>
						<b className="font-semibold">{tip.label}</b>
						<span aria-hidden="true" className="h-3 w-px bg-line-2" />
						{tip.detail ?? tip.value}
					</span>
				) : null}
			</div>
			{data.length ? (
				<figcaption aria-hidden="true" className="mt-2.5 flex justify-between text-sm text-text-3">
					<span>{data[0]!.label}</span>
					<span>{data[last]!.label}</span>
				</figcaption>
			) : null}
			<table className="sr-only">
				<caption>{label}</caption>
				<tbody>
					{data.map((d, i) => (
						<tr key={i}>
							<th scope="row">{d.label}</th>
							<td>{d.detail ?? d.value}</td>
						</tr>
					))}
				</tbody>
			</table>
		</figure>
	);
}

export type DotColumn = { label: string; count: number; tone: Tone };

/**
 * DotStrip (components.md): Column and Dot. One dot per person, stacked from the bottom, one column per bucket. A
 * column with more dots than fit shows the count instead of overflowing.
 */
export function DotStrip({
	label,
	columns,
	axis,
	maxDots = 10,
	className,
}: {
	label: string;
	columns: DotColumn[];
	/** The first and last axis labels: ["1 visit", "8+ visits"]. */
	axis?: [string, string];
	maxDots?: number;
	className?: string;
}) {
	return (
		<figure className={cn("m-0", className)}>
			<div aria-hidden="true" className="flex h-[150px] items-end justify-between gap-1.5">
				{columns.map((c, i) => (
					<div key={i} className="flex flex-col-reverse items-center gap-1.5">
						{Array.from({ length: Math.min(c.count, maxDots) }, (_, j) => (
							<span key={j} className={cn("size-[11px] rounded-full", SOLID[c.tone])} />
						))}
						{c.count > maxDots ? (
							<span className="text-xs font-semibold text-text-2 tabular-nums">+{c.count - maxDots}</span>
						) : null}
					</div>
				))}
			</div>
			{axis ? (
				<figcaption aria-hidden="true" className="mt-2.5 flex justify-between text-sm text-text-3">
					<span>{axis[0]}</span>
					<span>{axis[1]}</span>
				</figcaption>
			) : null}
			<table className="sr-only">
				<caption>{label}</caption>
				<tbody>
					{columns.map((c, i) => (
						<tr key={i}>
							<th scope="row">{c.label}</th>
							<td>{c.count}</td>
						</tr>
					))}
				</tbody>
			</table>
		</figure>
	);
}

/**
 * Heat levels 0 to 4: green-50 to green-700. Level 3 (the brand green in both themes) keeps the fixed ink; the other
 * steps take the theme ink or surface, so every number keeps its contrast in light and dark.
 */
const HEAT = [
	"bg-green-50 text-green-700",
	"bg-green-100 text-green-700",
	"bg-green-300 text-ink",
	"bg-green-500 text-ink-fixed",
	"bg-green-700 text-surface",
] as const;

/** The level 0..4 of a value against the largest value in the grid. Zero is always level 0. */
export function heatLevel(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
	if (value <= 0 || !(max > 0)) return 0;
	return Math.max(1, Math.min(4, Math.ceil((value / max) * 4))) as 1 | 2 | 3 | 4;
}

/**
 * Heatmap (components.md): Cell, level 0 to 4. It is a real table: row and column headers name every number, and
 * the number is written in each cell, so the shade only repeats it.
 */
export function Heatmap({
	label,
	columns,
	rows,
	className,
}: {
	label: string;
	columns: string[];
	rows: { label: string; values: number[] }[];
	className?: string;
}) {
	const max = Math.max(0, ...rows.flatMap((r) => r.values));
	return (
		<div
			role="region"
			aria-label={label}
			tabIndex={0}
			data-focus-inset=""
			className={cn("relative overflow-x-auto", className)}
		>
			<table className="w-full min-w-[320px] border-separate border-spacing-2">
				<caption className="sr-only">{label}</caption>
				<thead>
					<tr>
						<td />
						{columns.map((c) => (
							<th key={c} scope="col" className="text-center text-xs font-normal text-text-3">
								{c}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((r) => (
						<tr key={r.label}>
							<th scope="row" className="w-[90px] pr-1 text-left text-sm font-normal text-text-2">
								{r.label}
							</th>
							{r.values.map((v, i) => (
								<td
									key={i}
									className={cn(
										"h-16 rounded-[14px] text-center font-display text-base font-semibold tabular-nums max-app-sm:h-12",
										HEAT[heatLevel(v, max)],
									)}
								>
									{v}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export type StepState = "done" | "current" | "todo";
export type Step = { state: StepState; when: ReactNode; what: ReactNode; why?: ReactNode };

const STEP_DOT: Record<StepState, string> = {
	done: "bg-green-500 shadow-[0_0_0_4px_var(--ef-surface)]",
	current: "bg-ink shadow-[0_0_0_4px_var(--ef-surface),0_0_0_6px_var(--ef-green-500)]",
	todo: "bg-surface shadow-[0_0_0_4px_var(--ef-surface),inset_0_0_0_2px_var(--ef-line-2)]",
};
const STEP_WORD: Record<StepState, string> = { done: "Done", current: "Current step", todo: "Not started" };

/**
 * Stepper (components.md, Stepper / timeline): Step, Dot, When, What and Why, for a person's journey or a meeting
 * timeline. An ordered list; the current step has aria-current. It runs across from 640px and down below that.
 */
export function Stepper({ steps, label, className }: { steps: Step[]; label: string; className?: string }) {
	return (
		<ol aria-label={label} className={cn("grid auto-cols-fr grid-flow-col max-app-sm:grid-flow-row", className)}>
			{steps.map((s, i) => (
				<li
					key={i}
					aria-current={s.state === "current" ? "step" : undefined}
					className={cn(
						"relative pr-[18px] max-app-sm:pb-5 max-app-sm:pl-8",
						i < steps.length - 1 &&
							"before:absolute before:top-1.5 before:right-0 before:left-[7px] before:h-0.5 before:bg-line-2 max-app-sm:before:top-2 max-app-sm:before:bottom-0 max-app-sm:before:left-1.5 max-app-sm:before:h-auto max-app-sm:before:w-0.5",
					)}
				>
					<span
						aria-hidden="true"
						className={cn(
							"relative z-10 block size-3.5 rounded-full max-app-sm:absolute max-app-sm:left-0",
							STEP_DOT[s.state],
						)}
					/>
					<span className="sr-only">{STEP_WORD[s.state]}: </span>
					<div className="mt-3.5 text-sm text-text-3 max-app-sm:mt-0">{s.when}</div>
					<div className="mt-1.5 text-[15px] font-medium text-ink">{s.what}</div>
					{s.why ? <div className="mt-1.5 text-sm leading-[1.45] text-text-2">{s.why}</div> : null}
				</li>
			))}
		</ol>
	);
}

/**
 * PhaseTrack (components.md): Segment and Labels for phases 0 to 6. Done phases are ink, the current one is hatched
 * green and its number is bold. The track is one image named with the current phase.
 */
export function PhaseTrack({
	current,
	count = 7,
	name,
	className,
}: {
	/** The declared phase, 0-based; null when no phase is declared yet. */
	current: number | null;
	count?: number;
	/** The current phase's name: "Core Group Development". */
	name?: string;
	className?: string;
}) {
	const phases = Array.from({ length: count }, (_, i) => i);
	return (
		<div className={className}>
			<div
				role="img"
				aria-label={
					current === null ? "No phase declared yet" : `Phase ${current} of 0 to ${count - 1}${name ? `: ${name}` : ""}`
				}
				className="grid gap-1.5"
				style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
			>
				{phases.map((p) => (
					<span
						key={p}
						className={cn(
							"h-2.5 rounded-full",
							current === null || p > current ? "bg-surface-2" : p < current ? "bg-ink" : "hatch bg-green-100",
						)}
						style={p === current ? ({ "--hatch": "var(--ef-green-600)" } as CSSProperties) : undefined}
					/>
				))}
			</div>
			<div
				aria-hidden="true"
				className="mt-2.5 grid gap-1.5 text-xs text-text-3"
				style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
			>
				{phases.map((p) =>
					p === current ? (
						<b key={p} className="font-semibold text-ink">
							{p}
						</b>
					) : (
						<span key={p}>{p}</span>
					),
				)}
			</div>
		</div>
	);
}

export type JourneyPhase = {
	name: string;
	state: "done" | "current" | "next";
	/** "10 wk", "6 wk so far", "May 2". */
	weeks?: string;
	/** "Playbook 8 to 12". */
	range?: string;
	/** For the current phase: how far through its typical range, 0 to 1. */
	progress?: number;
};

/**
 * PhaseJourney (components.md): Phase, weeks and Playbook range for each phase. Done phases are full, the current one
 * is hatched to its progress. It is an ordered list; below 640px the phases stack.
 */
export function PhaseJourney({
	phases,
	label,
	className,
}: {
	phases: JourneyPhase[];
	label: string;
	className?: string;
}) {
	return (
		<ol
			aria-label={label}
			className={cn(
				"grid grid-cols-[repeat(var(--cols),minmax(0,1fr))] gap-1.5 max-app-sm:grid-cols-1 max-app-sm:gap-3",
				className,
			)}
			style={{ "--cols": phases.length } as CSSProperties}
		>
			{phases.map((p) => (
				<li
					key={p.name}
					aria-current={p.state === "current" ? "step" : undefined}
					className="flex flex-col gap-1.5 max-app-sm:grid max-app-sm:grid-cols-[110px_1fr] max-app-sm:items-center max-app-sm:gap-x-3"
				>
					<span
						aria-hidden="true"
						className="relative h-2.5 overflow-hidden rounded-full bg-surface-2 max-app-sm:col-span-2"
					>
						<i
							className={cn(
								"absolute inset-y-0 left-0 rounded-full",
								p.state === "done" && "w-full bg-green-500",
								p.state === "current" &&
									"bg-[repeating-linear-gradient(-45deg,var(--ef-green-500)_0_var(--ef-hatch-w),transparent_var(--ef-hatch-w)_calc(var(--ef-hatch-w)+var(--ef-hatch-gap)))] shadow-[inset_0_0_0_1.5px_var(--ef-green-500)]",
							)}
							style={p.state === "current" ? { width: `${share(p.progress ?? 0, 1) * 100}%` } : undefined}
						/>
					</span>
					<span className="text-xs font-semibold text-ink">
						{p.name}
						<span className="sr-only">
							{p.state === "done" ? ", done" : p.state === "current" ? ", current phase" : ", not reached"}
						</span>
					</span>
					<span className="text-xs text-text-2">
						{p.weeks ? <span className="block">{p.weeks}</span> : null}
						{p.range ? <span className="block text-text-3">{p.range}</span> : null}
					</span>
				</li>
			))}
		</ol>
	);
}

/**
 * PhasePipeline (components.md): one column per phase with its count and typical weeks. The column height is the
 * count against the largest phase; an empty phase says "none" rather than drawing a zero bar.
 */
export function PhasePipeline({
	label,
	phases,
	className,
}: {
	label: string;
	phases: { name: string; count: number; typical?: string }[];
	className?: string;
}) {
	const max = Math.max(1, ...phases.map((p) => p.count));
	return (
		<ol
			aria-label={label}
			className={cn("grid items-start gap-2.5 max-app-sm:gap-1", className)}
			style={{ gridTemplateColumns: `repeat(${phases.length}, minmax(0, 1fr))` }}
		>
			{phases.map((p) => (
				<li key={p.name} className="flex min-w-0 flex-col gap-1.5">
					<span aria-hidden="true" className="flex h-[120px] items-end">
						{p.count > 0 ? (
							<span
								className="grid w-full place-items-start justify-center rounded-t-[10px] rounded-b-[4px] bg-violet-300 pt-1.5 text-[13px] font-semibold text-ink"
								style={{ height: Math.max(26, (p.count / max) * 120) }}
							>
								{p.count}
							</span>
						) : null}
					</span>
					<span className="truncate text-[13px] font-semibold text-ink max-app-sm:text-[11px]">{p.name}</span>
					<span className="text-xs leading-[1.35] text-text-2">
						<span className="sr-only">
							{p.count} {p.count === 1 ? "plant" : "plants"}.{" "}
						</span>
						{p.count === 0 ? <span className="text-text-3">none</span> : p.typical ? `typical ${p.typical}` : null}
					</span>
				</li>
			))}
		</ol>
	);
}

/**
 * LaunchCalendar (components.md): 12 months with the plants that launch in each. A month with launches shows the count
 * in green; the plant names are listed for screen readers.
 */
export function LaunchCalendar({
	label,
	months,
	className,
}: {
	label: string;
	months: { month: string; plants: string[] }[];
	className?: string;
}) {
	return (
		<ol
			aria-label={label}
			className={cn("grid grid-cols-12 gap-1 max-app-sm:grid-cols-6 max-app-sm:gap-y-3", className)}
		>
			{months.map((m) => {
				const n = m.plants.length;
				return (
					<li key={m.month} className="flex flex-col items-center gap-1.5">
						<span className="text-[11px] tracking-[0.04em] text-text-3 uppercase">{m.month}</span>
						<span
							className={cn(
								"flex min-h-16 w-full flex-col items-center justify-center gap-[3px] rounded-[10px] p-1",
								n ? "bg-green-100" : "bg-surface-2",
							)}
						>
							{n ? (
								<>
									<b aria-hidden="true" className="font-display text-xl leading-none font-medium text-green-700">
										{n}
									</b>
									<small aria-hidden="true" className="text-[11px] text-text-2">
										{n === 1 ? "launch" : "launches"}
									</small>
									<span className="sr-only">
										{n} {n === 1 ? "launch" : "launches"}: {m.plants.join(", ")}
									</span>
								</>
							) : (
								<span className="sr-only">No launches</span>
							)}
						</span>
					</li>
				);
			})}
		</ol>
	);
}
