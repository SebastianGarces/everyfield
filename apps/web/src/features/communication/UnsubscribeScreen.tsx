"use client";

import { Alert02Icon, MailRemove01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@everyfield/ui/controls";
import { Icon, LogoMark, type IconSvgElement } from "@everyfield/ui/foundations";
import { useState, useTransition, type ReactNode } from "react";
import type { Outcome } from "./model.ts";
import { applyUnsubscribe, undoUnsubscribe } from "./unsubscribeActions.ts";

// The Unsubscribe page of a Messages email (REQ-NTF-016, D-284). It names the church, never the person's address.
// Opening it changes nothing: only the button unsubscribes, and the undo it offers works for one hour.

export type UnsubscribeView =
	{ state: "unavailable" } | { state: "invalid" } | { state: "open"; churchName: string; unsubscribed: boolean };

type Done = { kind: "off"; undoToken: string | null } | { kind: "on" } | { kind: "late" };

export function UnsubscribeScreen({ token, view }: { token: string; view: UnsubscribeView }) {
	if (view.state === "unavailable")
		return (
			<Shell>
				<Notice icon={Alert02Icon} title="Unsubscribe is not available right now">
					Nothing was changed. Try the link again later.
				</Notice>
			</Shell>
		);
	if (view.state === "invalid")
		return (
			<Shell>
				<Notice icon={Alert02Icon} title="This link does not work">
					It may be mistyped or cut short. Nothing was changed. Use the Unsubscribe link in the email again.
				</Notice>
			</Shell>
		);
	return <Choice token={token} churchName={view.churchName} unsubscribed={view.unsubscribed} />;
}

function Choice({ token, churchName, unsubscribed }: { token: string; churchName: string; unsubscribed: boolean }) {
	const church = churchName.trim() || "this church";
	const [done, setDone] = useState<Done | null>(unsubscribed ? { kind: "off", undoToken: null } : null);
	const [problem, setProblem] = useState<string | null>(null);
	const [pending, start] = useTransition();

	const run = <T,>(send: () => Promise<Outcome<T>>, next: (value: T) => Done) =>
		start(async () => {
			setProblem(null);
			const r = await send().catch(() => ({ status: "lost" }) as const);
			if (r.status === "ok") return setDone(next(r.value));
			setProblem(
				r.status === "lost"
					? "We did not hear back. Nothing changes twice, so you can try again."
					: r.code === "unavailable"
						? "Unsubscribe is not available right now. Nothing was changed. Try again later."
						: "This link no longer works. Nothing was changed.",
			);
		});
	const unsubscribe = () =>
		run(
			() => applyUnsubscribe(token),
			(r) => ({ kind: "off", undoToken: r.undoToken }),
		);
	const undo = (undoToken: string) =>
		run(
			() => undoUnsubscribe(undoToken),
			(r) => (r.expired ? { kind: "late" } : { kind: "on" }),
		);

	return (
		<Shell>
			<Header>
				{done?.kind === "on"
					? `You will get email from ${church} again`
					: done
						? `You will no longer get email from ${church}`
						: `Stop email from ${church}?`}
			</Header>
			<div className="flex flex-col gap-5 px-6 py-6" aria-live="polite">
				{done ? (
					<div className="flex flex-col items-center gap-2 text-center">
						<span className="grid size-12 place-items-center rounded-full bg-green-500 text-ink-fixed">
							<Icon icon={done.kind === "on" ? Tick02Icon : MailRemove01Icon} size={22} />
						</span>
						<p className="max-w-[320px] text-md text-text-2 text-pretty">
							{done.kind === "on"
								? `${church} can email you again. Nothing else changed.`
								: done.kind === "late"
									? "The hour to undo this has passed, so you stay unsubscribed. Nothing else changed."
									: `${church} will see that you unsubscribed. Email from other churches stays as it is.`}
						</p>
					</div>
				) : (
					<p className="text-md text-text-2 text-pretty">
						You will stop getting the messages {church} sends you by email. Nothing changes until you press Unsubscribe.
					</p>
				)}
				{done === null ? (
					<Button variant="primary" className="w-full" loading={pending} onClick={unsubscribe}>
						Unsubscribe
					</Button>
				) : done.kind === "off" && done.undoToken ? (
					<div className="flex flex-col gap-2">
						<Button variant="secondary" className="w-full" loading={pending} onClick={() => undo(done.undoToken!)}>
							Undo
						</Button>
						<p className="text-center text-xs text-text-3">You can undo this here for one hour.</p>
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
			</div>
		</Shell>
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
			<p className="mt-1.5 text-sm text-cream/75">Unsubscribe</p>
		</header>
	);
}

function Notice({ icon, title, children }: { icon: IconSvgElement; title: string; children: ReactNode }) {
	return (
		<div className="flex flex-col items-center gap-2 px-6 pt-12 pb-8 text-center">
			<LogoMark className="mb-4 h-8 w-8 text-green-600" />
			<span className="grid size-12 place-items-center rounded-full bg-amber-100 text-amber-600">
				<Icon icon={icon} size={22} />
			</span>
			<h1 className="font-semibold text-ink text-balance">{title}</h1>
			<p className="max-w-[320px] text-md text-text-2 text-pretty">{children}</p>
		</div>
	);
}
