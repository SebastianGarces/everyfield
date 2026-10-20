"use client";

import { UserMultipleIcon } from "@hugeicons/core-free-icons";
import { ToastProvider, useToast } from "@everyfield/ui/controls";
import { initials } from "@everyfield/ui/display";
import { AppShell, RoleBanner, type ShellNav } from "@everyfield/ui/shell";
import { createContext, use, useState, type ReactNode } from "react";
import { AccountMenu } from "../settings/AccountMenu";
import type { SettingsViewer } from "../settings/port";
import { useProductSettings } from "../settings/ProductSettings";
import type { Role } from "./server.ts";

// The product frame around the People and Settings pages. Only destinations that exist are in the navigation; the full
// product navigation, command palette, notifications and Evry come from their own packages and replace these when they
// ship. Settings is reached from the user menu behind the name button (screens.md, Overlays).

const NAV: ShellNav = {
	main: [{ kind: "link", key: "people", label: "People", href: "/people", icon: UserMultipleIcon }],
	pages: [],
	tools: [],
};
const ROLE: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };

type FrameProps = {
	name: string;
	/** The viewer as Settings sees it, with the seat's role; null when there is no active actor. */
	settings: SettingsViewer | null;
	children: ReactNode;
};

/**
 * A confirmed change to the viewer's own seat, from a page inside the frame (Seats): the new role, or null when the
 * seat was removed. The frame shows it at once, without reading the page again.
 */
const OwnSeat = createContext<(role: Role | null) => void>(() => {});
export const useOwnSeatChange = () => use(OwnSeat);

export function PeopleFrame({ settings: initial, ...props }: FrameProps) {
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
				<Frame {...props} settings={settings} />
			</OwnSeat>
		</ToastProvider>
	);
}

function Frame({ name, settings, children }: FrameProps) {
	const toast = useToast();
	const dialog = useProductSettings(settings);
	const role = settings && settings.context !== "account" ? settings.role : null;
	// A plant Member reads People but does not change it; organization seats have no People list.
	const banner =
		settings?.context === "plant" && role === "member" ? (
			<RoleBanner>
				You have a Member seat. You can see people and their history; Owners and Admins change them.
			</RoleBanner>
		) : null;
	const later = (what: string) => () => toast({ message: `${what} is not available yet.`, tone: "info" });
	const seat = role ? `${ROLE[role]} seat` : "";
	return (
		<AppShell
			nav={NAV}
			user={{ name, initials: initials(name), detail: role ? ROLE[role] : "" }}
			userMenu={<AccountMenu name={name} detail={seat} onAccount={() => dialog.open("account")} />}
			homeHref="/people"
			unread={0}
			width="wide"
			onSearch={() => {
				const search = document.querySelector<HTMLInputElement>("[data-people-search]");
				if (search) search.focus();
				else later("Search")();
			}}
			onNotifications={later("Notifications")}
			onAskEvry={later("Evry")}
			banner={banner}
		>
			{children}
			{dialog.element}
		</AppShell>
	);
}
