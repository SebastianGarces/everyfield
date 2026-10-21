"use client";

import { invitationCommandRequest } from "@everyfield/contracts/organizations";
import { ChurchIcon, HierarchyIcon, Link01Icon, MailSend01Icon } from "@hugeicons/core-free-icons";
import { Button, Card, CardIcon, Skeleton } from "@everyfield/ui/controls";
import { LoadableView } from "@everyfield/ui/display";
import { useCallback, useState } from "react";
import { NotAvailable } from "../access/AccessStates";
import { EndDialog, type EndConnection, type Side } from "./EndDialog";
import { HistoryList, otherSide, type ReadHistory } from "./History";
import { useIntent, useLoad } from "./intent";
import { InviteDialog, type InviteTarget, type ReadDisclosure } from "./InviteDialog";
import { formatDay, kindLabel, subjectOf } from "./model";
import { ProblemLine } from "./parts";
import { SharingChoices, type ReadSharing, type SaveSharing, type SharingRow } from "./Sharing";
import type { History, NameOf, PendingInvitation, Relationship, Run } from "./port";

/**
 * One read of the list: the first history page with the current connections, the requests still waiting, and for a
 * plant what each connection sees, keyed by relationship id.
 */
export type ConnectionsData = {
	history: { status: "unavailable" } | History;
	pending: PendingInvitation[];
	sharing: Record<string, SharingRow>;
};

/**
 * The connections of one plant, sending church or Discovery account, or of one organization, with their history
 * (REQ-IDN-020, REQ-IDN-021). Several connections can exist at once and each one is ended on its own. The server
 * renders the first list with the page. Each confirmed command answers with what changed (the invitation, the history
 * as it is now, the sharing as saved), and the list applies that answer: one request, no reload. The list reads again
 * only after an unconfirmed command. `canManage` only hides controls; the server still checks every command.
 */
export function Connections({
	side,
	load,
	readMore,
	canManage,
	nameOf,
	zone,
	run,
	end,
	invite,
	readSharing,
	initial,
}: {
	/** `subject` words the list for the side that asks to connect; `organization` for the side that receives. */
	side: Side;
	load: () => Promise<ConnectionsData>;
	/** The list as the server rendered it with the page, so the first paint needs no second read. */
	initial?: ConnectionsData;
	readMore: ReadHistory;
	canManage: boolean;
	nameOf: NameOf;
	zone: string;
	run: Run;
	end: EndConnection;
	/** Present when this viewer can ask organizations to connect. */
	invite?: { targets: InviteTarget[]; readDisclosure: ReadDisclosure; expectedRevision: string };
	/** Present for a plant: each connection row shows what that organization can see, and saves a change. */
	readSharing?: { read: ReadSharing; save: SaveSharing };
}) {
	const [status, setStatus] = useState("");
	const fetch = useCallback(() => load(), [load]);
	const { state, reload, update, refreshing } = useLoad<ConnectionsData>(fetch, "Connections did not load", initial);
	const changePending = (change: (p: PendingInvitation[]) => PendingInvitation[]) =>
		update((d) => ({ ...d, pending: change(d.pending) }));

	const subject = side === "subject";
	const titleId = `${side}-connections-title`;

	return (
		<Card as="section" aria-labelledby={titleId}>
			<div className="flex flex-wrap items-start gap-x-4 gap-y-3">
				<div className="min-w-0 flex-1 basis-64">
					<h2 id={titleId} className="font-title text-title-sm tracking-[-0.02em] text-ink">
						{subject ? "Connections" : "Connected churches"}
					</h2>
					<p className="mt-1 text-text-2">
						{subject
							? "Sending churches and networks you work with. Each one sees only what you choose to share with it."
							: "Churches that chose to connect with you. You see only what each one shares."}
					</p>
				</div>
				{canManage && invite ? (
					<InviteDialog
						targets={state.status === "ready" ? available(invite.targets, state.data.history) : invite.targets}
						readDisclosure={invite.readDisclosure}
						expectedRevision={invite.expectedRevision}
						run={run}
						onSent={(invitation, target) => {
							setStatus(`Invitation sent. ${target.name} has 30 days to accept.`);
							changePending((p) => [invitation, ...p.filter((i) => i.invitationId !== invitation.invitationId)]);
						}}
						onUnconfirmed={reload}
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
				{({ history, pending, sharing }) =>
					history.status === "unavailable" ? (
						<NotAvailable scope="section" />
					) : (
						<>
							<ActiveList
								side={side}
								history={history}
								sharing={sharing}
								canManage={canManage}
								nameOf={nameOf}
								zone={zone}
								end={end}
								onEnded={(name, history) => {
									if (!history) return reload();
									setStatus(`The connection with ${name} ended.`);
									update((d) => ({ ...d, history }));
								}}
								readSharing={readSharing}
								onRevision={(relationshipId, revision) =>
									update((d) => ({ ...d, history: withRevision(d.history, relationshipId, revision) }))
								}
								stale={refreshing}
							/>
							{invite && pending.length > 0 ? (
								<PendingList
									invitations={pending}
									canManage={canManage}
									nameOf={nameOf}
									zone={zone}
									run={run}
									onChange={(text, change) => {
										setStatus(text);
										changePending(change);
									}}
									onStale={reload}
									stale={refreshing}
								/>
							) : null}
							{canManage ? null : <p className="mt-4 text-sm text-text-3">Owners and Admins manage connections.</p>}
							<section aria-labelledby={`${titleId}-history`} className="mt-8">
								<h3 id={`${titleId}-history`} className="font-semibold text-ink">
									History
								</h3>
								<HistoryList
									key={history.items.map((r) => r.id).join()}
									first={history}
									read={readMore}
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

type EndAnswer = Parameters<Parameters<typeof EndDialog>[0]["onEnded"]>[0];
type SharingPort = { read: ReadSharing; save: SaveSharing };

/** Organizations this viewer may ask, without the ones it is connected with now as the asking side. */
function available(targets: InviteTarget[], history: ConnectionsData["history"]) {
	if (history.status !== "available") return targets;
	const connected = new Set(
		history.activeRelationships
			.filter((r) => sideIn(history.scope, r) === "subject")
			.map((r) => r.pair.organization.id),
	);
	return targets.filter((t) => !connected.has(t.pair.organization.id));
}

/** The history with one current connection's new revision, after a sharing change moved it. */
function withRevision(history: ConnectionsData["history"], relationshipId: string, revision: string) {
	if (history.status !== "available") return history;
	return {
		...history,
		activeRelationships: history.activeRelationships.map((r) =>
			r.id === relationshipId ? { ...r, revision: revision as Relationship["revision"] } : r,
		),
	};
}

/** The side this viewer holds in one connection: the receiving organization, or the side that asked. */
function sideIn(scope: History["scope"], relationship: Relationship): Side {
	return "organization" in scope && scope.organization.id === relationship.pair.organization.id
		? "organization"
		: "subject";
}

function ActiveList({
	side,
	history,
	canManage,
	nameOf,
	zone,
	end,
	onEnded,
	readSharing,
	sharing,
	onRevision,
	stale,
}: {
	side: Side;
	history: History;
	canManage: boolean;
	nameOf: NameOf;
	zone: string;
	end: EndConnection;
	onEnded: (name: string, history: EndAnswer) => void;
	readSharing?: SharingPort;
	sharing: Record<string, SharingRow>;
	onRevision: (relationshipId: string, revision: string) => void;
	stale: boolean;
}) {
	const rows = history.activeRelationships;
	if (rows.length === 0)
		return (
			<p className="mt-5 text-text-2">
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
					side={sideIn(history.scope, relationship)}
					relationship={relationship}
					name={otherSide(history.scope, relationship.pair, nameOf)}
					canManage={canManage}
					zone={zone}
					end={end}
					onEnded={onEnded}
					readSharing={readSharing}
					sharing={sharing[relationship.id]}
					onRevision={onRevision}
					stale={stale}
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
	end,
	onEnded,
	readSharing,
	sharing,
	onRevision,
	stale,
}: {
	side: Side;
	relationship: Relationship;
	name: string;
	canManage: boolean;
	zone: string;
	end: EndConnection;
	onEnded: (name: string, history: EndAnswer) => void;
	readSharing?: SharingPort;
	/** What this connection sees, as the list read it; a save answers with it as saved. */
	sharing?: SharingRow;
	onRevision: (relationshipId: string, revision: string) => void;
	/** The list is reloading; this row's revision may be old, so Leave waits. */
	stale: boolean;
}) {
	const subject = side === "subject";
	const other = subject ? relationship.pair.organization : subjectOf(relationship.pair);
	const kind =
		other.kind === "organization" ? kindLabel(other) : other.kind === "plant" ? "Church plant" : "Discovery account";
	return (
		<li className="border-t border-line py-3.5 first:border-t-0">
			<div className="flex items-center gap-3">
				<CardIcon icon={other.kind === "organization" ? HierarchyIcon : ChurchIcon} tone="blue" size={36} />
				<div className="min-w-0 flex-1">
					<p className="font-semibold text-ink">{name}</p>
					<p className="text-sm text-text-3">
						{kind} · connected{" "}
						<time dateTime={relationship.acceptedAt}>{formatDay(relationship.acceptedAt, zone)}</time>
					</p>
				</div>
				{canManage ? (
					<EndDialog
						side={side}
						relationship={relationship}
						otherName={name}
						end={end}
						onEnded={(history) => onEnded(name, history)}
						trigger={
							<Button
								variant="ghost"
								size="sm"
								disabled={stale}
								aria-label={subject ? `Leave ${name}` : `End connection with ${name}`}
							>
								{subject ? "Leave" : "End connection"}
							</Button>
						}
					/>
				) : null}
			</div>
			{subject && readSharing && relationship.pair.kind === "plant" ? (
				<div className="mt-2 pl-12 max-app-sm:pl-0">
					<SharingChoices
						relationship={relationship}
						organizationName={name}
						initial={sharing}
						read={readSharing.read}
						save={readSharing.save}
						onChanged={(revision) => onRevision(relationship.id, revision)}
					/>
				</div>
			) : null}
		</li>
	);
}

type Action = "resend" | "withdraw";
type InvitationCommand = ReturnType<typeof invitationCommandRequest.parse>;

const RESEND_REFUSED: Record<string, string> = {
	resend_cooldown: "This invitation was sent a moment ago. Wait a few minutes, then resend it.",
};

/**
 * Invitations this subject sent that are still waiting (REQ-IDN-020). Resend sends a fresh link and a new 30 days;
 * withdraw cancels the request. Each row keeps its own frozen command, so a lost reply on one row never sends its
 * request key with another invitation or another action. Until it is resolved or the list reloads, the other
 * controls wait.
 */
function PendingList({
	invitations,
	canManage,
	nameOf,
	zone,
	run,
	onChange,
	onStale,
	stale,
}: {
	invitations: PendingInvitation[];
	canManage: boolean;
	nameOf: NameOf;
	zone: string;
	run: Run;
	/** A confirmed command: what to say, and the list as it is now. */
	onChange: (status: string, change: (list: PendingInvitation[]) => PendingInvitation[]) => void;
	/** After an unconfirmed command: read the list again. */
	onStale: () => void;
	stale: boolean;
}) {
	const resend = useIntent<InvitationCommand>("relationship-resend");
	const withdraw = useIntent<InvitationCommand>("relationship-withdraw");
	const [last, setLast] = useState<Action>("resend");
	const intent = last === "resend" ? resend : withdraw;
	const busy = resend.pending ?? withdraw.pending;
	const held = resend.held ?? withdraw.held;

	const act = async (action: Action, invitation: PendingInvitation) => {
		setLast(action);
		const make = (requestKey: string) =>
			invitationCommandRequest.parse({
				requestKey,
				expectedRevision: invitation.revision,
				input: { invitationId: invitation.invitationId },
			});
		const name = nameOf(invitation.pair.organization);
		const id = invitation.invitationId;
		if (action === "resend") {
			const result = await resend.run(
				id,
				make,
				(command) => run("associations.resendInvitation", command),
				() => true,
			);
			if (result.ok)
				onChange(`A new link went to ${name}.`, (list) => list.map((i) => (i.invitationId === id ? result.reply : i)));
			return;
		}
		const result = await withdraw.run(
			id,
			make,
			(command) => run("associations.revokeInvitation", command),
			(r) => r.status === "committed",
		);
		if (result.ok)
			onChange(`The invitation to ${name} was withdrawn.`, (list) => list.filter((i) => i.invitationId !== id));
	};

	return (
		<section aria-labelledby="pending-invitations" className="mt-6">
			<h3 id="pending-invitations" className="font-semibold text-ink">
				Waiting for a reply
			</h3>
			<ul className="mt-2 flex flex-col">
				{invitations.map((invitation) => {
					const name = nameOf(invitation.pair.organization);
					const slot = invitation.invitationId;
					// While any command is in flight or unconfirmed, only that row's same action stays usable.
					const lockedTo: Action | null =
						resend.held === slot || resend.pending === slot
							? "resend"
							: withdraw.held === slot || withdraw.pending === slot
								? "withdraw"
								: null;
					const elsewhere = ((held !== null || busy !== null) && lockedTo === null) || (stale && lockedTo === null);
					return (
						<li
							key={slot}
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
										loading={resend.pending === slot}
										disabled={elsewhere || lockedTo === "withdraw"}
										onClick={() => act("resend", invitation)}
										aria-label={`${resend.held === slot ? "Try resending" : "Resend"} the invitation to ${name}`}
									>
										{resend.held === slot ? "Try again" : "Resend"}
									</Button>
									<Button
										variant="ghost"
										size="sm"
										loading={withdraw.pending === slot}
										disabled={elsewhere || lockedTo === "resend"}
										onClick={() => act("withdraw", invitation)}
										aria-label={`${withdraw.held === slot ? "Try withdrawing" : "Withdraw"} the invitation to ${name}`}
									>
										{withdraw.held === slot ? "Try again" : "Withdraw"}
									</Button>
								</div>
							) : null}
						</li>
					);
				})}
			</ul>
			<ProblemLine
				problem={intent.problem}
				refused={
					last === "withdraw"
						? "The invitation was not withdrawn. It may have been answered already."
						: (RESEND_REFUSED[intent.code ?? ""] ?? "The invitation was not sent again. Nothing changed.")
				}
				action={
					<Button
						size="sm"
						variant="secondary"
						onClick={() => {
							intent.release();
							onStale();
						}}
					>
						Reload the list
					</Button>
				}
			/>
		</section>
	);
}
