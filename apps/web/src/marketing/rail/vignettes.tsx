import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/components/cn";
import { Badge, CardIcon, type Tone } from "@/components/kit/kit";
import { ICONS, type IconName } from "../icons";
import { EASTSIDE_DAYS } from "../oversight/demo";

// The small product vignettes on the phases rail cards (Marketing v15, Revision 26). Static pictures of the app with the
// demo church's data; Server Components.

const T = "font-title type-lg leading-[1.2] tracking-[-0.02em] truncate";
const S = "truncate type-xs text-text-3";
const K = "type-xs font-semibold whitespace-nowrap text-text-2";
const IT = "truncate type-sm font-semibold";

function Vignette({ children }: { children: ReactNode }) {
	return (
		<div className="bg-white px-[15px] pt-3.5 pb-[15px] type-sm leading-[1.4] text-text shadow-mk-vignette">
			{children}
		</div>
	);
}
function Head({
	icon,
	tone,
	title,
	sub,
	right,
}: {
	icon: IconName;
	tone: Tone;
	title: string;
	sub: string;
	right?: ReactNode;
}) {
	return (
		<div className="flex items-center gap-2.5">
			<CardIcon tone={tone} icon={ICONS[icon]} size={34} glyph={16} />
			<div className="min-w-0 flex-1">
				<div className={T}>{title}</div>
				<div className={cn(S, "mt-px")}>{sub}</div>
			</div>
			{right}
		</div>
	);
}
function Delta({ children }: { children: ReactNode }) {
	return (
		<span className="inline-flex h-[26px] items-center gap-1.5 bg-white px-2.5 type-sm font-semibold whitespace-nowrap shadow-[inset_0_0_0_1px_var(--color-line)] before:border-x-[5px] before:border-b-[7px] before:border-x-transparent before:border-b-green-500 before:content-['']">
			{children}
		</span>
	);
}
function Stat({ n, children }: { n: string; children: ReactNode }) {
	return (
		<div className="mt-3 flex items-center gap-3">
			<span className="font-display type-display-md leading-[.95] tracking-[-0.02em] whitespace-nowrap">{n}</span>
			{children}
		</div>
	);
}
function Inset({ icon, tone, title, sub }: { icon: IconName; tone: Tone; title: string; sub: string }) {
	return (
		<div className="mt-3 flex items-center gap-2.5 bg-surface px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--color-line)]">
			<CardIcon tone={tone} icon={ICONS[icon]} size={30} glyph={16} />
			<div className="min-w-0 flex-1">
				<div className={IT}>{title}</div>
				<div className={cn(S, "mt-0.5")}>{sub}</div>
			</div>
		</div>
	);
}
/** A thin meter; the fill is hatched or solid. */
function Meter({ pct, color, hatch }: { pct: string; color: string; hatch?: boolean }) {
	return (
		<div className="relative mt-1.5 h-2.5 overflow-hidden bg-white shadow-[inset_0_0_0_1px_var(--color-line)]">
			<span
				className={cn("absolute inset-y-0.5 left-0.5", hatch && "mk-hatch")}
				style={
					{ width: `calc(${pct} - 4px)`, ...(hatch ? { "--hatch": color } : { background: color }) } as CSSProperties
				}
			/>
		</div>
	);
}


/* ---------- /oversight: what a sending church sees, plant by plant ---------- */
/** Card 2's countdown runs from the demo date (oversight/demo.ts). */
export function PlantVignette({ i }: { i: number }) {
	if (i === 2) return <StatusVignette />;
	if (i === 0)
		return (
			<Vignette>
				<Head
					icon="calendar"
					tone="blue"
					title="Phases"
					sub="Eastside Commons"
					right={<span className={K}>3 · Training</span>}
				/>
				<div className="mt-3.5 grid grid-cols-7 gap-1">
					{[1, 1, 1, 2, 0, 0, 0].map((s, k) => (
						<span key={k} className={cn("h-2", s === 1 ? "bg-ink" : s === 2 ? "bg-green-500" : "bg-surface-2")} />
					))}
				</div>
				<div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 type-xs text-text-2">
					{[
						["Discovery", "10 wk"],
						["Core group", "34 wk"],
						["Launch team", "18 wk"],
						["Training", "6 wk so far"],
					].map((r) => (
						<span key={r[0]}>
							<b className="block type-md font-semibold text-ink">{r[1]}</b>
							{r[0]}
						</span>
					))}
				</div>
			</Vignette>
		);
	if (i === 1)
		return (
			<Vignette>
				<Head icon="calendar" tone="green" title="Launch Sunday" sub="Sunday, May 2, 2027" />
				<Stat n={String(EASTSIDE_DAYS)}>
					<span className={cn(S, "mt-px")}>days to go</span>
				</Stat>
				<div>
					<div className="flex items-center justify-between gap-2">
						<span className={IT}>Milestones done</span>
						<span className={K}>3 of 9</span>
					</div>
					<Meter pct="33.3%" color="var(--color-green-500)" />
				</div>
			</Vignette>
		);
	if (i === 3)
		return (
			<Vignette>
				<Head icon="users" tone="blue" title="People" sub="Committed adults" />
				<Stat n="46">
					<Delta>5 in 28 days</Delta>
				</Stat>
				<Inset icon="calendar" tone="green" title="13 days between vision meetings" sub="On average" />
			</Vignette>
		);
	if (i === 4)
		return (
			<Vignette>
				<Head
					icon="users"
					tone="violet"
					title="Ministry teams"
					sub="Leader roles filled"
					right={<span className={K}>9 of 11</span>}
				/>
				<div className="mt-3.5 grid gap-[9px]">
					{["Kids", "Production"].map((r) => (
						<div key={r} className="flex items-center justify-between gap-2.5 type-sm font-medium">
							<span>{r}</span>
							<Badge status="risk" size="sm">
								Leader open
							</Badge>
						</div>
					))}
				</div>
			</Vignette>
		);
	return <TasksVignette />;
}

/* ---------- /oversight: Status and Tasks ---------- */
/** The four product status values (PI-031) across the 14 plants. A plant that shares no findings shows Limited visibility.
 *  The card crops the vignette under its second line, so the counts sit right under the head. */
const STATUS_COUNTS = [
	["positive", 7, "On track"],
	["risk", 1, "Launch readiness"],
	["attention", 3, "Watch"],
	["unknown", 3, "Limited visibility"],
] as const;
function StatusVignette() {
	return (
		<Vignette>
			<Head icon="eye" tone="teal" title="Status" sub="Your 14 plants" />
			<div className="mt-3 grid grid-cols-2 gap-x-1 gap-y-1.5 justify-items-start">
				{STATUS_COUNTS.map((r) => (
					<Badge key={r[2]} status={r[0]} size="sm" className="max-w-full">
						{r[1]} {r[2]}
					</Badge>
				))}
			</div>
		</Vignette>
	);
}
function TasksVignette() {
	return (
		<Vignette>
			<Head
				icon="task"
				tone="blue"
				title="Tasks"
				sub="Eastside Commons"
				right={
					<Badge status="attention" size="sm">
						6 past due
					</Badge>
				}
			/>
			<Stat n="38">
				<span className={cn(S, "mt-px")}>launch tasks open</span>
			</Stat>
		</Vignette>
	);
}
