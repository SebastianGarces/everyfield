"use client";

import { Mail01Icon } from "@hugeicons/core-free-icons";
import { Button, Card, CardIcon } from "@everyfield/ui/controls";
import { LogoMark } from "@everyfield/ui/foundations";
import { useState, useTransition } from "react";
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

export function ConfirmEmailScreen({
	proof,
	confirm,
	accountHref,
}: {
	proof: string | null;
	confirm: (request: { proof: string }) => Promise<CredentialOutcome>;
	accountHref: string;
}) {
	const [outcome, setOutcome] = useState<CredentialOutcome["status"] | null>(proof ? null : "refused");
	const [pending, startConfirm] = useTransition();

	const run = () => {
		if (pending || outcome || !proof) return;
		startConfirm(async () => {
			const status = await confirm({ proof }).then(
				(reply) => reply.status,
				(): CredentialOutcome["status"] => "unknown",
			);
			setOutcome(status);
		});
	};

	const text = outcome ? TEXT[outcome] : null;
	return (
		<main id="main" className="grid min-h-dvh place-items-center bg-frame px-4 py-10">
			<div className="w-full max-w-[480px]">
				<LogoMark className="mb-6 size-9 text-ink" />
				<Card className="flex flex-col gap-4 text-text-2">
					<CardIcon icon={Mail01Icon} tone={outcome === "succeeded" ? "green" : outcome ? "magenta" : "blue"} />
					<h1
						aria-live="polite"
						className="font-title text-title-md leading-[1.2] tracking-[-0.02em] text-ink text-balance"
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
