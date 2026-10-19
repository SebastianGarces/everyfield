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
import { AppShell, type ShellNav } from "@everyfield/ui/shell";
import { useState, type ReactNode } from "react";
import { SessionActions } from "../identity/SessionActions";
import { AccountMenu } from "../settings/AccountMenu";
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

type FrameProps = { name: string; role: Role | null; banner?: ReactNode; children: ReactNode };

export function PeopleFrame(props: FrameProps) {
	return (
		<ToastProvider>
			<Frame {...props} />
		</ToastProvider>
	);
}

function Frame({ name, role, banner, children }: FrameProps) {
	const toast = useToast();
	const [account, setAccount] = useState(false);
	const later = (what: string) => () => toast({ message: `${what} is not available yet.`, tone: "info" });
	const seat = role ? `${ROLE[role]} seat` : "";
	return (
		<AppShell
			nav={NAV}
			user={{ name, initials: initials(name), detail: role ? ROLE[role] : "" }}
			userMenu={<AccountMenu name={name} detail={seat} onAccount={() => setAccount(true)} />}
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
			<Dialog open={account} onOpenChange={setAccount}>
				<DialogContent size="sm">
					<DialogHeader title="Your account" description={seat ? `${name}, ${seat}` : name} />
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
