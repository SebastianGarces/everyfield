"use client";

import {
	BookOpen01Icon,
	BookOpen02Icon,
	Calendar03Icon,
	ChartLineData01Icon,
	File02Icon,
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

// The product frame around People, Meetings, Messages, Tasks, Ministries, Wiki, Documents and Settings. Only destinations that
// exist are in the navigation. The full product navigation and command palette come from their own packages and
// replace these when they ship. The bell
// opens the notification drop-down (WP-030). Send feedback (WP-049) opens its dialog over the current page. Settings sits
// at the bottom of the rail and in the user menu behind the name button (screens.md, Overlays).

const PEOPLE = { kind: "link", key: "people", label: "People", href: "/people", icon: UserMultipleIcon } as const;
// Meetings is a dynamic page; it loads when chosen, not whenever the frame renders.
const MEETINGS = {
	kind: "link",
	key: "meetings",
	label: "Meetings",
	href: "/meetings",
	icon: Calendar03Icon,
	prefetch: false,
} as const;
const TASKS = { kind: "link", key: "tasks", label: "Tasks", href: "/tasks", icon: Task01Icon } as const;
// Messages is a dynamic page. It loads when chosen, not whenever the frame renders.
const MESSAGES = {
	kind: "link",
	key: "messages",
	label: "Messages",
	href: "/communication",
	icon: Mail01Icon,
	prefetch: false,
} as const;
// Ministries (WP-017) loads when chosen, like Meetings.
const MINISTRIES = {
	kind: "link",
	key: "ministries",
	label: "Ministries",
	href: "/ministries",
	icon: UserGroupIcon,
	prefetch: false,
} as const;
const WIKI = { kind: "link", key: "wiki", label: "Wiki", href: "/wiki", icon: BookOpen01Icon } as const;
// Documents is a secondary rail page. It loads when chosen, not whenever the frame renders.
const DOCUMENTS = {
	kind: "link",
	key: "documents",
	label: "Documents",
	href: "/documents",
	icon: File02Icon,
	prefetch: false,
} as const;
// Plant Intelligence (WP-038: the phase journey) is for a plant's Owners and Admins. It loads when chosen.
const INTELLIGENCE = {
	kind: "link",
	key: "intelligence",
	label: "Plant Intelligence",
	href: "/intelligence",
	icon: ChartLineData01Icon,
	prefetch: false,
} as const;
// The Launch plan (WP-045) is for every seat of a church plant: Members read it and work their own prep tasks.
const LAUNCH = {
	kind: "link",
	key: "launch",
	label: "Launch",
	href: "/launch",
	icon: StartUp02Icon,
	prefetch: false,
} as const;
// A sending church or network seat (WP-047a): its plants, its connections and what it shares, its notifications and
// Settings. No planter page appears. Connections and Sharing are the one /settings/sharing page (D-1097).
const PLANTS = { kind: "link", key: "plants", label: "Plants", href: "/network", icon: HierarchyIcon } as const;
const ORGANIZATION_PAGES = [
	{ kind: "link", key: "connections", label: "Connections", href: "/settings/sharing#connections", icon: Link01Icon },
	{ kind: "link", key: "sharing", label: "Sharing", href: "/settings/sharing", icon: ShieldUserIcon },
	{ kind: "link", key: "notifications", label: "Notifications", href: "/notifications", icon: Notification03Icon },
] as const;
// An organization's Pipeline (WP-098a): the people a sending church or network develops toward planting.
const PIPELINE = {
	kind: "link",
	key: "pipeline",
	label: "Pipeline",
	href: "/organization/pipeline",
	icon: Route01Icon,
	prefetch: false,
} as const;
// My residency (WP-100): a seatless account linked to a sending church's residency, only while the link is live.
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
	/** The app's own route for the viewer's current photo, when there is one. */
	photo?: string;
	/** The viewer as Settings sees it, with the seat's role; null when there is no active actor. */
	settings: SettingsViewer | null;
	/** The settings section read the server started for this page's address, for the server's viewer only. */
	seed?: SectionSeed | null;
	/** A seatless account's live residency link, by the church's name; null without one. */
	residency?: { organizationName: string } | null;
	children: ReactNode;
};

/**
 * A confirmed change to the viewer's own seat, from a page inside the frame (Seats): the new role, or null when the
 * seat was removed. The frame shows it at once, without reading the page again.
 */
const OwnSeat = createContext<(role: Role | null) => void>(() => {});
export const useOwnSeatChange = () => use(OwnSeat);

export function ProductFrame({ settings: initial, seed, residency = null, ...props }: FrameProps) {
	// The server's link is the source until a page reports that the viewer left it.
	const [left, setLeft] = useState<{ from: typeof residency } | null>(null);
	const ended = left !== null && left.from === residency;
	const residencyState: ResidencyState = {
		linked: residency !== null && !ended,
		ended,
		left: () => setLeft({ from: residency }),
	};
	// The server's viewer is the source until a page reports a change to the viewer's own seat.
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
	// Evry is off while the private check-in is open: its panel closes and Ask Evry says so (REQ-PI-038).
	const privatePage = evryOff(pathname);
	const evry = useEvryPanel({ inPlant: settings?.context === "plant", off: privatePage });
	const bell = useNotificationBell();
	const wiki = useWikiChrome();
	const [feedback, setFeedback] = useState(false);
	const role = settings && settings.context !== "account" ? settings.role : null;
	const { linked } = useResidency();
	// A seatless account has no People, Meetings, Messages, Tasks or Ministries; while linked, it has My residency.
	const account = !settings || settings.context === "account";
	// A plant Member reads People and Tasks and works on their own tasks; organization seats have neither.
	const banner =
		settings?.context === "plant" && role === "member" ? (
			<RoleBanner>
				You have a Member seat. You can read what your seat allows and work on tasks assigned to you. Other changes need
				an Owner or Admin.
			</RoleBanner>
		) : null;
	// The rail's Settings opens the dialog over the current page, as the user menu does; /settings is its address.
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
		? { main: [PLANTS, PIPELINE], pages: ORGANIZATION_PAGES, tools: [feedbackAction, settingsLink] }
		: {
				main: account
					? linked
						? [MY_RESIDENCY, WIKI]
						: [WIKI]
					: [PEOPLE, MEETINGS, MESSAGES, TASKS, MINISTRIES, WIKI],
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
			homeHref={organization ? "/network" : account ? (linked ? "/my-residency" : "/home") : "/people"}
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
