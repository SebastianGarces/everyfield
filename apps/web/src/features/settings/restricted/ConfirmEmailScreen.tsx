"use client";

import { Mail01Icon } from "@hugeicons/core-free-icons";
import { Button, Card, CardIcon } from "@everyfield/ui/controls";
import { LogoMark } from "@everyfield/ui/foundations";
import { useRef, useState } from "react";
import type { CredentialOutcome } from "../port";

const TEXT: Record<CredentialOutcome["status"], { title: string; body: string }> = {
	succeeded: {
		title: "Your sign-in email changed",
		body: "Sign in with the new address from now on. We sent a notice to your old address too.",
	},
	refused: {
		title: "This link does not work",
		body: "It may be more than 24 hours old, a newer link may have replaced it, or you are signed in to a different account. Ask for a new link in Your account.",
	},
	unknown: {
		title: "We could not confirm the change",
		body: "Open Your account to see which email you sign in with before you ask for a new link.",
	},
};

/**
 * The page the email-change link opens (REQ-IDN-007). It confirms only after a click, so a mail scanner that opens
 * links cannot use it, and it sends the proof once. Confirmation needs the account that asked for the change.
 */
export function ConfirmEmailScreen({
	proof,
	confirm,
	accountHref,
}: {
	proof: string;
	confirm: (request: { proof: string }) => Promise<CredentialOutcome>;
	accountHref: string;
}) {
	const [outcome, setOutcome] = useState<CredentialOutcome["status"] | null>(null);
	const [pending, setPending] = useState(false);
	const sent = useRef(false);

	const run = async () => {
		if (sent.current) return;
		sent.current = true;
		setPending(true);
		try {
			setOutcome((await confirm({ proof })).status);
		} catch {
			setOutcome("unknown");
		} finally {
			setPending(false);
		}
	};

	const text = outcome ? TEXT[outcome] : null;
	return (
		<main className="grid min-h-dvh place-items-center bg-frame px-4 py-10">
			<div className="w-full max-w-[480px]">
				<LogoMark className="mb-6 size-9 text-ink" />
				<Card className="flex flex-col gap-4 text-text-2">
					<CardIcon icon={Mail01Icon} tone={outcome === "succeeded" ? "green" : outcome ? "magenta" : "blue"} />
					<h1
						aria-live="polite"
						className="font-display text-title-md leading-[1.2] font-medium tracking-[-0.02em] text-ink text-balance"
					>
						{text?.title ?? "Confirm your new email"}
					</h1>
					<p>{text?.body ?? "Confirm that you want to sign in with this address from now on."}</p>
					<div>
						{outcome ? (
							<Button asChild variant="secondary">
								<a href={accountHref}>Open Your account</a>
							</Button>
						) : (
							<Button variant="primary" onClick={run} loading={pending}>
								Confirm new email
							</Button>
						)}
					</div>
				</Card>
			</div>
		</main>
	);
}
