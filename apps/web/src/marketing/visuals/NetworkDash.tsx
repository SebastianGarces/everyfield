import { Icon } from "@/components/Icon";
import { Badge, CardIcon, UiButton, type Tone } from "@/components/kit/kit";
import { cn } from "@/components/cn";
import { ICONS } from "../icons";
import { AppFrame, DashCard, DashHead } from "./dash";
import { Insight } from "./insight";

// The /oversight hero dashboard (the OPS-82 prototype's vNetworkDash): the Austin Sending Network with 14 church plants.
// Sample data, coded in place; the prototype holds it in the page, not in the copy file.

/** A church plant row: name, place, icon tone, phase, core group, launch and its findings ("" shows a dash). */
const PLANTS: readonly (readonly [string, string, Tone, string, string, string, string])[] = [
	["Harvest Point Church", "Hyde Park, Austin, TX", "green", "1 · Core group", "34", "Mar 14, 2027", "1 finding"],
	["Eastside Commons", "East Austin, Austin, TX", "blue", "3 · Training", "46", "May 2, 2027", "4 findings"],
	["Mueller Fellowship", "Mueller, Austin, TX", "violet", "0 · Discovery", "8", "Not set", ""],
	["Alamo Heights Church", "San Antonio, TX", "amber", "2 · Launch team", "28", "Sep 2027", "2 findings"],
	["Deep Ellum Collective", "Dallas, TX", "teal", "4 · Pre-launch", "61", "Jan 24, 2027", "3 findings"],
];
/** A stat: label, value, the line under it, and whether the value is amber (needs attention). */
const STATS: readonly (readonly [string, string, string, boolean?])[] = [
	["Church plants", "14", "In 2 states"],
	["Launching in 12 months", "5", "Next: Deep Ellum, Jan 24"],
	["Committed adults", "412", "Across 14 church plants"],
	["Needs attention", "3", "Need a look this month", true],
];
const AREAS = [
	["All", 14],
	["Austin", 5],
	["San Antonio", 3],
	["Dallas–Fort Worth", 3],
	["Houston", 1],
	["Oklahoma City", 2],
] as const;
const TH =
	"border-b border-line px-2.5 py-2 text-left type-xs font-medium whitespace-nowrap text-text-3 max-mk-sm:px-1.5";
const TD = "border-b border-line px-2.5 py-3 align-middle type-md max-mk-sm:px-1.5";

export function NetworkDash() {
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
			sub="14 church plants in Texas and Oklahoma, in launch order."
			right={
				<UiButton variant="primary" className="max-mk-sm:hidden">
					<Icon icon={ICONS.users} />
					Invite a church plant
				</UiButton>
			}
			body={
				<>
					<div className="mx-1 mb-4 flex w-max gap-1 bg-surface-2 p-1 type-md font-medium text-ink-2 max-mk-sm:ml-0">
						<span className="bg-surface-raised px-3.5 py-[7px] whitespace-nowrap text-ink shadow-raised">
							Church plants
						</span>
						<span className="px-3.5 py-[7px] whitespace-nowrap">Network Intelligence</span>
					</div>
					<div className="mb-4 grid grid-cols-4 gap-4 max-mk-lg:gap-3 max-mk-sm:grid-cols-2 max-mk-sm:gap-2.5">
						{STATS.map((s) => (
							<DashCard key={s[0]} className="max-mk-lg:p-4 max-mk-sm:p-3.5">
								<div className="type-sm text-text-2 max-mk-sm:type-xs">{s[0]}</div>
								<div
									className={cn(
										"mt-2 mb-1.5 font-display type-display-md leading-none tracking-[-0.02em] max-mk-nav:type-display-sm max-mk-sm:mt-1.5 max-mk-sm:type-display-md",
										s[3] && "text-amber-display",
									)}
								>
									{s[1]}
								</div>
								<div className="type-sm text-text-3 max-mk-lg:hidden">{s[2]}</div>
							</DashCard>
						))}
					</div>
					<div className="grid grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)] items-start gap-4 max-mk-nav:grid-cols-[minmax(0,1fr)]">
						<DashCard>
							<DashHead title="Church plants" sub="In order of launch date." />
							<div className="-mt-0.5 mb-1.5 flex flex-wrap items-center gap-1.5">
								<span className="mr-1 type-sm text-text-2">Area</span>
								{AREAS.map((a, i) => (
									<span
										key={a[0]}
										className={cn(
											"inline-flex h-[30px] items-center gap-1.5 px-[11px] type-sm whitespace-nowrap",
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
										<th className={TH}>Church plant</th>
										<th className={TH}>Phase</th>
										<th className={cn(TH, "max-mk-sm:hidden")}>Core group</th>
										<th className={cn(TH, "max-mk-sm:hidden")}>Launch</th>
										<th className={cn(TH, "max-mk-sm:hidden")}>Findings</th>
									</tr>
								</thead>
								<tbody>
									{PLANTS.map((p, i) => {
										const td = cn(TD, i === PLANTS.length - 1 && "border-b-0");
										return (
											<tr key={p[0]}>
												<td className={td}>
													<div className="flex items-center gap-2.5">
														<CardIcon tone={p[2]} icon={ICONS.pin} size={34} className="max-mk-sm:hidden" />
														<div>
															<div className="font-semibold">{p[0]}</div>
															<div className="mt-0.5 type-xs text-text-3">{p[1]}</div>
														</div>
													</div>
												</td>
												<td className={td}>
													<span className="inline-flex h-[26px] items-center gap-1.5 bg-surface-2 px-2.5 type-sm font-medium whitespace-nowrap text-ink-2">
														{p[3]}
													</span>
												</td>
												<td className={cn(td, "max-mk-sm:hidden")}>{p[4]}</td>
												<td className={cn(td, "whitespace-nowrap max-mk-sm:hidden")}>{p[5]}</td>
												<td className={cn(td, "max-mk-sm:hidden")}>
													{p[6] ? (
														<Badge status="measured" size="sm">
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
							tone="g-sky"
							icon={ICONS.sparkle}
							label="Top network finding"
							count="From 11 of 14 church plants"
							num="4 of 6"
							unit="church plants within a year of launch have a Concern on Emerging leadership"
							unitMax={220}
							className="min-h-0"
							title="Emerging leadership is the most common gap before launch"
							text="It is the lens most often at Watch or Concern across church plants in Training and Pre-launch. Both church plants that have already launched had their leader roles filled before Training."
							footer={
								<UiButton variant="light">
									See the church plants <Icon icon={ICONS.arrow} />
								</UiButton>
							}
						/>
					</div>
				</>
			}
		/>
	);
}
