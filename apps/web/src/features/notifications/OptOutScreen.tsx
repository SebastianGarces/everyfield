"use client";

import { Alert02Icon, Mail01Icon, MailRemove01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Button, buttonVariants } from "@everyfield/ui/controls";
import { Icon, LogoMark, type IconSvgElement } from "@everyfield/ui/foundations";
import Link from "next/link";
import { useState, useTransition, type ReactNode } from "react";
import { applyEmailOptOut, undoEmailOptOut } from "./actions.ts";
import { categoryLabel, type Category, type OptOut, type Outcome } from "./model.ts";

// The email preferences page (screens.md, Phone screens), opened from the footer of a notification email. The token
// is the only authority (REQ-NTF-012): opening the page only reads it, and a mail scanner that follows the link
// changes nothing. Only the button turns the email off, and the undo it offers works for one hour.

export type OptOutView =
	| { state: "unavailable" }
	| { state: "invalid" }
	| { state: "expired"; category: Category }
	| { state: "open"; category: Category; emailEnabled: boolean };

type Done = { kind: "off"; undoToken: string | null } | { kind: "on" };

export function OptOutScreen({ token, view }: { token: string; view: OptOutView }) {
	if (view.state === "unavailable")
		return (
			<Shell>
				<Notice icon={Alert02Icon} title="Email preferences are not available right now" level="h1">
					Nothing was changed. Try the link again later, or sign in and change your notification settings.
				</Notice>
				<SignIn />
			</Shell>
		);
	if (view.state === "invalid")
		return (
			<Shell>
				<Notice icon={Alert02Icon} title="This link does not work" level="h1">
					It may be mistyped or replaced by a newer email. Sign in to change what Everyfield emails you.
				</Notice>
				<SignIn />
			</Shell>
		);
	if (view.state === "expired") return <Expired category={view.category} />;
	return <Choice token={token} category={view.category} emailEnabled={view.emailEnabled} />;
}

function Choice({ token, category, emailEnabled }: { token: string; category: Category; emailEnabled: boolean }) {
	const label = categoryLabel(category).toLowerCase();
	const [done, setDone] = useState<Done | null>(emailEnabled ? null : { kind: "off", undoToken: null });
	const [problem, setProblem] = useState<string | null>(null);
	const [expired, setExpired] = useState(false);
	const [pending, start] = useTransition();

	const run = (send: () => Promise<Outcome<OptOut>>, next: (r: OptOut) => Done) =>
		start(async () => {
			setProblem(null);
			const r = await send().catch(() => ({ status: "lost" }) as const);
			if (r.status === "ok") {
				if (r.value.expired) return setExpired(true);
				return setDone(next(r.value));
			}
			setProblem(
				r.status === "lost"
					? "We did not hear back. Nothing changes twice, so you can try again."
					: r.code === "unavailable"
						? "Email preferences are not available right now. Nothing was changed. Try again later."
						: "This link no longer works. Sign in to change your notification settings.",
			);
		});
	const turnOff = () =>
		run(
			() => applyEmailOptOut(token),
			(r) => ({ kind: "off", undoToken: r.undoToken }),
		);
	const turnOn = (undoToken: string) =>
		run(
			() => undoEmailOptOut(undoToken),
			() => ({ kind: "on" }),
		);

	if (expired) return <Expired category={category} />;
	return (
		<Shell>
			<Header>
				{done?.kind === "off"
					? `You will not get emails about ${label}`
					: done?.kind === "on"
						? `Emails about ${label} are on again`
						: `Stop emails about ${label}?`}
			</Header>
			<div className="flex flex-col gap-5 px-6 py-6" aria-live="polite">
				{done ? (
					<div className="flex flex-col items-center gap-2 text-center">
						<span className="grid size-12 place-items-center rounded-full bg-green-500 text-ink-fixed">
							<Icon icon={done.kind === "off" ? MailRemove01Icon : Tick02Icon} size={22} />
						</span>
						<p className="max-w-[320px] text-md text-text-2 text-pretty">
							{done.kind === "off"
								? "You still see these in Everyfield. Other emails stay as they are."
								: "We will email you about these again. You can change this any time in your notification settings."}
						</p>
					</div>
				) : (
					<p className="text-md text-text-2 text-pretty">
						Everyfield will stop emailing you about {label}. You still see them in Everyfield, and your other emails
						stay as they are.
					</p>
				)}
				{done === null ? (
					<Button variant="primary" className="w-full" loading={pending} onClick={turnOff}>
						Turn off these emails
					</Button>
				) : done.kind === "off" && done.undoToken ? (
					<div className="flex flex-col gap-2">
						<Button variant="secondary" className="w-full" loading={pending} onClick={() => turnOn(done.undoToken!)}>
							Turn them back on
						</Button>
						<p className="text-center text-xs text-text-3">You can turn them back on here for one hour.</p>
					</div>
				) : null}
				{problem ? (
					<p
						role="alert"
						className="flex items-start gap-2 rounded-md bg-magenta-50 px-3.5 py-2.5 text-sm text-magenta-600"
					>
						<Icon icon={Alert02Icon} size={16} className="mt-px flex-none" />
						{problem}
					</p>
				) : null}
				<SignIn quiet />
			</div>
		</Shell>
	);
}

function Expired({ category }: { category: Category }) {
	return (
		<Shell>
			<Notice icon={Mail01Icon} title="This link has expired" level="h1">
				Nothing was changed. To stop emails about {categoryLabel(category).toLowerCase()}, sign in and change your
				notification settings.
			</Notice>
			<SignIn />
		</Shell>
	);
}

function SignIn({ quiet = false }: { quiet?: boolean }) {
	const href = `/signin?returnTo=${encodeURIComponent("/settings/notifications")}`;
	return quiet ? (
		<p className="text-center text-sm text-text-3">
			More choices are in your{" "}
			<Link href={href} prefetch={false} className="text-ink underline underline-offset-2 hover:text-text-2">
				notification settings
			</Link>
			.
		</p>
	) : (
		<div className="px-6 pb-8">
			<Link href={href} prefetch={false} className={buttonVariants({ variant: "secondary", className: "w-full" })}>
				Open notification settings
			</Link>
		</div>
	);
}

function Shell({ children }: { children: ReactNode }) {
	return (
		<main className="flex min-h-dvh justify-center bg-frame sm:px-4 sm:py-10">
			<div className="w-full max-w-[440px] self-start overflow-hidden bg-surface sm:rounded-card sm:shadow-card">
				{children}
			</div>
		</main>
	);
}

function Header({ children }: { children: ReactNode }) {
	return (
		<header className="bg-ink-fixed px-6 pt-14 pb-7 text-cream max-app-sm:pt-12">
			<LogoMark className="h-8 w-8 text-green-500" />
			<h1 className="mt-5 font-display text-[26px] leading-[1.15] tracking-[-0.02em] text-balance">{children}</h1>
			<p className="mt-1.5 text-sm text-cream/75">Email preferences</p>
		</header>
	);
}

function Notice({
	icon,
	title,
	level: Heading = "h2",
	children,
}: {
	icon: IconSvgElement;
	title: string;
	level?: "h1" | "h2";
	children: ReactNode;
}) {
	return (
		<div className="flex flex-col items-center gap-2 px-6 pt-12 pb-6 text-center">
			<LogoMark className="mb-4 h-8 w-8 text-green-600" />
			<span className="grid size-12 place-items-center rounded-full bg-amber-100 text-amber-600">
				<Icon icon={icon} size={22} />
			</span>
			<Heading className="font-semibold text-ink text-balance">{title}</Heading>
			<p className="max-w-[320px] text-md text-text-2 text-pretty">{children}</p>
		</div>
	);
}
