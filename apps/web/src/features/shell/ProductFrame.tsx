"use client";

import { BookOpen02Icon, MessageEdit01Icon, Settings02Icon } from "@hugeicons/core-free-icons";
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
import { shellNav } from "./nav.ts";
import { Residency, useResidency, type ResidencyState } from "./residency.ts";
import type { SectionSeed, SettingsViewer } from "../settings/port";
import { useProductSettings } from "../settings/ProductSettings";
import type { Role } from "../people/server.ts";
import { useWikiChrome, WikiChrome } from "../wiki/client.tsx";

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
	const rail = shellNav(
		organization
			? { context: "organization" }
			: settings?.context === "plant"
				? { context: "plant", role: settings.role }
				: { context: "account", residencyLinked: linked },
	);
	const guide = {
		kind: "action",
		key: "guide",
		label: "Guide",
		icon: BookOpen02Icon,
		onSelect: () => wiki?.toggleGuide(),
		expanded: wiki?.guideOpen,
	} as const;
	const nav: ShellNav = {
		main: rail.main,
		pages: rail.pages,
		tools: rail.guide ? [feedbackAction, guide, settingsLink] : [feedbackAction, settingsLink],
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
