"use client";

import { ArrowRight01Icon, Calendar03Icon, CalendarAdd01Icon, Location01Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardHeader,
	CardHeading,
	CardTitle,
	EmptyState,
	FilterChip,
	PageHeader,
	SegmentedControl,
	StatePanel,
} from "@everyfield/ui/controls";
import { DataTable, Pagination, StatusBadge, type Column } from "@everyfield/ui/display";
import { Icon } from "@everyfield/ui/foundations";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
	DEFAULT_QUERY,
	isFiltered,
	pageCount,
	querySearch,
	STATUS_LABEL,
	STATUSES,
	TYPE_LABEL,
	TYPE_SHORT,
	TYPES,
	problemText,
	untilText,
	whenText,
	WINDOW_LABEL,
	WINDOWS,
	type MeetingsQuery,
	type Summary,
	type Window,
} from "./model.ts";
import { IntentLink, MeetingIcon, MeetingStatusBadge, RsvpBar } from "./parts.tsx";
import { deletions, useDeleted } from "./deletions.ts";
import { PlanMeetingDialog } from "./PlanMeetingDialog.tsx";
import { SaveNotice, useSaveIntent } from "../../components/save/parts.tsx";
import { VisionReport } from "./Report.tsx";
import type { MeetingsView } from "./server.ts";
import { VenuesSheet } from "./VenuesSheet.tsx";

const ALL = "all";

/**
 * The meetings list (REQ-MTG-001): every current meeting, newest first, with the window, type and status in the
 * address. A filter change goes back to page one. An empty filter says so and never claims there is no history.
 */
export function MeetingsScreen({ view, canWrite }: { view: MeetingsView; canWrite: boolean }) {
	const router = useRouter();
	const pathname = usePathname();
	const [navigating, startTransition] = useTransition();
	const [planning, setPlanning] = useState(false);
	const planLane = useSaveIntent({ explain: problemText });
	const [places, setPlaces] = useState(false);
	const { query, hasHistory, now } = view;
	// A meeting deleted from its page leaves this list at once, while its delete is confirmed (deletions.ts).
	const deleted = useDeleted();
	useEffect(() => deletions.flush(), []);
	const page = view.page && {
		...view.page,
		items: view.page.items.filter((m) => !deleted.has(m.id)),
		total: view.page.total - view.page.items.filter((m) => deleted.has(m.id)).length,
	};
	const next = view.next && !deleted.has(view.next.id) ? view.next : null;
	const thisYear = Number(now.slice(0, 4));
	const go = (q: MeetingsQuery) => startTransition(() => router.push(pathname + querySearch(q), { scroll: false }));
	const filter = (patch: Partial<MeetingsQuery>) => go({ ...query, ...patch, page: 1 });

	const plan = canWrite ? (
		<Button variant="primary" icon={CalendarAdd01Icon} onClick={() => setPlanning(true)}>
			Plan a meeting
		</Button>
	) : null;

	return (
		<>
			<PageHeader
				size="xl"
				title="Meetings"
				subtitle="Vision meetings, orientations and pre-launch practices."
				actions={
					<>
						<Button variant="secondary" icon={Location01Icon} onClick={() => setPlaces(true)}>
							Places
						</Button>
						{plan}
					</>
				}
			/>
			<SaveNotice {...planLane.noticeProps} dialogOpen={planning} />
			{!hasHistory && page ? (
				<Card>
					<EmptyState icon={Calendar03Icon} title="No meetings yet" headingLevel="h2" action={plan}>
						{canWrite
							? "Vision meetings are how a core group starts. The Playbook suggests one every 14 days."
							: "When an Owner or Admin plans a meeting, it appears here."}
					</EmptyState>
				</Card>
			) : (
				<div className="flex flex-col gap-5">
					{next ? <NextMeeting meeting={next} now={now} thisYear={thisYear} /> : null}
					{canWrite ? <VisionReport thisYear={thisYear} /> : null}
					<Card as="section" aria-labelledby="all-meetings">
						<CardHeader className="flex-wrap items-center gap-3">
							<CardHeading>
								<CardTitle id="all-meetings">All meetings</CardTitle>
							</CardHeading>
							<SegmentedControl
								label="When"
								size="sm"
								options={WINDOWS.map((w) => ({ value: w, label: WINDOW_LABEL[w] }))}
								value={query.window}
								onValueChange={(w: Window) => filter({ window: w })}
							/>
							<SegmentedControl
								label="Type"
								size="sm"
								options={[
									{ value: ALL, label: "All types" },
									...TYPES.map((t) => ({ value: t, label: TYPE_SHORT[t] })),
								]}
								value={query.type ?? ALL}
								onValueChange={(t) => filter({ type: TYPES.find((x) => x === t) ?? null })}
							/>
							<FilterChip
								label="Status"
								searchLabel="Search statuses"
								multiple={false}
								options={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
								value={query.status ? [query.status] : []}
								onValueChange={(v) => filter({ status: STATUSES.find((s) => s === v.at(-1)) ?? null })}
							/>
						</CardHeader>
						<div aria-busy={navigating || undefined} className="transition-opacity duration-150 aria-busy:opacity-60">
							{page ? (
								<>
									<DataTable
										caption="Meetings"
										columns={columns(thisYear)}
										state={{ status: "ready", data: page.items }}
										rowId={(m) => m.id}
										rowLabel={(m) => m.displayTitle}
										minWidth={760}
										empty={{
											icon: Calendar03Icon,
											title: "No meetings match these filters",
											text: "Other meetings are still here. Change or clear the filters to see them.",
											action: isFiltered(query) ? (
												<Button variant="secondary" size="sm" onClick={() => go(DEFAULT_QUERY)}>
													Clear filters
												</Button>
											) : undefined,
										}}
									/>
									<div className="mt-5 flex flex-wrap items-center justify-between gap-3 empty:hidden">
										{page.total > 0 ? (
											<p className="text-sm text-text-3">
												Showing {page.items.length} of {page.total} {page.total === 1 ? "meeting" : "meetings"}
											</p>
										) : null}
										<Pagination
											label="Meeting pages"
											page={query.page}
											pageCount={pageCount(page.total)}
											onPageChange={(p) => go({ ...query, page: p })}
										/>
									</div>
								</>
							) : (
								<StatePanel tone="error" title="Meetings did not load" headingLevel="h3">
									This is a loading problem, not an empty list. Nothing was changed. Reload the page in a moment.
								</StatePanel>
							)}
						</div>
					</Card>
				</div>
			)}
			{canWrite ? <PlanMeetingDialog open={planning} onOpenChange={setPlanning} lane={planLane} /> : null}
			<VenuesSheet open={places} onOpenChange={setPlaces} canWrite={canWrite} />
		</>
	);
}

function columns(thisYear: number): Column<Summary>[] {
	return [
		{
			key: "meeting",
			header: "Meeting",
			cell: (m) => (
				<div className="flex items-center gap-3">
					<MeetingIcon type={m.type} />
					<div className="min-w-0">
						<IntentLink
							href={`/meetings/${m.id}`}
							className="font-medium text-ink underline-offset-4 hover:underline focus-visible:underline"
						>
							{m.displayTitle}
						</IntentLink>
						<p className="text-sm text-text-3">{TYPE_LABEL[m.type]}</p>
					</div>
				</div>
			),
		},
		{
			key: "when",
			header: "When",
			cell: (m) => <span className="whitespace-nowrap">{whenText(m, thisYear)}</span>,
		},
		{
			key: "where",
			header: "Where",
			cell: (m) => (m.venue ? m.venue.name : <span className="text-text-3">Not set</span>),
		},
		{
			key: "rsvps",
			header: "RSVPs",
			cell: (m) =>
				m.guestCount === 0 ? (
					<span className="text-sm text-text-3">No guests yet</span>
				) : (
					<div className="flex flex-col gap-1.5">
						<RsvpBar yes={m.confirmedCount} other={m.guestCount - m.confirmedCount} />
						<span className="text-sm text-text-3">
							{m.confirmedCount} of {m.guestCount} said yes
						</span>
					</div>
				),
		},
		{
			key: "status",
			header: "Status",
			cell: (m) => (
				<span className="flex flex-wrap gap-1.5">
					<MeetingStatusBadge status={m.status} size="sm" />
					{m.preparation === "incomplete" && m.status !== "completed" && m.status !== "cancelled" ? (
						<StatusBadge status="attention" size="sm" fill="soft" plain>
							Kit not ready
						</StatusBadge>
					) : null}
				</span>
			),
		},
	];
}

/**
 * The next upcoming meeting, as the prototype's "Next" card: one link to the meeting page. Its name is the card's visible
 * text, so a voice-control user can say what they see (WCAG 2.5.3).
 */
function NextMeeting({ meeting: m, now, thisYear }: { meeting: Summary; now: string; thisYear: number }) {
	const until = untilText(m.startsAt, now);
	return (
		<IntentLink
			href={`/meetings/${m.id}`}
			className="group rounded-card focus-visible:outline-none"
		>
			<Card className="flex-row flex-wrap items-center gap-x-8 gap-y-4 transition-shadow group-hover:shadow-raised group-focus-visible:shadow-[0_0_0_2px_var(--ef-ink)]">
				<div className="flex min-w-0 flex-1 items-center gap-4">
					<MeetingIcon type={m.type} size={44} />
					<div className="min-w-0">
						<p className="flex flex-wrap items-center gap-2">
							<StatusBadge status="measured" size="sm">
								Next
							</StatusBadge>
							<span className="text-sm text-text-3">{until}</span>
						</p>
						<p className="mt-1.5 font-title text-title-md tracking-[-0.02em] text-ink">{m.displayTitle}</p>
						<p className="mt-1 text-md text-text-2">
							{whenText(m, thisYear)}
							{m.venue ? ` · ${m.venue.name}` : ""}
						</p>
					</div>
				</div>
				<div className="flex w-[240px] flex-col gap-2 max-app-sm:w-full">
					<p className="text-sm text-text-2">
						<b className="font-title text-xl font-normal text-ink tabular-nums">{m.confirmedCount}</b> of {m.guestCount}{" "}
						guests said yes
					</p>
					<RsvpBar yes={m.confirmedCount} other={m.guestCount - m.confirmedCount} className="max-w-none" />
				</div>
				<Icon icon={ArrowRight01Icon} size={18} className="text-text-3 max-app-sm:hidden" />
			</Card>
		</IntentLink>
	);
}
