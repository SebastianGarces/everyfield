"use client";

import type { PipelinePersonRecord } from "@everyfield/contracts/organizations";
import { Mail01Icon } from "@hugeicons/core-free-icons";
import { Button, Card, CardBody, CardHeader, CardHeading, CardTitle, ConfirmDialog } from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { useState } from "react";
import { runLinkInvitation } from "./actions";
import { formatDay } from "./model";
import { Problem } from "./Problem";

type Record = PipelinePersonRecord;

const PROBLEM: { [code: string]: string } = {
	address_blocked: "Email to this address bounced before, so nothing was sent. Check the address on the record.",
	invitation_rate_limited: "This address has had three invitations this month. Try again later.",
	invitation_cooldown: "It was just sent. Wait a minute before sending it again.",
	conflict: "Something changed while you were working. Reload the page, then try again.",
};
const problemText = (code: string) =>
	PROBLEM[code] ?? "This invitation couldn’t be changed. Reload the page and try again.";

/**
 * Whether the person's own Everyfield account is linked to the residency (REQ-MUL-004). An Owner or Admin invites the
 * address on the record, and sees a pending invitation with its date, to resend or revoke. Accepting gives the person
 * no seat; they choose what the organization sees.
 */
export function ResidencyLink({ record, onChanged }: { record: Record; onChanged: () => Promise<void> }) {
	const admin = record.audience === "administrator";
	const link = record.residency;
	const [busy, setBusy] = useState<"invite" | "resend" | null>(null);
	const [problem, setProblem] = useState<string | null>(null);

	async function run(operation: "invite" | "resend" | "revoke") {
		setProblem(null);
		const command =
			operation === "invite"
				? {
						requestKey: crypto.randomUUID(),
						expectedRevision: record.organizationRevision,
						input: { personId: record.personId, recipientEmail: record.email },
					}
				: link.status === "pending"
					? {
							requestKey: crypto.randomUUID(),
							expectedRevision: link.revision,
							input: { invitationId: link.invitationId },
						}
					: null;
		if (!command) return;
		const reply = await runLinkInvitation(operation, command).catch(() => null);
		if (!reply) setProblem("We couldn’t reach Everyfield. Nothing was changed. Try again.");
		else if (reply.status === "refused") setProblem(problemText(reply.code));
		else await onChanged();
	}
	const send = (operation: "invite" | "resend") => async () => {
		setBusy(operation);
		await run(operation);
		setBusy(null);
	};

	return (
		<Card>
			<CardHeader>
				<CardHeading>
					<CardTitle>Everyfield account</CardTitle>
				</CardHeading>
				{link.status === "linked" ? (
					<StatusBadge status="positive" size="sm" fill="soft">
						Linked
					</StatusBadge>
				) : link.status === "pending" ? (
					<StatusBadge status="attention" size="sm" fill="soft">
						Invitation pending
					</StatusBadge>
				) : (
					<StatusBadge status="unknown" size="sm" fill="soft">
						Not linked
					</StatusBadge>
				)}
			</CardHeader>
			<CardBody className="flex flex-col gap-3 text-sm">
				{link.status === "linked" ? (
					<p className="text-ink-2">
						{record.name} linked their own account to your residency. They choose what you see of their progress, and
						they have no seat here.
					</p>
				) : link.status === "pending" ? (
					<>
						<p className="text-ink-2">
							Sent {formatDay(link.sentOn)} to{" "}
							<span className="text-ink [overflow-wrap:anywhere]">{link.recipientEmail}</span>. It works for 30 days.
						</p>
						<div className="flex flex-wrap gap-2">
							<Button
								variant="secondary"
								size="sm"
								loading={busy === "resend"}
								disabled={busy !== null}
								onClick={send("resend")}
							>
								Resend
							</Button>
							<ConfirmDialog
								tone="danger"
								title="Revoke this invitation?"
								description={`The link in the email to ${link.recipientEmail} stops working. You can invite ${record.name} again later.`}
								confirmLabel="Revoke invitation"
								onConfirm={() => run("revoke")}
								trigger={
									<Button variant="ghost" size="sm" disabled={busy !== null}>
										Revoke
									</Button>
								}
							/>
						</div>
					</>
				) : (
					<>
						<p className="text-ink-2">
							{record.name} has no account linked to your residency. Once linked, they see their program, meetings,
							milestones and reading, and choose what you see.
						</p>
						{admin && !record.retired ? (
							record.email ? (
								<div>
									<Button
										variant="secondary"
										size="sm"
										icon={Mail01Icon}
										loading={busy === "invite"}
										disabled={busy !== null}
										onClick={send("invite")}
									>
										Invite to link account
									</Button>
								</div>
							) : (
								<p className="text-text-3">Add an email to their details to invite them.</p>
							)
						) : null}
					</>
				)}
				<Problem text={problem} />
			</CardBody>
		</Card>
	);
}
