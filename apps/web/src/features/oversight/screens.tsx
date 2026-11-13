import type {
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
import {
	HOME_HEADING,
	launchLabel,
	leadLabel,
	linkedLabel,
	locality,
	phaseLabel,
	plural,
	provenanceLabel,
	SECTIONS,
	sharedCount,
	STAGE_OF,
	type OrganizationKind,
} from "./model.ts";

// The organization oversight pages (REQ-IDN-023, REQ-IDN-024; prototype #/network and #/network/plant). They show
// names, localities, phases, dates and counts only, are read only for every organization role, and rank nothing:
// plants are listed by name.

/** Plants and Sending churches, a network's two views. A sending church has only its plants, so no tabs. */
function NetworkTabs({ current }: { current: "plants" | "churches" }) {
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
	return (
		<li className="border-t border-line first:border-t-0">
			<Link
				href={`/network/plants/${plant.plantId}`}
				data-focus-inset=""
				className="-mx-2 grid cursor-pointer grid-cols-[minmax(0,1fr)_9rem_8rem_12rem_auto] items-center gap-x-4 gap-y-2 rounded-md px-2 py-4 transition-colors hover:bg-hover max-app-md:grid-cols-[minmax(0,1fr)_auto]"
			>
				<span className="flex min-w-0 items-center gap-3.5 max-app-md:col-start-1">
					<CardIcon icon={ChurchIcon} tone="green" size={36} />
					<span className="min-w-0">
						<span className="block text-[15px] font-medium text-ink">{plant.name}</span>
						<span className="mt-0.5 block text-md text-text-3">
							{place ? `${place} · ` : ""}
							{plant.leadPlanter ? `Lead planter ${plant.leadPlanter}` : leadLabel(plant)}
						</span>
					</span>
				</span>
				<Field label="Phase">
					<Tag>{phaseLabel(plant.phase)}</Tag>
				</Field>
				<Field label="Launch Sunday">
					<span className={plant.launchDate ? "text-ink" : "text-text-3"}>{launchLabel(plant.launchDate)}</span>
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
				className="grid grid-cols-[minmax(0,1fr)_9rem_8rem_12rem_auto] gap-x-4 border-b border-line pb-3 text-sm text-text-3 max-app-md:hidden"
			>
				<span>Plant</span>
				<span>Phase</span>
				<span>Launch Sunday</span>
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
	const shared = sharedCount(sections);
	return (
		<div className="flex flex-col">
			<PageHeader
				breadcrumb={[{ label: "Plants", href: "/network" }, { label: plant.name }]}
				title={plant.name}
				subtitle={
					<span className="flex flex-wrap items-center gap-x-3 gap-y-2">
						<Tag>{phaseLabel(plant.phase)}</Tag>
						{[place, `Lead planter: ${leadLabel(plant)}`, linkedLabel(plant)].filter(Boolean).join(" · ")}
					</span>
				}
				actions={
					<StatusBadge plain>
						<Icon icon={ShieldUserIcon} size={16} />
						Shares {shared} of {SECTIONS.length} with you
					</StatusBadge>
				}
			/>
			<Card size="sm" className="mb-5 flex-row items-center gap-4">
				<CardIcon icon={Calendar03Icon} tone="amber" size={36} />
				<div>
					<p className="text-sm text-text-3">Launch Sunday</p>
					<p className={cn("font-medium", plant.launchDate ? "text-ink" : "text-text-3")}>
						{launchLabel(plant.launchDate)}
					</p>
				</div>
			</Card>
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
