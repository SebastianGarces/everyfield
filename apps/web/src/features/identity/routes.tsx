import { landingFor, safeReturn } from "@everyfield/contracts/identity";
import { dashboardReader } from "@everyfield/domain/dashboard";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import { AuthFrame } from "./AuthFrame";
import { InvitationScreen } from "./invitation/InvitationScreen";
import { RecoverScreen, ResetPasswordScreen, VerifyEmailScreen } from "./RecoveryScreens";
import { RegisterScreen } from "./RegisterScreen";
import { SignInScreen } from "./SignInScreen";

type Search = Promise<Record<string, string | string[] | undefined>>;
const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : null);

export function IdentityLayout({ children }: { children: ReactNode }) {
	return <AuthFrame>{children}</AuthFrame>;
}

export const signInMetadata: Metadata = { title: "Sign in" };
export async function SignInPage({ searchParams }: { searchParams: Search }) {
	const [search, viewer] = await Promise.all([searchParams, getViewer()]);
	const signedIn = viewer && viewer.status !== "unauthenticated" ? viewer.status : null;
	return <SignInScreen returnTo={safeReturn(one(search.returnTo))} signedIn={signedIn} />;
}

export const homeMetadata: Metadata = { title: "Home", robots: { index: false, follow: false } };
export async function HomePage({ searchParams }: { searchParams: Search }) {
	const returnTo = one((await searchParams).returnTo);
	const viewer = await getViewer();
	if (!viewer || viewer.status === "unauthenticated") redirect("/signin");
	const db = requestDatabase();
	const plant =
		viewer.status === "active" && db ? await dashboardReader.resolveHome(db, viewer.authority ?? null) : "none";
	redirect(landingFor({ status: viewer.status, plant, returnTo }));
}

export const registerMetadata: Metadata = { title: "Create your account" };
export function RegisterPage() {
	return <RegisterScreen />;
}

export const recoverMetadata: Metadata = { title: "Reset your password" };
export function RecoverPage() {
	return <RecoverScreen />;
}

const proofPage: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };

export const resetMetadata: Metadata = { title: "Choose a new password", ...proofPage };
export async function ResetPasswordPage({ searchParams }: { searchParams: Search }) {
	return <ResetPasswordScreen proof={one((await searchParams).token)} />;
}

export const verifyMetadata: Metadata = { title: "Confirm your email", ...proofPage };
export async function VerifyEmailPage({ searchParams }: { searchParams: Search }) {
	return <VerifyEmailScreen proof={one((await searchParams).token)} />;
}

export const invitationMetadata: Metadata = { title: "Your invitation", ...proofPage };
export function InvitationPage() {
	return <InvitationScreen />;
}
