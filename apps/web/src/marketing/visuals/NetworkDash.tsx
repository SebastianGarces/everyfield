import { Icon } from "@/components/Icon";
import { Badge, CardIcon, UiButton, type Status, type Tone } from "@/components/kit/kit";
import { cn } from "@/components/cn";
import { ICONS } from "../icons";
import { AppFrame, DashCard, DashHead } from "./dash";
import { Insight } from "./insight";

// Revision 24: the /oversight hero dashboard (Austin Sending Network, 14 plants), demo data.

/** A plant row: name, place, icon tone, phase, core group, launch, status label and its badge. */
type Row = readonly [string, string, Tone, string, string, string, string, Status];
type Stat = readonly [string, string, string, 0 | 1];
type Finding = { num: string; unit: string; title: string; text: string };
/** The demo values the page passes (oversight/demo.ts). */
export type DashDemo = { plants: Row[]; stats: readonly Stat[]; lastCol: string; finding: Finding };
const AREAS = [
	["All", 14],
	["Austin", 5],
	["San Antonio", 3],
	["Dallas–Fort Worth", 3],
	["Houston", 1],
	["Oklahoma City", 2],
] as const;
const TH =
	"border-b border-line px-2.5 py-2 text-left text-[12px] font-medium whitespace-nowrap text-text-3 max-mk-sm:px-1.5";
const TD = "border-b border-line px-2.5 py-3 align-middle text-[13.5px] max-mk-sm:px-1.5";

export function NetworkDash({ demo }: { demo: DashDemo }) {
	const { plants, stats, lastCol, finding } = demo;
	return (
		<AppFrame
			className="motion-safe:animate-mk-ov-rise"
			avatar="JM"
			title={
				<>
					Austin Sending Network
					<Badge status="measured" className="ml-3 align-[6px] font-sans tracking-normal max-mk-sm:hidden">
						Network view
					</Badge>
				</>
			}
			sub="14 plants in Texas and Oklahoma, in launch order."
			right={
				<UiButton variant="primary" className="max-mk-sm:hidden">
					<Icon icon={ICONS.users} />
					Invite a plant
				</UiButton>
			}
			body={
				<>
					<div className="mx-1 mb-4 flex w-max gap-1 rounded-[14px] bg-surface-2 p-1 text-[13.5px] font-medium text-ink-2 max-mk-sm:ml-0">
						<span className="rounded-[10px] bg-surface-raised px-3.5 py-[7px] whitespace-nowrap text-ink shadow-raised">
							Plants
						</span>
						<span className="rounded-[10px] px-3.5 py-[7px] whitespace-nowrap">Network Intelligence</span>
					</div>
					<div className="mb-4 grid grid-cols-4 gap-4 max-mk-lg:gap-3 max-mk-sm:grid-cols-2 max-mk-sm:gap-2.5">
						{stats.map((s) => (
							<DashCard key={s[0]} className="max-mk-lg:p-4 max-mk-sm:p-3.5">
								<div className="text-[13px] text-text-2 max-mk-sm:text-[12px]">{s[0]}</div>
								<div
									className={cn(
										"mt-2 mb-1.5 font-display text-[52px] leading-none font-medium tracking-[-0.05em] max-mk-nav:text-[44px] max-mk-lg:text-[40px] max-mk-sm:mt-1.5 max-mk-sm:text-[52px]",
										s[3] === 1 && "text-amber-display",
									)}
								>
									{s[1]}
								</div>
								<div className="text-[13px] text-text-3 max-mk-lg:hidden">{s[2]}</div>
							</DashCard>
						))}
					</div>
					<div className="grid grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)] items-start gap-4 max-mk-nav:grid-cols-[minmax(0,1fr)]">
						<DashCard>
							<DashHead title="Plants" sub="In order of launch date." />
							<div className="-mt-0.5 mb-1.5 flex flex-wrap items-center gap-1.5">
								<span className="mr-1 text-[12.5px] text-text-2">Area</span>
								{AREAS.map((a, i) => (
									<span
										key={a[0]}
										className={cn(
											"inline-flex h-[30px] items-center gap-1.5 rounded-sm px-[11px] text-[12.5px] whitespace-nowrap",
											i
												? "bg-surface-raised text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line-2)] [&>b]:text-ink"
												: "bg-ink text-on-ink [&>b]:text-on-ink",
											i >= 3 && "max-mk-sm:hidden",
										)}
									>
										{a[0]} <b className="font-semibold">{a[1]}</b>
									</span>
								))}
							</div>
							<table className="w-full border-collapse">
								<thead>
									<tr>
										<th className={TH}>Plant</th>
										<th className={TH}>Phase</th>
										<th className={cn(TH, "max-mk-sm:hidden")}>Core group</th>
										<th className={cn(TH, "max-mk-sm:hidden")}>Launch</th>
										<th className={cn(TH, "max-mk-sm:hidden")}>{lastCol}</th>
									</tr>
								</thead>
								<tbody>
									{plants.map((p, i) => {
										const td = cn(TD, i === plants.length - 1 && "border-b-0");
										return (
											<tr key={p[0]}>
												<td className={td}>
													<div className="flex items-center gap-2.5">
														<CardIcon tone={p[2]} icon={ICONS.pin} size={34} className="max-mk-sm:hidden" />
														<div>
															<div className="font-semibold">{p[0]}</div>
															<div className="mt-0.5 text-[12px] text-text-3">{p[1]}</div>
														</div>
													</div>
												</td>
												<td className={td}>
													<span className="inline-flex h-[26px] items-center gap-1.5 rounded-[8px] bg-surface-2 px-2.5 text-[12.5px] font-medium whitespace-nowrap text-ink-2">
														{p[3]}
													</span>
												</td>
												<td className={cn(td, "max-mk-sm:hidden")}>{p[4]}</td>
												<td className={cn(td, "whitespace-nowrap max-mk-sm:hidden")}>{p[5]}</td>
												<td className={cn(td, "max-mk-sm:hidden")}>
													{p[6] ? (
														<Badge status={p[7]} size="sm">
															{p[6]}
														</Badge>
													) : (
														<span className="text-text-3">—</span>
													)}
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</DashCard>
						<Insight
							tone="g-lilac"
							icon={ICONS.sparkle}
							label="Top network finding"
							count="From 11 of 14 plants"
							num={finding.num}
							unit={finding.unit}
							unitMax={220}
							className="min-h-0"
							title={finding.title}
							text={finding.text}
							footer={
								<UiButton variant="light">
									See the plants <Icon icon={ICONS.arrow} />
								</UiButton>
							}
						/>
					</div>
				</>
			}
		/>
	);
}
