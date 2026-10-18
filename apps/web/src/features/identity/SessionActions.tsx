"use client";

import { LaptopPhoneSyncIcon, Logout01Icon } from "@hugeicons/core-free-icons";
import { invalidSessionReturn } from "@everyfield/contracts/identity";
import { Button } from "@everyfield/ui/controls";
import { useState } from "react";
import { identityApi, loadPage } from "./api";
import { refusalMessage } from "./messages";
import { FormMessage } from "./parts";

type Busy = "sign_out" | "others" | null;

/**
 * Sign out, and sign out every other device (auth.signOut, auth.revokeOtherSessions). Settings > Your account
 * (WP-010) and the signed-in sign-in screen compose it. Both act on the current cookie session only; the server picks
 * the session, never this component.
 */
export function SessionActions({ className }: { className?: string }) {
	const [busy, setBusy] = useState<Busy>(null);
	const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);

	async function signOut() {
		setBusy("sign_out");
		setMessage(null);
		const result = await identityApi.signOut();
		if (result.ok) {
			loadPage("/signin");
			return;
		}
		setBusy(null);
		setMessage({ tone: "error", text: "Unable to sign out. Check your connection and try again." });
	}

	async function signOutOthers() {
		setBusy("others");
		setMessage(null);
		const result = await identityApi.revokeOtherSessions();
		setBusy(null);
		if (result.ok) {
			setMessage({ tone: "success", text: "Your other devices are signed out." });
			return;
		}
		// This session ended meanwhile (expired or revoked elsewhere): go to sign-in and come back here after.
		if (result.error.code === "unauthenticated") {
			loadPage(invalidSessionReturn(window.location.pathname + window.location.search));
			return;
		}
		setMessage({ tone: "error", text: refusalMessage("session", result.error) });
	}

	return (
		<div className={className}>
			<div className="flex flex-wrap gap-3">
				<Button variant="secondary" icon={Logout01Icon} loading={busy === "sign_out"} onClick={signOut}>
					Sign out
				</Button>
				<Button variant="ghost" icon={LaptopPhoneSyncIcon} loading={busy === "others"} onClick={signOutOthers}>
					Sign out other devices
				</Button>
			</div>
			<div className="has-[p]:mt-4">
				<FormMessage tone="error">{message?.tone === "error" ? message.text : null}</FormMessage>
				<FormMessage tone="success">{message?.tone === "success" ? message.text : null}</FormMessage>
			</div>
		</div>
	);
}
