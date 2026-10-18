"use client";

import { LockKeyIcon, Mail01Icon, UserIcon, WifiDisconnected01Icon } from "@hugeicons/core-free-icons";
import { accountKind, nativePassword, normalizedEmail, registrationOptions } from "@everyfield/contracts/identity";
import { Button, Field, Input, Radio, RadioGroup, Skeleton } from "@everyfield/ui/controls";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { z } from "zod";
import { identityApi, loadPage, type Refusal } from "./api";
import { AuthFooter, AuthHeading, AuthLink } from "./AuthFrame";
import { refusalMessage } from "./messages";
import { FormMessage, Outcome, PasswordInput } from "./parts";
import { AFTER_SIGN_IN, SignInForm } from "./SignInScreen";

type Kind = z.infer<typeof accountKind>;
type Options = z.infer<typeof registrationOptions>;

const KINDS: Record<Kind, { label: string; description: string; organization?: string }> = {
	plant_precreation: { label: "I’m planting a church", description: "Set up your plant, your people and the Playbook." },
	sending_church: {
		label: "We’re a sending church",
		description: "Walk with the plants your church sends.",
		organization: "Church name",
	},
	sending_network: {
		label: "We’re a network",
		description: "Support the planters in your network.",
		organization: "Network name",
	},
	discovery: { label: "I’m exploring", description: "Look around before you start a plant." },
};
const ORDER: Kind[] = ["plant_precreation", "sending_church", "sending_network", "discovery"];

type Loaded = { state: "loading" } | { state: "failed" } | { state: "ready"; options: Options };

/** Registration (accounts.getRegistrationOptions, accounts.register), then the native sign-in that resumes it. */
export function RegisterScreen() {
	const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
	const fetchOptions = useCallback(() => {
		void identityApi.registrationOptions().then((result) => {
			setLoaded(result.ok ? { state: "ready", options: result.value } : { state: "failed" });
		});
	}, []);
	useEffect(fetchOptions, [fetchOptions]);
	const retry = () => {
		setLoaded({ state: "loading" });
		fetchOptions();
	};

	if (loaded.state === "loading")
		return (
			<div aria-busy="true">
				<span className="sr-only" role="status">
					Loading sign-up
				</span>
				<Skeleton width="70%" height={38} />
				<Skeleton width="90%" className="mt-3" />
				<div className="mt-8 flex flex-col gap-4">
					{[0, 1, 2, 3].map((i) => (
						<Skeleton key={i} shape="block" height={44} />
					))}
				</div>
			</div>
		);
	if (loaded.state === "failed")
		return (
			<div role="alert">
				<Outcome
					icon={WifiDisconnected01Icon}
					tone="magenta"
					title="Sign-up did not load"
					actions={
						<Button variant="primary" onClick={retry} className="w-full">
							Try again
						</Button>
					}
				>
					Unable to reach Everyfield. Check your connection and try again.
				</Outcome>
			</div>
		);
	const { mode, kinds } = loaded.options;
	if (mode !== "open" || kinds.length === 0)
		return (
			<Outcome
				icon={LockKeyIcon}
				tone="violet"
				title={mode === "invitation_only" ? "Sign-up needs an invitation" : "Sign-up is closed"}
				actions={
					<Button asChild variant="primary" className="w-full">
						<a href="/signin">Sign in</a>
					</Button>
				}
			>
				{mode === "invitation_only"
					? "Ask your church or network for an invitation link. If you already have an account, sign in."
					: "New accounts are paused for now. If you already have an account, sign in."}
			</Outcome>
		);
	return <RegisterFlow kinds={ORDER.filter((k) => kinds.includes(k))} />;
}

type FieldName = "name" | "email" | "password" | "organizationName";
type Step = { step: "form" } | { step: "sign_in"; email: string; refusal: Refusal | null };

function RegisterFlow({ kinds }: { kinds: Kind[] }) {
	const [kind, setKind] = useState<Kind>(kinds[0] ?? "plant_precreation");
	const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
	const [refusal, setRefusal] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [step, setStep] = useState<Step>({ step: "form" });
	// One key for this form, so a resubmit after a lost response is the same request.
	const [requestKey] = useState(() => crypto.randomUUID());
	const nameRef = useRef<HTMLInputElement>(null);
	const emailRef = useRef<HTMLInputElement>(null);
	const passwordRef = useRef<HTMLInputElement>(null);
	const organizationRef = useRef<HTMLInputElement>(null);
	const organization = KINDS[kind].organization;
	const kindLabel = useId();

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busy) return;
		const data = new FormData(event.currentTarget);
		const name = String(data.get("name") ?? "").trim();
		const organizationName = String(data.get("organizationName") ?? "").trim();
		const email = normalizedEmail.safeParse(data.get("email"));
		const password = String(data.get("password") ?? "");
		const next: Partial<Record<FieldName, string>> = {
			name: name ? undefined : "Enter your name.",
			organizationName:
				organization && !organizationName ? `Enter the ${organization.toLowerCase()}.` : undefined,
			email: email.success ? undefined : "Enter an email address, like name@church.org.",
			password: nativePassword.safeParse(password).success
				? undefined
				: password.length > 1024
					? "Use 1,024 characters or fewer."
					: "Use at least 8 characters.",
		};
		setErrors(next);
		setRefusal(null);
		const first = (["name", "organizationName", "email", "password"] as const).find((f) => next[f]);
		if (first || !email.success) {
			const target = { name: nameRef, organizationName: organizationRef, email: emailRef, password: passwordRef };
			target[first ?? "email"].current?.focus();
			return;
		}
		setBusy(true);
		const registered = await identityApi.register({
			kind,
			name,
			email: email.data,
			password,
			requestKey,
			...(organization ? { organizationName } : {}),
		});
		if (!registered.ok) {
			setBusy(false);
			setRefusal(refusalMessage("register", registered.error));
			return;
		}
		// Every accepted registration answers "continue_identity_proof", whether or not the email already had an
		// account. Signing in with the password just typed is the proof that resumes it (REQ-IDN-030).
		const signedIn = await identityApi.signIn({ email: email.data, password });
		if (signedIn.ok) {
			loadPage(AFTER_SIGN_IN);
			return;
		}
		setBusy(false);
		const quiet = signedIn.error.code === "invalid_credentials" || signedIn.error.code === "unauthenticated";
		setStep({ step: "sign_in", email: email.data, refusal: quiet ? null : signedIn.error });
	}

	if (step.step === "sign_in")
		return (
			<>
				<AuthHeading title="Sign in to continue">
					Enter the password for {step.email} to finish. If you forgot it, reset it from the link below.
				</AuthHeading>
				{step.refusal ? (
					<div className="mt-6">
						<FormMessage tone="error">{refusalMessage("sign_in", step.refusal)}</FormMessage>
					</div>
				) : null}
				<SignInForm returnTo={null} initialEmail={step.email} submitLabel="Sign in and continue" />
			</>
		);

	return (
		<>
			<AuthHeading title="Create your account">Start your church, or join as a sending church or network.</AuthHeading>
			<form noValidate onSubmit={submit} className="mt-6 flex flex-col gap-4">
				<div className="min-w-0">
					<p id={kindLabel} className="text-sm font-medium text-ink-2">
						Who is signing up?
					</p>
					<RadioGroup
						value={kind}
						onValueChange={(value) => setKind(accountKind.parse(value))}
						className="mt-1 gap-0"
						aria-labelledby={kindLabel}
					>
						{kinds.map((k) => (
							<Radio key={k} value={k} label={KINDS[k].label} description={KINDS[k].description} />
						))}
					</RadioGroup>
				</div>
				<Field label="Your name" error={errors.name}>
					<Input ref={nameRef} name="name" icon={UserIcon} autoComplete="name" maxLength={200} />
				</Field>
				{organization ? (
					<Field label={organization} error={errors.organizationName}>
						<Input
							ref={organizationRef}
							name="organizationName"
							autoComplete="organization"
							maxLength={200}
						/>
					</Field>
				) : null}
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
					/>
				</Field>
				<Field label="Password" hint="At least 8 characters." error={errors.password}>
					<PasswordInput ref={passwordRef} name="password" autoComplete="new-password" />
				</Field>
				<FormMessage tone="error">{refusal}</FormMessage>
				<Button type="submit" variant="primary" loading={busy} className="w-full">
					Create account
				</Button>
			</form>
			<AuthFooter>
				Already use Everyfield? <AuthLink href="/signin">Sign in</AuthLink>
			</AuthFooter>
		</>
	);
}
