"use client";

import { respondInvitationRequest } from "@everyfield/contracts/organizations";
import { CheckmarkCircle02Icon, HierarchyIcon } from "@hugeicons/core-free-icons";
import { Button, Card, CardIcon, ConfirmDialog, StatePanel } from "@everyfield/ui/controls";
import { useState } from "react";
import { NotAvailable } from "../access/AccessStates";
import { useIntent } from "./intent";
import { formatDay, NEVER_SHARED, subjectName } from "./model";
import { PrivateLine, ProblemLine } from "./parts";
import type { NameOf, PendingInvitation, Run } from "./port";

/**
 * The receiving organization's answer to one connection request (REQ-IDN-020). Only an Owner or Admin of that exact
 * organization can answer, from the original emailed link (`proof`). Accepting connects only this pair; it changes
 * no other connection and gives no access to the church's people or records.
 */
export function InvitationResponse({
	invitation,
	proof,
	nameOf,
	zone,
	run,
	connectionsHref,
}: {
	/** null when the link is expired, withdrawn, answered, or not for this account: one shared refusal. */
	invitation: PendingInvitation | null;
	proof: string;
	nameOf: NameOf;
	zone: string;
	run: Run;
	connectionsHref: string;
}) {
	const [outcome, setOutcome] = useState<"accepted" | "declined" | "refused" | null>(null);
	// One intent for both answers: after a lost reply only that same answer can be retried, unchanged.
	const answer = useIntent<ReturnType<typeof respondInvitationRequest.parse>>("relationship-respond");

	if (!invitation || outcome === "refused") return <NotAvailable scope="page" homeHref={connectionsHref} />;

	const subject = subjectName(invitation.pair, nameOf);
	const organization = nameOf(invitation.pair.organization);

	if (outcome)
		return (
			<Card className="mx-auto w-full max-w-[560px]">
				<StatePanel
					icon={outcome === "accepted" ? CheckmarkCircle02Icon : HierarchyIcon}
					title={outcome === "accepted" ? `${subject} is connected` : "You declined this request"}
					headingLevel="h1"
					actions={
						<Button asChild variant={outcome === "accepted" ? "primary" : "secondary"}>
							<a href={connectionsHref}>Go to connected churches</a>
						</Button>
					}
				>
					{outcome === "accepted"
						? `${organization} now sees what ${subject} chooses to share. Either side can end the connection at any time.`
						: `${subject} is not connected with ${organization}. Nothing is shared.`}
				</StatePanel>
			</Card>
		);

	const respond = (decision: "accept" | "decline") =>
		answer.run(
			decision,
			(requestKey) =>
				respondInvitationRequest.parse({
					requestKey,
					expectedRevision: invitation.revision,
					input: { invitationId: invitation.invitationId, proof, decision },
				}),
			(command) => run("associations.respondInvitation", command),
			(r) => r.status === (decision === "accept" ? "accepted" : "declined"),
		);

	const onAccept = async () => {
		const result = await respond("accept");
		if (result.ok) setOutcome("accepted");
		else if (result.problem === "refused") setOutcome("refused");
	};
	// The decline dialog shows its own error and stays open, so a retry reuses the same request key.
	const onDecline = async () => {
		const result = await respond("decline");
		if (result.ok) return setOutcome("declined");
		if (result.problem === "refused") return setOutcome("refused");
		if (result.problem === "busy") throw new Error("Finish accepting first: use Try again on the page.");
		throw new Error("We could not confirm your answer. Check your connection, then try again.");
	};

	return (
		<Card as="article" className="mx-auto w-full max-w-[560px]" aria-labelledby="invitation-title">
			<div className="flex items-start gap-4">
				<CardIcon icon={HierarchyIcon} tone="blue" />
				<div className="min-w-0 flex-1">
					<p className="text-sm text-text-3">Connection request for {organization}</p>
					<h1 id="invitation-title" className="mt-1 font-title text-title-md tracking-[-0.02em] text-ink text-balance">
						{subject} wants to connect with {organization}
					</h1>
				</div>
			</div>
			<p className="mt-5 text-text-2">
				Sent by <span className="font-medium text-ink">{invitation.inviterDescription}</span>.
			</p>
			<ul className="mt-4 flex flex-col gap-2 rounded-md bg-surface px-5 py-4 text-text-2">
				<li className="flex gap-2.5">
					<span aria-hidden="true" className="mt-[9px] size-1.5 flex-none rounded-full bg-text-3" />
					{organization} will see only what {subject} chooses to share. {subject} can change that at any time.
				</li>
				<li className="flex gap-2.5">
					<span aria-hidden="true" className="mt-[9px] size-1.5 flex-none rounded-full bg-text-3" />
					This connects only {subject} and {organization}. Other connections do not change.
				</li>
				<li className="flex gap-2.5">
					<span aria-hidden="true" className="mt-[9px] size-1.5 flex-none rounded-full bg-text-3" />
					Either side can end the connection later.
				</li>
			</ul>
			<PrivateLine>{NEVER_SHARED}</PrivateLine>
			<p className="mt-4 text-sm text-text-3">
				This request expires on <time dateTime={invitation.expiresAt}>{formatDay(invitation.expiresAt, zone)}</time>.
			</p>
			<ProblemLine problem={answer.held === "accept" ? answer.problem : null} />
			<div className="mt-6 flex flex-wrap justify-end gap-2.5 max-app-sm:*:flex-1">
				<ConfirmDialog
					title="Decline this request?"
					consequences={[
						`${subject} is not connected with ${organization}.`,
						`${subject} can send a new request later.`,
					]}
					confirmLabel="Decline"
					onConfirm={onDecline}
					trigger={
						<Button variant="secondary" disabled={answer.pending === "accept" || answer.held === "accept"}>
							Decline
						</Button>
					}
				/>
				<Button
					variant="primary"
					loading={answer.pending === "accept"}
					disabled={answer.pending === "decline" || answer.held === "decline"}
					onClick={onAccept}
				>
					{answer.held === "accept" ? "Try again" : "Accept and connect"}
				</Button>
			</div>
		</Card>
	);
}
