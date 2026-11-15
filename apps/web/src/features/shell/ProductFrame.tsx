"use client";

import {
	BookOpen01Icon,
	BookOpen02Icon,
	Calendar03Icon,
	ChartLineData01Icon,
	DashboardSquare01Icon,
	File02Icon,
	FileSearchIcon,
	HierarchyIcon,
	Link01Icon,
	Mail01Icon,
	Mortarboard01Icon,
	Notification03Icon,
	MessageEdit01Icon,
	Route01Icon,
	Settings02Icon,
	StartUp02Icon,
	ShieldUserIcon,
	Task01Icon,
	UserGroupIcon,
	UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import { DASHBOARD_HOME, LANDING_ROUTE, ORGANIZATION_HOME } from "@everyfield/contracts/identity";
import { ToastProvider, useToast } from "@everyfield/ui/controls";
import { initials } from "@everyfield/ui/display";
import { AppShell, RoleBanner, type ShellNav } from "@everyfield/ui/shell";
import { usePathname } from "next/navigation";
import { createContext, use, useState, type ReactNode } from "react";
import { useEvryPanel } from "../evry/conversation/EvryPanel.tsx";
import { FeedbackDialog } from "../feedback/FeedbackDialog.tsx";
import { evryOff } from "../intelligence/path.ts";
import { useNotificationBell } from "../notifications/Bell.tsx";
import { NotificationsProvider } from "../notifications/feed.tsx";
import { AccountMenu } from "../settings/AccountMenu";
import { firstSection } from "../settings/model";
import { SettingsOpener } from "../settings/opener";
import { Residency, useResidency, type ResidencyState } from "./residency.ts";
import type { SectionSeed, SettingsViewer } from "../settings/port";
import { useProductSettings } from "../settings/ProductSettings";
import type { Role } from "../people/server.ts";
import { useWikiChrome, WikiChrome } from "../wiki/client.tsx";

const OVERVIEW = {
	kind: "link",
	key: "overview",
	label: "Overview",
	href: DASHBOARD_HOME,
	icon: DashboardSquare01Icon,
	prefetch: false,
} as const;
const PEOPLE = { kind: "link", key: "people", label: "People", href: "/people", icon: UserMultipleIcon } as const;
const MEETINGS = {
	kind: "link",
	key: "meetings",
	label: "Meetings",
	href: "/meetings",
	icon: Calendar03Icon,
	prefetch: false,
} as const;
const TASKS = { kind: "link", key: "tasks", label: "Tasks", href: "/tasks", icon: Task01Icon } as const;
const MESSAGES = {
	kind: "link",
	key: "messages",
	label: "Messages",
	href: "/communication",
	icon: Mail01Icon,
	prefetch: false,
} as const;
const MINISTRIES = {
	kind: "link",
	key: "ministries",
	label: "Ministries",
	href: "/ministries",
	icon: UserGroupIcon,
	prefetch: false,
} as const;
const WIKI = { kind: "link", key: "wiki", label: "Wiki", href: "/wiki", icon: BookOpen01Icon } as const;
const DOCUMENTS = {
	kind: "link",
	key: "documents",
	label: "Documents",
	href: "/documents",
	icon: File02Icon,
	prefetch: false,
} as const;
const INTELLIGENCE = {
	kind: "link",
	key: "intelligence",
	label: "Plant Intelligence",
	href: "/intelligence",
	icon: ChartLineData01Icon,
	prefetch: false,
} as const;
const LAUNCH = {
	kind: "link",
	key: "launch",
	label: "Launch",
	href: "/launch",
	icon: StartUp02Icon,
	prefetch: false,
} as const;
const PLANTS = { kind: "link", key: "plants", label: "Plants", href: "/network", icon: HierarchyIcon } as const;
const ORGANIZATION_PAGES = [
	{ kind: "link", key: "connections", label: "Connections", href: "/settings/sharing#connections", icon: Link01Icon },
	{ kind: "link", key: "sharing", label: "Sharing", href: "/settings/sharing", icon: ShieldUserIcon },
	{ kind: "link", key: "notifications", label: "Notifications", href: "/notifications", icon: Notification03Icon },
] as const;
const PIPELINE = {
	kind: "link",
	key: "pipeline",
	label: "Pipeline",
	href: "/organization/pipeline",
	icon: Route01Icon,
	prefetch: false,
} as const;
const REVIEWS = {
	kind: "link",
	key: "reviews",
	label: "Sent for review",
	href: "/organization/reviews",
	icon: FileSearchIcon,
	prefetch: false,
} as const;
const MY_RESIDENCY = {
	kind: "link",
	key: "my-residency",
	label: "My residency",
	href: "/my-residency",
	icon: Mortarboard01Icon,
} as const;
const ROLE: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };

type FrameProps = {
	name: string;
	photo?: string;
	settings: SettingsViewer | null;
	seed?: SectionSeed | null;
	residency?: { organizationName: string } | null;
	children: ReactNode;
};

const OwnSeat = createContext<(role: Role | null) => void>(() => {});
export const useOwnSeatChange = () => use(OwnSeat);

export function ProductFrame({ settings: initial, seed, residency = null, ...props }: FrameProps) {
	const [left, setLeft] = useState<{ from: typeof residency } | null>(null);
	const ended = left !== null && left.from === residency;
	const residencyState: ResidencyState = {
		linked: residency !== null && !ended,
		ended,
		left: () => setLeft({ from: residency }),
	};
	const [own, setOwn] = useState({ from: initial, settings: initial });
	const settings = own.from === initial ? own.settings : initial;
	const change = (role: Role | null) =>
		setOwn(() => ({
			from: initial,
			settings:
				!settings || settings.context === "account"
					? settings
					: role === null
						? { context: "account", accountId: settings.accountId }
						: { ...settings, role },
		}));
	return (
		<ToastProvider>
			<OwnSeat value={change}>
				<Residency value={residencyState}>
					<NotificationsProvider>
						<WikiChrome>
							<Frame {...props} settings={settings} seed={settings === initial ? seed : null} />
						</WikiChrome>
					</NotificationsProvider>
				</Residency>
			</OwnSeat>
		</ToastProvider>
	);
}

function Frame({ name, photo, settings, seed = null, children }: FrameProps) {
	const toast = useToast();
	const dialog = useProductSettings(settings, seed);
	const pathname = usePathname();
	const privatePage = evryOff(pathname);
	const evry = useEvryPanel({
		inPlant: settings?.context === "plant",
		off: privatePage,
		context:
			settings?.context === "plant"
				? `plant:${settings.plant.id}`
				: settings?.context === "organization"
					? `organization:${settings.organization.id}`
					: "account",
	});
	const bell = useNotificationBell();
	const wiki = useWikiChrome();
	const [feedback, setFeedback] = useState(false);
	const role = settings && settings.context !== "account" ? settings.role : null;
	const { linked } = useResidency();
	const account = !settings || settings.context === "account";
	const banner =
		settings?.context === "plant" && role === "member" ? (
			<RoleBanner>
				You have a Member seat. You can read what your seat allows and work on tasks assigned to you. Other changes need
				an Owner or Admin.
			</RoleBanner>
		) : null;
	const settingsLink = {
		kind: "link",
		key: "settings",
		label: "Settings",
		href: "/settings",
		icon: Settings02Icon,
		onNavigate: settings
			? (event: { preventDefault: () => void }) => {
					event.preventDefault();
					dialog.open(firstSection(settings));
				}
			: undefined,
	} as const;
	const feedbackAction = {
		kind: "action",
		key: "feedback",
		label: "Send feedback",
		icon: MessageEdit01Icon,
		onSelect: () => setFeedback(true),
	} as const;
	const organization = settings?.context === "organization";
	const nav: ShellNav = organization
		? { main: [PLANTS, PIPELINE, REVIEWS], pages: ORGANIZATION_PAGES, tools: [feedbackAction, settingsLink] }
		: {
				main: account
					? linked
						? [MY_RESIDENCY, WIKI]
						: [WIKI]
					: [OVERVIEW, PEOPLE, MEETINGS, MESSAGES, TASKS, MINISTRIES, WIKI],
				pages:
					settings?.context !== "plant"
						? [DOCUMENTS]
						: role !== "member"
							? [LAUNCH, INTELLIGENCE, DOCUMENTS]
							: [LAUNCH, DOCUMENTS],
				tools: [
					feedbackAction,
					{
						kind: "action",
						key: "guide",
						label: "Guide",
						icon: BookOpen02Icon,
						onSelect: () => wiki?.toggleGuide(),
						expanded: wiki?.guideOpen,
					},
					settingsLink,
				],
			};
	const later = (what: string) => () => toast({ message: `${what} is not available yet.`, tone: "info" });
	const seat = role ? `${ROLE[role]} seat` : "";
	return (
		<AppShell
			nav={nav}
			user={{ name, initials: initials(name), detail: role ? ROLE[role] : "", photo }}
			userMenu={
				<AccountMenu
					name={name}
					detail={seat}
					onAccount={() => dialog.open("account")}
					checkIn={settings?.context === "plant" && role !== "member"}
				/>
			}
			homeHref={
				organization ? ORGANIZATION_HOME : account ? (linked ? "/my-residency" : LANDING_ROUTE) : DASHBOARD_HOME
			}
			unread={bell.unread}
			width="wide"
			onSearch={() => {
				if (pathname.startsWith("/wiki")) {
					wiki?.openSearch();
					return;
				}
				const search = document.querySelector<HTMLInputElement>("[data-people-search]");
				if (search) search.focus();
				else later("Search")();
			}}
			onNotifications={bell.open}
			notificationsOpen={bell.expanded}
			onAskEvry={privatePage ? undefined : evry.open}
			banner={banner}
		>
			<SettingsOpener value={dialog.open}>{children}</SettingsOpener>
			{dialog.element}
			{evry.element}
			{bell.element}
			<FeedbackDialog open={feedback} onOpenChange={setFeedback} name={name} />
		</AppShell>
	);
}
