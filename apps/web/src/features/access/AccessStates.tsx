"use client";

import type { CurrentActorResult } from "@everyfield/contracts/access";
import { invalidSessionReturn } from "@everyfield/contracts/identity";
import { Button, StatePanel } from "@everyfield/ui/controls";
import type { ReactNode } from "react";
import { AuthFooter, AuthFrame, AuthHeading, AuthLink } from "../identity/AuthFrame";
import { SessionActions } from "../identity/SessionActions";
import { AFTER_SIGN_IN } from "../identity/SignInScreen";

/**
 * The one refusal state (REQ-IDN-005, WP-006/ui R2). A record that does not exist, a record in another church or
 * organization, and a record this account may not open all show these same words, so the screen never confirms
 * that something hidden exists or says which rule refused it.
 */
export function NotAvailable({
	scope,
	homeHref,
	headingLevel,
}: {
	/** `page` replaces the whole page; `section` replaces one panel inside a page the person can open. */
	scope: "page" | "section";
	/** Where "Go to home" leads. Pages only. */
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

/**
 * Session recovery (REQ-IDN-028). A missing, expired or revoked session gets the bare sign-in frame with no church
 * content. The return path goes through `safeReturn`, so only a local path survives (WP-006/ui R3).
 */
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

/**
 * A signed-in account whose registration is not finished (`pending_domain`) has no church or organization
 * authority (REQ-IDN-030). It can only continue setup or sign out (WP-006/ui R4).
 */
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

type ActiveActor = Extract<CurrentActorResult, { status: "active" }>;

/**
 * Picks the screen for the server's current-actor result (access.currentActor). Only an active actor reaches the
 * page; what that actor may open is still each operation's own server check.
 */
export function ActorGate({
	actor,
	returnTo,
	children,
}: {
	actor: CurrentActorResult;
	returnTo: string | null;
	children: (actor: ActiveActor) => ReactNode;
}) {
	switch (actor.status) {
		case "unavailable":
			return <SessionEnded returnTo={returnTo} />;
		case "pending_domain":
			return <PendingAccount />;
		case "active":
			return children(actor);
	}
}
