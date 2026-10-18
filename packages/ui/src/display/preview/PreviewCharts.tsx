"use client";

import {
	BarChart,
	DotStrip,
	Heatmap,
	LaunchCalendar,
	Legend,
	PhaseJourney,
	PhasePipeline,
	PhaseTrack,
	Stepper,
} from "..";
import { ATTENDANCE, CALENDAR, JOURNEY, PIPELINE, RETURN_VISITS, SERVING } from "./fixtures";
import { Grid, Section, Specimen } from "./kit";

export function ChartsSection({ index }: { index: number }) {
	return (
		<Section
			index={index}
			title="Charts"
			code="<BarChart> <DotStrip> <Heatmap> <Stepper> <PhaseTrack> <PhaseJourney> <PhasePipeline> <LaunchCalendar>"
			note="Owned components, no chart library. Hatch is history or a plan, solid is measured. Every chart also carries its numbers as a table or list for screen readers; focus the bar chart and use the arrow keys."
		>
			<Grid cols={3}>
				<Specimen title="Vision meeting attendance" description="Last 10 meetings">
					<BarChart
						label="Vision meeting attendance, last 10 meetings"
						data={ATTENDANCE}
						target={{ value: 50, label: "Goal 50" }}
					/>
				</Specimen>
				<Specimen title="Guests by return visits">
					<DotStrip label="Guests by number of return visits" columns={RETURN_VISITS} axis={["1 visit", "8+ visits"]} />
					<Legend
						className="mt-3 text-sm"
						items={[
							{ label: "Lost", tone: "magenta" },
							{ label: "At risk", tone: "amber" },
							{ label: "Returning", tone: "blue" },
							{ label: "Committed", tone: "green" },
						]}
					/>
				</Specimen>
				<Specimen title="Serving by ministry and month">
					<Heatmap label="People serving by ministry and month" columns={SERVING.columns} rows={SERVING.rows} />
				</Specimen>
				<Specimen
					title="Stepper"
					description="Person journey or meeting timeline"
					className="col-span-2 max-app-md:col-span-1"
				>
					<Stepper
						label="Maria Santos's journey"
						steps={[
							{ state: "done", when: "Aug 18", what: "First visit", why: "Vision meeting #8, invited by Ana" },
							{ state: "done", when: "Aug 20", what: "Follow-up call", why: "Called by Daniel within 48 h" },
							{ state: "done", when: "Sep 30", what: "Interviewed", why: "5 of 5 considerations recorded" },
							{ state: "current", when: "Next", what: "Commitment", why: "Commitment card ready to sign" },
							{ state: "todo", when: "Later", what: "Ministry", why: "Interested in Worship" },
						]}
					/>
				</Specimen>
				<Specimen title="Phase track">
					<PhaseTrack current={1} name="Core Group Development" />
					<div className="mt-4">
						<span className="text-sm text-text-2">Phase 1</span>
						<div className="font-display text-xl text-ink">Core Group Development</div>
					</div>
				</Specimen>
			</Grid>
			<Grid cols={2} className="mt-5">
				<Specimen title="Phase journey" description="Weeks in each phase, compared with the Playbook range">
					<PhaseJourney label="Eastside Commons phase journey" phases={JOURNEY} />
				</Specimen>
				<Specimen title="Phase pipeline" description="Plants in each phase, and typical weeks in it">
					<PhasePipeline label="Plants in each phase" phases={PIPELINE} />
				</Specimen>
				<Specimen title="Launch calendar" description="Launch Sundays in the next 12 months" className="col-span-full">
					<LaunchCalendar label="Launch Sundays by month" months={CALENDAR} />
				</Specimen>
			</Grid>
		</Section>
	);
}
