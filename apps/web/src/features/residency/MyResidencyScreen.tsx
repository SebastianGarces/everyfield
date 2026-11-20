"use client";

import type { MyResidency } from "@everyfield/contracts/organizations";
import {
	ArrowRight01Icon,
	BookOpen01Icon,
	Calendar03Icon,
	CheckmarkCircle02Icon,
	Clock01Icon,
	LockKeyIcon,
	Mortarboard01Icon,
} from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardBody,
	CardHeader,
	CardHeading,
	CardTitle,
	EmptyState,
	PageHeader,
} from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { cn, Icon } from "@everyfield/ui/foundations";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { markSubjectRead } from "../notifications/actions";
import { useReadElsewhere } from "../notifications/feed";
import { formatPlainDate } from "../../components/dates.ts";
import { Problem } from "../../components/Problem.tsx";
import { programProblem, KIND } from "../organizations/programs/model";
import { useResidency } from "./context.ts";
import { markMilestone } from "./actions";
import { articlePath } from "../wiki/model";
import { meetingDay, meetingTime, milestoneAnchor, readingPath, zoneName } from "./model";

type Linked = Extract<MyResidency, { status: "linked" }>;
type Enrollment = Linked["enrollments"][number];
type Milestone = Enrollment["milestones"][number];

export function MyResidencyScreen({ initial }: { initial: Exclude<MyResidency, { status: "not_linked" }> }) {
	const frame = useResidency();
	if (initial.status === "ended" || frame.ended) return <NotLinked />;
	return <LinkedResidency residency={initial} />;
}

function NotLinked() {
	return (
		<div className="flex flex-col gap-5">
			<PageHeader title="My residency" />
			<Card>
				<EmptyState
					icon={Mortarboard01Icon}
					headingLevel="h2"
					title="You’re no longer linked to a residency"
					action={
						<Button asChild variant="primary">
							<a href="/home">Back to Discovery</a>
						</Button>
					}
				>
					Your Discovery space, reading and documents are still yours. If a sending church invites you again, you can
					choose to link.
				</EmptyState>
			</Card>
		</div>
	);
}

function useOpenedNotice() {
	const opened = useSearchParams().get("milestone");
	const readElsewhere = useReadElsewhere();
	const sent = useRef<string | null>(null);
	useEffect(() => {
		if (!opened || sent.current === opened) return;
		sent.current = opened;
		void markSubjectRead({ kind: "residency_milestone", id: opened })
			.then((r) => {
				if (r.status === "ok" && r.value.markedIds.length) readElsewhere(r.value.markedIds);
			})
			.catch(() => undefined);
	}, [opened, readElsewhere]);
	return opened;
}

function LinkedResidency({ residency }: { residency: Linked }) {
	const opened = useOpenedNotice();
	const church = residency.organizationName;
	return (
		<div className="flex flex-col gap-5">
			<PageHeader
				title="My residency"
				subtitle={`With ${church}. Your progress stays yours; you choose what they see.`}
			/>
			{residency.enrollments.length === 0 ? (
				<Card>
					<EmptyState icon={Mortarboard01Icon} headingLevel="h2" title="No program yet">
						You’re linked to {church}. Your program, meetings and milestones show here once they enroll you.
					</EmptyState>
				</Card>
			) : (
				residency.enrollments.map((e) => (
					<EnrollmentView key={e.id} enrollment={e} residency={residency} opened={opened} />
				))
			)}
		</div>
	);
}

function EnrollmentView({
	enrollment: e,
	residency,
	opened,
}: {
	enrollment: Enrollment;
	residency: Linked;
	opened: string | null;
}) {
	const church = residency.organizationName;
	const [marks, setMarks] = useState<Record<string, Milestone["completion"]>>({});
	const milestones = e.milestones.map((m) => (m.id in marks ? { ...m, completion: marks[m.id]! } : m));
	const confirmed = milestones.filter((m) => m.completion?.confirmedOn).length;
	return (
		<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-5 max-app-md:grid-cols-1">
			<div className="flex flex-col gap-5">
				<Card>
					<CardHeader>
						<CardHeading>
							<CardTitle>{e.program.name}</CardTitle>
							<p className="mt-1 text-sm text-text-2">
								{KIND[e.program.kind]} · Directed by {e.program.director}
							</p>
						</CardHeading>
					</CardHeader>
					<CardBody className="flex flex-col gap-5">
						<div>
							<p className="text-sm text-text-2">Program stage</p>
							<p className="mt-1 font-title text-title-sm tracking-[-0.02em] text-ink">{e.stage}</p>
						</div>
						<NextMeeting meeting={e.nextMeeting} timezone={residency.timezone} church={church} />
						<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm">
							<Detail term="Cohort">{e.cohort}</Detail>
							<Detail term="Started">{formatPlainDate(e.startedOn)}</Detail>
							<Detail term="Expected end">{formatPlainDate(e.expectedEndOn)}</Detail>
						</dl>
					</CardBody>
				</Card>
				<Visibility residency={residency} />
			</div>
			<div className="flex flex-col gap-5">
				<Card>
					<CardHeader>
						<CardHeading>
							<CardTitle>
								Milestones{" "}
								<span className="font-body text-sm font-normal text-text-2">
									{confirmed} of {milestones.length} confirmed
								</span>
							</CardTitle>
						</CardHeading>
					</CardHeader>
					<CardBody>
						{residency.sharing.shareMilestones ? null : (
							<p className="mb-4 rounded-md bg-surface-2 p-3 text-sm text-ink-2">
								You don’t share milestone progress, so {church} can’t see or confirm what you mark done. Turn it on in
								Sharing when you’re ready.
							</p>
						)}
						{milestones.length ? (
							<ol className="flex flex-col divide-y divide-line">
								{milestones.map((m) => (
									<MilestoneRow
										key={m.id}
										milestone={m}
										opened={m.id === opened}
										enrollmentId={e.id}
										director={e.program.director}
										today={residency.today}
										onMarked={(completion) => setMarks((x) => ({ ...x, [m.id]: completion }))}
									/>
								))}
							</ol>
						) : (
							<p className="text-sm text-text-3">Your program has no milestones yet.</p>
						)}
					</CardBody>
				</Card>
				<Reading readings={e.readings} church={church} />
			</div>
		</div>
	);
}

function Detail({ term, children }: { term: string; children: React.ReactNode }) {
	return (
		<>
			<dt className="text-text-2">{term}</dt>
			<dd className="min-w-0 text-ink [overflow-wrap:anywhere]">{children}</dd>
		</>
	);
}

function NextMeeting({
	meeting,
	timezone,
	church,
}: {
	meeting: Enrollment["nextMeeting"];
	timezone: string;
	church: string;
}) {
	return (
		<div className="flex items-start gap-3 rounded-md bg-surface-2 p-3">
			<Icon icon={Calendar03Icon} size={18} className="mt-0.5 flex-none text-text-2" />
			<div className="min-w-0 text-sm">
				<p className="font-medium text-ink">Next meeting</p>
				{meeting ? (
					<>
						<p className="text-ink">
							{meetingDay(meeting.at)} · {meetingTime(meeting.at)}
						</p>
						{meeting.churchTimezone === timezone ? (
							<p className="text-text-2">{zoneName(timezone)}</p>
						) : (
							<p className="text-text-2">
								Your time ({zoneName(timezone)}). That’s {meetingTime(meeting.churchAt)}{" "}
								{zoneName(meeting.churchTimezone)} for {church}.
							</p>
						)}
					</>
				) : (
					<p className="text-text-2">Not scheduled yet.</p>
				)}
			</div>
		</div>
	);
}

function MilestoneRow({
	milestone: m,
	opened,
	enrollmentId,
	director,
	today,
	onMarked,
}: {
	milestone: Milestone;
	opened: boolean;
	enrollmentId: string;
	director: string;
	today: Linked["today"];
	onMarked: (completion: Milestone["completion"]) => void;
}) {
	const c = m.completion;
	const [problem, setProblem] = useState<string | null>(null);
	async function mark() {
		setProblem(null);
		onMarked({ completedOn: today, confirmedOn: null, source: "resident" });
		const answer = await markMilestone({ enrollmentId, milestoneId: m.id }).catch(() => ({ status: "lost" as const }));
		if (answer.status !== "ok") {
			onMarked(null);
			setProblem(
				answer.status === "lost" || answer.refusal.code !== "unavailable"
					? programProblem(answer)
					: "This milestone couldn’t be marked. Reload the page to see the latest.",
			);
		}
	}
	return (
		<li
			id={milestoneAnchor(m.id)}
			aria-current={opened ? "location" : undefined}
			className={cn(
				"flex scroll-mt-24 flex-col gap-2 py-3.5",
				opened ? "-mx-3 rounded-md bg-blue-50 px-3" : "first:pt-0 last:pb-0",
			)}
		>
			<div className="flex flex-wrap items-start gap-x-3 gap-y-2">
				<span
					aria-hidden
					className={
						c?.confirmedOn
							? "mt-0.5 flex-none text-green-700"
							: c
								? "mt-0.5 flex-none text-amber-600"
								: "mt-0.5 size-[18px] flex-none rounded-full shadow-edge-inset"
					}
				>
					{c?.confirmedOn ? (
						<Icon icon={CheckmarkCircle02Icon} size={18} />
					) : c ? (
						<Icon icon={Clock01Icon} size={18} />
					) : null}
				</span>
				<div className="flex min-w-[200px] flex-1 basis-0 flex-col gap-0.5 text-sm">
					<span className="font-medium [overflow-wrap:anywhere] text-ink">{m.title}</span>
					{m.handsOn ? <span className="text-xs font-medium text-blue-600">Hands-on assignment</span> : null}
					{m.description ? <span className="[overflow-wrap:anywhere] text-text-2">{m.description}</span> : null}
					{c?.confirmedOn ? (
						<span className="text-ink">
							Confirmed {formatPlainDate(c.confirmedOn)}
							<span className="text-text-2"> · Completed {formatPlainDate(c.completedOn)}</span>
						</span>
					) : c ? (
						<span className="text-amber-600">
							Waiting for {director} to confirm · Marked done {formatPlainDate(c.completedOn)}
						</span>
					) : (
						<span className="text-text-3">Not done yet</span>
					)}
					<Problem text={problem} />
				</div>
				{c ? null : (
					<Button size="sm" variant="secondary" className="flex-none max-app-sm:ml-[30px]" onClick={mark}>
						Mark done
					</Button>
				)}
			</div>
			{m.feedback.length ? (
				<section
					aria-label={`Feedback on ${m.title}`}
					className="ml-[30px] flex flex-col gap-2 rounded-md bg-surface-2 p-3"
				>
					<h4 className="text-xs font-semibold tracking-normal text-ink-2">Feedback</h4>
					<ul className="flex flex-col gap-2.5">
						{m.feedback.map((f) => (
							<li key={f.id} className="flex flex-col gap-0.5 text-sm">
								<span className="whitespace-pre-wrap [overflow-wrap:anywhere] text-ink">{f.body}</span>
								<span className="text-xs text-text-3">
									{f.writer ?? "Former staff"} · {formatPlainDate(f.writtenOn)}
								</span>
							</li>
						))}
					</ul>
				</section>
			) : null}
		</li>
	);
}

function Reading({ readings, church }: { readings: Enrollment["readings"]; church: string }) {
	return (
		<Card>
			<CardHeader>
				<CardHeading>
					<CardTitle>Reading</CardTitle>
				</CardHeading>
			</CardHeader>
			<CardBody>
				{readings.length ? (
					<ul className="flex flex-col divide-y divide-line">
						{readings.map((r) => {
							const href = !r.available ? null : r.source === "organization" ? readingPath(r.id) : articlePath(r.slug!);
							const label = (
								<>
									<Icon icon={BookOpen01Icon} size={18} className="mt-0.5 flex-none text-text-2" />
									<span className="flex min-w-0 flex-1 flex-col gap-0.5">
										<span className={href ? "font-medium text-ink" : "font-medium text-text-2"}>{r.title}</span>
										<span className="text-xs text-text-3">
											{r.source === "organization" ? `${church}’s version` : "Everyfield Wiki"}
										</span>
									</span>
								</>
							);
							return (
								<li key={r.id} className="py-3 first:pt-0 last:pb-0">
									{href ? (
										<Link href={href} className="group flex items-start gap-3 rounded-md text-sm outline-offset-4">
											{label}
											<Icon
												icon={ArrowRight01Icon}
												size={16}
												className="mt-0.5 flex-none text-text-3 group-hover:text-ink"
											/>
										</Link>
									) : (
										<div className="flex items-start gap-3 text-sm">
											{label}
											<StatusBadge status="unknown" size="sm" fill="soft" className="flex-none">
												Unavailable
											</StatusBadge>
										</div>
									)}
								</li>
							);
						})}
					</ul>
				) : (
					<p className="text-sm text-text-3">Your program has no reading list yet.</p>
				)}
			</CardBody>
		</Card>
	);
}

function Visibility({ residency }: { residency: Linked }) {
	const church = residency.organizationName;
	const rows = [
		["Milestone progress", residency.sharing.shareMilestones],
		["Foundation progress", residency.sharing.shareFoundations],
	] as const;
	return (
		<Card>
			<CardHeader>
				<CardHeading>
					<CardTitle>What {church} can see</CardTitle>
				</CardHeading>
			</CardHeader>
			<CardBody className="flex flex-col gap-4 text-sm">
				<ul className="flex flex-col">
					{rows.map(([label, shared]) => (
						<li key={label} className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0 first:pt-0">
							<span className="min-w-0 flex-1 text-ink">{label}</span>
							<StatusBadge status={shared ? "positive" : "unknown"} size="sm" fill="soft">
								{shared ? "Shared" : "Not shared"}
							</StatusBadge>
						</li>
					))}
				</ul>
				<p className="flex items-start gap-2 text-text-2">
					<Icon icon={LockKeyIcon} size={16} className="mt-0.5 flex-none" />
					Never shared: your reading history, reflections and documents. You have no seat at {church}.
				</p>
				<div>
					<Button asChild variant="secondary" size="sm">
						<Link href="/settings/sharing">Change what you share</Link>
					</Button>
				</div>
			</CardBody>
		</Card>
	);
}
