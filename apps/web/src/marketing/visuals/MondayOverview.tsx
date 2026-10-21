import { Icon } from "@/components/Icon";
import type { CSSProperties } from "react";
import { Badge, StageChip, UiButton, type Tone } from "@/components/kit/kit";
import { EvryBot } from "@/components/kit/EvryBot";
import { cn } from "@/components/cn";
import { ICONS } from "../icons";
import { AppFrame, DashCard, DashHead, Delta, Kv, KV_V, ListRow, More } from "./dash";
import { Insight } from "./insight";

// "Here is what a Monday looks like": the overview dashboard of the demo church (Harvest Point), close to the mockup.

/** The demo values the page passes (home/demo.ts). */
export type MondayDemo = {
	title: string;
	sub: string;
	core: string;
	lastMeeting: string;
	nextMeeting: string;
	focus: { num: string; title: string; text: string };
	coming: readonly (readonly [string, string])[];
	needs: readonly (readonly [string, string])[];
};
export function MondayOverview({ demo: d }: { demo: MondayDemo }) {
	return (
		<AppFrame
			tabs
			title={d.title}
			sub={d.sub}
			topRight={
				<span className="inline-flex h-10 items-center gap-[9px] rounded-nav-item bg-surface-raised pr-3.5 pl-2 type-sm font-semibold whitespace-nowrap text-ink shadow-[0_0_0_1px_var(--color-line)] max-mk-sm:px-1.5">
					<EvryBot size="sm" />
					<span className="max-mk-sm:hidden">Ask Evry</span>
				</span>
			}
			body={
				<div className="grid grid-cols-[1fr_1fr_1.08fr] items-start gap-4 max-mk-nav:grid-cols-[1fr_1fr] max-mk-sm:grid-cols-[1fr]">
					<div className="flex min-w-0 flex-col gap-4">
						<CoreGroup d={d} />
						<Meetings />
					</div>
					<div className="flex min-w-0 flex-col gap-4 max-mk-sm:hidden">
						<People />
						<ComingUp rows={d.coming} />
					</div>
					<div className="flex min-w-0 flex-col gap-4 max-mk-nav:col-span-full max-mk-nav:grid max-mk-nav:grid-cols-[1fr_1fr] max-mk-sm:grid-cols-[1fr]">
						<Insight
							tone="g-field"
							icon={ICONS.compass}
							label="Focus this week"
							count="Plant Intelligence"
							num={d.focus.num}
							unit="since the last vision meeting"
							title={d.focus.title}
							text={d.focus.text}
							footer={
								<>
									<UiButton variant="light">
										See the facts <Icon icon={ICONS.arrow} />
									</UiButton>
									<UiButton variant="glass">Why this?</UiButton>
								</>
							}
						/>
						<NeedsYou rows={d.needs} />
					</div>
				</div>
			}
		/>
	);
}

function CoreGroup({ d }: { d: MondayDemo }) {
	return (
		<DashCard>
			<DashHead title={d.core} sub="Committed adults" right={<More />} />
			<div className="font-display type-display-lg leading-none tracking-[-0.02em] max-mk-sm:type-display-md">34</div>
			<div className="mt-2.5 flex items-center gap-2">
				<Delta dir="up">9 people</Delta>
				<span className="type-sm text-text-3">vs prior 28 days</span>
			</div>
			<div className="mt-3">
				<Kv k="Launch team" first>
					<span className="flex items-center gap-2">
						<span className={KV_V}>12</span>
						<Delta dir="up">3 people</Delta>
					</span>
				</Kv>
				<Kv k="Last vision meeting">
					<span className="flex items-center gap-2">
						<span className={KV_V}>{d.lastMeeting}</span>
						<Badge status="measured" size="sm">
							{d.nextMeeting}
						</Badge>
					</span>
				</Kv>
				<Kv k="Avg attendance">
					<span className={KV_V}>44</span>
				</Kv>
				<Kv k="Followed up in 48 h">
					<span className="flex items-center gap-2">
						<span className={KV_V}>71%</span>
						<Delta dir="down">8%</Delta>
					</span>
				</Kv>
			</div>
		</DashCard>
	);
}

const BARS = [38, 44, 41, 52, 55, 50, 61, 66, 70];
function Meetings() {
	return (
		<DashCard>
			<DashHead title="Vision meetings" right={<span className="type-sm text-text-3">Attendance, last 10</span>} />
			<div className="mt-[26px] flex h-[150px] items-end gap-2">
				{BARS.map((h, i) => (
					<div
						key={i}
						className="mk-hatch relative flex-1 rounded-[8px_8px_4px_4px] [--hatch:var(--color-green-500)]"
						style={{ height: h + "%" }}
					/>
				))}
				<div className="relative flex-1 rounded-[8px_8px_4px_4px] bg-green-500" style={{ height: "78%" }}>
					<span className="absolute -top-[22px] left-1/2 -translate-x-1/2 font-sans type-xs leading-none font-semibold">
						47
					</span>
				</div>
			</div>
			<div className="mt-2 flex justify-between type-xs text-text-3">
				<span>Jun 1</span>
				<span>Sep 28</span>
			</div>
		</DashCard>
	);
}

const STAGES: [Tone, string, number, number, string, boolean][] = [
	["ink", "Prospect", 82, 100, "var(--color-text-3)", true],
	["blue", "Attendee", 41, 50, "var(--color-blue-500)", true],
	["amber", "Following up", 23, 28, "var(--color-amber-500)", true],
	["violet", "Interviewed", 14, 17, "var(--color-violet-500)", true],
	["green", "Core group", 34, 41, "var(--color-green-500)", false],
	["teal", "Launch team", 12, 15, "var(--color-teal-500)", false],
	["ink", "Leader", 8, 10, "var(--color-ink)", false],
];
function People() {
	return (
		<DashCard>
			<DashHead title="Where people are" sub="214 people across 7 stages" />
			<div className="grid gap-3.5">
				{STAGES.map((s) => (
					<div key={s[1]}>
						<div className="flex items-center justify-between gap-2">
							<StageChip tone={s[0]}>{s[1]}</StageChip>
							<span className="font-title type-title-sm tracking-[-0.02em] whitespace-nowrap">{s[2]}</span>
						</div>
						<div className="relative mt-1.5 h-2.5 overflow-hidden bg-surface-raised shadow-[inset_0_0_0_1px_var(--color-line)]">
							<span
								className={cn("absolute top-0.5 bottom-0.5 left-0.5", s[5] && "mk-hatch")}
								style={
									s[5]
										? ({ width: s[3] + "%", "--hatch": s[4] } as CSSProperties)
										: { width: s[3] + "%", background: s[4] }
								}
							/>
						</div>
					</div>
				))}
			</div>
			<div className="mt-4 bg-surface-raised px-4 py-3.5 shadow-mk-hairline">
				<div className="type-md font-semibold">14 interviewed people have not committed yet.</div>
				<div className="mt-1 type-sm text-text-3">Half of them were interviewed more than 3 weeks ago.</div>
			</div>
		</DashCard>
	);
}

const COMING: [Tone, keyof typeof ICONS][] = [
	["green", "calendar"],
	["violet", "users"],
	["blue", "task"],
];
function ComingUp({ rows }: { rows: MondayDemo["coming"] }) {
	return (
		<DashCard>
			<DashHead title="Coming up" sub="This week and next" />
			{rows.map((r, i) => (
				<ListRow key={r[0]} tone={COMING[i]![0]} icon={ICONS[COMING[i]![1]]} title={r[0]} sub={r[1]} />
			))}
		</DashCard>
	);
}

const NEEDS: [Tone, keyof typeof ICONS][] = [
	["magenta", "alert"],
	["amber", "task"],
	["blue", "users"],
	["ink", "heart"],
];
function NeedsYou({ rows }: { rows: MondayDemo["needs"] }) {
	return (
		<DashCard>
			<DashHead title="Needs you" sub="4 things this week" right={<More />} />
			<div>
				{rows.map((r, i) => (
					<ListRow
						key={r[0]}
						first={i === 0}
						tone={NEEDS[i]![0]}
						icon={ICONS[NEEDS[i]![1]]}
						title={r[0]}
						sub={r[1]}
						end={<Icon icon={ICONS.arrow} className="text-text-3" />}
					/>
				))}
			</div>
		</DashCard>
	);
}
