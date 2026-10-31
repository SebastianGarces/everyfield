import type { ReactNode } from "react";
import { cn } from "@/components/cn";
import { Icon } from "@/components/Icon";
import { Av, CardIcon, NUM, StageChip } from "@/components/kit/kit";
import { Fade, MoodBot, Move, Target, Tf } from "@/components/motion/fx";
import { ICONS } from "../icons";
import { ApproveButton, HeroStage, Roll, Typed, TypedName } from "./hero-fx";

// The home hero (OPS-82 prototype): one person, from first contact to the core group. Evry creates a follow-up task for a
// team member and you approve it; Evry never writes the message. The cards render on the server; hero-fx.tsx runs the
// clock, the typing, the moving chip and the pause button.

const label = (name: string, first: string, task: HeroDemo["task"]) =>
	`Example: ${name} is added and comes to a vision meeting. Evry creates a follow-up task for ${task.assignee}, and you approve it. ${first} commits and joins the core group.`;
const CARD =
	"relative col-start-1 row-start-1 w-[min(440px,calc(100%-32px))] px-5 pt-[18px] pb-5 opacity-0 max-mk-sm:w-[calc(100%-24px)] max-mk-sm:px-4 max-mk-sm:pt-4 max-mk-sm:pb-[18px]";

/** Card text the page passes (home/demo.ts): the meeting, the follow-up task and the person. */
export type HeroDemo = {
	meeting: { title: string; sub: string };
	/** The task Evry creates: its title (typed in), who it is for and when it is due. */
	task: { title: string; assignee: string; initials: string; due: string };
	person: HeroPerson;
};
/** following and core: the stage counts before and after the person moves from Following up to Core group. */
type HeroPerson = {
	name: string;
	first: string;
	initials: string;
	following: readonly [number, number];
	core: readonly [number, number];
};

export function HeroAnimation({ demo }: { demo: HeroDemo }) {
	const { meeting, task, person } = demo;
	return (
		<HeroStage
			label={label(person.name, person.first, task)}
			chip={
				<>
					<Av>{person.initials}</Av>
					{person.name}
				</>
			}
		>
			<div className="col-start-1 row-start-1 w-[min(440px,calc(100%-32px))] self-stretch shadow-mk-hero-card max-mk-sm:w-[calc(100%-24px)]" />
			<div className="col-start-1 row-start-1 w-[min(440px,calc(100%-32px))] self-stretch bg-white max-mk-sm:w-[calc(100%-24px)]" />
			<Move fx="card" n={0} className={CARD}>
				<Head
					i={0}
					lead={<CardIcon tone="green" icon={ICONS.users} size={36} glyph={17} />}
					title="Add person"
					sub="People"
				/>
				<St i={0} k={1} className="flex items-end gap-2">
					<div className="min-w-0 flex-1">
						<Lab>Name</Lab>
						<div className="flex h-10 items-center overflow-hidden bg-white px-3 type-md whitespace-nowrap text-ink shadow-mk-input-focus">
							<TypedName name={person.name} />
						</div>
					</div>
					<Tf
						fx="add"
						className="relative inline-grid h-10 flex-none place-items-center overflow-hidden bg-ink px-4 type-sm font-semibold whitespace-nowrap text-white shadow-pill"
					>
						<span className="col-start-1 row-start-1 inline-flex items-center gap-1.5">Add</span>
					</Tf>
				</St>
				<St i={0} k={2} className="mt-4">
					<Lab>Recently added</Lab>
					<Li first>
						<Slot i={0} person={person} />
					</Li>
					<Li>
						<span className="skeleton block size-6 flex-none rounded-full" />
						<span className="skeleton block h-2" style={{ width: "46%" }} />
					</Li>
				</St>
			</Move>
			<Move fx="card" n={1} className={CARD}>
				<Head
					i={1}
					lead={<CardIcon tone="blue" icon={ICONS.calendar} size={36} glyph={17} />}
					title={meeting.title}
					sub={meeting.sub}
				/>
				<Kv k={1} label="Type">
					Vision meeting
				</Kv>
				<Kv k={2} label="Host home">
					<Icon icon={ICONS.pin} className="text-text-3" />
					Hyde Park
				</Kv>
				<Kv k={3} label="Guests">
					<Roll a={8} b={9} p="guests" />
				</Kv>
				<St i={1} k={4} className="mt-2.5 flex flex-nowrap gap-2 overflow-hidden">
					<span className="skeleton inline-block h-[30px] w-16 flex-none" />
					<span className="skeleton inline-block h-[30px] w-16 flex-none" />
					<Slot i={1} person={person} />
				</St>
			</Move>
			<Move fx="card" n={2} className={CARD}>
				<Head
					i={2}
					lead={<MoodBot fx="mood" />}
					title="Evry created a follow-up task"
					sub={`Assigned to ${task.assignee}. You approve it.`}
				/>
				<St i={2} k={1} className="flex items-center gap-2.5 type-sm text-text-3">
					<span>For</span>
					<Slot i={2} person={person} />
				</St>
				{/* The follow-up is a task row (ring, title, assignee), not a message. */}
				<St
					i={2}
					k={2}
					className="relative mt-3 grid h-[88px] grid-cols-[auto_1fr] content-start gap-x-2.5 gap-y-1.5 overflow-hidden bg-surface px-[13px] py-[11px] text-left type-md leading-[1.5] text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line)]"
				>
					<span
						aria-hidden="true"
						className="mt-0.5 size-4 rounded-full shadow-[inset_0_0_0_1.6px_var(--color-line-2)]"
					/>
					<span className="font-semibold text-ink">
						<Typed text={task.title} />
					</span>
					<span className="col-start-2 inline-flex items-center gap-1.5 type-sm text-text-3">
						<Av small>{task.initials}</Av>
						{task.assignee} · {task.due}
					</span>
				</St>
				<St i={2} k={3} className="mt-3.5 flex items-center justify-between gap-2.5">
					<span className="skeleton block h-2" style={{ width: "28%" }} />
					<ApproveButton />
				</St>
			</Move>
			<Move fx="card" n={3} className={CARD}>
				<St i={3} k={0} className="mb-3.5 flex items-center justify-between gap-2.5">
					<Slot i={3} person={person} />
					{/* Scene 4: the stage flips from Following up to Committed. */}
					<span className="inline-grid">
						<Move as="span" fx="flipA" className="col-start-1 row-start-1 justify-self-end">
							<StageChip tone="amber">Following up</StageChip>
						</Move>
						<Move as="span" fx="flipB" className="col-start-1 row-start-1 justify-self-end">
							<StageChip tone="green">Committed</StageChip>
						</Move>
					</span>
				</St>
				{[
					[meeting.title, "Attended"],
					[`${task.assignee.split(" ")[0]}'s follow-up task`, "Done"],
					["Commitment card", "Signed"],
				].map((r, k) => (
					<St key={r[0]} i={3} k={k + 1} className="flex h-11 items-center gap-2.5 border-t border-line">
						<Move
							as="span"
							fx="check"
							n={k}
							className="grid size-[22px] flex-none place-items-center rounded-full bg-green-500 text-ink"
						>
							<Icon icon={ICONS.check} className="[&_path]:[stroke-width:2.6]" />
						</Move>
						<span className="min-w-0 flex-1 type-sm font-semibold">{r[0]}</span>
						<span className="type-sm text-text-3">{r[1]}</span>
					</St>
				))}
				<St i={3} k={4}>
					<Li first>
						<span className="skeleton block size-6 flex-none rounded-full" />
						<span className="skeleton block h-2" style={{ width: "52%" }} />
					</Li>
				</St>
			</Move>
			<Move fx="card" n={4} className={CARD}>
				<Head
					i={4}
					lead={<CardIcon tone="ink" icon={ICONS.users} size={36} glyph={17} />}
					title="Where people are"
					sub="Harvest Point · this week"
				/>
				<div className="grid gap-3">
					<Row k={0} chip={<StageChip tone="blue">Attendee</StageChip>} num={ATTENDEES} />
					<Row
						k={1}
						chip={<StageChip tone="amber">Following up</StageChip>}
						num={<Roll a={person.following[0]} b={person.following[1]} p="join" />}
					/>
					<Row
						k={2}
						chip={<StageChip tone="green">Core group</StageChip>}
						slot={<Slot i={4} person={person} />}
						num={<Roll a={person.core[0]} b={person.core[1]} p="join" />}
						hl
					/>
				</div>
			</Move>
		</HeroStage>
	);
}

/** A card child that staggers in with its card (k-th child of card i). */
function St({ i, k, className, children }: { i: number; k: number; className?: string; children: ReactNode }) {
	return (
		<Move fx="st" n={i * 10 + k} className={className}>
			{children}
		</Move>
	);
}

function Head({ i, lead, title, sub }: { i: number; lead: ReactNode; title: string; sub: string }) {
	return (
		<St i={i} k={0} className="mb-4 flex items-center gap-3">
			{lead}
			<div className="min-w-0 flex-1">
				<div className="font-title type-title-sm leading-[1.2] tracking-[-0.02em]">{title}</div>
				<div className="mt-0.5 type-sm text-text-3">{sub}</div>
			</div>
		</St>
	);
}

function Lab({ children }: { children: ReactNode }) {
	return <span className="mb-1.5 block type-xs font-semibold text-text-2">{children}</span>;
}
/** A list line; the first one of its group has no rule above it. */
function Li({ first, children }: { first?: boolean; children: ReactNode }) {
	return <div className={cn("flex h-11 items-center gap-2.5", !first && "border-t border-line")}>{children}</div>;
}
function Kv({ k, label, children }: { k: number; label: string; children: ReactNode }) {
	return (
		<St
			i={1}
			k={k}
			className="flex h-[38px] items-center justify-between gap-2.5 border-t border-line type-sm text-text-2"
		>
			<span>{label}</span>
			<span className="inline-flex items-center gap-1.5 font-semibold text-ink">{children}</span>
		</St>
	);
}

/** The person's chip as the hidden slot in card i that the moving chip flies to. */
function Slot({ i, person }: { i: number; person: HeroPerson }) {
	return (
		<Target name={"s" + i} className="invisible inline-flex">
			<span className="inline-flex h-[30px] items-center gap-[7px] bg-white pr-3 pl-1 type-sm font-semibold whitespace-nowrap text-ink shadow-mk-chip">
				<Av>{person.initials}</Av>
				{person.name}
			</span>
		</Target>
	);
}

/** Scene 5: three people stages with the demo church's counts. Following up and Core group roll as the person moves;
 *  hero-fx.tsx fills the meters (Attendee 41, Following up 23, Core group 34, out of 50). */
const ATTENDEES = 41;
const METER = ["bg-blue-500", "bg-amber-500", "bg-green-500"] as const;
/** One stage: its chip, the person's slot (Core group only), the count, and a meter under them. The core-group row gets
 *  a short highlight. */
function Row({ k, chip, slot, num, hl }: { k: number; chip: ReactNode; slot?: ReactNode; num: ReactNode; hl?: boolean }) {
	return (
		<St i={4} k={k + 1} className="relative">
			{hl ? (
				<Fade
					fx="hl"
					className="absolute -inset-x-2.5 -inset-y-1.5 -z-1 bg-green-50 opacity-0 shadow-mk-green-edge"
				/>
			) : null}
			<div className="flex min-h-[30px] items-center gap-2">
				<span className="flex-none">{chip}</span>
				{slot}
				<span className={cn(NUM, "ml-auto font-title type-title-sm")}>{num}</span>
			</div>
			<span className="relative mt-1.5 block h-2.5 overflow-hidden bg-surface-2">
				<Tf fx="meter" n={k} className={cn("absolute inset-0", METER[k])} />
			</span>
		</St>
	);
}
