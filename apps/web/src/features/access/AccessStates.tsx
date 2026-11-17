"use client";

import { invalidSessionReturn } from "@everyfield/contracts/identity";
import { Button, StatePanel } from "@everyfield/ui/controls";
import { AuthFooter, AuthFrame, AuthHeading, AuthLink } from "../identity/AuthFrame";
import { SessionActions } from "../identity/SessionActions";
import { AFTER_SIGN_IN } from "../identity/SignInScreen";

export function NotAvailable({
	scope,
	homeHref,
	headingLevel,
}: {
	scope: "page" | "section";
	homeHref?: string;
	headingLevel?: "h1" | "h2" | "h3";
}) {
	if (scope === "section")
		return (
			<StatePanel tone="lock" title="This is not available" headingLevel={headingLevel ?? "h3"} className="py-10">
				It may have been removed, or your account cannot open it.
			</StatePanel>
		);
	return (
		<StatePanel
			tone="lock"
			title="This page is not available"
			headingLevel={headingLevel ?? "h1"}
			actions={
				<>
					{homeHref ? (
						<Button asChild variant="primary">
							<a href={homeHref}>Go to home</a>
						</Button>
					) : null}
					<Button asChild variant="ghost">
						<a href="/signin">Sign in with another account</a>
					</Button>
				</>
			}
		>
			It may have moved or been removed, or your account cannot open it. Nothing was changed.
		</StatePanel>
	);
}

export function SessionEnded({ returnTo }: { returnTo: string | null }) {
	return (
		<AuthFrame>
			<AuthHeading title="Your session ended">
				You are signed out on this device. Sign in again to continue where you were.
			</AuthHeading>
			<Button asChild variant="primary" className="mt-6 w-full">
				<a href={invalidSessionReturn(returnTo)}>Sign in again</a>
			</Button>
			<AuthFooter>
				Forgot your password? <AuthLink href="/recover-password">Reset it</AuthLink>
			</AuthFooter>
		</AuthFrame>
	);
}

export function PendingAccount() {
	return (
		<AuthFrame>
			<AuthHeading title="Finish setting up">
				Your account is ready. Set up your church before you open church pages.
			</AuthHeading>
			<Button asChild variant="primary" className="mt-6 w-full">
				<a href={AFTER_SIGN_IN}>Set up your church</a>
			</Button>
			<SessionActions className="mt-6" />
		</AuthFrame>
	);
}
