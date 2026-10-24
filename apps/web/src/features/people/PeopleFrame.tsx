"use client";

import { Calendar03Icon, File02Icon, Settings02Icon, Task01Icon, UserMultipleIcon } from "@hugeicons/core-free-icons";
import { ToastProvider, useToast } from "@everyfield/ui/controls";
import { initials } from "@everyfield/ui/display";
import { AppShell, RoleBanner, type ShellNav } from "@everyfield/ui/shell";
import { createContext, use, useState, type ReactNode } from "react";
import { useEvryPanel } from "../evry/conversation/EvryPanel.tsx";
import { useNotificationBell } from "../notifications/Bell.tsx";
import { NotificationsProvider } from "../notifications/feed.tsx";
import { AccountMenu } from "../settings/AccountMenu";
import { firstSection } from "../settings/model";
import type { SectionSeed, SettingsViewer } from "../settings/port";
import { useProductSettings } from "../settings/ProductSettings";
import type { Role } from "./server.ts";

// The product frame around the People and Settings pages. Only destinations that exist are in the navigation; the full
// product navigation and command palette come from their own packages and replace these when they ship. The bell
// opens the notification drop-down (WP-030). Settings sits at the bottom of the rail and in the user menu behind the
// name button (screens.md, Overlays).

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
// Documents is a secondary rail page. It loads when chosen, not whenever the frame renders.
const DOCUMENTS = {
	kind: "link",
	key: "documents",
	label: "Documents",
	href: "/documents",
	icon: File02Icon,
	prefetch: false,
} as const;
const ROLE: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };

type FrameProps = {
	name: string;
	/** The viewer as Settings sees it, with the seat's role; null when there is no active actor. */
	settings: SettingsViewer | null;
	/** The settings section read the server started for this page's address, for the server's viewer only. */
	seed?: SectionSeed | null;
	children: ReactNode;
};

/**
 * A confirmed change to the viewer's own seat, from a page inside the frame (Seats): the new role, or null when the
 * seat was removed. The frame shows it at once, without reading the page again.
 */
const OwnSeat = createContext<(role: Role | null) => void>(() => {});
export const useOwnSeatChange = () => use(OwnSeat);

export function PeopleFrame({ settings: initial, seed, ...props }: FrameProps) {
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
				<NotificationsProvider>
					<Frame {...props} settings={settings} seed={settings === initial ? seed : null} />
				</NotificationsProvider>
			</OwnSeat>
		</ToastProvider>
	);
}

function Frame({ name, settings, seed = null, children }: FrameProps) {
	const toast = useToast();
	const dialog = useProductSettings(settings, seed);
	const evry = useEvryPanel({ inPlant: settings?.context === "plant" });
	const bell = useNotificationBell();
	const role = settings && settings.context !== "account" ? settings.role : null;
	// A plant Member reads People and Tasks and works on their own tasks; organization seats have neither.
	const banner =
		settings?.context === "plant" && role === "member" ? (
			<RoleBanner>
				You have a Member seat. You can read what your seat allows and work on tasks assigned to you. Other changes need
				an Owner or Admin.
			</RoleBanner>
		) : null;
	// The rail's Settings opens the dialog over the current page, as the user menu does; /settings is its address.
	const nav: ShellNav = {
		main: [PEOPLE, MEETINGS, TASKS],
		pages: [DOCUMENTS],
		tools: [
			{
				kind: "link",
				key: "settings",
				label: "Settings",
				href: "/settings",
				icon: Settings02Icon,
				onNavigate: settings
					? (event) => {
							event.preventDefault();
							dialog.open(firstSection(settings));
						}
					: undefined,
			},
		],
	};
	const later = (what: string) => () => toast({ message: `${what} is not available yet.`, tone: "info" });
	const seat = role ? `${ROLE[role]} seat` : "";
	return (
		<AppShell
			nav={nav}
			user={{ name, initials: initials(name), detail: role ? ROLE[role] : "" }}
			userMenu={<AccountMenu name={name} detail={seat} onAccount={() => dialog.open("account")} />}
			homeHref="/people"
			unread={bell.unread}
			width="wide"
			onSearch={() => {
				const search = document.querySelector<HTMLInputElement>("[data-people-search]");
				if (search) search.focus();
				else later("Search")();
			}}
			onNotifications={bell.open}
			onAskEvry={evry.open}
			banner={banner}
		>
			{children}
			{dialog.element}
			{evry.element}
			{bell.element}
		</AppShell>
	);
}
