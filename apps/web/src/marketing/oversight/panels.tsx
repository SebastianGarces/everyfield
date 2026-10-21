import { Mail01Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/components/cn";
import { Icon } from "@/components/Icon";
import { Avatar, Badge, CardIcon, UiButton } from "@/components/kit/kit";
import { Count, Done, Field, Hl, Move, Target, Tf } from "@/components/motion/fx";
import { St } from "@/components/motion/scene";
import { PanelCard } from "../chapters/panel-frame";
import { ICONS } from "../icons";
import { Lab, Num, PanelHead } from "../panels/parts";
import { DIGEST, MILESTONES, RES_STAGES, STAGE_AFTER, STAGES, TALK_MONTHS, TALK_NEW, TALKS } from "./demo";
import { OversightPanelsFx } from "./fx";

// The /oversight-only panels: the daily digest (Every plant, step 3) and the four steps of "Raise the next planters"
// (MUL-007 to MUL-013). Pictures of the app with the demo network's data; the timing is in fx.tsx.

const ROW = "flex items-center gap-2.5";
const TITLE = "type-md font-semibold";
const SUB = "type-xs text-text-3";

/* ---------- The daily digest by email (NTF-008): counts and dates, no names ---------- */
export function DigestPanel() {
	return (
		<OversightPanelsFx>
			<PanelCard kind="digest" className="min-w-0">
				<PanelHead
					tone="blue"
					icon={Mail01Icon}
					title="Daily digest"
					sub="Austin Sending Network · Mon, Oct 26, 7:00 AM"
				/>
				<St i={1} className="type-xs font-semibold text-text-2">
					3 plants had activity on Sun, Oct 25
				</St>
				<div className="mt-1.5">
					{DIGEST.map((r, k) => (
						<Move key={r[1]} fx="digest.row" n={k} className={cn(ROW, "border-t border-line py-2.5 opacity-0")}>
							<CardIcon tone={k === 0 ? "green" : k === 1 ? "blue" : "teal"} icon={ICONS[r[0]]} size={32} glyph={15} />
							<div className="min-w-0 flex-1">
								<div className={cn(TITLE, "truncate")}>{r[1]}</div>
								<div className={cn(SUB, "mt-0.5 truncate")}>{r[3]}</div>
							</div>
							<span className="font-title tracking-[-0.02em] type-title-sm whitespace-nowrap text-ink">{r[2]}</span>
						</Move>
					))}
				</div>
				<St i={2} className="mt-3 flex items-center justify-between gap-2.5 border-t border-line pt-3">
					<span className="type-sm text-text-3">Counts and dates only</span>
					<Tf fx="digest.press" target="t0" className="inline-flex" layer={false}>
						<UiButton variant="primary" size="sm">
							Open your plants <Icon icon={ICONS.arrow} size={14} />
						</UiButton>
					</Tf>
				</St>
			</PanelCard>
		</OversightPanelsFx>
	);
}

/* ---------- Leader pipeline (MUL-008): a person moves a stage, with a reason ---------- */
export function StagesPanel() {
	return (
		<OversightPanelsFx>
			<PanelCard kind="stages" className="min-w-0">
				<PanelHead tone="violet" icon={ICONS.users} title="Leader pipeline" sub="Grace Church · 15 people" />
				<St i={1} className="grid grid-cols-4 gap-1.5">
					{STAGES.map((s, k) => (
						<div
							key={s}
							className="relative isolate min-w-0 rounded-[12px] bg-white px-2 pt-2 pb-2.5 shadow-[inset_0_0_0_1px_var(--color-line)] max-mk-sm:px-1.5"
						>
							{k === 2 ? <Hl a={2850} b={1e9} box="inset-0 rounded-[12px] bg-green-50 shadow-mk-group-on" /> : null}
							<Num className="block font-title type-title-md leading-none">
								<Count fx="stages.n" n={k} max={9} />
							</Num>
							<small className="mt-1.5 block type-mk-pic-xs leading-[1.2] text-text-3 max-mk-sm:type-mk-pic-2xs">
								{s}
							</small>
						</div>
					))}
				</St>
				<St i={2} className="mt-3.5 rounded-[14px] px-3 pt-3 pb-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
					<div className={ROW}>
						<Avatar tone="violet" small>
							HC
						</Avatar>
						<div className="min-w-0 flex-1">
							<div className={TITLE}>Hannah Cole</div>
							<div className={cn(SUB, "mt-0.5")}>
								Apprentice <Icon icon={ICONS.arrow} size={12} className="inline align-[-2px]" /> Resident
							</div>
						</div>
					</div>
					<div className="mt-3">
						<Lab>Reason</Lab>
						<Field fx="stages.none">
							<span className="min-w-0 truncate">Finished her apprentice year.</span>
						</Field>
					</div>
					<div className="mt-3 flex justify-end">
						<Done target="t0" at={2700} label="Record move" done="Move recorded" />
					</div>
				</St>
			</PanelCard>
		</OversightPanelsFx>
	);
}

/* ---------- Sending goal (MUL-007): a target and today's count at each stage ---------- */
export function GoalsPanel() {
	return (
		<OversightPanelsFx>
			<PanelCard kind="goals" className="min-w-0">
				<PanelHead tone="green" icon={ICONS.flag} title="Sending goal" sub="Grace Church" />
				<St i={1} className="flex items-end gap-3 pb-1">
					<Num className="font-display type-display-md leading-[.95]">6</Num>
					<span className="pb-1 type-md leading-[1.3] text-text-2">leaders raised by 2030</span>
				</St>
				<St i={2} className="mt-4">
					<Lab>People at each stage today, Oct 19</Lab>
					{STAGES.map((s, k) => {
						const cells = (
							<>
								<b className="truncate font-semibold">{s}</b>
								<span className="relative h-3 overflow-hidden rounded-full bg-surface-2">
									<Tf
										as="i"
										fx="goals.bar"
										n={k}
										className="absolute inset-0 origin-left rounded-full bg-[color-mix(in_srgb,var(--color-green-500)_70%,var(--color-white))]"
									/>
								</span>
								<span className="justify-self-end font-title tracking-[-0.02em]">
									<Count fx="goals.n" n={k} max={9} />
								</span>
							</>
						);
						const cls =
							"relative isolate grid h-[38px] grid-cols-[116px_minmax(0,1fr)_24px] items-center gap-2.5 border-t border-line type-sm";
						return k === 2 ? (
							<Target key={s} name="t0" as="div" className={cls}>
								<Hl a={2200} b={1e9} />
								{cells}
							</Target>
						) : (
							<div key={s} className={cls}>
								{cells}
							</div>
						);
					})}
				</St>
				<St i={3} className="mt-3 rounded-[14px] bg-surface-2 px-3.5 py-[11px] type-sm text-text-2">
					2 residents are in the residency program now.
				</St>
			</PanelCard>
		</OversightPanelsFx>
	);
}

/* ---------- Leadership conversations (MUL-009): who met whom, counted by month ---------- */
export function TalksPanel() {
	return (
		<OversightPanelsFx>
			<PanelCard kind="talks" className="min-w-0">
				<PanelHead tone="amber" icon={ICONS.users} title="Leadership conversations" sub="Grace Church" />
				<St i={1} className="flex gap-1.5">
					<span className="inline-flex h-[30px] items-center rounded-sm bg-ink px-[11px] type-sm font-medium text-cream">
						By month
					</span>
					<span className="inline-flex h-[30px] items-center rounded-sm bg-surface px-[11px] type-sm font-medium text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line-2)]">
						By quarter
					</span>
				</St>
				<St i={2} className="mt-3.5 grid h-[104px] grid-cols-4 items-end gap-3 px-1">
					{TALK_MONTHS.map((m, k) => (
						<div key={m[0]} className="grid h-full grid-rows-[1fr_auto] justify-items-center gap-1.5">
							<span className="relative w-full max-w-11 self-stretch overflow-hidden rounded-[8px]">
								<Tf
									as="i"
									fx="talks.bar"
									n={k}
									className={cn(
										"absolute inset-0 origin-bottom rounded-[8px]",
										k === 3 ? "bg-amber-500" : "bg-[color-mix(in_srgb,var(--color-amber-500)_45%,var(--color-white))]",
									)}
								/>
							</span>
							<span className="type-xs text-text-3">
								{m[0]} · <b className="font-semibold text-ink">{k === 3 ? <Count fx="talks.n" max={10} /> : m[1]}</b>
							</span>
						</div>
					))}
				</St>
				<div className="mt-3">
					<Move fx="talks.row" className="opacity-0">
						<Talk who={TALK_NEW[0]} when={TALK_NEW[1]} />
					</Move>
					{TALKS.map((r, k) => (
						<St key={r[0]} i={3 + k}>
							<Talk who={r[0]} when={r[1]} />
						</St>
					))}
				</div>
				<St i={5} className="mt-3 flex justify-end">
					<Done target="t0" at={2400} label="Log conversation" done="Conversation logged" />
				</St>
			</PanelCard>
		</OversightPanelsFx>
	);
}
function Talk({ who, when }: { who: string; when: string }) {
	return (
		<div className="flex items-center justify-between gap-2.5 border-t border-line py-2 type-sm">
			<span className="min-w-0 truncate font-medium">{who}</span>
			<span className="text-text-3 whitespace-nowrap">{when}</span>
		</div>
	);
}

/* ---------- Residency program (MUL-010, MUL-012, MUL-013): the resident marks a milestone, the director confirms ---------- */
export function ProgramPanel() {
	return (
		<OversightPanelsFx>
			<PanelCard kind="program" className="min-w-0">
				<PanelHead
					tone="teal"
					icon={ICONS.book}
					title="Church planting residency"
					sub={"Director: Ruth Alvarez · " + STAGE_AFTER[2] + " residents"}
				/>
				<St i={1}>
					<div className="grid grid-cols-4 gap-1">
						{RES_STAGES.map((s, k) => (
							<span
								key={s[0]}
								className={cn("h-2 rounded-full", k === 0 ? "bg-ink" : k === 1 ? "bg-green-500" : "bg-surface-2")}
							/>
						))}
					</div>
					<div className="mt-2 flex items-baseline justify-between gap-2 type-xs">
						<span>
							<b className="font-semibold text-ink">Luis Romero</b>{" "}
							<span className="text-text-3">· {RES_STAGES[1][0]}, month 5</span>
						</span>
						<span className="text-text-3 whitespace-nowrap">{RES_STAGES[1][1]}</span>
					</div>
				</St>
				<St i={2} className="mt-3.5 type-xs font-semibold text-text-2">
					Milestones
				</St>
				{MILESTONES.map((m, k) => (
					<St key={m[0]} i={3 + k} className="flex items-center gap-2.5 border-t border-line py-2.5 type-sm">
						<span
							className={cn(
								"grid size-5 flex-none place-items-center rounded-full",
								m[1] === "open" ? "shadow-[inset_0_0_0_1.5px_var(--color-line-2)]" : "bg-green-500 text-ink",
							)}
						>
							{m[1] === "open" ? null : <Icon icon={ICONS.check} size={12} className="[&_path]:[stroke-width:2.6]" />}
						</span>
						<span className="min-w-0 flex-1 leading-[1.3]">
							{m[0]}
							{m[1] === "marked" ? <span className={cn(SUB, "mt-0.5 block")}>Marked done by Luis</span> : null}
						</span>
						{m[1] === "done" ? (
							<Badge status="positive" size="sm">
								Confirmed
							</Badge>
						) : m[1] === "open" ? (
							<Badge status="unknown" size="sm">
								Open
							</Badge>
						) : (
							<Done target="t0" at={2700} label="Confirm" done="Confirmed" />
						)}
					</St>
				))}
				<St i={6} className="mt-1 flex items-center gap-2.5 rounded-[14px] bg-surface-2 px-3.5 py-[11px] type-sm">
					<Icon icon={ICONS.book} size={16} />
					<span className="flex-1 font-semibold">Reading list</span>
					<span className="text-text-3">6 articles</span>
				</St>
			</PanelCard>
		</OversightPanelsFx>
	);
}
