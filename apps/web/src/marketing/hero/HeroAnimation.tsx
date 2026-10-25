import type { ReactNode } from "react";
import { cn } from "@/components/cn";
import { Icon } from "@/components/Icon";
import { Av, CardIcon, NUM, StageChip, type Tone } from "@/components/kit/kit";
import { Fade, MoodBot, Move, Target, Tf } from "@/components/motion/fx";
import { ICONS } from "../icons";
import { ApproveButton, Draft, HeroStage, Roll, TypedName } from "./hero-fx";

// The home hero: one person, from first contact to the core group. Every stage chip is one of the seven people stages
// (Prospect, Attendee, Following up, Interviewed, Core group, Launch team, Leader); the last card shows all seven. The cards render on the server; hero-fx.tsx runs the
// clock, the typing, the moving chip and the pause button.

const label = (name: string) =>
	`Example: ${name} is added, comes to a vision meeting, gets a follow-up that Evry drafted and you approved, is interviewed, commits, and joins the core group.`;
const CARD =
	"relative col-start-1 row-start-1 w-[min(440px,calc(100%-32px))] px-5 pt-[18px] pb-5 opacity-0 max-mk-sm:w-[calc(100%-24px)] max-mk-sm:px-4 max-mk-sm:pt-4 max-mk-sm:pb-[18px]";

/** Card text the page passes (home/demo.ts): the meeting, the person and the core group count. */
export type HeroDemo = {
	meeting: { title: string; sub: string };
	draftSub: string;
	peopleTitle: string;
	person: HeroPerson;
};
/** core and interviewed: the stage counts before and after the person moves from Interviewed to Core group. */
type HeroPerson = {
	name: string;
	initials: string;
	core: readonly [number, number];
	interviewed: readonly [number, number];
};

export function HeroAnimation({ demo }: { demo: HeroDemo }) {
	const { meeting, person } = demo;
	return (
		<HeroStage
			label={label(person.name)}
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
				<Head i={2} lead={<MoodBot fx="mood" />} title="Evry drafted a follow-up" sub={demo.draftSub} />
				<St i={2} k={1} className="flex items-center gap-2.5 type-sm text-text-3">
					<span>To</span>
					<Slot i={2} person={person} />
				</St>
				<St
					i={2}
					k={2}
					className="relative mt-3 h-[88px] overflow-hidden bg-surface px-[13px] py-[11px] type-md leading-[1.5] text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line)]"
				>
					<Draft />
				</St>
				<St i={2} k={3} className="mt-3.5 flex items-center justify-between gap-2.5">
					<span className="skeleton block h-2" style={{ width: "28%" }} />
					<ApproveButton />
				</St>
			</Move>
			<Move fx="card" n={3} className={CARD}>
				<St i={3} k={0} className="mb-3.5 flex items-center justify-between gap-2.5">
					<Slot i={3} person={person} />
					{/* Scene 4: the stage flips from Following up to Interviewed. */}
					<span className="inline-grid">
						<Move as="span" fx="flipA" className="col-start-1 row-start-1 justify-self-end">
							<StageChip tone="amber">Following up</StageChip>
						</Move>
						<Move as="span" fx="flipB" className="col-start-1 row-start-1 justify-self-end">
							<StageChip tone="violet">Interviewed</StageChip>
						</Move>
					</span>
				</St>
				{[
					[meeting.title, "Attended"],
					["Follow-up from Evry", "Sent"],
					["Interview", "Done"],
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
					title={demo.peopleTitle}
					sub="Harvest Point · this week"
				/>
				<div className="grid gap-1">
					{BOARD.map(([tone, stage, count], k) => (
						<Row
							key={stage}
							k={k}
							chip={<StageChip tone={tone}>{stage}</StageChip>}
							slot={stage === "Core group" ? <Slot i={4} person={person} /> : undefined}
							num={
								stage === "Core group" ? (
									<Roll a={person.core[0]} b={person.core[1]} p="join" />
								) : stage === "Interviewed" ? (
									<Roll a={person.interviewed[0]} b={person.interviewed[1]} p="join" />
								) : (
									count
								)
							}
							hl={stage === "Core group"}
						/>
					))}
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

/** Maria's chip as the hidden slot in card i that the moving chip flies to. */
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

/** Scene 5: the seven people stages, in order, with the demo church's counts (they match the Monday overview after
 *  the move). Interviewed and Core group roll as the person moves; hero-fx.tsx fills the meters from the same counts. */
const BOARD: readonly (readonly [Tone, string, number])[] = [
	["ink", "Prospect", 82],
	["blue", "Attendee", 41],
	["amber", "Following up", 23],
	["violet", "Interviewed", 15],
	["green", "Core group", 33],
	["teal", "Launch team", 12],
	["ink", "Leader", 8],
];
const METER = [
	"bg-text-3",
	"bg-blue-500",
	"bg-amber-500",
	"bg-violet-500",
	"bg-green-500",
	"bg-teal-500",
	"bg-ink",
] as const;
/** One stage: its chip, the person's slot (Core group only), a meter and the count. The core-group row gets a short
 *  highlight. */
function Row({
	k,
	chip,
	slot,
	num,
	hl,
}: {
	k: number;
	chip: ReactNode;
	slot?: ReactNode;
	num: ReactNode;
	hl?: boolean;
}) {
	return (
		<St i={4} k={k + 1} className="relative flex min-h-[26px] items-center gap-2">
			{hl ? (
				<Fade fx="hl" className="absolute -inset-x-2.5 -inset-y-0.5 -z-1 bg-green-50 opacity-0 shadow-mk-green-edge" />
			) : null}
			{/* A fixed chip column, so the meters start on one edge. */}
			<span className="w-[104px] flex-none">{chip}</span>
			{slot}
			<span className="relative h-1.5 min-w-4 flex-1 overflow-hidden bg-surface-2">
				<Tf fx="meter" n={k} className={cn("absolute inset-0", METER[k])} />
			</span>
			<span className={cn(NUM, "w-7 flex-none text-right font-title type-title-sm")}>{num}</span>
		</St>
	);
}
