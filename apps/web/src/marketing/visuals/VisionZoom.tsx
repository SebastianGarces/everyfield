import type { IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/components/cn";
import { Icon } from "@/components/Icon";
import { CardIcon, NUM, StageChip, type Tone } from "@/components/kit/kit";
import { Count, Move, Tf } from "@/components/motion/fx";
import { ICONS } from "../icons";
import { VisionScene } from "./vision-fx";

// "The vision, down to this week": four levels of the demo church (Harvest Point, as in the Monday overview): Launch
// Sunday, the current phase with its benchmark, one launch milestone, and this week's tasks, each with the goal it serves. Close to Instagram ad 13-a. Markup renders
// on the server; vision-fx.tsx moves it.

/*
 * One green line links the levels. Each node (an icon or a task ring) draws the part of the line inside its own box:
 * from the box's top edge to the node and from the node to the box's bottom edge, plus the 12 px gap below a card.
 * Every node sits at a fixed offset (x 39 px, y 33 px in a row), so the line needs no measuring.
 */
const LINE = "pointer-events-none absolute left-[38px] w-0.5 origin-top rounded-full bg-green-600";
const IN = { 33: "top-0 h-[33px]", 22: "top-0 h-[22px]" } as const;
const OUT = { 39: "top-[39px]", 33: "top-[33px]", 22: "top-[22px]" } as const;
function LineIn({ n, to = 33 }: { n: number; to?: keyof typeof IN }) {
	return <Tf as="i" fx="vision.in" n={n} layer={false} className={cn(LINE, IN[to])} />;
}
/** gap: the line also crosses the 12 px gap below its card. */
function LineOut({ n, from = 33, gap }: { n: number; from?: keyof typeof OUT; gap?: boolean }) {
	return (
		<Tf as="i" fx="vision.out" n={n} layer={false} className={cn(LINE, OUT[from], gap ? "-bottom-3" : "bottom-0")} />
	);
}

const CARD = "relative rounded-[20px] border border-[color:var(--ef-card-edge)] bg-surface shadow-card";
const LABEL = "type-sm leading-[1.3] text-text-3";
const VALUE = "mt-0.5 type-lg leading-[1.3] font-semibold text-ink";

/** A plan level: icon, small label, value, optional end. Its node sits 33 px from the top. */
function Level({
	n,
	tone,
	icon,
	label,
	value,
	end,
	children,
}: {
	n: number;
	tone: Tone;
	icon: IconSvgElement;
	label: string;
	value: string;
	end?: ReactNode;
	children?: ReactNode;
}) {
	return (
		<Move fx="vision.card" n={n} className={cn(CARD, "px-5 pt-3.5 pb-4")}>
			<LineIn n={n} />
			<LineOut n={n} gap />
			<div className="flex items-start gap-3">
				<CardIcon tone={tone} icon={icon} className="relative z-1" />
				<div className="min-w-0 flex-1 pt-px">
					<div className={LABEL}>{label}</div>
					<div className={VALUE}>{value}</div>
				</div>
				{end}
			</div>
			{children}
		</Move>
	);
}

/** The seven phases, 0 to 6, with Phase 1 the current one. */
function PhaseTrack() {
	return (
		<span aria-hidden="true" className="mt-3 flex flex-none items-center gap-1 max-mk-xs:hidden">
			{Array.from({ length: 7 }, (_, i) => (
				<i
					key={i}
					className={cn(
						"h-1.5 w-[9px] rounded-full",
						i === 0
							? "bg-green-500"
							: i === 1
								? "bg-violet-500"
								: "bg-surface-2 shadow-[inset_0_0_0_1px_var(--color-line)]",
					)}
				/>
			))}
		</span>
	);
}

/** This week's tasks: [title, what it is about, the tone and name of the goal it serves]. */
const TASKS = [
	["Set the launch team's personal invitation goal", "Launch prep", "green", "Promotion plan chosen"],
	["Invite the 9 guests from #11", "Vision meeting #12", "blue", "Committed adults"],
	["Interview David Kim", "Close to committing", "blue", "Committed adults"],
] as const satisfies readonly (readonly [string, string, Tone, string])[];

/** A thin progress bar whose fill grows from the left (fx gives its scaleX). */
function Meter({ fx, fill, color }: { fx: string; fill: string; color: string }) {
	return (
		<div
			aria-hidden="true"
			className="relative mt-2 h-2 overflow-hidden rounded-full bg-surface-2 shadow-[inset_0_0_0_1px_var(--color-line)]"
		>
			<span className={cn("absolute inset-y-0 left-0 overflow-hidden rounded-full", fill)}>
				<Tf fx={fx} as="span" layer={false} className={cn("absolute inset-0 origin-left rounded-full", color)} />
			</span>
		</div>
	);
}

export function VisionZoom() {
	return (
		<VisionScene className="ef-ui relative isolate overflow-hidden rounded-frame px-[clamp(16px,3vw,40px)] py-[clamp(20px,3.2vw,44px)] shadow-mk-frame">
			<span aria-hidden="true" className="mk-gsurf g-sage absolute inset-0 z-0 [--grain:.3]" />
			<div className="relative mx-auto flex max-w-[500px] flex-col gap-3">
				{/* Launch Sunday: the date the whole plan leads to. */}
				<Move fx="vision.card" n={0} className={cn(CARD, "px-5 pt-5 pb-5")}>
					<LineOut n={0} from={39} gap />
					<div className="flex items-start gap-3">
						<CardIcon tone="green" icon={ICONS.rocket} className="relative z-1" />
						<div className="min-w-0 flex-1">
							<div className={LABEL}>Launch Sunday</div>
							<div
								className={cn(
									NUM,
									"mt-1 font-title type-title-md mk-lg:font-display mk-lg:type-title-lg leading-[1.1]",
								)}
							>
								Sun, Mar 14, 2027
							</div>
							<div className="mt-2 type-sm text-text-2">9 launch milestones and 23 preparation tasks</div>
						</div>
					</div>
				</Move>

				{/* The current phase with its benchmark (a benchmark, never a requirement). */}
				<Level
					n={1}
					tone="violet"
					icon={ICONS.route}
					label="Phase 1"
					value="Core Group Development"
					end={<PhaseTrack />}
				>
					<div className="mt-3 ml-[50px]">
						<div className="flex items-baseline justify-between gap-3">
							<span className="type-sm text-text-3">Benchmark: committed adults</span>
							<span className={cn(NUM, "font-title type-title-md leading-none")}>
								<Count fx="vision.count" max={34} />
								<span className="ml-1 font-sans type-sm font-medium tracking-normal text-text-3">of 50</span>
							</span>
						</div>
						<Meter fx="vision.bar" fill="w-[68%]" color="bg-blue-500" />
					</div>
				</Level>

				{/* A launch milestone: one of the nine set up with the Launch Sunday date. Its tasks are ordinary tasks. */}
				<Level
					n={2}
					tone="green"
					icon={ICONS.flag}
					label="Launch milestone"
					value="Promotion plan chosen"
					end={<span className="pt-1 type-sm whitespace-nowrap text-text-3">1 of 2 tasks done</span>}
				>
					<div className="mt-3 ml-[50px] grid grid-cols-2 gap-1.5" aria-hidden="true">
						<span className="relative h-2 overflow-hidden rounded-full bg-surface-2 shadow-[inset_0_0_0_1px_var(--color-line)]">
							<Tf
								fx="vision.ms"
								as="span"
								layer={false}
								className="absolute inset-0 origin-left rounded-full bg-green-500"
							/>
						</span>
						<span className="h-2 rounded-full bg-surface-2 shadow-[inset_0_0_0_1px_var(--color-line)]" />
					</div>
				</Level>

				{/* This week: three tasks, each with the goal it serves. */}
				<Move fx="vision.card" n={3} className={cn(CARD, "pb-1.5")}>
					<div className="relative flex items-start gap-3 px-5 pt-3.5 pb-3">
						<LineIn n={3} />
						<LineOut n={3} />
						<CardIcon tone="amber" icon={ICONS.task} className="relative z-1" />
						<div className="min-w-0 flex-1 pt-px">
							<div className="font-title type-title-sm leading-[1.2] tracking-[-0.02em]">This week</div>
							<div className="mt-0.5 type-sm text-text-3">3 tasks for the core group</div>
						</div>
					</div>
					<ul className="m-0 list-none p-0">
						{TASKS.map(([title, link, tone, goal], k) => (
							<li key={title} className="relative border-t border-line">
								<Move fx="vision.task" n={k} className="relative flex items-start gap-3 px-5 py-3">
									<LineIn n={4 + k} to={22} />
									{k < TASKS.length - 1 ? <LineOut n={4 + k} from={22} /> : null}
									<span aria-hidden="true" className="relative z-1 grid w-[38px] flex-none place-items-center">
										<span className="size-5 rounded-full bg-surface shadow-[inset_0_0_0_1.5px_var(--color-line-2)]" />
									</span>
									<span className="min-w-0 flex-1">
										<span className="block type-md leading-5 font-semibold text-ink">{title}</span>
										<span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 type-sm text-text-3">
											{link}
											{/* The arrow stays with the goal, so a narrow row wraps before the arrow, not after it. */}
											<span className="inline-flex items-center gap-1.5">
												<Icon icon={ICONS.arrow} size={13} className="flex-none text-text-3" />
												<span className="sr-only">serves</span>
												<StageChip tone={tone} className="h-[22px]">
													{goal}
												</StageChip>
											</span>
										</span>
									</span>
								</Move>
							</li>
						))}
					</ul>
				</Move>
			</div>
		</VisionScene>
	);
}
