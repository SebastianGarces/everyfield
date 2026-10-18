"use client";

import {
	CheckmarkCircle02Icon,
	Mail01Icon,
	MailOpen01Icon,
	MailValidation01Icon,
	UnlinkIcon,
} from "@hugeicons/core-free-icons";
import { nativePassword, normalizedEmail } from "@everyfield/contracts/identity";
import { Button, Field, Input } from "@everyfield/ui/controls";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { identityApi } from "./api";
import { AuthFooter, AuthHeading, AuthLink } from "./AuthFrame";
import { refusalMessage } from "./messages";
import { FormMessage, Outcome, PasswordInput } from "./parts";

function SignInButton({ label = "Sign in" }: { label?: string }) {
	return (
		<Button asChild variant="primary" className="w-full">
			<a href="/signin">{label}</a>
		</Button>
	);
}

/**
 * A proof arrives in the link's query string. Keep it in memory and drop it from the address bar and history, so it
 * is not left in the browser history or shown on screen.
 */
function useProofFromLink(proof: string | null): string | null {
	const [kept] = useState(proof);
	useEffect(() => {
		if (kept) window.history.replaceState(null, "", window.location.pathname);
	}, [kept]);
	return kept;
}

function IncompleteLink({ action }: { action: ReactNode }) {
	return (
		<Outcome icon={UnlinkIcon} tone="amber" title="This link is incomplete" actions={action}>
			Open the link from your email again. If it still does not work, ask for a new one.
		</Outcome>
	);
}

/** Password recovery request (auth.requestPasswordRecovery). Every address gets the same answer (REQ-IDN-009). */
export function RecoverScreen() {
	const [sentTo, setSentTo] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [refusal, setRefusal] = useState<string | null>(null);
	const [resent, setResent] = useState(false);
	const [busy, setBusy] = useState(false);
	const emailRef = useRef<HTMLInputElement>(null);

	async function send(email: string) {
		setBusy(true);
		setRefusal(null);
		setResent(false);
		const result = await identityApi.requestPasswordRecovery(email);
		setBusy(false);
		if (!result.ok) {
			setRefusal(refusalMessage("recover", result.error));
			return;
		}
		if (sentTo) setResent(true);
		setSentTo(email);
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busy) return;
		const email = normalizedEmail.safeParse(new FormData(event.currentTarget).get("email"));
		setError(email.success ? null : "Enter an email address, like name@church.org.");
		if (!email.success) {
			emailRef.current?.focus();
			return;
		}
		await send(email.data);
	}

	if (sentTo)
		return (
			<Outcome
				icon={MailOpen01Icon}
				tone="blue"
				title="Check your email"
				actions={
					<>
						<FormMessage tone="error">{refusal}</FormMessage>
						<FormMessage tone="success">{resent ? "Another link is on its way." : null}</FormMessage>
						<SignInButton label="Back to sign in" />
						<Button variant="ghost" loading={busy} onClick={() => void send(sentTo)} className="w-full">
							Send another link
						</Button>
					</>
				}
			>
				If an account uses <span className="font-medium text-ink">{sentTo}</span>, it gets a link to reset the password.
				The link works once and expires after 1 hour.
			</Outcome>
		);

	return (
		<>
			<AuthHeading title="Reset your password">
				Enter the email you sign in with. You will get a link to choose a new password.
			</AuthHeading>
			<form noValidate onSubmit={submit} className="mt-6 flex flex-col gap-4">
				<Field label="Email" error={error}>
					<Input
						ref={emailRef}
						name="email"
						type="email"
						icon={Mail01Icon}
						autoComplete="email"
						inputMode="email"
						spellCheck={false}
						autoCapitalize="none"
					/>
				</Field>
				<FormMessage tone="error">{refusal}</FormMessage>
				<Button type="submit" variant="primary" loading={busy} className="w-full">
					Send reset link
				</Button>
			</form>
			<AuthFooter>
				Remembered it? <AuthLink href="/signin">Sign in</AuthLink>
			</AuthFooter>
		</>
	);
}

type ResetState = "form" | "done" | "expired";

/** Choose a new password from a reset link (auth.recoverPassword). It never signs in by itself (REQ-IDN-009). */
export function ResetPasswordScreen({ proof: linkProof }: { proof: string | null }) {
	const proof = useProofFromLink(linkProof);
	const [state, setState] = useState<ResetState>("form");
	const [errors, setErrors] = useState<{ newPassword?: string; confirmPassword?: string }>({});
	const [refusal, setRefusal] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const newRef = useRef<HTMLInputElement>(null);
	const confirmRef = useRef<HTMLInputElement>(null);

	if (!proof)
		return (
			<IncompleteLink
				action={
					<Button asChild variant="primary" className="w-full">
						<a href="/recover-password">Ask for a new link</a>
					</Button>
				}
			/>
		);

	if (state === "done")
		return (
			<Outcome icon={CheckmarkCircle02Icon} tone="green" title="Your password is reset" actions={<SignInButton />}>
				Sign in with your new password. Everyfield signed you out on every device.
			</Outcome>
		);

	if (state === "expired")
		return (
			<Outcome
				icon={UnlinkIcon}
				tone="amber"
				title="This link has expired"
				actions={
					<Button asChild variant="primary" className="w-full">
						<a href="/recover-password">Ask for a new link</a>
					</Button>
				}
			>
				A reset link works once and expires after 1 hour. Ask for a new one to choose a password.
			</Outcome>
		);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busy || !proof) return;
		const data = new FormData(event.currentTarget);
		const newPassword = String(data.get("newPassword") ?? "");
		const confirmPassword = String(data.get("confirmPassword") ?? "");
		const next = {
			newPassword: nativePassword.safeParse(newPassword).success
				? undefined
				: newPassword.length > 1024
					? "Use 1,024 characters or fewer."
					: "Use at least 8 characters.",
			confirmPassword:
				confirmPassword && confirmPassword === newPassword ? undefined : "Enter the same password again.",
		};
		setErrors(next);
		setRefusal(null);
		if (next.newPassword || next.confirmPassword) {
			(next.newPassword ? newRef : confirmRef).current?.focus();
			return;
		}
		setBusy(true);
		const result = await identityApi.recoverPassword({ proof, newPassword, confirmPassword });
		setBusy(false);
		if (result.ok) return setState("done");
		if (result.error.code === "invalid_proof") return setState("expired");
		if (result.error.code === "invalid_input") {
			setErrors({ newPassword: refusalMessage("reset", result.error) });
			newRef.current?.focus();
			return;
		}
		setRefusal(refusalMessage("reset", result.error));
	}

	return (
		<>
			<AuthHeading title="Choose a new password">
				After you save it, Everyfield signs you out on every device. Then sign in with the new password.
			</AuthHeading>
			<form noValidate onSubmit={submit} className="mt-6 flex flex-col gap-4">
				<Field label="New password" hint="At least 8 characters." error={errors.newPassword}>
					<PasswordInput ref={newRef} name="newPassword" autoComplete="new-password" />
				</Field>
				<Field label="Confirm new password" error={errors.confirmPassword}>
					<PasswordInput ref={confirmRef} name="confirmPassword" autoComplete="new-password" />
				</Field>
				<FormMessage tone="error">{refusal}</FormMessage>
				<Button type="submit" variant="primary" loading={busy} className="w-full">
					Reset password
				</Button>
			</form>
		</>
	);
}

type VerifyState = "ready" | "done" | "expired";

/**
 * Confirm an email address from its link. The proof is spent only when the person presses the button: mail scanners
 * open links on their own, and a GET must never use up the proof.
 */
export function VerifyEmailScreen({ proof: linkProof }: { proof: string | null }) {
	const proof = useProofFromLink(linkProof);
	const [state, setState] = useState<VerifyState>("ready");
	const [refusal, setRefusal] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	if (!proof) return <IncompleteLink action={<SignInButton />} />;
	if (state === "done")
		return (
			<Outcome icon={CheckmarkCircle02Icon} tone="green" title="Your email is confirmed" actions={<SignInButton />}>
				Thank you. Everyfield will use this address for sign-in and account email.
			</Outcome>
		);
	if (state === "expired")
		return (
			<Outcome icon={UnlinkIcon} tone="amber" title="This link has expired" actions={<SignInButton />}>
				A confirmation link works once and expires. Sign in to ask for a new one.
			</Outcome>
		);

	async function verify() {
		if (busy || !proof) return;
		setBusy(true);
		setRefusal(null);
		const result = await identityApi.verifyEmail(proof);
		setBusy(false);
		if (result.ok) return setState("done");
		if (result.error.code === "invalid_proof") return setState("expired");
		setRefusal(refusalMessage("session", result.error));
	}

	return (
		<Outcome
			icon={MailValidation01Icon}
			tone="blue"
			title="Confirm your email"
			actions={
				<>
					<FormMessage tone="error">{refusal}</FormMessage>
					<Button variant="primary" loading={busy} onClick={() => void verify()} className="w-full">
						Confirm email
					</Button>
				</>
			}
		>
			Confirm that this address belongs to you.
		</Outcome>
	);
}
