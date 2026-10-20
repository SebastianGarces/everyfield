"use client";

import {
	Alert02Icon,
	Calendar03Icon,
	CheckmarkCircle02Icon,
	Delete02Icon,
	Time04Icon,
} from "@hugeicons/core-free-icons";
import { Button, Card, CardIcon, Skeleton } from "@everyfield/ui/controls";
import { LogoMark } from "@everyfield/ui/foundations";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { DeletionPort, DeletionStatus } from "../port";
import { refusalOf, type Refusal } from "../save";
import { SaveError } from "../SettingsDialog";
import { formatMoment } from "../time";

// REQ-KNOW-074: what deletion cannot reach, said plainly (no promise of instant or total erasure).
const OUT_OF_REACH =
	"Some copies are out of our reach. Emails already accepted for delivery still arrive. File links given out before the request work until they expire a short time later. Other services we use delete their copies on their own schedule. Copies someone downloaded or posted elsewhere stay where they are.";

type Subject = { kind: "account"; email: string } | { kind: "workspace"; churchName: string };

/**
 * The restricted deletion page (REQ-IDN-032, REQ-KNOW-067). A fresh sign-in of the original account, or of the
 * workspace Owner who asked, opens only this: the status of one exact request and its cancellation. It has no
 * settings, navigation or church content. Cancel shows only before the deadline; the server still refuses at or
 * after it, even when the deletion has not started yet.
 */
export function DeletionStatusScreen({
	subject,
	port,
	now,
	zone,
	signInHref,
}: {
	subject: Subject;
	port: DeletionPort;
	/** The current time, passed in so the deadline check is testable and never reads the host clock here. */
	now: () => number;
	/** The zone to show dates in: the account's own zone or the church's. */
	zone: string;
	signInHref: string;
}) {
	const [status, setStatus] = useState<DeletionStatus | null>(null);
	const [loadError, setLoadError] = useState<Refusal | null>(null);
	const [cancelError, setCancelError] = useState<Refusal | null>(null);
	const [cancelling, setCancelling] = useState(false);

	const [attempt, setAttempt] = useState(0);
	const load = useCallback(() => {
		setLoadError(null);
		setAttempt((n) => n + 1);
	}, []);

	useEffect(() => {
		let live = true;
		port.getStatus().then((reply) => {
			if (!live) return;
			if (reply.status === "ok") setStatus(reply.value);
			else setLoadError(refusalOf(reply.error));
		});
		return () => {
			live = false;
		};
	}, [port, attempt]);

	const cancel = async () => {
		if (!status || status.status !== "pending_deletion" || cancelling) return;
		setCancelling(true);
		setCancelError(null);
		const reply = await port.cancel(status.revision);
		setCancelling(false);
		if (reply.status === "ok") return setStatus(reply.value);
		setCancelError(refusalOf(reply.error));
		if (reply.error.code === "deadline_passed" || reply.error.code === "conflict") load();
	};

	const what = subject.kind === "account" ? "Your account" : subject.churchName;

	let body: ReactNode;
	if (loadError) {
		body = (
			<Panel icon={<CardIcon icon={Alert02Icon} tone="magenta" />} title="The deletion status did not load">
				<SaveError message={loadError.message} reference={loadError.reference} />
				<div>
					<Button variant="secondary" size="sm" onClick={() => load()}>
						Try again
					</Button>
				</div>
			</Panel>
		);
	} else if (!status) {
		body = (
			<div aria-busy="true" className="flex flex-col gap-4">
				<span className="sr-only" role="status">
					Loading deletion status
				</span>
				<Skeleton shape="block" height={40} />
				<Skeleton shape="line" />
				<Skeleton shape="line" width="70%" />
			</div>
		);
	} else {
		body = statusView(status);
	}

	function statusView(status: DeletionStatus): ReactNode {
		switch (status.status) {
			case "pending_deletion": {
				const open = now() < Date.parse(status.cancelUntil) && cancelError?.code !== "deadline_passed";
				const deadline = formatMoment(status.cancelUntil, zone);
				return (
					<Panel icon={<CardIcon icon={Calendar03Icon} tone="amber" />} title={`${what} is scheduled for deletion`}>
						<p>
							{subject.kind === "account"
								? `The login for ${subject.email} is closed, and every session has ended.`
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
					<Panel icon={<CardIcon icon={CheckmarkCircle02Icon} tone="green" />} title="Deletion cancelled">
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
					<Panel icon={<CardIcon icon={Time04Icon} tone="ink" />} title="Deletion in progress">
						<p>The 30 days to cancel have ended. The data is being deleted and stays hidden until it is gone.</p>
					</Panel>
				);
			case "purged":
				return (
					<Panel icon={<CardIcon icon={Delete02Icon} tone="ink" />} title={`${what} was deleted`}>
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

	return (
		<main className="grid min-h-dvh place-items-center bg-frame px-4 py-10">
			<div className="w-full max-w-[520px]">
				<LogoMark className="mb-6 size-9 text-ink" />
				<Card className="flex flex-col gap-4">{body}</Card>
			</div>
		</main>
	);
}

function Panel({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-4 text-text-2">
			{icon}
			<h1 className="font-title text-title-md leading-[1.2] tracking-[-0.02em] text-ink text-balance">{title}</h1>
			{children}
		</div>
	);
}
