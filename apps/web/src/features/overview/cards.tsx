import type { Activity, Metrics } from "@everyfield/contracts/dashboard";
import type { Plan } from "@everyfield/contracts/launch";
import {
	Calendar03Icon,
	CheckmarkCircle02Icon,
	PencilEdit02Icon,
	Route01Icon,
	StartUp02Icon,
	UserAdd01Icon,
} from "@hugeicons/core-free-icons";
import {
	buttonVariants,
	Card,
	CardActions,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	IntentLink,
	Skeleton,
	StatePanel,
} from "@everyfield/ui/controls";
import { formatCount, List, ListRow, StatusBadge, type Tone } from "@everyfield/ui/display";
import { cn, Icon, type IconSvgElement } from "@everyfield/ui/foundations";
import Link from "next/link";
import { milestonesDone } from "../launch/model.ts";
import {
	daysText,
	entryByline,
	entryText,
	launchShown,
	longDate,
	METRICS,
	type Loaded,
} from "./model.ts";

// Overview's cards. Each takes its own read and shows its own loading and failure: a card whose read failed says so
// and never shows a 0 or an empty list in its place (ADM-005, screens.md states).

/** A card whose read did not arrive. `what` names it: "Your numbers", "Recent changes". */
export function CardFailed({ what, loaded }: { what: string; loaded: Exclude<Loaded<unknown>, { status: "ok" }> }) {
	return (
		<Card>
			<StatePanel
				tone={loaded.status === "denied" ? "lock" : "error"}
				headingLevel="h2"
				title={loaded.status === "denied" ? `${what} are not part of your seat` : `${what} could not load`}
				className="py-10"
			>
				{loaded.status === "denied"
					? "Your seat in this church changed. Reload the page to see what it allows now."
					: "This is a loading problem, so nothing is shown in its place. Nothing in your church has changed. Reload the page in a moment."}
			</StatePanel>
		</Card>
	);
}

export function MetricsCards({ loaded }: { loaded: Loaded<Metrics> }) {
	if (loaded.status !== "ok") return <CardFailed what="Your numbers" loaded={loaded} />;
	return (
		<section aria-label="Key numbers" className="grid grid-cols-4 gap-5 max-app-md:grid-cols-2 max-app-sm:gap-3">
			{METRICS.map((m) => (
				<Link
					key={m.key}
					href={m.href}
					prefetch={false}
					className="group cursor-pointer rounded-card border border-line bg-surface p-5 transition-colors hover:bg-hover max-app-sm:p-4"
				>
					<span className="block text-md font-medium text-text-2">{m.label}</span>
					<span className="num mt-3 block font-display text-[40px] leading-none tracking-[-0.02em] text-ink max-app-sm:text-[32px]">
						{formatCount(loaded.value[m.key])}
					</span>
					<span className="mt-3 block text-sm text-text-3 text-pretty">{m.detail}</span>
				</Link>
			))}
		</section>
	);
}
export function MetricsLoading() {
	return (
		<div aria-busy="true" className="grid grid-cols-4 gap-5 max-app-md:grid-cols-2 max-app-sm:gap-3">
			<span className="sr-only" role="status">
				Loading your numbers
			</span>
			{METRICS.map((m) => (
				<Skeleton key={m.key} shape="block" height={150} className="rounded-card" />
			))}
		</div>
	);
}

const ENTRY_ICON: Record<Activity["entries"][number]["change"]["kind"], { icon: IconSvgElement; tone: Tone }> = {
	person_added: { icon: UserAdd01Icon, tone: "green" },
	meeting_held: { icon: Calendar03Icon, tone: "blue" },
	attendance_corrected: { icon: PencilEdit02Icon, tone: "amber" },
	task_completed: { icon: CheckmarkCircle02Icon, tone: "teal" },
	launch_date: { icon: StartUp02Icon, tone: "violet" },
	launch_recorded: { icon: StartUp02Icon, tone: "violet" },
	phase_changed: { icon: Route01Icon, tone: "ink" },
};

export function ActivityCard({ loaded }: { loaded: Loaded<Activity> }) {
	if (loaded.status !== "ok") return <CardFailed what="Recent changes" loaded={loaded} />;
	const { entries, timeZone, more } = loaded.value;
	return (
		<Card>
			<CardHeader>
				<CardHeading>
					<CardTitle>Recent changes</CardTitle>
					<CardDescription>
						{more ? "The latest 20 changes in your church" : "Everything that changed in your church so far"}
					</CardDescription>
				</CardHeading>
			</CardHeader>
			{entries.length ? (
				<List>
					{entries.map((e) => {
						const { title, href } = entryText(e);
						const { icon, tone } = ENTRY_ICON[e.change.kind];
						return (
							<ListRow
								key={e.id}
								icon={icon}
								tone={tone}
								title={title}
								subtitle={entryByline(e, timeZone)}
								href={href}
								linkAs={Link}
							/>
						);
					})}
				</List>
			) : (
				<p className="text-md text-text-2">Nothing has changed yet. People you add and meetings you hold show here.</p>
			)}
		</Card>
	);
}

/** The launch card (LCH-008): the same date, countdown and readiness as the Launch plan, or what happened. */
export function LaunchCard({ loaded, admin }: { loaded: Loaded<Plan>; admin: boolean }) {
	if (loaded.status !== "ok") return <CardFailed what="Launch Sunday" loaded={loaded} />;
	const plan = loaded.value;
	const shown = launchShown(plan);
	const done = milestonesDone(plan);
	const total = plan.milestones.length;
	const badge =
		shown.kind === "held" ? (
			<StatusBadge status="positive">Launched</StatusBadge>
		) : shown.kind === "overdue" ? (
			<StatusBadge status="risk">Overdue</StatusBadge>
		) : shown.kind === "postponed" ? (
			<StatusBadge status="attention">Postponed</StatusBadge>
		) : shown.kind === "none" ? (
			<StatusBadge status="unknown">No date</StatusBadge>
		) : (
			<StatusBadge status="positive">Scheduled</StatusBadge>
		);
	return (
		<Card>
			<CardHeader>
				<CardHeading>
					<CardTitle>Launch Sunday</CardTitle>
				</CardHeading>
				<CardActions>{badge}</CardActions>
			</CardHeader>
			<LaunchFigure shown={shown} />
			{shown.kind === "none" ? (
				<div className="mt-4 flex flex-wrap items-center gap-3">
					<p className="text-md text-text-2">Set Launch Sunday to start the countdown and the readiness milestones.</p>
					{admin ? (
						<IntentLink href="/launch" className={buttonVariants({ variant: "primary", size: "sm" })}>
							Set Launch Sunday
						</IntentLink>
					) : null}
				</div>
			) : null}
			{total ? (
				<div className="mt-6">
					<div className="flex items-baseline justify-between gap-3 text-md">
						<span className="text-text-2">Readiness milestones</span>
						<b className="font-semibold text-ink">
							{done} of {total}
						</b>
					</div>
					<div className="mt-2 h-2 overflow-hidden rounded-pill bg-surface-2" aria-hidden="true">
						<span className="block h-full rounded-pill bg-green-500" style={{ width: `${(done / total) * 100}%` }} />
					</div>
				</div>
			) : null}
			<div className="mt-6">
				<IntentLink href="/launch" className={buttonVariants({ variant: "secondary", size: "sm" })}>
					Open Launch plan
					<Icon icon={StartUp02Icon} size={16} />
				</IntentLink>
			</div>
		</Card>
	);
}

function LaunchFigure({ shown }: { shown: ReturnType<typeof launchShown> }) {
	const big = "num font-display text-[44px] leading-none tracking-[-0.02em] text-ink max-app-sm:text-[36px]";
	switch (shown.kind) {
		case "held":
			return (
				<div>
					<p className={big}>{longDate(shown.date)}</p>
					<p className="mt-3 text-md text-text-2">
						Held · Attendance{" "}
						<b className="font-semibold text-ink">
							{shown.attendance === null ? "not recorded" : formatCount(shown.attendance)}
						</b>
					</p>
				</div>
			);
		case "ahead":
			return (
				<div>
					<p className={big}>{daysText(shown.days)}</p>
					<p className="mt-3 text-md text-text-2">Until {longDate(shown.date)}</p>
				</div>
			);
		case "today":
			return (
				<div>
					<p className={big}>Today</p>
					<p className="mt-3 text-md text-text-2">{longDate(shown.date)}</p>
				</div>
			);
		case "overdue":
			return (
				<div>
					<p className={cn(big, "text-magenta-600")}>{longDate(shown.date)}</p>
					<p className="mt-3 text-md text-text-2">This date has passed and no Launch Sunday is recorded yet.</p>
				</div>
			);
		case "postponed":
			return (
				<div>
					<p className={big}>Postponed</p>
					<p className="mt-3 text-md text-text-2">No date is set right now.</p>
				</div>
			);
		case "none":
			return <p className={big}>No date yet</p>;
	}
}

export function CardLoading({ label, height = 320 }: { label: string; height?: number }) {
	return (
		<div aria-busy="true">
			<span className="sr-only" role="status">
				Loading {label}
			</span>
			<Skeleton shape="block" height={height} className="rounded-card" />
		</div>
	);
}
