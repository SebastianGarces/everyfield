import type {
	IntelligenceView,
	PlantDirectory,
	PlantDirectoryRow,
	PlantView,
	Section,
	SectionKey,
	SendingChurchRoster,
	SendingChurchView,
} from "@everyfield/contracts/oversight";
import { PERSON_STAGES } from "@everyfield/contracts/oversight";
import {
	AlertCircleIcon,
	ArrowRight01Icon,
	BookOpen01Icon,
	Calendar03Icon,
	ChurchIcon,
	LockKeyIcon,
	News01Icon,
	StartUp02Icon,
	ShieldUserIcon,
	Task01Icon,
	UserGroupIcon,
	UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import {
	Button,
	CalloutLabel,
	CalloutText,
	Card,
	CardIcon,
	EmptyState,
	PageHeader,
	type Tone,
} from "@everyfield/ui/controls";
import { STAGE_DOT, STAGE_LABEL, StatusBadge, Tag } from "@everyfield/ui/display";
import { cn, Icon, type IconSvgElement } from "@everyfield/ui/foundations";
import Link from "next/link";
import type { ReactNode } from "react";
import { IntelligenceBody } from "./Intelligence.tsx";
import {
	dayOf,
	daysText,
	gapText,
	HEALTH,
	HOME_HEADING,
	LAUNCH_STATE,
	launchLabel,
	leadLabel,
	linkedLabel,
	locality,
	phaseLabel,
	plural,
	provenanceLabel,
	regionText,
	SECTIONS,
	sharedCount,
	STAGE_OF,
	type OrganizationKind,
} from "./model.ts";

// The organization oversight pages (REQ-IDN-023, REQ-IDN-024; prototype #/network and #/network/plant). They show
// names, localities, phases, dates and counts only, are read only for every organization role, and rank nothing:
// plants are listed by name.

/**
 * Plants, Sending churches and Network Intelligence, a network's views. A sending church has only its plants, so no
 * tabs; its Network Intelligence wording is a later slice.
 */
function NetworkTabs({ current }: { current: "plants" | "churches" | "intelligence" }) {
	const tab = (active: boolean) =>
		cn(
			"inline-flex cursor-pointer items-center gap-2 rounded-md px-3.5 py-2 font-medium text-ink-2 transition-colors duration-150 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ef-focus)]",
			active && "bg-surface-raised text-ink shadow-[var(--ef-shadow-raised)]",
		);
	return (
		<nav aria-label="Network views" className="mb-5 flex w-max max-w-full gap-1 rounded-md bg-surface-2 p-1">
			<Link
				href="/network"
				aria-current={current === "plants" ? "page" : undefined}
				className={tab(current === "plants")}
			>
				Plants
			</Link>
			<Link
				href="/network/sending-churches"
				aria-current={current === "churches" ? "page" : undefined}
				className={tab(current === "churches")}
			>
				Sending churches
			</Link>
			<Link
				href="/network/intelligence"
				aria-current={current === "intelligence" ? "page" : undefined}
				className={tab(current === "intelligence")}
			>
				Network Intelligence
			</Link>
		</nav>
	);
}

function PrivacyNote() {
	return (
		<Card variant="callout" tone="ink" className="mt-5">
			<CalloutLabel tone="ink" icon={ShieldUserIcon}>
				Privacy
			</CalloutLabel>
			<CalloutText className="text-md">
				Names and personal details of people in each plant are never shown here. Each plant decides what it shares with
				you, and can change it at any time.
			</CalloutText>
		</Card>
	);
}

/** One plant in a list: its name, locality and lead planter, phase, Launch Sunday and how it is linked. */
function PlantRow({ plant }: { plant: PlantDirectoryRow }) {
	const place = locality(plant);
	const region = regionText(plant);
	const health = HEALTH[plant.health];
	return (
		<li className="border-t border-line first:border-t-0" data-health={plant.health}>
			<Link
				href={`/network/plants/${plant.plantId}`}
				data-focus-inset=""
				className="-mx-2 grid cursor-pointer grid-cols-[minmax(0,1fr)_9rem_8rem_10rem_11rem_auto] items-center gap-x-4 gap-y-2 rounded-md px-2 py-4 transition-colors hover:bg-hover max-app-md:grid-cols-[minmax(0,1fr)_auto]"
			>
				<span className="flex min-w-0 items-center gap-3.5 max-app-md:col-start-1">
					<CardIcon icon={ChurchIcon} tone="green" size={36} />
					<span className="min-w-0">
						<span className="block text-[15px] font-medium text-ink">{plant.name}</span>
						<span className="mt-0.5 block text-md text-text-3">
							{place ? `${place} · ` : ""}
							{plant.leadPlanter ? `Lead planter ${plant.leadPlanter}` : leadLabel(plant)}
						</span>
						{region ? <span className="mt-0.5 block text-sm text-text-3">{region}</span> : null}
					</span>
				</span>
				<Field label="Phase">
					<Tag>{phaseLabel(plant.phase)}</Tag>
				</Field>
				<Field label="Launch Sunday">
					<span className={plant.launchDate ? "text-ink" : "text-text-3"}>{launchLabel(plant.launchDate)}</span>
				</Field>
				<Field label="Status">
					<StatusBadge status={health.status} size="sm">
						{health.label}
					</StatusBadge>
				</Field>
				<Field label="Linked">
					<span className="text-text-2">{provenanceLabel(plant)}</span>
				</Field>
				<Icon
					icon={ArrowRight01Icon}
					size={16}
					className="text-text-3 max-app-md:col-start-2 max-app-md:row-start-1 max-app-md:self-center"
				/>
			</Link>
		</li>
	);
}

/** A row value with its label: the label is for screen readers on wide screens and shows on narrow ones. */
function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<span className="flex min-w-0 items-center gap-2 text-md max-app-md:col-span-2 max-app-md:pl-[50px]">
			<span className="text-text-3 app-md:sr-only">{label}:</span>
			{children}
		</span>
	);
}

function PlantList({ plants, caption }: { plants: readonly PlantDirectoryRow[]; caption: string }) {
	return (
		<div>
			<div
				aria-hidden="true"
				className="grid grid-cols-[minmax(0,1fr)_9rem_8rem_10rem_11rem_auto] gap-x-4 border-b border-line pb-3 text-sm text-text-3 max-app-md:hidden"
			>
				<span>Plant</span>
				<span>Phase</span>
				<span>Launch Sunday</span>
				<span>Status</span>
				<span>Linked</span>
				<span className="w-4" />
			</div>
			<ul aria-label={caption}>
				{plants.map((p) => (
					<PlantRow key={p.plantId} plant={p} />
				))}
			</ul>
		</div>
	);
}

/** /network: the organization home. */
export function DirectoryScreen({ directory, kind }: { directory: PlantDirectory; kind: OrganizationKind }) {
	const { organizationName, plants } = directory;
	return (
		<div className="flex flex-col">
			<PageHeader
				title={organizationName}
				subtitle={
					plants.length
						? `${plural(plants.length, "plant")} linked to you. You only see what each plant chooses to share.`
						: "You only see what each plant chooses to share."
				}
			/>
			{kind === "sending_network" ? <NetworkTabs current="plants" /> : null}
			<Card as="section" aria-labelledby="plants-title">
				<h2 id="plants-title" className="font-title text-title-sm tracking-[-0.02em] text-ink">
					{HOME_HEADING[kind]}
				</h2>
				{plants.length ? (
					<>
						<p className="mt-1 mb-3 text-text-2">In order of name. Select a plant to see what it shares with you.</p>
						<PlantList plants={plants} caption={HOME_HEADING[kind]} />
					</>
				) : (
					<EmptyState
						icon={ChurchIcon}
						title="No plants are linked yet"
						headingLevel="h3"
						action={
							<Button asChild variant="primary">
								<Link href="/settings/sharing#connections">Open Connections</Link>
							</Button>
						}
					>
						A church plant links to you by sending a connection request. You approve it in Connections, and then it
						appears here.
					</EmptyState>
				)}
			</Card>
			<PrivacyNote />
		</div>
	);
}

const SECTION_ICON: Record<SectionKey, { icon: IconSvgElement; tone: Tone }> = {
	people: { icon: UserMultipleIcon, tone: "blue" },
	meetings: { icon: Calendar03Icon, tone: "green" },
	tasks: { icon: Task01Icon, tone: "amber" },
	ministryTeams: { icon: UserGroupIcon, tone: "violet" },
	wiki: { icon: BookOpen01Icon, tone: "teal" },
};

const SHARE_TAG = {
	shared: { label: "Shared", status: "positive" },
	empty: { label: "Shared, nothing yet", status: "measured" },
	withheld: { label: "Not shared", status: "unknown" },
	unavailable: { label: "Couldn't load", status: "risk" },
} as const;

/** /network/plants/[plantId]: one plant as this organization sees it. */
export function PlantScreen({ view }: { view: PlantView }) {
	const { plant, sections } = view;
	const place = locality(plant);
	const region = regionText(plant);
	const shared = sharedCount(sections);
	return (
		<div className="flex flex-col">
			<PageHeader
				breadcrumb={[{ label: "Plants", href: "/network" }, { label: plant.name }]}
				title={plant.name}
				subtitle={
					<span className="flex flex-wrap items-center gap-x-3 gap-y-2">
						<Tag>{phaseLabel(plant.phase)}</Tag>
						{[place, region, `Lead planter: ${leadLabel(plant)}`, linkedLabel(plant)].filter(Boolean).join(" · ")}
					</span>
				}
				actions={
					<StatusBadge plain>
						<Icon icon={ShieldUserIcon} size={16} />
						Shares {shared} of {SECTIONS.length} with you
					</StatusBadge>
				}
			/>
			<LaunchCard view={view} />
			{view.summary ? <SummaryCard view={view} summary={view.summary} /> : null}
			<div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
				<h2 className="font-title text-title-sm tracking-[-0.02em] text-ink">What {plant.name} shares with you</h2>
				<p className="text-sm text-text-3">Counts only. Names and notes are never shared.</p>
			</div>
			<div className="grid grid-cols-3 gap-4 max-app-lg:grid-cols-2 max-app-sm:grid-cols-1">
				{SECTIONS.map(({ key, label }) => (
					<SectionCard key={key} name={key} label={label} section={sections[key]} plantName={plant.name} />
				))}
			</div>
			<PrivacyNote />
		</div>
	);
}

/**
 * Launch Sunday as this organization may see it. Without Plant Intelligence findings shared: only the planned date the
 * directory shows, and Limited visibility in place of status, readiness and outcome.
 */
function LaunchCard({ view }: { view: PlantView }) {
	const { plant, launch } = view;
	if (launch.status === "withheld")
		return (
			<Card as="section" aria-label="Launch Sunday" size="sm" className="mb-5" data-launch="withheld">
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
					<CardIcon icon={Calendar03Icon} tone="amber" size={36} />
					<div className="min-w-0 flex-1">
						<p className="text-sm text-text-3">Launch Sunday</p>
						<p className={cn("font-medium", plant.launchDate ? "text-ink" : "text-text-3")}>
							{launchLabel(plant.launchDate)}
						</p>
					</div>
					<StatusBadge status="unknown" size="sm">
						Limited visibility
					</StatusBadge>
				</div>
				<p className="mt-3 text-md text-text-2 text-pretty">
					{plant.name} doesn&apos;t share Plant Intelligence findings with you, so its launch status, readiness and
					outcome aren&apos;t shown. This is their choice.
				</p>
			</Card>
		);
	const state = LAUNCH_STATE[launch.state];
	const gap = gapText(launch.preparation);
	const days = launch.preparation.daysToLaunch;
	return (
		<Card as="section" aria-label="Launch Sunday" className="mb-5" data-launch={launch.state}>
			<div className="flex flex-wrap items-center gap-x-8 gap-y-4">
				<div className="flex min-w-[240px] flex-1 items-center gap-4">
					<CardIcon icon={StartUp02Icon} tone="amber" size={44} />
					<div className="min-w-0">
						<p className="text-sm text-text-3">{launch.outcome ? "Launch Sunday" : "Planned Launch Sunday"}</p>
						<p className="font-title text-title-sm tracking-[-0.02em] text-ink">
							{launchLabel(launch.outcome?.actualDate ?? launch.plannedDate)}
						</p>
					</div>
					<StatusBadge status={state.status} size="sm">
						{state.label}
					</StatusBadge>
				</div>
				{launch.outcome ? (
					<dl className="flex gap-8">
						{(
							[
								["Attendance", launch.outcome.attendance],
								["Decisions", launch.outcome.decisions],
							] as const
						).map(([label, n]) => (
							<div key={label}>
								<dt className="text-sm text-text-3">{label}</dt>
								<dd
									className={cn("num font-display text-[28px] leading-none", n === null ? "text-text-3" : "text-ink")}
								>
									{n === null ? "Not recorded" : n.toLocaleString("en-US")}
								</dd>
							</div>
						))}
					</dl>
				) : (
					<div>
						<p className="text-sm text-text-3">Readiness</p>
						<p className="font-medium text-ink">
							{launch.milestones.total
								? `${launch.milestones.completed} of ${launch.milestones.total} milestones completed`
								: "Milestones start once Launch Sunday has a date"}
						</p>
					</div>
				)}
			</div>
			{plant.health === "launch_readiness" && gap && days !== null ? (
				<Card variant="callout" tone="amber" className="mt-4" data-concern="launch_readiness">
					<CalloutLabel tone="amber" icon={StartUp02Icon}>
						Launch readiness
					</CalloutLabel>
					<CalloutText className="text-md">
						{daysText(days)}, with {gap}. {plant.name} sees the same on their Launch page.
					</CalloutText>
				</Card>
			) : null}
		</Card>
	);
}

/** The planter's latest published launch summary, exactly as they published it, with its day. */
function SummaryCard({ view, summary }: { view: PlantView; summary: NonNullable<PlantView["summary"]> }) {
	return (
		<Card as="section" aria-labelledby="summary-title" className="mb-5" data-summary-version={summary.version}>
			<div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
				<CardIcon icon={News01Icon} tone="blue" size={36} />
				<h2 id="summary-title" className="min-w-0 flex-1 font-semibold text-ink">
					Launch summary
				</h2>
				<p className="text-sm text-text-3">Published {dayOf(summary.publishedAt, view.timeZone)}</p>
			</div>
			<p className="whitespace-pre-line text-ink text-pretty">{summary.body}</p>
			<p className="mt-3 text-sm text-text-3">Written and published by {view.plant.name}.</p>
		</Card>
	);
}

/** /network/intelligence: patterns across the plants that share with this organization. */
export function IntelligenceScreen({ view, kind }: { view: IntelligenceView; kind: OrganizationKind }) {
	return (
		<div className="flex flex-col">
			<PageHeader
				title="Network Intelligence"
				subtitle="Patterns across your plants, from what each one shares with you. A pattern needs at least 2 plants."
			/>
			{kind === "sending_network" ? <NetworkTabs current="intelligence" /> : null}
			<Card variant="callout" tone="ink" className="mb-5">
				<CalloutLabel tone="ink" icon={ShieldUserIcon}>
					How this works
				</CalloutLabel>
				<CalloutText className="text-md">
					Everyfield&apos;s network rubric v1 reads only counts and dates each plant shares with you: launch dates,
					unfilled roles, overdue follow-ups, when its newest committed adult signed and required training. It never
					names a person, ranks or scores plants. A plant that doesn&apos;t share counts as Not shared, never as zero.
				</CalloutText>
			</Card>
			<IntelligenceBody initial={view} />
		</div>
	);
}

function SectionCard({
	name,
	label,
	section,
	plantName,
}: {
	name: SectionKey;
	label: string;
	section: Section<SectionKey>;
	plantName: string;
}) {
	const tag = SHARE_TAG[section.status];
	const { icon, tone } = SECTION_ICON[name];
	return (
		<Card as="section" size="sm" aria-label={label} data-section={name} data-share={section.status}>
			<div className="mb-4 flex items-center gap-3">
				<CardIcon icon={section.status === "withheld" ? LockKeyIcon : icon} tone={tone} size={36} />
				<h3 className="min-w-0 flex-1 font-semibold text-ink">{label}</h3>
				<StatusBadge status={tag.status} size="sm">
					{tag.label}
				</StatusBadge>
			</div>
			{section.status === "shared" ? (
				<SectionCounts name={name} section={section} />
			) : (
				<p className="text-md text-text-2 text-pretty">
					{section.status === "withheld" ? (
						<>{plantName} has not shared this with you. This is their choice, not a zero.</>
					) : section.status === "empty" ? (
						<>Shared, nothing recorded yet.</>
					) : (
						<span className="flex items-start gap-2">
							<Icon icon={AlertCircleIcon} size={16} className="mt-0.5 flex-none text-magenta-600" />
							This section couldn&apos;t load. Reload the page to try again.
						</span>
					)}
				</p>
			)}
		</Card>
	);
}

function Big({ value, unit, tone }: { value: ReactNode; unit: ReactNode; tone?: "attention" }) {
	return (
		<p className="flex items-end gap-2.5">
			<span
				className={cn(
					"num font-display text-[32px] leading-none tracking-[-0.02em] text-ink",
					tone && "text-[var(--ef-amber-display)]",
				)}
			>
				{value}
			</span>
			<span className="pb-0.5 text-md text-text-2">{unit}</span>
		</p>
	);
}

function SectionCounts({
	name,
	section,
}: {
	name: SectionKey;
	section: Extract<Section<SectionKey>, { status: "shared" }>;
}) {
	const c = section.counts;
	switch (name) {
		case "people": {
			const p = c as Extract<Section<"people">, { status: "shared" }>["counts"];
			const stages = PERSON_STAGES.filter((s) => p.byStage[s] > 0);
			return (
				<>
					<Big value={p.total.toLocaleString("en-US")} unit={p.total === 1 ? "person" : "people"} />
					<div aria-hidden="true" className="mt-4 flex h-2 overflow-hidden rounded-pill bg-surface-2">
						{stages.map((s) => (
							<span key={s} className={STAGE_DOT[STAGE_OF[s]]} style={{ flex: p.byStage[s] }} />
						))}
					</div>
					<dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
						{stages.map((s) => (
							<div key={s} className="flex items-center gap-2">
								<span aria-hidden="true" className={cn("size-2 flex-none rounded-full", STAGE_DOT[STAGE_OF[s]])} />
								<dt className="text-text-2">{STAGE_LABEL[STAGE_OF[s]]}</dt>
								<dd className="num ml-auto text-ink">{p.byStage[s]}</dd>
							</div>
						))}
					</dl>
				</>
			);
		}
		case "tasks": {
			const t = c as Extract<Section<"tasks">, { status: "shared" }>["counts"];
			return (
				<div className="flex gap-8">
					<Big value={t.open} unit="open" />
					<Big value={t.overdue} unit="overdue" tone={t.overdue ? "attention" : undefined} />
				</div>
			);
		}
		case "meetings": {
			const m = c as Extract<Section<"meetings">, { status: "shared" }>["counts"];
			const peak = Math.max(1, ...m.meetings.map((x) => x.attended ?? 0));
			return (
				<>
					{m.averageDaysBetween === null ? (
						<Big value="1" unit="meeting held" />
					) : (
						<Big value={`${m.averageDaysBetween} d`} unit="between meetings, on average" />
					)}
					<div aria-hidden="true" className="mt-4 flex h-12 items-end gap-1">
						{m.meetings.map((x, i) => (
							<span
								key={i}
								className={cn("flex-1 rounded-xs", x.attended === null ? "bg-surface-2" : "bg-green-500")}
								style={{ height: `${Math.max(8, ((x.attended ?? 0) / peak) * 100)}%` }}
							/>
						))}
					</div>
					<p className="mt-2 text-sm text-text-3">
						Attendance at the last {plural(m.meetings.length, "meeting")} · {m.attendedTotal.toLocaleString("en-US")} in
						total
					</p>
				</>
			);
		}
		case "ministryTeams": {
			const t = c as Extract<Section<"ministryTeams">, { status: "shared" }>["counts"];
			return (
				<>
					<Big value={`${t.rolesFilled} of ${t.roles}`} unit="roles filled" />
					<p className="mt-3 text-sm text-text-3">
						{plural(t.teams, "ministry", "ministries")}
						{t.trainingAssigned
							? ` · Required training ${t.trainingComplete} of ${t.trainingAssigned} complete`
							: " · No required training assigned"}
					</p>
				</>
			);
		}
		case "wiki": {
			const w = c as Extract<Section<"wiki">, { status: "shared" }>["counts"];
			return (
				<>
					<Big value={w.finished} unit={w.finished === 1 ? "article finished" : "articles finished"} />
					<p className="mt-3 text-sm text-text-3">{plural(w.inProgress, "article")} in progress</p>
				</>
			);
		}
	}
}

/** /network/sending-churches: the sending churches linked to this network. */
export function RosterScreen({ roster }: { roster: SendingChurchRoster }) {
	const { churches, pendingInvitations } = roster;
	return (
		<div className="flex flex-col">
			<PageHeader
				title="Sending churches"
				subtitle="Sending churches linked to your network. Their plants show here only when each plant links to you too."
			/>
			<NetworkTabs current="churches" />
			<Card as="section" aria-labelledby="churches-title">
				<div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
					<h2 id="churches-title" className="font-title text-title-sm tracking-[-0.02em] text-ink">
						Linked sending churches
					</h2>
					{pendingInvitations ? (
						<Link
							href="/settings/sharing#connections"
							className="cursor-pointer text-md text-text-2 underline-offset-[3px] hover:text-ink hover:underline"
						>
							{plural(pendingInvitations, "pending invitation")}
						</Link>
					) : (
						<span className="text-md text-text-3">No pending invitations</span>
					)}
				</div>
				{churches.length ? (
					<ul aria-label="Sending churches">
						{churches.map((c) => (
							<li key={c.organizationId} className="border-t border-line first:border-t-0">
								<Link
									href={`/network/sending-churches/${c.organizationId}`}
									data-focus-inset=""
									className="-mx-2 flex cursor-pointer items-center gap-3.5 rounded-md px-2 py-4 transition-colors hover:bg-hover"
								>
									<CardIcon icon={ChurchIcon} tone="blue" size={36} />
									<span className="min-w-0 flex-1">
										<span className="block text-[15px] font-medium text-ink">{c.name}</span>
										<span className="mt-0.5 block text-md text-text-3">
											{c.plants
												? `${plural(c.plants, "plant")} linked to both you and ${c.name}`
												: `No plant is linked to both you and ${c.name} yet`}
										</span>
									</span>
									<Icon icon={ArrowRight01Icon} size={16} className="text-text-3" />
								</Link>
							</li>
						))}
					</ul>
				) : (
					<EmptyState icon={ChurchIcon} title="No sending churches are linked yet">
						A sending church links to your network by sending a connection request. You approve it in Connections.
					</EmptyState>
				)}
			</Card>
		</div>
	);
}

/** /network/sending-churches/[id]: one sending church and the plants linked to both it and this network. */
export function SendingChurchScreen({ church }: { church: SendingChurchView }) {
	return (
		<div className="flex flex-col">
			<PageHeader
				breadcrumb={[{ label: "Sending churches", href: "/network/sending-churches" }, { label: church.name }]}
				title={church.name}
				subtitle={`Plants linked to both ${church.name} and your network. Each opens what that plant shares with you.`}
			/>
			<Card as="section" aria-labelledby="church-plants-title">
				<h2 id="church-plants-title" className="mb-3 font-title text-title-sm tracking-[-0.02em] text-ink">
					Plants
				</h2>
				{church.plants.length ? (
					<PlantList plants={church.plants} caption={`Plants of ${church.name}`} />
				) : (
					<EmptyState icon={ChurchIcon} title="No shared plants yet">
						No plant is linked to both {church.name} and your network. A plant appears here once it links to each of
						you.
					</EmptyState>
				)}
			</Card>
			<PrivacyNote />
		</div>
	);
}
