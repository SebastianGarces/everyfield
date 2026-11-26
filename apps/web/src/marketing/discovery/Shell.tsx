import { cn } from "@everyfield/ui/foundations";
import {
	ArrowDown01Icon,
	BellIcon,
	BookOpen02Icon,
	Calendar03Icon,
	ChurchIcon,
	ChartLineData01Icon,
	Link01Icon,
	Mail01Icon,
	Menu01Icon,
	MessageEdit01Icon,
	Moon02Icon,
	Notification03Icon,
	Search01Icon,
	Settings02Icon,
	ShieldUserIcon,
	StartUp02Icon,
	Sun01Icon,
	Task01Icon,
	UserGroupIcon,
	UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { EvryBot } from "@/components/kit/EvryBot";
import { Mark } from "@/components/Logo";

type RailItem = { key: string; icon: IconSvgElement };

const PLANTER = {
	main: ["Home", "Wiki", "Documents"],
	pages: [
		{ key: "people", icon: UserMultipleIcon },
		{ key: "meetings", icon: Calendar03Icon },
		{ key: "messages", icon: Mail01Icon },
		{ key: "tasks", icon: Task01Icon },
		{ key: "ministries", icon: UserGroupIcon },
		{ key: "launch", icon: StartUp02Icon },
		{ key: "intelligence", icon: ChartLineData01Icon },
	],
	guide: true,
	user: "Caleb Turner",
	initials: "CT",
} as const;

const DIRECTOR = {
	main: ["Plants", "Pipeline", "Sent for review"],
	pages: [
		{ key: "connections", icon: Link01Icon },
		{ key: "sharing", icon: ShieldUserIcon },
		{ key: "notifications", icon: Notification03Icon },
	],
	guide: false,
	user: "Grace Church",
	initials: "GC",
} as const;

const PILL = "bg-surface-raised shadow-nav";
const ON = "bg-ink text-on-ink shadow-nav-active";

function Rail({ items, current, className }: { items: readonly RailItem[]; current?: string; className?: string }) {
	return (
		<span className={cn("flex w-16 flex-col items-center gap-1.5 py-2.5", PILL, className)}>
			{items.map((r) => (
				<span key={r.key} className={cn("grid size-[46px] place-items-center text-ink-2", r.key === current && ON)}>
					<Icon icon={r.icon} size={24} stroke={1.5} />
				</span>
			))}
		</span>
	);
}

export function Shell({
	who = "planter",
	nav,
	rail,
	label,
	children,
}: {
	who?: "planter" | "director";
	nav?: string;
	rail?: string;
	label: string;
	children: ReactNode;
}) {
	const s = who === "planter" ? PLANTER : DIRECTOR;
	const bottom: RailItem[] = [
		{ key: "feedback", icon: MessageEdit01Icon },
		...(s.guide ? [{ key: "guide", icon: BookOpen02Icon }] : []),
		{ key: "settings", icon: Settings02Icon },
	];
	return (
		<div className={"@container h-full ef-ui type-lg shadow-mk-app"}>
			<div
				role="img"
				aria-label={label}
				className={cn(
					"grid h-full grid-cols-[96px_minmax(0,1fr)] grid-rows-[auto_1fr] bg-frame [zoom:.86]",
					"@max-[1000px]:grid-cols-[minmax(0,1fr)] @max-[1000px]:[zoom:1]",
				)}
			>
				<div
					aria-hidden="true"
					className={cn(
						"col-span-full grid grid-cols-[minmax(max-content,1fr)_auto_minmax(max-content,1fr)] items-center gap-2.5 px-6 pt-[22px] pb-2 pl-[22px] whitespace-nowrap",
						"@max-[1000px]:flex @max-[1000px]:gap-2 @max-[1000px]:px-3 @max-[1000px]:pt-3 @max-[330px]:gap-1.5 @max-[330px]:px-2",
					)}
				>
					<span
						className={cn(
							"flex h-[60px] items-center justify-self-start px-6 text-ink @max-[1000px]:px-2.5 @max-[330px]:px-1",
							PILL,
						)}
					>
						<svg viewBox="0 0 1308 241" className={cn("h-[26px] w-[141px] @max-[1000px]:hidden")}>
							<use href="#ef-lockup" />
						</svg>
						<Mark className={cn("mx-2 hidden size-6 @max-[1000px]:block")} />
					</span>
					<span className={cn("flex h-[60px] items-center gap-0.5 px-2 @max-[1000px]:hidden", PILL)}>
						{s.main.map((n) => (
							<span key={n} className={cn("inline-flex h-11 items-center px-[13px] text-ink-2", n === nav && ON)}>
								{n}
							</span>
						))}
					</span>
					<span className={cn("hidden h-[60px] items-center px-2 @max-[1000px]:flex @max-[330px]:px-0.5", PILL)}>
						<span className="inline-flex h-11 items-center gap-2 px-3 text-ink-2 @max-[330px]:px-2">
							<Icon icon={Menu01Icon} size={24} stroke={1.5} />
							<span className="@max-[639px]:hidden">Menu</span>
						</span>
					</span>
					<span className="ml-auto flex gap-2.5 justify-self-end @max-[1000px]:gap-2 @max-[330px]:gap-1.5">
						<span className={cn("flex h-[60px] items-center gap-1.5 px-2 @max-[330px]:px-0.5", PILL)}>
							<span className="grid size-11 place-items-center text-ink-2 @max-[639px]:hidden">
								<Icon icon={Search01Icon} size={24} stroke={1.5} />
							</span>
							<span className="grid size-11 place-items-center text-ink-2">
								<Icon icon={BellIcon} size={24} stroke={1.5} />
							</span>
							<span className="inline-flex h-11 items-center gap-[9px] bg-surface-2 pr-3 pl-2.5 text-ink @max-[639px]:px-2.5">
								<EvryBot size="sm" />
								<span className="font-medium @max-[639px]:hidden">Ask Evry</span>
							</span>
						</span>
						<span
							className={cn(
								"flex h-[60px] items-center gap-3 pr-3.5 pl-2.5 @max-[639px]:px-2.5 @max-[330px]:px-1",
								PILL,
							)}
						>
							<span className="grid size-10 place-items-center rounded-full bg-green-100 type-md font-semibold text-green-700">
								{s.initials}
							</span>
							<span className="font-semibold @max-[1000px]:hidden">{s.user}</span>
							<Icon icon={ArrowDown01Icon} size={16} className="text-text-3 @max-[639px]:hidden" />
						</span>
					</span>
				</div>
				<div aria-hidden="true" className={cn("flex flex-col gap-3.5 pt-[18px] pb-5 pl-[22px] @max-[1000px]:hidden")}>
					<Rail
						items={[
							{ key: "sun", icon: Sun01Icon },
							{ key: "moon", icon: Moon02Icon },
						]}
						current=""
						className="[&>span:first-child]:bg-surface-2 [&>span:first-child]:text-ink"
					/>
					<i className="flex-[.6]" />
					<Rail items={s.pages} current={rail} />
					<i className="flex-1" />
					<Rail items={bottom} />
				</div>
				<div
					className={cn(
						"flex min-w-0 flex-col pt-[18px] pr-[26px] pb-8 pl-2.5 @max-[1000px]:px-4 @max-[1000px]:pt-2 @max-[1000px]:pb-5",
					)}
				>
					{children}
				</div>
			</div>
		</div>
	);
}

export function PageHead({
	title,
	crumb,
	sub,
	xl,
	actions,
}: {
	title: string;
	crumb?: readonly string[];
	sub?: string;
	xl?: boolean;
	actions?: ReactNode;
}) {
	return (
		<div className="mb-[26px] flex items-end justify-between gap-6 @max-[1000px]:flex-col @max-[1000px]:items-start @max-[1000px]:gap-4 @max-[639px]:mb-4 @max-[639px]:gap-3">
			<div className="min-w-0">
				{crumb ? (
					<div className="mb-2.5 flex flex-wrap items-center gap-2 type-md text-text-3">
						{crumb.map((c, i) => (
							<span key={c} className={cn("flex items-center gap-2", i === crumb.length - 1 && "text-text-2")}>
								{i ? <span aria-hidden="true">›</span> : null}
								{c}
							</span>
						))}
					</div>
				) : null}
				<div
					className={cn(
						"font-display leading-[1.05] tracking-[-0.02em] text-balance text-ink @max-[639px]:type-title-lg",
						xl ? "type-display-md" : "type-display-sm",
					)}
				>
					{title}
				</div>
				{sub ? <div className="mt-2 text-text-2">{sub}</div> : null}
			</div>
			{actions ? <div className="flex flex-none items-center gap-2.5">{actions}</div> : null}
		</div>
	);
}

export function LockedNote({ title, body }: { title: string; body: string }) {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-2.5 bg-surface px-6 py-16 text-center shadow-card @max-[639px]:px-4 @max-[639px]:py-10">
			<span className="mb-1.5 grid size-16 place-items-center bg-surface-2 text-ink-2">
				<Icon icon={ChurchIcon} size={28} stroke={1.5} />
			</span>
			<div className="font-title type-title-md leading-[1.2] tracking-[-0.02em] text-balance text-ink">{title}</div>
			<p className="max-w-[420px] text-pretty text-text-2">{body}</p>
			<span className="mt-3 inline-flex h-11 items-center bg-ink px-[18px] font-medium text-on-ink shadow-pill">
				Start a church
			</span>
		</div>
	);
}
