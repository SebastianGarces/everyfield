"use client";

import { dateText } from "@everyfield/contracts/common";

import { Button, Card, CardDescription, CardHeader, CardHeading, CardTitle, Skeleton } from "@everyfield/ui/controls";
import { KeyValue, KeyValueList } from "@everyfield/ui/display";
import { useEffect, useState } from "react";
import { visionReport } from "./actions.ts";
import { CLASSIFICATION_LABEL, scoreText, type Classification } from "./model.ts";
import type { MeetingsReport } from "./server.ts";

type Got = { status: "loading" } | { status: "failed" } | { status: "ok"; report: MeetingsReport };
const BAR: Record<Classification, string> = {
	first_time: "bg-green-500",
	returning: "bg-blue-500",
	core_group: "bg-amber-500",
};
const ORDER: Classification[] = ["core_group", "returning", "first_time"];

/**
 * The Vision report (REQ-MTG-016): totals and the attendance and evaluation trend of the last 12 finalized Vision
 * meetings. Read once when the list first shows, not again on every filter change. Unknown values say so, never 0.
 * The bars only repeat numbers that a table beside them holds for screen readers.
 */
export function VisionReport({ thisYear }: { thisYear: number }) {
	const [got, setGot] = useState<Got>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let live = true;
		visionReport()
			.then((r) => live && setGot(r.status === "ok" ? { status: "ok", report: r.value } : { status: "failed" }))
			.catch(() => live && setGot({ status: "failed" }));
		return () => {
			live = false;
		};
	}, [attempt]);
	return (
		<Card as="section" aria-labelledby="vision-report" aria-busy={got.status === "loading" || undefined}>
			<CardHeader className="mb-2">
				<CardHeading>
					<CardTitle id="vision-report">Vision meetings</CardTitle>
					<CardDescription>The last 12 with final attendance</CardDescription>
				</CardHeading>
			</CardHeader>
			{got.status === "loading" ? (
				<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] gap-6 max-app-md:grid-cols-1">
					<Skeleton className="h-[220px] rounded-md" />
					<Skeleton className="h-[220px] rounded-md" />
					<span className="sr-only" role="status">
						Loading the report
					</span>
				</div>
			) : got.status === "failed" ? (
				<div role="alert" className="flex flex-wrap items-center justify-between gap-3 py-2">
					<p className="text-md text-text-2">The report did not load. Nothing was changed.</p>
					<Button
						variant="secondary"
						size="sm"
						onClick={() => {
							setGot({ status: "loading" });
							setAttempt((n) => n + 1);
						}}
					>
						Try again
					</Button>
				</div>
			) : (
				<Body report={got.report} thisYear={thisYear} />
			)}
		</Card>
	);
}

function Body({ report, thisYear }: { report: MeetingsReport; thisYear: number }) {
	const s = report.stats;
	const points = report.attendance?.points ?? [];
	const scores = new Map(report.evaluation?.points.map((p) => [p.meetingId, p]) ?? []);
	const max = Math.max(1, ...points.map((p) => p.attended));
	return (
		<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] items-start gap-6 max-app-md:grid-cols-1">
			{s ? (
				<KeyValueList className="self-start">
					<KeyValue size="sm" k="Held" value={s.held} />
					<KeyValue
						size="sm"
						k="Average attendance"
						value={s.averageAttendance.status === "known" ? scoreText(s.averageAttendance.value) : "Unknown"}
					/>
					<KeyValue size="sm" k="Different people" value={s.uniqueAttendees} />
					<KeyValue size="sm" k="First visits" value={s.firstTime} />
					<KeyValue size="sm" k="Returning visits" value={s.returning} />
					<KeyValue
						size="sm"
						k="Average evaluation"
						value={s.averageEvaluation.status === "known" ? `${scoreText(s.averageEvaluation.value)} of 5` : "Unknown"}
					/>
				</KeyValueList>
			) : (
				<p className="text-md text-text-3">The totals did not load.</p>
			)}
			{points.length === 0 ? (
				<p className="self-center text-md text-text-3">
					{report.attendance
						? "No Vision meeting has final attendance yet. Finalize one to start the trend."
						: "The trend did not load."}
				</p>
			) : (
				<figure className="flex min-w-0 flex-col gap-3">
					<div aria-hidden="true" className="flex h-[160px] items-end gap-1.5">
						{points.map((p) => (
							<div key={p.meetingId} className="flex h-full max-w-14 min-w-0 flex-1 flex-col justify-end gap-1">
								<span className="text-center text-xs text-text-2 tabular-nums">{p.attended}</span>
								<span
									className="flex flex-col-reverse overflow-hidden rounded-xs"
									style={{ height: `${(p.attended / max) * 100}%` }}
								>
									{ORDER.map((k) =>
										p.classifications[k] ? (
											<span key={k} className={BAR[k]} style={{ flex: p.classifications[k] }} />
										) : null,
									)}
								</span>
							</div>
						))}
					</div>
					<div aria-hidden="true" className="flex gap-1.5 border-t border-line pt-2">
						{points.map((p) => {
							const e = scores.get(p.meetingId);
							return (
								<span key={p.meetingId} className="max-w-14 min-w-0 flex-1 text-center text-xs tabular-nums">
									<span className="block text-ink">{e ? scoreText(e.average) : "–"}</span>
									<span className="block truncate text-text-3">{dateText(p.localDate, thisYear).slice(4)}</span>
								</span>
							);
						})}
					</div>
					<figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-text-2">
						{(["first_time", "returning", "core_group"] as const).map((k) => (
							<span key={k} className="inline-flex items-center gap-1.5">
								<span aria-hidden="true" className={`size-2 rounded-full ${BAR[k]}`} />
								{CLASSIFICATION_LABEL[k]}
							</span>
						))}
						<span className="text-text-3">Numbers under the line: evaluation average</span>
					</figcaption>
					<table className="sr-only">
						<caption>Attendance and evaluation of the last Vision meetings</caption>
						<thead>
							<tr>
								<th scope="col">Meeting</th>
								<th scope="col">Attended</th>
								<th scope="col">First visits</th>
								<th scope="col">Returning</th>
								<th scope="col">Core group</th>
								<th scope="col">Evaluation</th>
							</tr>
						</thead>
						<tbody>
							{points.map((p) => (
								<tr key={p.meetingId}>
									<th scope="row">
										{p.displayTitle}, {dateText(p.localDate, thisYear)}
									</th>
									<td>{p.attended}</td>
									<td>{p.classifications.first_time}</td>
									<td>{p.classifications.returning}</td>
									<td>{p.classifications.core_group}</td>
									<td>{scores.get(p.meetingId) ? scoreText(scores.get(p.meetingId)!.average) : "None"}</td>
								</tr>
							))}
						</tbody>
					</table>
				</figure>
			)}
		</div>
	);
}
