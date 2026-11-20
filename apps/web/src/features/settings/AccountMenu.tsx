"use client";

import {
	LockKeyIcon,
	Logout01Icon,
	MessageEdit01Icon,
	ShieldUserIcon,
	UserIcon,
	UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import { MenuItem, MenuLabel, MenuSeparator, toast } from "@everyfield/ui/controls";
import { leavePage } from "../../components/save/leave.ts";
import { identityApi, loadPage } from "../identity/api";
import { SECTION_LABEL } from "./model";

export function AccountMenu({
	name,
	detail,
	onAccount,
	checkIn = false,
}: {
	name: string;
	detail: string;
	onAccount: () => void;
	checkIn?: boolean;
}) {
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
			<MenuItem icon={MessageEdit01Icon} href="/feedback">
				Sent feedback
			</MenuItem>
			<MenuItem icon={UserMultipleIcon} href="/settings/seats">
				{SECTION_LABEL.seats}
			</MenuItem>
			<MenuItem icon={ShieldUserIcon} href="/settings/sharing">
				{SECTION_LABEL.sharing}
			</MenuItem>
			{checkIn ? (
				<>
					<MenuSeparator />
					<MenuItem icon={LockKeyIcon} href="/me/check-in">
						My weekly check-in
						<span className="ml-2 rounded-sm bg-violet-100 px-1.5 text-xs font-semibold text-violet-600">Private</span>
					</MenuItem>
				</>
			) : null}
			<MenuSeparator />
			<MenuItem icon={Logout01Icon} danger onSelect={() => leavePage(() => void signOut())}>
				Sign out
			</MenuItem>
		</>
	);
}
