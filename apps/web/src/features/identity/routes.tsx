import { safeReturn } from "@everyfield/contracts/identity";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AuthFrame } from "./AuthFrame";
import { InvitationScreen } from "./invitation/InvitationScreen";
import { RecoverScreen, ResetPasswordScreen, VerifyEmailScreen } from "./RecoveryScreens";
import { RegisterScreen } from "./RegisterScreen";
import { SignInScreen } from "./SignInScreen";

// The identity routes. The files under apps/web/src/app/(product)/(identity)/ only re-export these, so the screens, their
// metadata and their query parsing stay in this feature folder.

type Search = Promise<Record<string, string | string[] | undefined>>;
const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : null);

/** Bare pages (screens.md): no top bar or rail. */
export function IdentityLayout({ children }: { children: ReactNode }) {
	return <AuthFrame>{children}</AuthFrame>;
}

export const signInMetadata: Metadata = { title: "Sign in" };
export async function SignInPage({ searchParams }: { searchParams: Search }) {
	// Only a safe local path survives (REQ-IDN-028); anything else signs in to the default place.
	return <SignInScreen returnTo={safeReturn(one((await searchParams).returnTo))} />;
}

export const registerMetadata: Metadata = { title: "Create your account" };
export function RegisterPage() {
	return <RegisterScreen />;
}

export const recoverMetadata: Metadata = { title: "Reset your password" };
export function RecoverPage() {
	return <RecoverScreen />;
}

// Links that carry a proof are never indexed and never send the proof on in a Referer header.
const proofPage: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };

export const resetMetadata: Metadata = { title: "Choose a new password", ...proofPage };
export async function ResetPasswordPage({ searchParams }: { searchParams: Search }) {
	return <ResetPasswordScreen proof={one((await searchParams).token)} />;
}

export const verifyMetadata: Metadata = { title: "Confirm your email", ...proofPage };
export async function VerifyEmailPage({ searchParams }: { searchParams: Search }) {
	return <VerifyEmailScreen proof={one((await searchParams).token)} />;
}

// The seat and residency invitation link (/invitation#proof=..., built by the WP-008 domain, ruling D54). The proof is in
// the fragment, which the browser never sends; the page reads it, keeps it in this tab and cleans the address.
export const invitationMetadata: Metadata = { title: "Your invitation", ...proofPage };
export function InvitationPage() {
	return <InvitationScreen />;
}
