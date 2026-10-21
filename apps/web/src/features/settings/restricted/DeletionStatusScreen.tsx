"use client";

import {
	Alert02Icon,
	Calendar03Icon,
	CheckmarkCircle02Icon,
	Delete02Icon,
	Time04Icon,
} from "@hugeicons/core-free-icons";
import { normalizedEmail } from "@everyfield/contracts/identity";
import { Button, Card, CardIcon, Field, Input, Skeleton } from "@everyfield/ui/controls";
import { LogoMark } from "@everyfield/ui/foundations";
import { Suspense, use, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { FormMessage, PasswordInput } from "../../identity/parts";
import { OUT_OF_REACH } from "../flows/DeletionDialogs";
import type { DeletionPort, DeletionStatus, Reply } from "../port";
import { refusalOf, type Refusal } from "../save";
import { SaveError } from "../SettingsDialog";
import { formatMoment } from "../time";

type Subject = { kind: "account" } | { kind: "workspace"; churchName: string };

type View = { step: "proof" } | { step: "status"; status: DeletionStatus } | { step: "error"; refusal: Refusal };

/** No restricted session (or an expired one) asks for proof; any other refusal is a loading problem. */
function viewOf(reply: Reply<DeletionStatus>): View {
	if (reply.status === "ok") return { step: "status", status: reply.value };
	return reply.error.code === "proof_invalid" ? { step: "proof" } : { step: "error", refusal: refusalOf(reply.error) };
}

const OFFLINE: Refusal = {
	message: "Everyfield could not be reached. Check your connection and try again.",
	reference: "EF-OFFLINE",
	code: "unknown",
};

/** The browser's own time zone for the dates on this page; UTC while the server renders it. */
export function useBrowserZone(): string {
	return useSyncExternalStore(
		() => () => {},
		() => Intl.DateTimeFormat().resolvedOptions().timeZone,
		() => "UTC",
	);
}

type Props = {
	subject: Subject;
	port: DeletionPort;
	/** The status read the page started with, or null when no restricted session can exist yet. */
	initial: Promise<Reply<DeletionStatus>> | null;
	/** The deadline the deletion request returned, when this page opens right after it. */
	requestedUntil?: string | null;
	/** The current time, passed in so the deadline check is testable and never reads the host clock here. */
	now: () => number;
	/** The zone to show dates in. */
	zone: string;
	signInHref: string;
};

/**
 * The restricted deletion page (REQ-IDN-032, REQ-KNOW-067). After a deletion request every normal session has ended.
 * The email and password of the original login open only this: the status of one exact request and its
 * cancellation. It has no settings, navigation or church content. Cancel shows only before the deadline; the server
 * still refuses at or after it, even when the deletion has not started yet.
 */
export function DeletionStatusScreen(props: Props) {
	return (
		<main id="main" className="grid min-h-dvh place-items-center bg-frame px-4 py-10">
			<div className="w-full max-w-[520px]">
				<LogoMark className="mb-6 size-9 text-ink" />
				<Card className="flex flex-col gap-4">
					<Suspense fallback={<Loading />}>
						<Deletion {...props} />
					</Suspense>
				</Card>
			</div>
		</main>
	);
}

function Loading() {
	return (
		<div aria-busy="true" className="flex flex-col gap-4">
			<span className="sr-only" role="status">
				Loading deletion status
			</span>
			<Skeleton shape="block" height={40} />
			<Skeleton shape="line" />
			<Skeleton shape="line" width="70%" />
		</div>
	);
}

function Deletion({ subject, port, initial, requestedUntil = null, now, zone, signInHref }: Props) {
	const first = initial ? use(initial) : null;
	const [view, setShown] = useState<View>(() => (first ? viewOf(first) : { step: "proof" }));
	// A view that replaces the one in use moves focus to its heading, so the button that was pressed is not lost.
	const moved = useRef(false);
	const setView = (next: View) => {
		moved.current = true;
		setShown(next);
	};
	const heading = (el: HTMLHeadingElement | null) => {
		if (el && moved.current) {
			moved.current = false;
			el.focus();
		}
	};
	const [loading, setLoading] = useState(false);
	const [cancelError, setCancelError] = useState<Refusal | null>(null);
	const [cancelling, setCancelling] = useState(false);

	const load = async () => {
		setLoading(true);
		try {
			setView(viewOf(await port.getStatus()));
		} catch {
			setView({ step: "error", refusal: OFFLINE });
		} finally {
			setLoading(false);
		}
	};

	const cancel = async () => {
		if (view.step !== "status" || view.status.status !== "pending_deletion" || cancelling) return;
		setCancelling(true);
		setCancelError(null);
		try {
			const reply = await port.cancel(view.status.revision);
			if (reply.status === "ok") return setView({ step: "status", status: reply.value });
			setCancelError(refusalOf(reply.error));
			if (reply.error.code === "deadline_passed" || reply.error.code === "conflict") await load();
		} catch {
			// The cancellation may have happened. The status, read again, says whether it did.
			setCancelError({
				...OFFLINE,
				message: "We could not confirm that the deletion was cancelled. The status below is the latest we have.",
			});
			await load();
		} finally {
			setCancelling(false);
		}
	};

	const what = subject.kind === "account" ? "Your account" : subject.churchName;

	switch (view.step) {
		case "proof":
			return (
				<Proof
					port={port}
					requestedUntil={requestedUntil}
					zone={zone}
					onOpened={(status) => setView({ step: "status", status })}
				/>
			);
		case "error":
			return (
				<Panel
					heading={heading}
					icon={<CardIcon icon={Alert02Icon} tone="magenta" />}
					title="The deletion status did not load"
				>
					<SaveError message={view.refusal.message} reference={view.refusal.reference} />
					<div>
						<Button variant="secondary" size="sm" onClick={() => void load()} loading={loading}>
							Try again
						</Button>
					</div>
				</Panel>
			);
	}

	const status = view.status;
	switch (status.status) {
		case "pending_deletion": {
			const open = now() < Date.parse(status.cancelUntil) && cancelError?.code !== "deadline_passed";
			const deadline = formatMoment(status.cancelUntil, zone);
			return (
				<Panel
					heading={heading}
					icon={<CardIcon icon={Calendar03Icon} tone="amber" />}
					title={`${what} is scheduled for deletion`}
				>
					<p>
						{subject.kind === "account"
							? "Your login is closed, and every session has ended."
							: "Every seat has lost access, and every session has ended. Nothing in the workspace is visible."}{" "}
						{open
							? `You can cancel until ${deadline}. After that, the data is deleted. Backup copies expire within 7 days after the deletion finishes.`
							: `The time to cancel ended on ${deadline}.`}
					</p>
					<p className="text-sm text-text-3">{OUT_OF_REACH}</p>
					{cancelError ? <SaveError message={cancelError.message} reference={cancelError.reference} /> : null}
					{open ? (
						<div className="flex flex-wrap gap-2.5">
							<Button variant="primary" onClick={cancel} loading={cancelling}>
								{subject.kind === "account" ? "Keep my account" : "Keep the workspace"}
							</Button>
						</div>
					) : null}
				</Panel>
			);
		}
		case "cancelled":
			return (
				<Panel
					heading={heading}
					icon={<CardIcon icon={CheckmarkCircle02Icon} tone="green" />}
					title="Deletion cancelled"
				>
					<p>
						{what} is kept. Sign in again to continue. Access that was removed for other reasons does not come back.
					</p>
					<div>
						<Button asChild variant="primary">
							<a href={signInHref}>Sign in</a>
						</Button>
					</div>
				</Panel>
			);
		case "purging":
			return (
				<Panel heading={heading} icon={<CardIcon icon={Time04Icon} tone="ink" />} title="Deletion in progress">
					<p>The 30 days to cancel have ended. The data is being deleted and stays hidden until it is gone.</p>
				</Panel>
			);
		case "purged":
			return (
				<Panel heading={heading} icon={<CardIcon icon={Delete02Icon} tone="ink" />} title={`${what} was deleted`}>
					<p>
						Deleted on {formatMoment(status.livePurgedAt, zone)}. Backup copies expire by{" "}
						{formatMoment(status.copyExpiresAt, zone)}. Records that belong to a church keep a name-free attribution.
					</p>
					<p className="text-sm text-text-3">{OUT_OF_REACH}</p>
				</Panel>
			);
		case "active":
			return (
				<Panel
					heading={heading}
					icon={<CardIcon icon={CheckmarkCircle02Icon} tone="green" />}
					title="Nothing is scheduled for deletion"
				>
					<p>{what} is active.</p>
					<div>
						<Button asChild variant="secondary">
							<a href={signInHref}>Sign in</a>
						</Button>
					</div>
				</Panel>
			);
	}
}

/**
 * Fresh proof of the original login: its email and current password. The password is never kept after a try, and a
 * refusal does not say which of the two was wrong.
 */
function Proof({
	port,
	requestedUntil,
	zone,
	onOpened,
}: {
	port: DeletionPort;
	requestedUntil: string | null;
	zone: string;
	onOpened: (status: DeletionStatus) => void;
}) {
	const email = useRef<HTMLInputElement>(null);
	const password = useRef<HTMLInputElement>(null);
	const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
	const [refusal, setRefusal] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	const submit = async (form: FormData) => {
		if (pending) return;
		const address = normalizedEmail.safeParse(String(form.get("email") ?? ""));
		const secret = String(form.get("password") ?? "");
		const found = {
			email: address.success ? undefined : "Enter the email you sign in with.",
			password: secret ? undefined : "Enter your password.",
		};
		setErrors(found);
		setRefusal(null);
		if (found.email) return email.current?.focus();
		if (found.password || !address.success) return password.current?.focus();
		setPending(true);
		let reply: Reply<DeletionStatus> | null;
		try {
			reply = await port.open({ email: address.data, password: secret });
		} catch {
			reply = null;
		}
		setPending(false);
		if (reply?.status === "ok") return onOpened(reply.value);
		if (password.current) password.current.value = "";
		setRefusal(proofText(reply));
		password.current?.focus();
	};

	return (
		<div className="flex flex-col gap-5 text-text-2">
			<CardIcon icon={Calendar03Icon} tone="amber" />
			<header className="flex flex-col gap-2">
				<h1 className="font-title text-title-md leading-[1.2] tracking-[-0.02em] text-ink text-balance">
					{requestedUntil ? "Your account is scheduled for deletion" : "Your account deletion"}
				</h1>
				<p className="text-pretty">
					{requestedUntil
						? `You are signed out on every device. You can cancel until ${formatMoment(requestedUntil, zone)}. To see the request or cancel it, enter your email and password.`
						: "To see your deletion request or cancel it, enter the email and password of the account."}
				</p>
			</header>
			<form
				noValidate
				className="flex flex-col gap-4"
				onSubmit={(e) => {
					e.preventDefault();
					void submit(new FormData(e.currentTarget));
				}}
			>
				<Field label="Email" error={errors.email}>
					<Input
						ref={email}
						name="email"
						type="email"
						autoComplete="username"
						spellCheck={false}
						autoCapitalize="none"
						invalid={Boolean(errors.email)}
					/>
				</Field>
				<Field label="Password" error={errors.password}>
					<PasswordInput
						ref={password}
						name="password"
						autoComplete="current-password"
						invalid={Boolean(errors.password)}
					/>
				</Field>
				<FormMessage tone="error">{refusal}</FormMessage>
				<div>
					<Button type="submit" variant="primary" loading={pending}>
						Continue
					</Button>
				</div>
			</form>
		</div>
	);
}

function proofText(reply: Reply<DeletionStatus> | null): string {
	if (!reply) return OFFLINE.message;
	if (reply.status === "ok") return "";
	if (reply.error.code === "proof_invalid")
		return "This email and password do not match an account that is scheduled for deletion. After several tries you need to wait 15 minutes.";
	return `Everyfield could not check this just now. Wait a minute, then try again. Reference ${refusalOf(reply.error).reference}.`;
}

function Panel({
	heading,
	icon,
	title,
	children,
}: {
	heading: (el: HTMLHeadingElement | null) => void;
	icon: ReactNode;
	title: string;
	children: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-4 text-text-2">
			{icon}
			<h1
				ref={heading}
				tabIndex={-1}
				className="outline-none font-title text-title-md leading-[1.2] tracking-[-0.02em] text-ink text-balance"
			>
				{title}
			</h1>
			{children}
		</div>
	);
}
