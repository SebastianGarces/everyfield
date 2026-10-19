"use client";

import { UserMultipleIcon } from "@hugeicons/core-free-icons";
import {
	Button,
	Dialog,
	DialogBody,
	DialogContent,
	DialogHeader,
	ToastProvider,
	useToast,
} from "@everyfield/ui/controls";
import { initials } from "@everyfield/ui/display";
import { AppShell, RoleBanner, type ShellNav } from "@everyfield/ui/shell";
import { useState, type ReactNode } from "react";
import { SessionActions } from "../identity/SessionActions";
import type { Role } from "./server.ts";

// The product frame around the People screens. Only destinations that exist are in the navigation; the full product
// navigation, command palette, notifications and Evry come from their own packages and replace these when they ship.

const NAV: ShellNav = {
	main: [{ kind: "link", key: "people", label: "People", href: "/people", icon: UserMultipleIcon }],
	pages: [],
	tools: [],
};
const ROLE: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };

export function PeopleFrame({ name, role, children }: { name: string; role: Role | null; children: ReactNode }) {
	return (
		<ToastProvider>
			<Frame name={name} role={role}>
				{children}
			</Frame>
		</ToastProvider>
	);
}

function Frame({ name, role, children }: { name: string; role: Role | null; children: ReactNode }) {
	const toast = useToast();
	const [account, setAccount] = useState(false);
	const later = (what: string) => () => toast({ message: `${what} is not available yet.`, tone: "info" });
	return (
		<AppShell
			nav={NAV}
			user={{ name, initials: initials(name), detail: role ? ROLE[role] : "" }}
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
			onUserMenu={() => setAccount(true)}
			banner={
				role === "member" ? (
					<RoleBanner>
						You have a Member seat. You can see people and their history; Owners and Admins change them.
					</RoleBanner>
				) : null
			}
		>
			{children}
			<Dialog open={account} onOpenChange={setAccount}>
				<DialogContent size="sm">
					<DialogHeader title={name} description={role ? `${ROLE[role]} seat` : undefined} />
					<DialogBody>
						<SessionActions />
						<Button variant="ghost" className="mt-3 self-start" onClick={() => setAccount(false)}>
							Close
						</Button>
					</DialogBody>
				</DialogContent>
			</Dialog>
		</AppShell>
	);
}
