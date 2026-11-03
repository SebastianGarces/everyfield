"use client";

import { Calendar03Icon, CalendarAdd01Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	EmptyState,
	IntentLink,
	StatePanel,
} from "@everyfield/ui/controls";
import { useState } from "react";
import { SaveNotice, useSaveIntent } from "../../components/save/parts.tsx";
import { problemText, whenText, type Summary } from "../meetings/model.ts";
import { MeetingStatusBadge } from "../meetings/parts.tsx";
import { PlanMeetingDialog } from "../meetings/PlanMeetingDialog.tsx";
import { plural } from "./model.ts";
import type { TeamView } from "./server.ts";

/**
 * A ministry's team meetings (REQ-TEAM-013 for its ministry): upcoming ones soonest first, then past ones newest first.
 * Each row opens the meeting. Every seat reads them; an Owner or Admin plans a new one here with this ministry chosen.
 * An archived ministry still lists its meetings and plans no new one.
 */
export function MeetingsCard({
	team,
	meetings,
	now,
	canPlan,
}: {
	team: { id: string; name: string };
	meetings: TeamView["meetings"];
	now: string;
	canPlan: boolean;
}) {
	const [planning, setPlanning] = useState(false);
	const lane = useSaveIntent({ explain: problemText });
	const thisYear = Number(now.slice(0, 4));
	const items = meetings?.items ?? [];
	// The read lists latest first; upcoming ones read soonest first.
	const upcoming = items.filter((m) => m.startsAt >= now).reverse();
	const past = items.filter((m) => m.startsAt < now);
	const plan = canPlan ? (
		<Button variant="secondary" size="sm" icon={CalendarAdd01Icon} onClick={() => setPlanning(true)}>
			Plan team meeting
		</Button>
	) : null;
	return (
		<Card as="section" aria-labelledby="ministry-meetings">
			<CardHeader className="flex-wrap items-start gap-3">
				<CardHeading>
					<CardTitle id="ministry-meetings" size="sm">
						Meetings
					</CardTitle>
					{meetings && items.length ? (
						<CardDescription>
							{meetings.total > items.length
								? `The latest ${items.length} of ${meetings.total}`
								: plural(items.length, "team meeting")}
						</CardDescription>
					) : null}
				</CardHeading>
				{items.length ? plan : null}
			</CardHeader>
			{canPlan ? <SaveNotice {...lane.noticeProps} dialogOpen={planning} /> : null}
			{meetings === null ? (
				<StatePanel tone="error" title="The meetings did not load" headingLevel="h3">
					Nothing was changed. Reload the page in a moment.
				</StatePanel>
			) : items.length === 0 ? (
				<EmptyState icon={Calendar03Icon} title="No team meetings yet" headingLevel="h3" action={plan}>
					{canPlan
						? `Plan one, and everyone serving in ${team.name} joins the guest list.`
						: "When an Owner or Admin plans a team meeting for this ministry, it shows here."}
				</EmptyState>
			) : (
				<div className="flex flex-col gap-4">
					<Group title="Upcoming" meetings={upcoming} thisYear={thisYear} empty="None planned." />
					<Group title="Past" meetings={past} thisYear={thisYear} empty="None yet." />
				</div>
			)}
			{canPlan ? <PlanMeetingDialog open={planning} onOpenChange={setPlanning} lane={lane} ministry={team} /> : null}
		</Card>
	);
}

function Group({
	title,
	meetings,
	thisYear,
	empty,
}: {
	title: string;
	meetings: Summary[];
	thisYear: number;
	empty: string;
}) {
	return (
		<section aria-label={`${title} meetings`} className="flex flex-col gap-1">
			<h3 className="text-xs font-semibold tracking-wide text-text-3 uppercase">{title}</h3>
			{meetings.length === 0 ? (
				<p className="py-1 text-sm text-text-3">{empty}</p>
			) : (
				<ul className="flex flex-col divide-y divide-line">
					{meetings.map((m) => (
						<li key={m.id}>
							<IntentLink
								href={`/meetings/${m.id}`}
								className="-mx-2 flex cursor-pointer items-center justify-between gap-3 rounded-sm px-2 py-2.5 hover:bg-surface-sunken"
							>
								<span className="flex min-w-0 flex-col">
									<span className="truncate font-medium text-ink">{m.displayTitle}</span>
									<span className="text-sm text-text-2">{whenText(m, thisYear)}</span>
								</span>
								<MeetingStatusBadge status={m.status} />
							</IntentLink>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
