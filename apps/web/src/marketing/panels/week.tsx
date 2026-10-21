import type { ReactNode } from "react";
import { cn } from "@/components/cn";
import { Icon } from "@/components/Icon";
import { Av, StageChip, type Tone } from "@/components/kit/kit";
import { Count, Done, Fade, Field, MoodBot, Move, Target, Tf, Typed } from "@/components/motion/fx";
import { St } from "@/components/motion/scene";
import { PanelCard } from "../chapters/panel-frame";
import { CX_PEOPLE, CX_TYPES } from "../demo-data";
import { ICONS } from "../icons";
import { CHIP } from "./classes";
import { Head, Lab, Num, PIcon } from "./parts";
import { Fly, FlyGuest, WeekFx } from "./week-fx";

// The home week chapter: reach, gather, follow up, commit. Markup renders on the server; the timing is in week-fx.tsx.

const TONE: Record<string, Tone> = {
	"tone-ink": "ink",
	"tone-blue": "blue",
	"tone-amber": "amber",
	"tone-violet": "violet",
	"tone-green": "green",
	"tone-teal": "teal",
};
const tone = (k: string) => TONE[k] ?? "ink";

/** A thin meter (8 px in the chapters) whose fill slides in. */
function Meter({ fx, n, color }: { fx: string; n: number; color: string }) {
	return (
		<div className="relative mt-[5px] h-2 overflow-hidden rounded-full bg-surface-2">
			<Tf fx={fx} n={n} className="absolute inset-0 rounded-full">
				<span className="absolute inset-0 rounded-full" style={{ background: color }} />
			</Tf>
		</div>
	);
}

/* ---------- 1. People: counts rise, a list is imported, the new people land in Prospect ---------- */
const PEOPLE_MAX = CX_PEOPLE.reduce((a, r) => a + r[2], 0) + 20;

export function PeoplePanel({ title, note }: { title: string; note: string }) {
	return (
		<WeekFx>
			<PanelCard kind="people">
				<Head
					lead={<PIcon tone="ink" icon={ICONS.users} />}
					title={title}
					sub={
						<>
							Harvest Point · <Count fx="people.total" max={PEOPLE_MAX} unit=" people" />
						</>
					}
					right={<Done target="t0" at={2000} label="Import list" done="Added" R="people.R" />}
				/>
				<St i={1} className="mt-0.5 mb-3 h-[30px]">
					<Move
						as="span"
						fx="people.added"
						className="inline-flex h-[30px] items-center gap-[7px] rounded-[16px] bg-green-50 pr-3 pl-2 type-sm font-semibold whitespace-nowrap text-green-700 opacity-0 shadow-mk-green-edge"
					>
						<Icon icon={ICONS.check} />
						24 people added from the sign-up form
					</Move>
				</St>
				<div className="grid gap-2.5">
					{CX_PEOPLE.map((r, k) => (
						<St key={r[1]} i={k + 2}>
							<div className="flex min-h-[26px] items-center gap-2">
								<StageChip tone={tone(r[0])}>{r[1]}</StageChip>
								<Num className="ml-auto font-title type-title-sm">
									<Count fx="people.row" n={k} max={r[2]} />
								</Num>
							</div>
							<Meter fx="people.meter" n={k} color={r[4]} />
						</St>
					))}
				</div>
				<St i={7}>
					<Move
						fx="people.note"
						className="mt-3.5 rounded-[14px] bg-white px-4 py-3.5 type-sm font-semibold opacity-0 shadow-mk-hairline"
					>
						{note}
					</Move>
				</St>
			</PanelCard>
		</WeekFx>
	);
}

/* ---------- 2. Meet: a gathering is created, guests check in ---------- */
const GUESTS = [
	["KW", "Kim Wu"],
	["JO", "James Okafor"],
] as const;

export function MeetPanel({ when }: { when: string }) {
	return (
		<WeekFx>
			<PanelCard kind="meet">
				<Head
					lead={<PIcon tone="blue" icon={ICONS.calendar} />}
					title="New gathering"
					sub="Harvest Point"
					right={<Done target="t1" at={3300} label="Create" done="Created" R="meet.R" />}
				/>
				<St i={1}>
					<Lab>Type</Lab>
					{/* The type picker steps through each kind of gathering, then lands on Vision meeting. */}
					<Tf as="div" fx="meet.pickPress" target="t0" layer={false}>
						<Field fx="meet.pickFocus">
							<span className="inline-block h-[1.3em] overflow-hidden align-bottom leading-[1.3em] tabular-nums">
								<Tf fx="meet.roll" className="block">
									{CX_TYPES.map((x, i) => (
										<i key={i} className="block not-italic">
											{x}
										</i>
									))}
								</Tf>
							</span>
							<Icon icon={ICONS.arrow} className="ml-auto rotate-90 text-text-3" />
						</Field>
					</Tf>
				</St>
				<St i={2} className="mt-3 grid grid-cols-2 gap-2.5">
					<div className="min-w-0">
						<Lab>When</Lab>
						<Field fx="meet.whenFocus">
							<Fade fx="meet.R" className="min-w-0 flex-1">
								<Typed text={when} fx="meet.whenType" className="min-w-0 flex-1" />
							</Fade>
						</Field>
					</div>
					<div className="min-w-0">
						<Lab>Where</Lab>
						<Field fx="meet.whereFocus">
							<Fade fx="meet.R" className="min-w-0 flex-1">
								<Typed text="Reyes home" fx="meet.whereType" className="min-w-0 flex-1" />
							</Fade>
						</Field>
					</div>
				</St>
				<St i={3} className="mt-3.5 border-t border-line pt-3">
					<div className="flex items-center justify-between gap-2">
						<span className="flex items-center gap-2">
							<Lab flush>Checked in</Lab>
							<Move as="span" fx="meet.badge" className="grid opacity-0">
								<BadgeSm>3 new guests</BadgeSm>
							</Move>
						</span>
						<Tf
							fx="meet.bump"
							className="grid origin-bottom-right font-title tracking-[-0.02em] type-title-md leading-none"
						>
							<Count fx="meet.count" max={12} />
						</Tf>
					</div>
					<div className="mt-2.5 flex h-[30px] flex-nowrap gap-1.5 overflow-hidden">
						{GUESTS.map((g, j) => (
							<Drop key={g[1]} j={j}>
								<Av small>{g[0]}</Av>
								{g[1]}
							</Drop>
						))}
						<Drop j={2} more>
							10 more
						</Drop>
					</div>
				</St>
			</PanelCard>
		</WeekFx>
	);
}
function BadgeSm({ children }: { children: ReactNode }) {
	return (
		<span className="inline-flex h-[22px] items-center gap-1.5 rounded-full bg-white px-2 type-xs font-semibold whitespace-nowrap text-text shadow-mk-badge before:size-[7px] before:rounded-full before:bg-blue-500 before:content-['']">
			{children}
		</span>
	);
}
/** A guest chip drops in from above. */
function Drop({ j, more, children }: { j: number; more?: boolean; children: ReactNode }) {
	return (
		<Move
			as="span"
			fx="meet.drop"
			n={j}
			className={cn(CHIP, "h-7 flex-none gap-[7px] pr-2.5 type-xs opacity-0", more ? "pl-2.5" : "pl-1")}
		>
			{children}
		</Move>
	);
}

/* ---------- 3. Follow: Evry makes a follow-up task for each new guest of the vision meeting; they move to your week ---------- */
const FGUESTS = [
	["KW", "Kim Wu"],
	["JO", "James Okafor"],
	["SN", "Sara Nunez"],
] as const;

type FollowDemo = {
	says: string;
	after: string;
	due: string;
	note: string;
	tasks: readonly (readonly [string, string])[];
};

export function FollowPanel({ demo }: { demo: FollowDemo }) {
	return (
		<WeekFx>
			<PanelCard kind="follow">
				<Head lead={<MoodBot fx="follow.mood" />} title="Evry" sub={demo.after} />
				<St i={1} className="rounded-[14px] bg-surface px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
					<Typed text={demo.says} fx="follow.type" className="type-sm leading-[1.45] text-ink-2" />
					<div className="mt-2.5 flex flex-wrap gap-1.5">
						{FGUESTS.map((g, k) => (
							<Move
								key={g[1]}
								as="span"
								fx="follow.chip"
								n={k}
								target={"fsrc" + k}
								className={cn(CHIP, "h-7 gap-[7px] pr-2.5 pl-1 type-xs opacity-0")}
							>
								<Av small>{g[0]}</Av>
								{g[1]}
							</Move>
						))}
					</div>
				</St>
				<St i={2} className="mt-3 flex items-center justify-between gap-2.5">
					<span className="type-sm text-text-3">{demo.note}</span>
					<Done target="t0" at={3600} label="Add to my week" done="Added" R="follow.R" />
				</St>
				<St i={3} className="mt-3.5 border-t border-line pt-3">
					<div className="flex items-center justify-between gap-2">
						<Lab flush>Your week</Lab>
						<Tf fx="follow.bump" className="grid origin-right type-sm font-semibold text-text-2">
							<Count fx="follow.count" max={5} unit=" tasks" />
						</Tf>
					</div>
					<ul className="m-0 mt-1 list-none p-0">
						{demo.tasks.map(([title, sub]) => (
							<li key={title} className="flex h-[46px] items-center gap-2.5 border-b border-line">
								<Ring />
								<span className="min-w-0 flex-1">
									<L1>{title}</L1>
									<L2>{sub}</L2>
								</span>
							</li>
						))}
						{FGUESTS.map((g, k) => (
							<li
								key={g[1]}
								className={cn(
									"relative flex h-[46px] items-center gap-2.5",
									k < FGUESTS.length - 1 && "border-b border-line",
								)}
							>
								{/* An empty slot until the guest's task lands in it. */}
								<Move
									as="span"
									fx="follow.slot"
									n={k}
									className="pointer-events-none absolute inset-x-0 inset-y-2 rounded-[10px] border border-dashed border-line-2"
								/>
								<Target name={"fdst" + k} className="grid size-[22px] flex-none place-items-center">
									<Move as="span" fx="follow.row" n={k} className="grid opacity-0">
										<Av small>{g[0]}</Av>
									</Move>
								</Target>
								<Move fx="follow.row" n={k} className="flex min-w-0 flex-1 items-center gap-2 opacity-0">
									<span className="min-w-0 flex-1">
										<L1>Follow up with {g[1]}</L1>
										<L2>{demo.due}</L2>
									</span>
									<span className="inline-flex h-[22px] flex-none items-center rounded-full bg-green-50 px-2 type-xs font-semibold text-green-700 shadow-mk-green-edge">
										New
									</span>
								</Move>
							</li>
						))}
					</ul>
				</St>
				{FGUESTS.map((g, k) => (
					<FlyGuest key={g[1]} k={k}>
						<Av small>{g[0]}</Av>
						{g[1]}
					</FlyGuest>
				))}
			</PanelCard>
		</WeekFx>
	);
}
/** An open task's empty check ring. */
function Ring() {
	return (
		<span
			aria-hidden="true"
			className="size-[22px] flex-none rounded-full bg-surface shadow-[inset_0_0_0_1.5px_var(--color-line-2)]"
		/>
	);
}
function L1({ children }: { children: ReactNode }) {
	return (
		<span className="block overflow-hidden type-sm font-semibold text-ellipsis whitespace-nowrap">{children}</span>
	);
}
function L2({ children }: { children: ReactNode }) {
	return <span className="mt-px block type-xs font-medium text-text-3">{children}</span>;
}

/* ---------- 4. Teams: commitments are recorded, each person moves into a team ---------- */
const teamAt = (k: number) => (k ? 3300 : 1700);

type TeamsDemo = {
	teams: readonly (readonly [string, string, string, number])[];
	signs: readonly (readonly [string, string, string])[];
};

export function TeamsPanel({ demo: d }: { demo: TeamsDemo }) {
	return (
		<WeekFx>
			<PanelCard kind="teams">
				<Head
					lead={<PIcon tone="violet" icon={ICONS.users} />}
					title="Your teams"
					sub="Harvest Point · committed adults"
				/>
				{d.teams.map((r, k) => (
					<St key={r[1]} i={k + 1} className="mt-3">
						<Target name={"dst" + k} as="div">
							<div className="flex min-h-[28px] items-center justify-between gap-2">
								<StageChip tone={tone(r[0])}>{r[1]}</StageChip>
								<Tf
									fx="teams.bump"
									n={k}
									className="grid origin-bottom-right font-title tracking-[-0.02em] type-title-md leading-none"
								>
									<Count fx="teams.count" n={k} max={r[3] + 1} />
								</Tf>
							</div>
							<Meter fx="teams.meter" n={k} color={r[2]} />
						</Target>
					</St>
				))}
				<St i={3} className="mt-[18px] border-t border-line pt-3 type-xs font-semibold text-text-2">
					To record
				</St>
				{d.signs.map((r, k) => (
					<St
						key={r[1]}
						i={k + 4}
						className={cn("relative isolate flex items-center gap-3", k ? "border-t border-line py-3" : "pt-2 pb-3")}
					>
						<Target
							name={"src" + k}
							className="grid size-[30px] flex-none place-items-center rounded-full bg-green-100 type-xs font-bold tracking-[.02em] text-green-700"
						>
							{r[0]}
						</Target>
						<div className="min-w-0 flex-1">
							<div className="type-md font-semibold">{r[1]}</div>
							<div className="mt-0.5 type-sm text-text-3">{r[2]}</div>
						</div>
						<Done target={k ? "t1" : "t0"} at={teamAt(k)} label="Record" done="Recorded" R="teams.R" />
					</St>
				))}
				{d.signs.map((r, k) => (
					<Fly key={r[1]} k={k}>
						<Av>{r[0]}</Av>
						{r[1]}
					</Fly>
				))}
			</PanelCard>
		</WeekFx>
	);
}
