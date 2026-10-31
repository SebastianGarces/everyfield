"use client";

import { timeText } from "@everyfield/contracts/common";

import { Alert02Icon, Calendar03Icon, Location01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import type * as c from "@everyfield/contracts/meetings";
import { Button } from "@everyfield/ui/controls";
import { Icon, LogoMark } from "@everyfield/ui/foundations";
import { useOptimistic, useState, useTransition, type ReactNode } from "react";
import type { z } from "zod";
import { answerRsvp, readRsvpLink } from "./actions.ts";
import { longDateText, problemText } from "./model.ts";

type View = z.infer<typeof c.rsvpTokenView>;
type Open = Extract<View, { meeting: unknown }>;
type Answer = "confirmed" | "declined";

/**
 * The public RSVP page (COM-010, REQ-MTG-009), opened from an invitation email on a phone. It shows only the meeting
 * basics and the guest's own answer. Opening it never answers: only a tap does, and the link closes after one answer.
 * When the answer's reply is lost, or the link says it is already closed, the page reads the link once and shows the
 * answer the server kept (C58, R3-5); it never asks to tap again for an answer that may be saved.
 */
export function RsvpScreen({ token, view }: { token: string; view: View }) {
	if (view.state === "unavailable")
		return (
			<Shell>
				<Notice icon={Alert02Icon} title="This link does not work" level="h1">
					It may be mistyped, or the invitation was withdrawn. Ask the person who invited you for a new link.
				</Notice>
			</Shell>
		);
	return <Invitation token={token} view={view} />;
}

function Invitation({ token, view }: { token: string; view: Open }) {
	const [saved, setSaved] = useState<{ state: Open["state"]; rsvp: Open["rsvp"] }>({
		state: view.state,
		rsvp: view.rsvp,
	});
	const [optimistic, show] = useOptimistic(saved);
	/** A refusal code, "not_recorded" (the read found no answer) or "unknown" (the read failed too: Check again). */
	const [problem, setProblem] = useState<string | null>(null);
	/** The answer whose result is unknown. It stays on screen, and nothing else can be sent, until Check again. */
	const [asked, setAsked] = useState<Answer | null>(null);
	const shown = asked ? { state: "answered" as const, rsvp: asked } : optimistic;
	const [pending, startTransition] = useTransition();
	const { meeting: m, guestFirstName: name } = view;

	/** Reads what the link holds now and shows it. The optimistic answer stays on screen while this runs. */
	async function settle() {
		const r = await readRsvpLink(token).catch(() => ({ status: "lost" }) as const);
		if (r.status !== "ok") return setProblem("unknown");
		setAsked(null);
		const v = r.value;
		if (v.state === "unavailable") return setProblem("unavailable");
		startTransition(() => setSaved({ state: v.state, rsvp: v.rsvp }));
		if (v.state === "pending") setProblem("not_recorded");
	}
	const answer = (rsvp: Answer) =>
		startTransition(async () => {
			setProblem(null);
			show({ state: "answered", rsvp });
			const r = await answerRsvp(token, rsvp).catch(() => ({ status: "lost" }) as const);
			if (r.status === "ok") return startTransition(() => setSaved({ state: "answered", rsvp }));
			if (r.status === "refused" && r.code !== "token_closed") return setProblem(r.code);
			// The reply was lost, or the link is closed (perhaps by this same answer): the link's record decides.
			setAsked(rsvp);
			await settle();
		});
	const checkAgain = () =>
		startTransition(async () => {
			setProblem(null);
			await settle();
		});

	return (
		<Shell>
			<header className="relative bg-ink-fixed px-6 pt-14 pb-7 text-cream max-app-sm:pt-12">
				<LogoMark className="h-8 w-8 text-green-500" />
				<h1 className="mt-5 font-display text-[26px] leading-[1.15] tracking-[-0.02em] text-balance">
					{shown.state === "answered" && shown.rsvp === "confirmed"
						? `See you there, ${name}`
						: shown.state === "answered" && shown.rsvp === "declined"
							? `Thanks for letting us know, ${name}`
							: `You're invited to ${m.displayTitle}`}
				</h1>
				{shown.state === "answered" ? <p className="mt-1.5 text-sm text-cream/75">{m.displayTitle}</p> : null}
			</header>
			<div className="flex flex-col gap-5 px-6 py-6">
				<dl className="flex flex-col">
					<Row icon={Calendar03Icon} label="When">
						{longDateText(m.localDate)} · {timeText(m.localTime)}
					</Row>
					<Row icon={Location01Icon} label="Where">
						{m.venue ? (
							<span className="flex flex-col">
								<span>{m.venue.name}</span>
								<a
									href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(m.venue.address)}`}
									target="_blank"
									rel="noreferrer noopener"
									className="text-sm text-blue-600 underline underline-offset-2 hover:text-blue-700"
								>
									{m.venue.address}
									<span className="sr-only"> (opens a map in a new tab)</span>
								</a>
							</span>
						) : (
							<span className="text-text-3">The place will follow</span>
						)}
					</Row>
				</dl>

				{shown.state === "expired" ? (
					<Notice icon={Alert02Icon} title="This link has expired">
						Links work for 7 days. Ask the person who invited you for a new one.
					</Notice>
				) : shown.state === "answered" && shown.rsvp === "pending" ? (
					<Notice icon={Alert02Icon} title="This link is closed">
						Your invitation changed after this link was sent. Ask the person who invited you for a new one.
					</Notice>
				) : shown.state === "answered" ? (
					<div className="flex flex-col items-center gap-2 text-center" aria-live="polite">
						<span className="grid size-12 place-items-center rounded-full bg-green-500 text-ink-fixed">
							<Icon icon={Tick02Icon} size={24} />
						</span>
						<p className="font-semibold text-ink">
							{shown.rsvp === "confirmed" ? "Your answer: Yes, I'll come" : "Your answer: I can't make it"}
						</p>
						<p className="text-sm text-text-3">
							{pending
								? "Saving…"
								: asked
									? "Not confirmed yet."
									: "This link is now closed. To change your answer, contact the person who invited you."}
						</p>
					</div>
				) : (
					<div className="flex flex-col gap-3">
						<p className="font-semibold text-ink">Hi {name}, will you come?</p>
						<Button variant="primary" onClick={() => answer("confirmed")} className="w-full">
							Yes, I&apos;ll come
						</Button>
						<Button variant="secondary" onClick={() => answer("declined")} className="w-full">
							Can&apos;t make it
						</Button>
					</div>
				)}
				{problem ? (
					<div
						role="alert"
						className="flex flex-col items-start gap-2.5 rounded-md bg-magenta-50 px-3.5 py-2.5 text-sm text-magenta-600"
					>
						<p className="flex items-start gap-2">
							<Icon icon={Alert02Icon} size={16} className="mt-px flex-none" />
							{LINK_PROBLEM[problem] ?? problemText(problem)}
						</p>
						{problem === "unknown" ? (
							<Button variant="secondary" size="sm" loading={pending} onClick={checkAgain}>
								Check again
							</Button>
						) : null}
					</div>
				) : null}
				<p className="text-center text-xs text-text-3">
					No account needed. This link is only for you, so please do not share it.
				</p>
			</div>
		</Shell>
	);
}

/** What the link page says when an answer did not settle. Other codes use the shared words. */
const LINK_PROBLEM: Record<string, string> = {
	not_recorded: "Your answer did not reach us. Choose again.",
	unknown:
		"Your answer may already be saved. We did not hear back from the server. Check again to find out; it will not be saved twice.",
	unavailable: "This link no longer works. Ask the person who invited you for a new link.",
};

function Shell({ children }: { children: ReactNode }) {
	return (
		<main className="flex min-h-dvh justify-center bg-frame sm:px-4 sm:py-10">
			<div className="w-full max-w-[440px] self-start overflow-hidden bg-surface sm:rounded-card sm:shadow-card">
				{children}
			</div>
		</main>
	);
}

function Row({ icon, label, children }: { icon: typeof Calendar03Icon; label: string; children: ReactNode }) {
	return (
		<div className="flex items-start gap-3 border-t border-line py-3 first:border-t-0">
			<dt className="flex-none pt-0.5 text-text-3">
				<Icon icon={icon} size={18} />
				<span className="sr-only">{label}</span>
			</dt>
			<dd className="min-w-0 flex-1 text-md text-ink">{children}</dd>
		</div>
	);
}

function Notice({
	icon,
	title,
	level: Heading = "h2",
	children,
}: {
	icon: typeof Alert02Icon;
	title: string;
	level?: "h1" | "h2";
	children: ReactNode;
}) {
	return (
		<div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
			<span className="grid size-12 place-items-center rounded-full bg-amber-100 text-amber-600">
				<Icon icon={icon} size={22} />
			</span>
			<Heading className="font-semibold text-ink">{title}</Heading>
			<p className="max-w-[320px] text-md text-text-2">{children}</p>
		</div>
	);
}
