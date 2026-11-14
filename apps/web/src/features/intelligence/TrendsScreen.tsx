import { TREND_FACTS, type AssessmentHistory } from "@everyfield/contracts/intelligence";
import type { Catalog } from "@everyfield/contracts/phases";
import {
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	PageHeader,
	StatePanel,
} from "@everyfield/ui/controls";
import { cn } from "@everyfield/ui/foundations";
import { dayText, trendText } from "./assessment-model.ts";
import { IntelligenceTabs } from "./IntelligenceTabs.tsx";

/**
 * Plant Intelligence trends (WP-044, PI-029): the latest twelve complete assessments, newest first, each with the facts
 * its own original snapshot measured. A fact an older snapshot did not have reads Not measured, never zero.
 */
export function TrendsScreen({ history, catalog }: { history: AssessmentHistory; catalog: Catalog }) {
	return (
		<>
			<PageHeader
				size="xl"
				title="Plant Intelligence"
				subtitle="How your measured facts have moved across your latest assessments."
			/>
			<IntelligenceTabs current="trends" />
			<Card as="section" aria-labelledby="trends-heading">
				<CardHeader>
					<CardHeading>
						<CardTitle id="trends-heading">Trends</CardTitle>
						<CardDescription>
							{history.runs.length
								? `${history.runs.length === 1 ? "Your assessment" : `Your latest ${history.runs.length} assessments`}, newest first (up to twelve). Each keeps the numbers it measured then.`
								: "Trends start with your first assessment."}
						</CardDescription>
					</CardHeading>
				</CardHeader>
				{history.runs.length ? (
					<div className="-mx-1 overflow-x-auto px-1">
						<table className="w-full min-w-[760px] border-collapse text-sm" data-trend-runs={history.runs.length}>
							<thead>
								<tr className="text-left text-xs text-text-3">
									<th scope="col" className="py-2 pr-4 font-medium">
										Measured
									</th>
									<th scope="col" className="py-2 pr-4 font-medium">
										Phase
									</th>
									{TREND_FACTS.map((f) => (
										<th key={f.key} scope="col" className="py-2 pr-4 text-right font-medium">
											{f.label}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{history.runs.map((r) => (
									<tr key={r.runId} className="border-t border-line" data-run={r.runId}>
										<th scope="row" className="py-2.5 pr-4 text-left font-medium whitespace-nowrap text-ink">
											{dayText(r.measuredOn)}
										</th>
										<td className="py-2.5 pr-4 whitespace-nowrap text-ink-2" title={catalog.phases[r.phase]?.name}>
											Phase {r.phase}
										</td>
										{r.values.map((v, i) => (
											<td
												key={TREND_FACTS[i]!.key}
												data-trend={TREND_FACTS[i]!.key}
												data-state={v.state}
												className={cn(
													"py-2.5 pr-4 text-right whitespace-nowrap",
													v.state === "measured" ? "num font-medium text-ink" : "text-xs text-text-3",
												)}
											>
												{trendText(v)}
											</td>
										))}
									</tr>
								))}
							</tbody>
						</table>
					</div>
				) : (
					<StatePanel tone="neutral" title="No assessments yet" headingLevel="h3">
						Each complete assessment adds a row here, dated, with the facts it measured.
					</StatePanel>
				)}
				{history.runs.length ? (
					<p className="mt-4 text-xs text-text-3">
						Not measured means that assessment was made before Everyfield measured the fact. It is not a zero.
					</p>
				) : null}
			</Card>
		</>
	);
}
