"use client";

import {
	appointAdminRequest,
	demoteSeatRequest,
	invitationListResult,
	inviteSeatRequest,
	normalizedEmail,
	resendInvitationRequest,
	revokeInvitationRequest,
	seatListResult,
	seatMutationResult,
	invitationRevokedResult,
	invitationSentResult,
} from "@everyfield/contracts/identity";
import { Mail01Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardDescription,
	CardTitle,
	ConfirmDialog,
	Field,
	Input,
	PageHeader,
	Select,
} from "@everyfield/ui/controls";
import { Avatar, Tag } from "@everyfield/ui/display";
import { Icon } from "@everyfield/ui/foundations";
import { useCallback, useRef, useState, type FormEvent } from "react";
import { NotAvailable } from "../../access/AccessStates";
import { Refusal, useIntent } from "../../organizations/intent";
import { ProblemLine } from "../../organizations/parts";
import { FormMessage } from "../parts";
import { readSeats, readSeatsPage, runSeatCommand, type SeatOperation } from "./actions";
import { RemoveDialog } from "./RemoveDialog";
import {
	emailProblem,
	formatMoment,
	invitationText,
	joinedText,
	placeWord,
	ROLE_NAME,
	type Invitations,
	type PendingInvitation,
	parseSeats,
	type Seat,
	type SeatsData,
	withInvitation,
	withoutInvitation,
	withPage,
	withRemoved,
	withRole,
} from "./model";

// /settings/seats on the real WP-008 API (REQ-IDN-017, REQ-IDN-019). Everyone with a seat reads the roster. Owners and
// Admins also invite, resend and revoke, and change or remove ordinary seats; the server returns which actions each
// seat allows, and the page shows only those. A confirmed change updates the lists from its answer, in one request.
// A refusal means the page was out of date: the lists load again, and while they load nothing that would carry an old
// revision can be sent.

async function send<T>(op: SeatOperation, command: unknown, schema: { parse: (v: unknown) => T }): Promise<T> {
	const reply = await runSeatCommand(op, command);
	if (reply.status === "refused") throw new SeatRefusal(reply.code, reply.retryAt);
	return schema.parse(reply.value);
}

class SeatRefusal extends Refusal {
	constructor(
		code: string,
		readonly retryAt: string | null,
	) {
		super(code);
	}
}

type Load = { attempt: number; data: SeatsData } | { attempt: number; gone: true };

export function SeatsScreen({ initial }: { initial: SeatsData }) {
	const [state, setState] = useState<Load>({ attempt: 0, data: initial });
	const [refreshing, setRefreshing] = useState(false);
	const [reloadFailed, setReloadFailed] = useState(false);
	const [status, setStatus] = useState<string | null>(null);
	const attempt = useRef(0);

	// A reload belongs to one attempt, so a slow earlier reply never replaces a later one.
	const reload = useCallback(async () => {
		const mine = ++attempt.current;
		setRefreshing(true);
		setReloadFailed(false);
		try {
			const r = await readSeats();
			if (mine !== attempt.current) return;
			setState(r.status === "ready" ? { attempt: mine, data: parseSeats(r) } : { attempt: mine, gone: true });
		} catch {
			if (mine === attempt.current) setReloadFailed(true);
		} finally {
			if (mine === attempt.current) setRefreshing(false);
		}
	}, []);

	if ("gone" in state)
		return (
			<Shell title="Seats and invitations" subtitle={null}>
				<Card>
					<NotAvailable scope="section" headingLevel="h2" />
				</Card>
			</Shell>
		);
	const data = state.data;
	const place = placeWord(data.kind);
	/** A confirmed answer, applied to the lists on screen. A message, when given, replaces the last one. */
	const apply: Apply = (change, message) => {
		setState((s) => ("gone" in s ? s : { ...s, data: change(s.data) }));
		if (message !== undefined) setStatus(message);
	};
	/** The page was out of date, or the viewer's own seat changed: the lists load again. */
	const stale = (message: string | null = null) => {
		setStatus(message);
		void reload();
	};
	return (
		<Shell
			title="Seats and invitations"
			subtitle={
				data.canManage
					? `People who can sign in to ${data.workspaceName}. People in your directory do not need a seat.`
					: `People who can sign in to ${data.workspaceName}. Owners and Admins manage seats.`
			}
		>
			<div role="status" className="empty:hidden">
				{status ? <FormMessage tone="success">{status}</FormMessage> : null}
			</div>
			{reloadFailed ? (
				<ProblemLine
					problem="refused"
					refused="The latest seats did not load. Check your connection, then load them again."
					action={
						<Button size="sm" variant="secondary" onClick={() => void reload()}>
							Load again
						</Button>
					}
				/>
			) : null}
			{data.canManage ? (
				<InviteCard key={state.attempt} data={data} refreshing={refreshing} onApply={apply} onStale={stale} />
			) : null}
			<RosterCard data={data} refreshing={refreshing} onApply={apply} onStale={stale} />
			{data.canManage && data.invitations ? (
				<PendingCard
					data={data}
					invitations={data.invitations}
					refreshing={refreshing}
					onApply={apply}
					onStale={stale}
					place={place}
				/>
			) : null}
		</Shell>
	);
}

function Shell({ title, subtitle, children }: { title: string; subtitle: string | null; children: React.ReactNode }) {
	return (
		<div className="mx-auto flex max-w-[880px] flex-col gap-6">
			<PageHeader title={title} subtitle={subtitle ?? undefined} className="mb-0" />
			{children}
		</div>
	);
}

type Apply = (change: (d: SeatsData) => SeatsData, message?: string | null) => void;
type Changes = { onApply: Apply; onStale: (message?: string | null) => void };

type InviteCommand = ReturnType<typeof inviteSeatRequest.parse>;
const ROLE_OPTIONS = [
	{ value: "member", label: "Member" },
	{ value: "admin", label: "Admin" },
];

function inviteRefused(code: string | null, retryAt: string | null, zone: string, place: string): string {
	switch (code) {
		case "invitation_rate_limited":
			return `This address has had 3 invitations in the last 30 days.${retryAt ? ` You can invite it again after ${formatMoment(retryAt, zone)}.` : ""}`;
		case "invitation_unavailable":
			return "An invitation to this address is already waiting. Resend it from the list below.";
		case "conflict":
			return `Your ${place} changed since this page loaded. Reload the page, then send again.`;
		default:
			return "The invitation was not sent. Nothing changed.";
	}
}

/**
 * Invite one address to an ordinary seat (seats.invite). When the reply is lost the fields lock and Try again
 * resends that same command, so a retry never carries an edited address or role under the old request key.
 */
function InviteCard({
	data,
	refreshing,
	onApply,
	onStale,
}: {
	data: SeatsData;
	refreshing: boolean;
} & Changes) {
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<"member" | "admin">("member");
	const [checked, setChecked] = useState(false);
	const [retryAt, setRetryAt] = useState<string | null>(null);
	const intent = useIntent<InviteCommand>("seat-invite");
	const locked = intent.held !== null || intent.pending !== null;
	const parsed = normalizedEmail.safeParse(email);
	const problem = checked ? emailProblem(email, parsed.success) : undefined;
	const emailRef = useRef<HTMLInputElement>(null);
	const place = placeWord(data.kind);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setChecked(true);
		if (!intent.held && (!parsed.success || emailProblem(email, true))) {
			emailRef.current?.focus();
			return;
		}
		const result = await intent.run(
			"invite",
			(requestKey) =>
				inviteSeatRequest.parse({
					requestKey,
					expectedRevision: data.revision,
					input: { workspace: data.workspace, recipientEmail: parsed.data, role },
				}),
			async (command) => {
				try {
					return await send("invite", command, invitationSentResult);
				} catch (e) {
					setRetryAt(e instanceof SeatRefusal ? e.retryAt : null);
					throw e;
				}
			},
			() => true,
		);
		if (result.ok) {
			setEmail("");
			setChecked(false);
			const invitation = result.reply.invitation;
			onApply((d) => withInvitation(d, invitation), `Invitation sent to ${invitation.recipientEmail}.`);
		}
	}

	return (
		<Card as="section" aria-labelledby="invite-title">
			<CardTitle id="invite-title" size="sm">
				Invite someone
			</CardTitle>
			<CardDescription>They get an email link that works for 30 days.</CardDescription>
			<form
				noValidate
				onSubmit={submit}
				className="mt-4 flex items-start gap-3 max-app-sm:flex-col max-app-sm:items-stretch"
			>
				<Field label="Email address" error={problem} className="min-w-0 flex-1">
					<Input
						ref={emailRef}
						name="email"
						type="email"
						icon={Mail01Icon}
						autoComplete="off"
						inputMode="email"
						spellCheck={false}
						autoCapitalize="none"
						value={email}
						readOnly={locked}
						onChange={(e) => setEmail(e.target.value)}
					/>
				</Field>
				<Field label="Role" className="w-[150px] max-app-sm:w-full">
					<Select
						options={ROLE_OPTIONS}
						value={role}
						disabled={locked}
						onValueChange={(v) => setRole(v === "admin" ? "admin" : "member")}
					/>
				</Field>
				<Button
					type="submit"
					variant="primary"
					className="mt-[22px] max-app-sm:mt-0"
					loading={intent.pending !== null}
					disabled={refreshing && !intent.held}
				>
					{intent.held ? "Try again" : "Send invitation"}
				</Button>
			</form>
			<ProblemLine
				problem={intent.problem}
				refused={inviteRefused(intent.code, retryAt, data.zone, place)}
				action={
					intent.held ? (
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
					) : undefined
				}
			/>
		</Card>
	);
}

type RoleCommand = ReturnType<typeof appointAdminRequest.parse> | ReturnType<typeof demoteSeatRequest.parse>;
function RosterCard({
	data,
	refreshing,
	onApply,
	onStale,
}: {
	data: SeatsData;
	refreshing: boolean;
} & Changes) {
	const roleIntent = useIntent<RoleCommand>("seat-role");
	const [more, setMore] = useState<"idle" | "loading" | "failed">("idle");
	const items = data.roster.items;
	const next = data.roster.next;
	// The Owner first, then everyone by name. The server pages by seat ID, which says nothing to a reader.
	const active = items
		.filter((s) => s.status === "active")
		.sort(
			(a, b) => Number(b.role === "owner") - Number(a.role === "owner") || a.displayName.localeCompare(b.displayName),
		);
	const removed = items.filter((s) => s.status === "removed");
	const busy = roleIntent.pending;
	const held = roleIntent.held;

	async function changeRole(seat: Seat, to: "admin" | "member") {
		const result = await roleIntent.run(
			seat.seatId,
			(requestKey) =>
				to === "admin"
					? appointAdminRequest.parse({
							requestKey,
							expectedRevision: seat.revision,
							input: { seatId: seat.seatId, expectedRole: "member", to: "admin" },
						})
					: demoteSeatRequest.parse({
							requestKey,
							expectedRevision: seat.revision,
							input: { seatId: seat.seatId, expectedRole: "admin", to: "member" },
						}),
			(command) => send(command.input.to === "admin" ? "appointAdmin" : "demote", command, seatMutationResult),
			() => true,
		);
		const said = `${seat.displayName} is now ${to === "admin" ? "an Admin" : "a Member"}.`;
		// Your own role decides what this page offers you, so a change to it loads the page again.
		if (result.ok && seat.isSelf) onStale(said);
		else if (result.ok) onApply((d) => withRole(d, seat.seatId, to, result.reply.revision), said);
		// A refusal means this screen was out of date; load the current roles and revisions at once.
		else if (result.problem === "refused") onStale();
	}

	async function loadMore() {
		if (!next) return;
		setMore("loading");
		try {
			const r = await readSeatsPage("seats", next);
			if (r.status !== "ok") throw new Error("refused");
			const page = seatListResult.parse(r.value);
			onApply((d) => withPage(d, { list: "seats", value: page }));
			setMore("idle");
		} catch {
			setMore("failed");
		}
	}

	const roleProblem = roleIntent.problem;
	return (
		<Card as="section" aria-labelledby="roster-title" aria-busy={refreshing}>
			<div className="flex items-baseline justify-between gap-3">
				<CardTitle id="roster-title" size="sm">
					Seats
				</CardTitle>
				<span className="text-sm text-text-3">{active.length === 1 ? "1 seat" : `${active.length} seats`}</span>
			</div>
			<ul className="mt-3 flex flex-col">
				{active.map((seat) => {
					const canRole = seat.allowedActions.includes("appoint_admin") || seat.allowedActions.includes("demote");
					const canRemove = seat.allowedActions.includes("remove");
					// While any command waits or is unconfirmed, only that seat's own controls stay usable.
					const mine = roleIntent.held === seat.seatId || roleIntent.pending === seat.seatId;
					const elsewhere = ((held !== null || busy !== null) && !mine) || refreshing;
					return (
						<li
							key={seat.seatId}
							className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line py-3.5 first:border-t-0"
						>
							<Avatar name={seat.displayName} tone={seat.isSelf ? "green" : "blue"} size="sm" decorative />
							<div className="min-w-0 flex-1 basis-48">
								<p className="font-semibold text-ink">
									{seat.displayName}
									{seat.isSelf ? <span className="ml-1 text-sm font-normal text-text-3">(you)</span> : null}
								</p>
								<p className="text-sm text-text-3">{joinedText(seat, data.zone)}</p>
							</div>
							<div className="flex items-center gap-2 max-app-sm:w-full max-app-sm:pl-11">
								{canRole ? (
									<>
										<Select
											aria-label={`Role for ${seat.displayName}`}
											options={ROLE_OPTIONS}
											value={mine && roleIntent.held ? (seat.role === "admin" ? "member" : "admin") : seat.role}
											disabled={elsewhere || mine}
											onValueChange={(v) => {
												if (v !== seat.role) void changeRole(seat, v === "admin" ? "admin" : "member");
											}}
											className="h-[34px] w-[130px]"
										/>
										{roleIntent.held === seat.seatId ? (
											<Button
												size="sm"
												variant="secondary"
												loading={roleIntent.pending === seat.seatId}
												onClick={() => void changeRole(seat, seat.role === "admin" ? "member" : "admin")}
											>
												Try again
											</Button>
										) : null}
									</>
								) : (
									<Tag>{ROLE_NAME[seat.role]}</Tag>
								)}
								{canRemove ? (
									<RemoveDialog
										seat={seat}
										workspaceName={data.workspaceName}
										onRemoved={(said, revision) =>
											seat.isSelf ? onStale(said) : onApply((d) => withRemoved(d, seat.seatId, revision), said)
										}
										onClosedUnconfirmed={() => onStale()}
										trigger={
											<Button
												variant="ghost"
												size="sm"
												disabled={elsewhere || mine}
												aria-label={`Remove ${seat.displayName}'s seat`}
											>
												Remove
											</Button>
										}
									/>
								) : null}
							</div>
						</li>
					);
				})}
			</ul>
			<ProblemLine
				problem={roleProblem}
				refused="The role did not change. Someone may have changed this seat, so the list was loaded again. Try again if you still want the change."
				action={
					roleIntent.held ? (
						<Button
							size="sm"
							variant="secondary"
							onClick={() => {
								roleIntent.release();
								onStale();
							}}
						>
							Reload the list
						</Button>
					) : undefined
				}
			/>
			{next ? (
				<div className="mt-3 flex items-center gap-3">
					<Button size="sm" variant="secondary" loading={more === "loading"} onClick={() => void loadMore()}>
						Show more seats
					</Button>
					{more === "failed" ? (
						<p role="alert" className="text-sm text-magenta-600">
							More seats did not load. Try again.
						</p>
					) : null}
				</div>
			) : null}
			{removed.length ? (
				<details className="mt-4 border-t border-line pt-3">
					<summary className="cursor-pointer rounded-sm text-sm font-medium text-text-2">
						Removed seats ({removed.length})
					</summary>
					<ul className="mt-2 flex flex-col">
						{removed.map((seat) => (
							<li key={seat.seatId} className="flex items-center gap-3 py-2.5">
								<Avatar name={seat.displayName} tone="ink" size="xs" decorative />
								<p className="min-w-0 flex-1 text-sm text-text-2">{seat.displayName}</p>
								<Tag>Removed</Tag>
							</li>
						))}
					</ul>
				</details>
			) : null}
		</Card>
	);
}

type InvitationCommand = ReturnType<typeof resendInvitationRequest.parse>;
type Action = "resend" | "revoke";

function resendRefused(code: string | null, retryAt: string | null, zone: string): string {
	if (code === "invitation_cooldown")
		return retryAt
			? `This invitation was just sent. You can resend it after ${formatMoment(retryAt, zone)}.`
			: "This invitation was just sent. Wait a minute, then resend it.";
	return "The invitation was not sent again. It may have been accepted or revoked. Reload the list.";
}

/**
 * Pending invitations (seats.listInvitations, REQ-IDN-017). Resend sends a fresh link and the old one stops working;
 * revoke stops the link. Each row keeps its own frozen command, so a lost reply on one row never sends its request key
 * with another invitation or action.
 */
function PendingCard({
	data,
	invitations,
	refreshing,
	onApply,
	onStale,
	place,
}: {
	data: SeatsData;
	invitations: Invitations;
	refreshing: boolean;
	place: string;
} & Changes) {
	const resend = useIntent<InvitationCommand>("seat-resend");
	const revoke = useIntent<InvitationCommand>("seat-revoke");
	const [last, setLast] = useState<Action>("resend");
	const [retryAt, setRetryAt] = useState<string | null>(null);
	const [more, setMore] = useState<"idle" | "loading" | "failed">("idle");
	const items = invitations.items;
	const next = invitations.next;
	const intent = last === "resend" ? resend : revoke;
	const busy = resend.pending ?? revoke.pending;
	const held = resend.held ?? revoke.held;

	async function act(action: Action, invitation: PendingInvitation) {
		setLast(action);
		const make = (requestKey: string) =>
			(action === "resend" ? resendInvitationRequest : revokeInvitationRequest).parse({
				requestKey,
				expectedRevision: invitation.revision,
				input: { invitationId: invitation.invitationId },
			});
		if (action === "resend") {
			const result = await resend.run(
				invitation.invitationId,
				make,
				async (command) => {
					try {
						return await send("resend", command, invitationSentResult);
					} catch (e) {
						setRetryAt(e instanceof SeatRefusal ? e.retryAt : null);
						throw e;
					}
				},
				() => true,
			);
			if (result.ok)
				onApply(
					(d) => withInvitation(d, result.reply.invitation),
					`A new link went to ${invitation.recipientEmail}. The old link no longer works.`,
				);
			return;
		}
		const result = await revoke.run(
			invitation.invitationId,
			make,
			(c) => send("revoke", c, invitationRevokedResult),
			() => true,
		);
		if (result.ok)
			return onApply(
				(d) => withoutInvitation(d, invitation.invitationId),
				`The invitation to ${invitation.recipientEmail} was revoked.`,
			);
		throw new Error(
			result.problem === "unknown"
				? "We could not confirm this. Check your connection, then select Revoke again. It never revokes twice."
				: result.problem === "busy"
					? "Another change is still on its way. Wait for it, then try again."
					: "The invitation was not revoked. It may have been accepted already. Reload the list.",
		);
	}

	async function loadMore() {
		if (!next) return;
		setMore("loading");
		try {
			const r = await readSeatsPage("invitations", next);
			if (r.status !== "ok") throw new Error("refused");
			const page = invitationListResult.parse(r.value);
			onApply((d) => withPage(d, { list: "invitations", value: page }));
			setMore("idle");
		} catch {
			setMore("failed");
		}
	}

	return (
		<Card as="section" aria-labelledby="pending-title" aria-busy={refreshing}>
			<div className="flex items-baseline justify-between gap-3">
				<CardTitle id="pending-title" size="sm">
					Waiting for an answer
				</CardTitle>
				<span className="text-sm text-text-3">{items.length}</span>
			</div>
			{items.length === 0 ? (
				<p className="mt-2 text-sm text-text-3">
					No invitations are waiting. Invitations you send appear here until they are accepted or expire.
				</p>
			) : (
				<ul className="mt-3 flex flex-col">
					{items.map((invitation) => {
						const slot = invitation.invitationId;
						const lockedTo: Action | null =
							resend.held === slot || resend.pending === slot
								? "resend"
								: revoke.held === slot || revoke.pending === slot
									? "revoke"
									: null;
						const elsewhere =
							((held !== null || busy !== null) && lockedTo === null) || (refreshing && lockedTo === null);
						return (
							<li
								key={slot}
								className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line py-3.5 first:border-t-0"
							>
								<span
									aria-hidden="true"
									className="grid size-8 flex-none place-items-center rounded-full border-[1.5px] border-dashed border-line-2 text-text-3"
								>
									<Icon icon={Mail01Icon} size={16} />
								</span>
								<div className="min-w-0 flex-1 basis-48">
									<p className="font-semibold break-all text-ink">{invitation.recipientEmail}</p>
									<p className="text-sm text-text-3">{invitationText(invitation, data.zone)}</p>
								</div>
								<div className="flex gap-2 max-app-sm:w-full max-app-sm:pl-11">
									<Button
										variant="secondary"
										size="sm"
										loading={resend.pending === slot}
										disabled={elsewhere || lockedTo === "revoke"}
										onClick={() => void act("resend", invitation)}
										aria-label={`${resend.held === slot ? "Try resending" : "Resend"} the invitation to ${invitation.recipientEmail}`}
									>
										{resend.held === slot ? "Try again" : "Resend"}
									</Button>
									<ConfirmDialog
										title="Revoke this invitation?"
										description={`The link sent to ${invitation.recipientEmail} stops working. You can invite them to your ${place} again later.`}
										confirmLabel="Revoke invitation"
										onConfirm={() => act("revoke", invitation)}
										trigger={
											<Button
												variant="ghost"
												size="sm"
												disabled={elsewhere || lockedTo === "resend"}
												aria-label={`Revoke the invitation to ${invitation.recipientEmail}`}
											>
												Revoke
											</Button>
										}
									/>
								</div>
							</li>
						);
					})}
				</ul>
			)}
			{last === "resend" ? (
				<ProblemLine
					problem={intent.problem}
					refused={resendRefused(intent.code, retryAt, data.zone)}
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
			) : null}
			{next ? (
				<div className="mt-3 flex items-center gap-3">
					<Button size="sm" variant="secondary" loading={more === "loading"} onClick={() => void loadMore()}>
						Show more invitations
					</Button>
					{more === "failed" ? (
						<p role="alert" className="text-sm text-magenta-600">
							More invitations did not load. Try again.
						</p>
					) : null}
				</div>
			) : null}
		</Card>
	);
}
