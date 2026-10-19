"use client";

import { invitationCommandRequest } from "@everyfield/contracts/organizations";
import { ChurchIcon, HierarchyIcon, Link01Icon, MailSend01Icon } from "@hugeicons/core-free-icons";
import { Button, Card, CardIcon, Skeleton } from "@everyfield/ui/controls";
import { LoadableView } from "@everyfield/ui/display";
import { useCallback, useState } from "react";
import { NotAvailable } from "../access/AccessStates";
import { EndDialog, type Side } from "./EndDialog";
import { HistoryList, otherSide, type ReadHistory } from "./History";
import { useIntent, useLoad } from "./intent";
import { InviteDialog, type InviteTarget } from "./InviteDialog";
import { formatDay, kindLabel, subjectOf } from "./model";
import { ProblemLine } from "./parts";
import type { History, Invitation, NameOf, Relationship, Run } from "./port";

type Loaded = { status: "unavailable" } | History;

/**
 * The connections of one plant, sending church or Discovery account (`side="subject"`), or of one organization
 * (`side="organization"`), with their history (REQ-IDN-020, REQ-IDN-021). Several connections can exist at once and
 * each one is ended on its own. `canManage` only hides controls; the server still checks every command.
 */
export function Connections({
	side,
	read,
	canManage,
	nameOf,
	zone,
	run,
	invite,
}: {
	side: Side;
	read: ReadHistory;
	canManage: boolean;
	nameOf: NameOf;
	zone: string;
	run: Run;
	/** Subject side only: who this subject may ask, its revision, and the invitations still waiting. */
	invite?: { targets: InviteTarget[]; expectedRevision: string; pending: Invitation[] };
}) {
	const [pending, setPending] = useState<Invitation[]>(invite?.pending ?? []);
	const [status, setStatus] = useState("");

	const fetch = useCallback(() => read(null), [read]);
	const { state, reload: load } = useLoad<Loaded>(fetch, "Connections did not load");

	const subject = side === "subject";
	const titleId = `${side}-connections-title`;

	return (
		<Card as="section" aria-labelledby={titleId}>
			<div className="flex flex-wrap items-start gap-x-4 gap-y-3">
				<div className="min-w-0 flex-1 basis-64">
					<h2 id={titleId} className="font-display text-title-sm font-medium tracking-[-0.01em] text-ink">
						{subject ? "Connections" : "Connected churches"}
					</h2>
					<p className="mt-1 text-text-2">
						{subject
							? "Sending churches and networks you work with. Each one sees only what you choose to share with it."
							: "Churches that chose to connect with you. You see only what each one shares."}
					</p>
				</div>
				{subject && canManage && invite ? (
					<InviteDialog
						targets={invite.targets}
						expectedRevision={invite.expectedRevision}
						run={run}
						onSent={(invitation, target) => {
							setPending((list) => [invitation, ...list]);
							setStatus(`Invitation sent. ${target.name} has 30 days to accept.`);
						}}
						trigger={
							<Button variant="primary" size="sm" icon={Link01Icon}>
								Connect
							</Button>
						}
					/>
				) : null}
			</div>
			<p role="status" className="mt-3 text-sm text-green-700 empty:hidden">
				{status}
			</p>
			<LoadableView
				state={state}
				empty={{ title: "" }}
				loadingLabel="Loading connections"
				skeleton={
					<div className="mt-5 flex flex-col gap-4">
						{[0, 1].map((i) => (
							<Skeleton key={i} shape="block" height={52} />
						))}
					</div>
				}
			>
				{(data) =>
					data.status === "unavailable" ? (
						<NotAvailable scope="section" />
					) : (
						<>
							<ActiveList
								side={side}
								history={data}
								canManage={canManage}
								nameOf={nameOf}
								zone={zone}
								run={run}
								onEnded={(name) => {
									setStatus(subject ? `You left ${name}.` : `The connection with ${name} ended.`);
									load();
								}}
							/>
							{subject && pending.length > 0 ? (
								<PendingList
									invitations={pending}
									canManage={canManage}
									nameOf={nameOf}
									zone={zone}
									run={run}
									onChange={(next) => setPending(next)}
								/>
							) : null}
							{canManage ? null : <p className="mt-4 text-sm text-text-3">Owners and Admins manage connections.</p>}
							<section aria-labelledby={`${titleId}-history`} className="mt-8">
								<h3 id={`${titleId}-history`} className="font-semibold text-ink">
									History
								</h3>
								<HistoryList
									key={data.activeRelationships.map((r) => r.id).join()}
									first={data}
									read={read}
									nameOf={nameOf}
									zone={zone}
								/>
							</section>
						</>
					)
				}
			</LoadableView>
		</Card>
	);
}

function ActiveList({
	side,
	history,
	canManage,
	nameOf,
	zone,
	run,
	onEnded,
}: {
	side: Side;
	history: History;
	canManage: boolean;
	nameOf: NameOf;
	zone: string;
	run: Run;
	onEnded: (name: string) => void;
}) {
	const rows = history.activeRelationships;
	if (rows.length === 0)
		return (
			<p className="mt-5 rounded-md bg-surface px-5 py-4 text-text-2">
				{side === "subject"
					? "Not connected to a sending church or network. Nothing is shared."
					: "No churches are connected yet."}
			</p>
		);
	return (
		<ul className="mt-5 flex flex-col" aria-label="Current connections">
			{rows.map((relationship) => (
				<ActiveRow
					key={relationship.id}
					side={side}
					relationship={relationship}
					name={otherSide(history.scope, relationship.pair, nameOf)}
					canManage={canManage}
					zone={zone}
					run={run}
					onEnded={onEnded}
				/>
			))}
		</ul>
	);
}

function ActiveRow({
	side,
	relationship,
	name,
	canManage,
	zone,
	run,
	onEnded,
}: {
	side: Side;
	relationship: Relationship;
	name: string;
	canManage: boolean;
	zone: string;
	run: Run;
	onEnded: (name: string) => void;
}) {
	const subject = side === "subject";
	const other = subject ? relationship.pair.organization : subjectOf(relationship.pair);
	const kind =
		other.kind === "organization" ? kindLabel(other) : other.kind === "plant" ? "Church plant" : "Discovery account";
	return (
		<li className="flex items-center gap-3 border-t border-line py-3.5 first:border-t-0">
			<CardIcon icon={other.kind === "organization" ? HierarchyIcon : ChurchIcon} tone="blue" size={36} />
			<div className="min-w-0 flex-1">
				<p className="font-semibold text-ink">{name}</p>
				<p className="text-sm text-text-3">
					{kind} · connected <time dateTime={relationship.acceptedAt}>{formatDay(relationship.acceptedAt, zone)}</time>
				</p>
			</div>
			{canManage ? (
				<EndDialog
					side={side}
					relationship={relationship}
					otherName={name}
					run={run}
					onEnded={() => onEnded(name)}
					trigger={
						<Button
							variant="ghost"
							size="sm"
							aria-label={subject ? `Leave ${name}` : `End the connection with ${name}`}
						>
							{subject ? "Leave" : "End connection"}
						</Button>
					}
				/>
			) : null}
		</li>
	);
}

/**
 * Invitations this subject sent that are still waiting (REQ-IDN-020). Resend sends a fresh link and a new 30 days;
 * withdraw cancels the request. Both act on this one invitation only.
 */
function PendingList({
	invitations,
	canManage,
	nameOf,
	zone,
	run,
	onChange,
}: {
	invitations: Invitation[];
	canManage: boolean;
	nameOf: NameOf;
	zone: string;
	run: Run;
	onChange: (next: Invitation[]) => void;
}) {
	const resend = useIntent("relationship-resend");
	const withdraw = useIntent("relationship-withdraw");
	const [busy, setBusy] = useState<string | null>(null);
	const [last, setLast] = useState<"resend" | "withdraw">("resend");
	const problem = last === "resend" ? resend.problem : withdraw.problem;

	const act = async (kind: "resend" | "withdraw", invitation: Invitation) => {
		setLast(kind);
		setBusy(invitation.invitationId);
		const command = (requestKey: string) =>
			invitationCommandRequest.parse({
				requestKey,
				expectedRevision: invitation.revision,
				input: { invitationId: invitation.invitationId },
			});
		if (kind === "resend") {
			const reply = await resend.run(
				(requestKey) => run("associations.resendInvitation", command(requestKey)),
				() => true,
			);
			if (reply.ok) onChange(invitations.map((i) => (i.invitationId === reply.reply.invitationId ? reply.reply : i)));
		} else {
			const reply = await withdraw.run(
				(requestKey) => run("associations.revokeInvitation", command(requestKey)),
				(r) => r.status === "committed",
			);
			if (reply.ok) onChange(invitations.filter((i) => i.invitationId !== invitation.invitationId));
		}
		setBusy(null);
	};

	return (
		<section aria-labelledby="pending-invitations" className="mt-6">
			<h3 id="pending-invitations" className="font-semibold text-ink">
				Waiting for a reply
			</h3>
			<ul className="mt-2 flex flex-col">
				{invitations.map((invitation) => {
					const name = nameOf(invitation.pair.organization);
					const mine = busy === invitation.invitationId;
					return (
						<li
							key={invitation.invitationId}
							className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line py-3.5 first:border-t-0"
						>
							<CardIcon icon={MailSend01Icon} tone="amber" size={36} />
							<div className="min-w-0 flex-1 basis-48">
								<p className="font-semibold text-ink">{name}</p>
								<p className="text-sm text-text-3">
									Invitation sent · expires{" "}
									<time dateTime={invitation.expiresAt}>{formatDay(invitation.expiresAt, zone)}</time>
								</p>
							</div>
							{canManage ? (
								<div className="flex gap-2 max-app-sm:w-full max-app-sm:pl-12">
									<Button
										variant="secondary"
										size="sm"
										loading={mine && last === "resend" && resend.pending}
										disabled={busy !== null && !mine}
										onClick={() => act("resend", invitation)}
										aria-label={`Resend the invitation to ${name}`}
									>
										Resend
									</Button>
									<Button
										variant="ghost"
										size="sm"
										loading={mine && last === "withdraw" && withdraw.pending}
										disabled={busy !== null && !mine}
										onClick={() => act("withdraw", invitation)}
										aria-label={`Withdraw the invitation to ${name}`}
									>
										Withdraw
									</Button>
								</div>
							) : null}
						</li>
					);
				})}
			</ul>
			<ProblemLine
				problem={problem}
				refused={
					last === "withdraw"
						? "The invitation was not withdrawn. It may have been answered already. Reload to see its current state."
						: undefined
				}
			/>
		</section>
	);
}
