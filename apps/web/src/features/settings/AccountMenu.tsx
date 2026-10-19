"use client";

import { Logout01Icon, ShieldUserIcon, UserIcon, UserMultipleIcon } from "@hugeicons/core-free-icons";
import { MenuItem, MenuLabel, MenuSeparator, useToast } from "@everyfield/ui/controls";
import { useRouter } from "next/navigation";
import { identityApi, loadPage } from "../identity/api";
import { SECTION_LABEL } from "./model";

/**
 * The user menu (screens.md, Overlays: User menu): who you are, your account, the settings pages that exist, and
 * Sign out. The AppShell's name button opens it on every signed-in page. Seats and Sharing are offered to every seat:
 * Members read them and the pages themselves hide every change a Member may not make.
 */
export function AccountMenu({ name, detail, onAccount }: { name: string; detail: string; onAccount: () => void }) {
	const router = useRouter();
	const toast = useToast();

	async function signOut() {
		const result = await identityApi.signOut();
		if (result.ok) loadPage("/signin");
		else toast({ message: "Unable to sign out. Check your connection and try again.", tone: "error" });
	}

	return (
		<>
			<div className="px-2.5 pt-2 pb-2.5">
				<div className="truncate font-semibold text-ink">{name}</div>
				{detail ? <div className="truncate text-xs text-text-3">{detail}</div> : null}
			</div>
			<MenuSeparator />
			<MenuLabel>Settings</MenuLabel>
			<MenuItem icon={UserIcon} onSelect={onAccount}>
				{SECTION_LABEL.account}
			</MenuItem>
			<MenuItem icon={UserMultipleIcon} onSelect={() => router.push("/settings/seats")}>
				{SECTION_LABEL.seats}
			</MenuItem>
			<MenuItem icon={ShieldUserIcon} onSelect={() => router.push("/settings/sharing")}>
				{SECTION_LABEL.sharing}
			</MenuItem>
			<MenuSeparator />
			<MenuItem icon={Logout01Icon} danger onSelect={signOut}>
				Sign out
			</MenuItem>
		</>
	);
}
