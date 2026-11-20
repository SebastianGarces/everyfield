"use client";

import { BookOpen02Icon, MessageEdit01Icon, Settings02Icon } from "@hugeicons/core-free-icons";
import { DASHBOARD_HOME, LANDING_ROUTE, ORGANIZATION_HOME } from "@everyfield/contracts/identity";
import { toast, Toaster } from "@everyfield/ui/controls";
import { initials } from "@everyfield/ui/display";
import { AppShell, RoleBanner, type ShellNav } from "@everyfield/ui/shell";
import { usePathname } from "next/navigation";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useEvryPanel } from "../evry/conversation/panel.tsx";
import { FeedbackOverlay, whenFeedbackLoaded } from "../feedback/FeedbackOverlay.tsx";
import { OwnSeatContext } from "../identity/seat-context.ts";
import { evryOff } from "../intelligence/path.ts";
import { useNotificationBell } from "../notifications/Bell.tsx";
import { NotificationsProvider } from "../notifications/feed.tsx";
import { AccountMenu } from "../settings/AccountMenu";
import { firstSection } from "../settings/model";
import { SettingsOpenerContext } from "../settings/opener";
import { shellNav } from "./nav.ts";
import { ResidencyContext, useResidency, type ResidencyState } from "../residency/context.ts";
import type { SectionSeed, SettingsViewer } from "../settings/port";
import { useProductSettings } from "../settings/ProductSettings";
import type { Role } from "../people/server.ts";
import { useWikiChrome, WikiChrome } from "../wiki/chrome.tsx";

const ROLE: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };

type FrameProps = {
	name: string;
	photo?: string;
	settings: SettingsViewer | null;
	seed?: SectionSeed | null;
	residency?: { organizationName: string } | null;
	children: ReactNode;
};

export function ProductFrame({ settings: initial, seed, residency = null, ...props }: FrameProps) {
	const [left, setLeft] = useState<{ from: typeof residency } | null>(null);
	const ended = left !== null && left.from === residency;
	const residencyState = useMemo<ResidencyState>(
		() => ({ linked: residency !== null && !ended, ended, left: () => setLeft({ from: residency }) }),
		[residency, ended],
	);
	const [own, setOwn] = useState({ from: initial, settings: initial });
	const settings = own.from === initial ? own.settings : initial;
	const change = useCallback(
		(role: Role | null) =>
			setOwn(() => ({
				from: initial,
				settings:
					!settings || settings.context === "account"
						? settings
						: role === null
							? { context: "account", accountId: settings.accountId }
							: { ...settings, role },
			})),
		[initial, settings],
	);
	return (
		<>
			<Toaster />
			<OwnSeatContext value={change}>
				<ResidencyContext value={residencyState}>
					<NotificationsProvider account={initial?.accountId ?? ""}>
						<WikiChrome>
							<Frame {...props} settings={settings} seed={settings === initial ? seed : null} />
						</WikiChrome>
					</NotificationsProvider>
				</ResidencyContext>
			</OwnSeatContext>
		</>
	);
}

function Frame({ name, photo, settings, seed = null, children }: FrameProps) {
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
		onSelect: () => {
			whenFeedbackLoaded(() => setFeedback(true));
		},
	} as const;
	const organization = settings?.context === "organization";
	const rail = shellNav(
		organization
			? { context: "organization" }
			: settings?.context === "plant"
				? { context: "plant", role: settings.role }
				: settings
					? { context: "account", residencyLinked: linked }
					: { context: "pending" },
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
		pages: rail.pages.map((p) => (p.key === "notifications" ? { ...p, onNavigate: bell.refresh } : p)),
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
			onAskEvry={privatePage ? undefined : evry.toggle}
			askEvryOpen={privatePage ? undefined : evry.open}
			askEvryShortcut="Meta+J Control+J"
			banner={banner}
		>
			<SettingsOpenerContext value={dialog.open}>{children}</SettingsOpenerContext>
			{dialog.element}
			{evry.element}
			{bell.element}
			<FeedbackOverlay open={feedback} onOpenChange={setFeedback} name={name} />
		</AppShell>
	);
}
