"use client";

import { Mail01Icon } from "@hugeicons/core-free-icons";
import {
	LANDING_ROUTE,
	ONBOARDING_HOME,
	normalizedEmail,
	safeReturn,
	type SessionResult,
} from "@everyfield/contracts/identity";
import { Button, Field, Input } from "@everyfield/ui/controls";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { identityApi, loadPage } from "./api";
import { AuthFooter, AuthHeading, AuthLink } from "./AuthFrame";
import { refusalMessage } from "./messages";
import { FormMessage, PasswordInput } from "./parts";
import { SessionActions } from "./SessionActions";

/**
 * A sign-in without a return path lands on the landing route, which decides on the server (landingFor). When Overview
 * (WP-048) ships, the dashboard home moves in DASHBOARD_HOME in packages/contracts/src/identity/navigation.ts, nowhere else.
 */
export const AFTER_SIGN_IN = LANDING_ROUTE;

type SignedIn = Exclude<SessionResult, { status: "unauthenticated" }>;

/** Sign in (#/signin). A visitor who already has a session sees the signed-in state instead of the form. */
export function SignInScreen({ returnTo }: { returnTo: string | null }) {
	const [session, setSession] = useState<SignedIn | null>(null);
	useEffect(() => {
		let live = true;
		void identityApi.session().then((result) => {
			if (live && result.ok && result.value.status !== "unauthenticated") setSession(result.value);
		});
		return () => {
			live = false;
		};
	}, []);
	if (session) return <SignedInState session={session} returnTo={returnTo} />;
	return (
		<>
			<AuthHeading title="Welcome back">{returnTo ? "Sign in to continue." : "Sign in to your church."}</AuthHeading>
			<SignInForm returnTo={returnTo} />
			<AuthFooter>
				New to Everyfield? <AuthLink href="/register">Start your church</AuthLink>
			</AuthFooter>
		</>
	);
}

function SignedInState({ session, returnTo }: { session: SignedIn; returnTo: string | null }) {
	const pending = session.status === "pending_domain";
	return (
		<>
			<AuthHeading title="You’re signed in">
				{pending
					? "Your account is ready. Setting up your church comes next."
					: "Continue where you left off, or sign out."}
			</AuthHeading>
			<Button asChild variant="primary" className="mt-6 w-full">
				<a href={pending ? ONBOARDING_HOME : (returnTo ?? AFTER_SIGN_IN)}>
					{pending ? "Set up your church" : "Continue"}
				</a>
			</Button>
			<SessionActions className="mt-6" />
		</>
	);
}

type Errors = { email?: string; password?: string };

export function SignInForm({
	returnTo,
	initialEmail = "",
	submitLabel = "Sign in",
}: {
	returnTo: string | null;
	initialEmail?: string;
	submitLabel?: string;
}) {
	const [errors, setErrors] = useState<Errors>({});
	const [refusal, setRefusal] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const emailRef = useRef<HTMLInputElement>(null);
	const passwordRef = useRef<HTMLInputElement>(null);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busy) return;
		const data = new FormData(event.currentTarget);
		const email = normalizedEmail.safeParse(data.get("email"));
		const password = String(data.get("password") ?? "");
		const next: Errors = {
			email: email.success ? undefined : "Enter an email address, like name@church.org.",
			password: password ? undefined : "Enter your password.",
		};
		setErrors(next);
		setRefusal(null);
		if (!email.success || !password) {
			(next.email ? emailRef : passwordRef).current?.focus();
			return;
		}
		setBusy(true);
		const result = await identityApi.signIn({
			email: email.data,
			password,
			...(returnTo ? { returnTo } : {}),
		});
		if (result.ok) {
			// A full load, so every server component reads the new session cookie.
			loadPage(safeReturn(result.value.returnTo) ?? AFTER_SIGN_IN);
			return;
		}
		setBusy(false);
		setRefusal(refusalMessage("sign_in", result.error));
	}

	return (
		<form noValidate onSubmit={submit} className="mt-6 flex flex-col gap-4">
			<Field label="Email" error={errors.email}>
				<Input
					ref={emailRef}
					name="email"
					type="email"
					icon={Mail01Icon}
					autoComplete="email"
					inputMode="email"
					spellCheck={false}
					autoCapitalize="none"
					defaultValue={initialEmail}
				/>
			</Field>
			<div className="relative">
				<Field label="Password" error={errors.password}>
					<PasswordInput ref={passwordRef} name="password" autoComplete="current-password" />
				</Field>
				<Link
					href="/recover-password"
					className="absolute top-0 right-0 rounded-md text-sm text-blue-600 underline-offset-4 hover:underline"
				>
					Forgot password?
				</Link>
			</div>
			<FormMessage tone="error">{refusal}</FormMessage>
			<Button type="submit" variant="primary" loading={busy} className="w-full">
				{submitLabel}
			</Button>
		</form>
	);
}
