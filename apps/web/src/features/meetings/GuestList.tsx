"use client";

import {
	CheckmarkCircle02Icon,
	Delete02Icon,
	MoreHorizontalIcon,
	Note01Icon,
	Tick02Icon,
	UserAdd01Icon,
	UserMultipleIcon,
	UserSwitchIcon,
} from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardHeader,
	CardHeading,
	CardTitle,
	ConfirmDialog,
	Field,
	IconButton,
	Input,
	Menu,
	MenuContent,
	MenuItem,
	MenuLabel,
	MenuSeparator,
	MenuTrigger,
	Radio,
	RadioGroup,
	SegmentedControl,
	StatePanel,
	Textarea,
	useToast,
} from "@everyfield/ui/controls";
import { instant } from "@everyfield/contracts/common";
import { Avatar, DataTable, StatusBadge, type Column } from "@everyfield/ui/display";
import { startTransition, useState } from "react";
import { NoticeInDialog, RecordDialog, RowNotices, SaveNotice, useSaveIntent } from "../../components/save/parts.tsx";
import {
	addAttendeeNote,
	clearCard,
	correctRsvp,
	createGuestContact,
	inviteGuest,
	recordCard,
	removeGuest,
	setInviter,
} from "./actions.ts";
import { PresenceCell, type usePresence } from "./Attendance.tsx";
import { PersonPicker, ReasonDialog, type PickedPerson } from "./dialogs.tsx";
import type { Wait } from "../../components/save/model.ts";
import {
	CARD_LABEL,
	CARD_RESPONSES,
	problemText,
	RSVP_LABEL,
	RSVP_SOURCE_LABEL,
	RSVP_TONE,
	PRESENCE_LABEL,
	rsvpCounts,
	type Attendance,
	type CardResponse,
	type Detail,
	type Guest,
	type Outcome,
	type Presence,
	type Rsvp,
} from "./model.ts";
import { isPending, PENDING, type CardEntry, type Change, type GuestRow, type PendingGuest } from "./page-state.ts";
import { IntentLink } from "./parts.tsx";

type Filter = "all" | Rsvp;
type AddDraft = {
	mode: "existing" | "new";
	person: PickedPerson | null;
	inviter: PickedPerson | null;
	contact: { displayName: string; email: string; phone: string };
};
/**
 * The card's open form with what was entered. A save closes it; a refusal opens it again with the same values and the
 * reason, while it is still the latest form (components/save).
 */
type Form = (
	| { kind: "add"; draft: AddDraft }
	| { kind: "inviter"; guest: Guest; inviter: PickedPerson | null }
	| { kind: "card"; guest: Guest; response: CardResponse | null; notes: string }
	| { kind: "clear"; guest: Guest; reason: string }
	| { kind: "note"; guest: Guest; text: string }
) & { problem?: string };

const STATE_NOTE = { retired: "Retired", merged: "Merged", live: null } as const;
const ACCEPTS_REPLIES = ["planning", "ready", "in_progress"];
const nextRevision = (r: string) => String(BigInt(r) + 1n) as Guest["revision"];
const EMPTY_ADD: AddDraft = {
	mode: "existing",
	person: null,
	inviter: null,
	contact: { displayName: "", email: "", phone: "" },
};

/**
 * The guest list (REQ-MTG-007, REQ-MTG-019): each guest's RSVP, who invited them and, for Vision meetings, their
 * response card. Owners and Admins correct an RSVP from the row menu (REQ-MTG-008, not drawn: composed from Menu).
 * Every change shows at once in the row and the page's counts; the answer confirms it, or the page goes back and says
 * why. A form that fails reopens with what was entered. Before attendance is final, the row menu marks each guest
 * attended, excused or absent (REQ-MTG-010); an attended guest can get a note in their history (REQ-MTG-017).
 */
export function GuestList({
	meeting,
	guests,
	cards,
	attendance,
	presence,
	canMark,
	canWrite,
	project,
	onGuest,
	onRemoved,
	onCard,
	onStale,
}: {
	meeting: Detail;
	guests: GuestRow[] | null;
	cards: CardEntry[] | null;
	attendance: Attendance | null;
	presence: ReturnType<typeof usePresence>;
	/** Presence may change: an Owner or Admin, before attendance is final, on a meeting that is not cancelled. */
	canMark: boolean;
	canWrite: boolean;
	project: (change: Change) => void;
	onGuest: (guest: Guest) => void;
	onRemoved: (guestId: string) => void;
	onCard: (personId: string, card: CardEntry | null) => void;
	onStale: () => void;
}) {
	const toast = useToast();
	const [filter, setFilter] = useState<Filter>("all");
	const [removing, setRemoving] = useState<Guest | null>(null);
	// One save at a time for the whole guest list (C68): RSVP corrections, cards, inviters, adds and removals.
	const lane = useSaveIntent<Form>({ explain: problemText });
	const shown = guests ?? [];
	const vision = meeting.type === "vision_meeting";
	const counts = rsvpCounts(shown);
	const cardOf = new Map((cards ?? []).map((c) => [c.personId, c]));
	const marker = attendance?.viewerCanMarkAttendance === true;
	const final = attendance?.finalized != null;
	const classOf = new Map((attendance?.items ?? []).map((a) => [a.person.personId, a.classification]));
	const rows = filter === "all" ? shown : shown.filter((g) => g.rsvp === filter);
	const open = ACCEPTS_REPLIES.includes(meeting.status);
	const busy = lane.wait !== null;

	/**
	 * One save through the card's lane: `changes` show at once, the answer confirms them, and the lane replays a lost
	 * answer once with the same request key or offers Check again. A refusal puts the page back and says why; out of
	 * date also reads the meeting again.
	 */
	function write<T>(save: {
		what: string;
		done: string;
		changes: Change[];
		form?: Form;
		send: (key: string) => Promise<Outcome<T>>;
		ok: (value: T) => void;
	}) {
		if (busy) return;
		startTransition(async () => {
			for (const c of save.changes) project(c);
			await lane.save({
				...save,
				ok: (value) => startTransition(() => save.ok(value)),
				refused: (code) => code === "conflict" && onStale(),
			});
		});
	}

	function correct(guest: Guest, rsvp: Rsvp) {
		write({
			what: `The RSVP for ${guest.person.displayName}`,
			done: "changed",
			changes: [{ kind: "guest", guest: { ...guest, rsvp, rsvpSource: "admin" } }],
			send: (key) =>
				correctRsvp(key, guest.revision, meeting.id, guest.person.personId, rsvp === "pending" ? null : rsvp),
			ok: (v) => {
				onGuest(v.guest);
				toast({ message: `${guest.person.displayName}: RSVP set to ${RSVP_LABEL[rsvp]}.`, tone: "success" });
			},
		});
	}
	function add(draft: AddDraft) {
		const person = draft.mode === "existing" ? draft.person : null;
		const name = person?.name ?? draft.contact.displayName.trim();
		const input = person
			? { meetingId: meeting.id, personId: person.id, inviterPersonId: draft.inviter?.id ?? null }
			: {
					meetingId: meeting.id,
					displayName: name,
					email: draft.contact.email.trim() || null,
					phone: draft.contact.phone.trim() || null,
					country: "US",
				};
		write({
			what: name,
			done: "added",
			form: { kind: "add", draft },
			changes: [{ kind: "guest", guest: pendingGuest(person, name, person ? draft.inviter : null) }],
			send: (key) => ("personId" in input ? inviteGuest(key, input) : createGuestContact(key, input)),
			ok: (v) => {
				onGuest(v.guest);
				toast({ message: `${v.guest.person.displayName} is on the guest list.`, tone: "success" });
			},
		});
	}
	function changeInviter(guest: Guest, inviter: PickedPerson | null) {
		const id = inviter?.id ?? null;
		write({
			what: `Who invited ${guest.person.displayName}`,
			done: "saved",
			form: { kind: "inviter", guest, inviter },
			changes: [
				{
					kind: "guest",
					guest: {
						...guest,
						inviter: inviter
							? ({ personId: inviter.id, displayName: inviter.name, state: "live" } as Guest["inviter"])
							: null,
					},
				},
			],
			send: (key) => setInviter(key, guest.revision, meeting.id, guest.person.personId, id),
			ok: (v) => onGuest(v.guest),
		});
	}
	function saveCard(guest: Guest, response: CardResponse, notes: string) {
		const input = { meetingId: meeting.id, personId: guest.person.personId, response, notes: notes.trim() || null };
		const before = cardOf.get(guest.person.personId);
		const now = instant.parse(new Date().toISOString());
		write({
			what: `The card for ${guest.person.displayName}`,
			done: "saved",
			form: { kind: "card", guest, response, notes },
			changes: [
				{
					kind: "card",
					personId: guest.person.personId,
					card: before
						? { ...before, response, notes: input.notes }
						: {
								guestId: guest.id,
								personId: guest.person.personId,
								response,
								notes: input.notes,
								occurredAt: now,
								recordedAt: now,
								attended: guest.presence === "attended",
								revision: guest.revision,
							},
				},
				{ kind: "guest", guest: { ...guest, hasCard: true } },
			],
			send: (key) => recordCard(key, guest.revision, input),
			ok: (v) => {
				if (!v.card) return;
				onCard(v.card.personId, v.card);
				onGuest({ ...guest, revision: v.card.revision, hasCard: true });
			},
		});
	}
	function clear(guest: Guest, reason: string) {
		write({
			what: `The card for ${guest.person.displayName}`,
			done: "cleared",
			form: { kind: "clear", guest, reason },
			changes: [
				{ kind: "card", personId: guest.person.personId, card: null },
				{ kind: "guest", guest: { ...guest, hasCard: false } },
			],
			send: (key) => clearCard(key, guest.revision, meeting.id, guest.person.personId, reason),
			ok: () => {
				onCard(guest.person.personId, null);
				onGuest({ ...guest, revision: nextRevision(guest.revision), hasCard: false });
			},
		});
	}
	/** A note about an attendee, kept in their history with this meeting as its source (REQ-MTG-017). */
	function note(guest: Guest, text: string) {
		write({
			what: `The note about ${guest.person.displayName}`,
			done: "saved",
			form: { kind: "note", guest, text },
			changes: [],
			send: (key) => addAttendeeNote(key, meeting.id, guest.person.personId, text),
			ok: () => toast({ message: `The note is in ${guest.person.displayName}'s history.`, tone: "success" }),
		});
	}
	function remove(guest: Guest) {
		write({
			what: guest.person.displayName,
			done: "removed",
			changes: [{ kind: "removeGuest", guestId: guest.id }],
			send: (key) => removeGuest(key, guest.revision, meeting.id, guest.person.personId),
			ok: () => {
				onRemoved(guest.id);
				toast({ message: `${guest.person.displayName} was removed from the guest list.`, tone: "success" });
			},
		});
	}

	const columns: Column<GuestRow>[] = [
		{
			key: "guest",
			header: "Guest",
			cell: (g) => (
				<div className="flex items-center gap-3">
					<Avatar name={g.person.displayName} size="sm" decorative />
					<div className="min-w-0">
						{g.person.state === "live" && !isPending(g) ? (
							<IntentLink
								href={`/people/${g.person.personId}`}
								className="font-medium text-ink underline-offset-4 hover:underline focus-visible:underline"
							>
								{g.person.displayName}
							</IntentLink>
						) : (
							<span className="font-medium text-ink">{g.person.displayName}</span>
						)}
						{isPending(g) ? (
							<p className="text-sm text-text-3">Saving…</p>
						) : STATE_NOTE[g.person.state] ? (
							<p className="text-sm text-text-3">{STATE_NOTE[g.person.state]}</p>
						) : null}
					</div>
				</div>
			),
		},
		{
			key: "inviter",
			header: "Invited by",
			cell: (g) => (g.inviter ? g.inviter.displayName : <span className="text-text-3">Not recorded</span>),
		},
		{
			key: "rsvp",
			header: "RSVP",
			cell: (g) => (
				<div className="flex flex-col items-start gap-1">
					<StatusBadge status={RSVP_TONE[g.rsvp]} size="sm">
						{RSVP_LABEL[g.rsvp]}
					</StatusBadge>
					{g.rsvpSource && g.rsvp !== "pending" ? (
						<span className="text-xs text-text-3">{RSVP_SOURCE_LABEL[g.rsvpSource]}</span>
					) : null}
				</div>
			),
		},
		{
			key: "attendance",
			header: "Attendance",
			cell: (g) => (
				<PresenceCell
					presence={g.presence}
					classification={isPending(g) ? null : (classOf.get(g.person.personId) ?? null)}
					final={final}
					state={isPending(g) ? undefined : presence.stateOf(g.person.personId)}
				/>
			),
		},
		...(vision
			? [
					{
						key: "card",
						header: "Response card",
						cell: (g: GuestRow) => {
							const c = isPending(g) ? undefined : cardOf.get(g.person.personId);
							return c ? CARD_LABEL[c.response] : <span className="text-text-3">No card</span>;
						},
					},
				]
			: []),
		// An Owner or Admin gets the whole menu; the leader of a team meeting gets only attendance (C74).
		...(canWrite || marker
			? [
					{
						key: "actions",
						header: "Actions",
						srOnlyHeader: true,
						align: "right" as const,
						cell: (g: GuestRow) =>
							isPending(g) ? null : (
								<Menu>
									<MenuTrigger asChild>
										<IconButton icon={MoreHorizontalIcon} label={`Actions for ${g.person.displayName}`} size="sm" />
									</MenuTrigger>
									<MenuContent align="end">
										<MenuLabel>Attendance</MenuLabel>
										{(["attended", "excused", "absent"] as const satisfies Presence[]).map((p) => (
											<MenuItem
												key={p}
												icon={Tick02Icon}
												disabled={!canMark || g.presence === p || presence.stateOf(g.person.personId) !== undefined}
												onSelect={() => presence.set(g.person, p)}
											>
												Mark as {PRESENCE_LABEL[p].toLowerCase()}
											</MenuItem>
										))}
										{canWrite && g.presence === "attended" && g.person.state === "live" ? (
											<MenuItem
												icon={Note01Icon}
												disabled={busy}
												onSelect={() => lane.open({ kind: "note", guest: g, text: "" })}
											>
												Add a note to their history
											</MenuItem>
										) : null}
										{canWrite ? (
											<>
												<MenuSeparator />
												<MenuLabel>Correct the RSVP</MenuLabel>
												{(["confirmed", "declined", "pending"] as const).map((r) => (
													<MenuItem
														key={r}
														icon={CheckmarkCircle02Icon}
														disabled={g.rsvp === r || !open || busy}
														onSelect={() => correct(g, r)}
													>
														{r === "pending" ? "Reset to Pending" : `Set to ${RSVP_LABEL[r]}`}
													</MenuItem>
												))}
												<MenuSeparator />
												<MenuItem
													icon={UserSwitchIcon}
													disabled={busy}
													onSelect={() =>
														lane.open({
															kind: "inviter",
															guest: g,
															inviter: g.inviter && { id: g.inviter.personId, name: g.inviter.displayName },
														})
													}
												>
													Change who invited them
												</MenuItem>
												{vision ? (
													<>
														<MenuItem
															icon={Note01Icon}
															disabled={busy}
															onSelect={() => {
																const c = cardOf.get(g.person.personId);
																lane.open({
																	kind: "card",
																	guest: g,
																	response: c?.response ?? null,
																	notes: c?.notes ?? "",
																});
															}}
														>
															{cardOf.has(g.person.personId) ? "Correct response card" : "Record response card"}
														</MenuItem>
														{cardOf.has(g.person.personId) ? (
															<MenuItem
																icon={Note01Icon}
																disabled={busy}
																onSelect={() => lane.open({ kind: "clear", guest: g, reason: "" })}
															>
																Clear response card
															</MenuItem>
														) : null}
													</>
												) : null}
												{/* After finalization only Correct attendance changes who attended (R3-2). */}
												{final && g.presence === "attended" ? null : (
													<>
														<MenuSeparator />
														<MenuItem icon={Delete02Icon} danger disabled={busy} onSelect={() => setRemoving(g)}>
															Remove from guest list
														</MenuItem>
													</>
												)}
											</>
										) : null}
									</MenuContent>
								</Menu>
							),
					},
				]
			: []),
	];

	const form = lane.editing;
	return (
		<Card as="section" aria-labelledby="guests-title">
			<CardHeader className="flex-wrap items-center">
				<CardHeading>
					<CardTitle id="guests-title">Guest list</CardTitle>
				</CardHeading>
				{guests && guests.length ? (
					<SegmentedControl
						label="Show guests"
						size="sm"
						value={filter}
						onValueChange={setFilter}
						options={[
							{ value: "all", label: "All", count: shown.length },
							{ value: "confirmed", label: "Yes", count: counts.confirmed },
							{ value: "pending", label: "Pending", count: counts.pending },
							{ value: "declined", label: "No", count: counts.declined },
						]}
					/>
				) : null}
			</CardHeader>
			<SaveNotice {...lane.noticeProps} dialogOpen={form !== null} className="mb-3" />
			<RowNotices lanes={presence.lanes} className="mb-3" />
			{guests === null ? (
				<StatePanel tone="error" title="Guests did not load" headingLevel="h3" className="py-8">
					Nothing was changed. Reload the page in a moment.
				</StatePanel>
			) : (
				<DataTable
					caption="Guests"
					columns={columns}
					state={{ status: "ready", data: rows }}
					rowId={(g) => g.id}
					rowLabel={(g) => g.person.displayName}
					minWidth={vision ? 760 : 640}
					empty={{
						icon: UserMultipleIcon,
						title: filter === "all" ? "No guests yet" : `No guests with ${RSVP_LABEL[filter]}`,
						text:
							filter === "all"
								? canWrite
									? "Add the people you invite. Their answers show here."
									: "When an Owner or Admin adds guests, they appear here."
								: "Choose All to see everyone.",
					}}
				/>
			)}
			{canWrite && guests ? (
				<div className="mt-4 flex items-center justify-between gap-3">
					<Button
						variant="ghost"
						size="sm"
						icon={UserAdd01Icon}
						disabled={busy}
						onClick={() => lane.open({ kind: "add", draft: EMPTY_ADD })}
					>
						Add guest
					</Button>
					<span className="text-sm text-text-3">
						{rows.length === shown.length
							? `${shown.length} ${shown.length === 1 ? "guest" : "guests"}`
							: `Showing ${rows.length} of ${shown.length}`}
					</span>
				</div>
			) : null}

			{canWrite ? (
				<NoticeInDialog {...lane.noticeProps}>
					{form?.kind === "add" ? (
						<AddGuestForm
							initial={form.draft}
							problem={lane.problem}
							wait={lane.wait}
							meeting={meeting}
							guestIds={shown.flatMap((g) => (g.person.personId ? [g.person.personId] : []))}
							onClose={lane.close}
							onSubmit={add}
						/>
					) : form?.kind === "inviter" ? (
						<InviterForm
							initial={form.inviter}
							problem={lane.problem}
							wait={lane.wait}
							guest={form.guest}
							onClose={lane.close}
							onSubmit={(inviter) => changeInviter(form.guest, inviter)}
						/>
					) : form?.kind === "card" ? (
						<CardForm
							initial={form}
							problem={lane.problem}
							wait={lane.wait}
							guest={form.guest}
							corrects={cardOf.has(form.guest.person.personId)}
							onClose={lane.close}
							onSubmit={(response, notes) => saveCard(form.guest, response, notes)}
						/>
					) : form?.kind === "note" ? (
						<NoteForm
							initial={form.text}
							problem={lane.problem}
							wait={lane.wait}
							guest={form.guest}
							meetingTitle={meeting.displayTitle}
							onClose={lane.close}
							onSubmit={(text) => note(form.guest, text)}
						/>
					) : form?.kind === "clear" ? (
						<ReasonDialog
							title={`Clear ${form.guest.person.displayName}'s response card?`}
							consequences={["The card counts as unknown again.", "The history keeps that a card was cleared."]}
							confirmLabel="Clear card"
							initial={form.reason}
							problem={lane.problem}
							wait={lane.wait}
							onClose={lane.close}
							onSubmit={(reason) => clear(form.guest, reason)}
						/>
					) : null}
					<ConfirmDialog
						open={removing !== null}
						onOpenChange={(o) => !o && setRemoving(null)}
						tone="danger"
						title={removing ? `Remove ${removing.person.displayName}?` : ""}
						consequences={[
							"They leave this meeting's guest list and get no more reminders for it.",
							"Their open RSVP link stops working.",
							"Their person record and history stay.",
						]}
						confirmLabel="Remove guest"
						onConfirm={() => {
							if (removing) remove(removing);
						}}
					/>
				</NoticeInDialog>
			) : null}
		</Card>
	);
}

/** A guest row shown while its add is saved: no link, no actions, Pending, absent. */
function pendingGuest(person: PickedPerson | null, name: string, inviter: PickedPerson | null): PendingGuest {
	return {
		id: `${PENDING}${person?.id ?? crypto.randomUUID()}`,
		revision: null,
		person: { personId: person?.id ?? null, displayName: name, state: "live" },
		inviter: inviter ? { personId: inviter.id, displayName: inviter.name, state: "live" } : null,
		rsvp: "pending",
		rsvpSource: null,
		rsvpAt: null,
		presence: "absent",
		hasCard: false,
	};
}

type FormProps<T> = {
	initial: T;
	/** Why the last save of this form was refused, in words. */
	problem: string | undefined;
	wait: Wait;
	onClose: () => void;
};

/**
 * Add guest (REQ-MTG-011): someone already in People, with who invited them, or someone new with a name and optional
 * contact details. A new person starts as a prospect from this meeting, in the United States by default. Nothing here
 * gives them a login.
 */
function AddGuestForm({
	initial,
	problem,
	wait,
	meeting,
	guestIds,
	onClose,
	onSubmit,
}: FormProps<AddDraft> & { meeting: Detail; guestIds: string[]; onSubmit: (draft: AddDraft) => void }) {
	const [draft, setDraft] = useState(initial);
	const [touched, setTouched] = useState(false);
	const { mode, person, inviter, contact } = draft;
	const set = (patch: Partial<AddDraft>) => setDraft((d) => ({ ...d, ...patch }));
	const setContact = (patch: Partial<AddDraft["contact"]>) => set({ contact: { ...contact, ...patch } });
	const nameMissing = contact.displayName.trim() === "";
	const emailBad = contact.email.trim() !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email.trim());
	return (
		<RecordDialog
			icon={UserAdd01Icon}
			tone="green"
			title="Add guest"
			description={meeting.displayTitle}
			action="Add guest"
			problem={problem}
			wait={wait}
			onClose={onClose}
			onSubmit={() => {
				setTouched(true);
				if (mode === "existing" ? !person : nameMissing || emailBad) return false;
				onSubmit(draft);
				return true;
			}}
		>
			<SegmentedControl
				label="Who"
				value={mode}
				onValueChange={(m) => set({ mode: m })}
				options={[
					{ value: "existing", label: "Someone in People" },
					{ value: "new", label: "Someone new" },
				]}
			/>
			{mode === "existing" ? (
				<>
					<Field label="Guest" error={touched && !person ? "Choose the person to add." : null}>
						<PersonPicker
							label="Guest"
							value={person}
							onChange={(p) => set({ person: p })}
							exclude={guestIds}
							autoFocus
						/>
					</Field>
					<Field label="Invited by" optional>
						<PersonPicker
							label="Invited by"
							value={inviter}
							onChange={(p) => set({ inviter: p })}
							exclude={person ? [person.id] : []}
							none="Not recorded"
						/>
					</Field>
				</>
			) : (
				<>
					<Field label="Name" error={touched && nameMissing ? "Enter the name people call them." : null}>
						<Input
							value={contact.displayName}
							maxLength={255}
							autoComplete="off"
							onChange={(e) => setContact({ displayName: e.target.value })}
							autoFocus
						/>
					</Field>
					<div className="grid grid-cols-2 gap-4 max-app-sm:grid-cols-1">
						<Field label="Email" optional error={touched && emailBad ? "Enter a full email address." : null}>
							<Input
								type="email"
								value={contact.email}
								maxLength={320}
								autoComplete="off"
								onChange={(e) => setContact({ email: e.target.value })}
							/>
						</Field>
						<Field label="Phone" optional hint="Country: United States (US). Change it later on their person page.">
							<Input
								type="tel"
								value={contact.phone}
								maxLength={40}
								autoComplete="off"
								onChange={(e) => setContact({ phone: e.target.value })}
							/>
						</Field>
					</div>
					<p className="text-sm text-text-3">
						They join People as a prospect from this meeting. If they are already in People, choose them instead, so you
						do not make a duplicate.
					</p>
				</>
			)}
		</RecordDialog>
	);
}

/** Who invited a guest (REQ-MTG-019). A guest cannot be their own inviter. */
function InviterForm({
	initial,
	problem,
	wait,
	guest,
	onClose,
	onSubmit,
}: FormProps<PickedPerson | null> & { guest: Guest; onSubmit: (inviter: PickedPerson | null) => void }) {
	const [inviter, setChoice] = useState(initial);
	return (
		<RecordDialog
			icon={UserSwitchIcon}
			tone="blue"
			title="Who invited them?"
			description={guest.person.displayName}
			action="Save"
			problem={problem}
			wait={wait}
			onClose={onClose}
			onSubmit={() => {
				onSubmit(inviter);
				return true;
			}}
		>
			<PersonPicker
				label="Invited by"
				value={inviter}
				onChange={setChoice}
				exclude={[guest.person.personId]}
				none="Not recorded"
				autoFocus
			/>
		</RecordDialog>
	);
}

/**
 * A guest's Vision response card (REQ-MTG-013): one response and optional prayer or question notes. Notes are private
 * to Owners and Admins. A card records what the guest wrote; it does not mark them as attended.
 */
function CardForm({
	initial,
	problem,
	wait,
	guest,
	corrects,
	onClose,
	onSubmit,
}: FormProps<{ response: CardResponse | null; notes: string }> & {
	guest: Guest;
	/** The guest already has a card: this corrects it. */
	corrects: boolean;
	onSubmit: (response: CardResponse, notes: string) => void;
}) {
	const [response, setResponse] = useState(initial.response);
	const [notes, setNotes] = useState(initial.notes);
	const [touched, setTouched] = useState(false);
	return (
		<RecordDialog
			icon={Note01Icon}
			tone="violet"
			title={corrects ? "Correct response card" : "Record response card"}
			description={guest.person.displayName}
			action="Save card"
			problem={problem}
			wait={wait}
			onClose={onClose}
			onSubmit={() => {
				setTouched(true);
				if (!response) return false;
				onSubmit(response, notes);
				return true;
			}}
		>
			<fieldset className="flex flex-col gap-1">
				<legend className="mb-1 text-sm font-medium text-ink-2">What they marked</legend>
				<RadioGroup
					aria-label="What they marked"
					aria-invalid={touched && !response ? true : undefined}
					value={response ?? ""}
					onValueChange={(v) => setResponse(v as CardResponse)}
				>
					{CARD_RESPONSES.map((r) => (
						<Radio key={r} value={r} label={CARD_LABEL[r]} />
					))}
				</RadioGroup>
				{touched && !response ? (
					<p className="text-xs font-medium text-magenta-600" role="alert">
						Choose what they marked on the card.
					</p>
				) : null}
			</fieldset>
			<Field label="Prayer requests or questions" optional hint="Only Owners and Admins see these notes.">
				<Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={3} />
			</Field>
		</RecordDialog>
	);
}

/** A note about one attendee (REQ-MTG-017). It goes to their history with this meeting as its source. */
function NoteForm({
	initial,
	problem,
	wait,
	guest,
	meetingTitle,
	onClose,
	onSubmit,
}: FormProps<string> & { guest: Guest; meetingTitle: string; onSubmit: (text: string) => void }) {
	const [text, setText] = useState(initial);
	const [touched, setTouched] = useState(false);
	const missing = text.trim() === "";
	return (
		<RecordDialog
			icon={Note01Icon}
			tone="violet"
			size="sm"
			title="Add a note"
			description={guest.person.displayName}
			action="Add note"
			problem={problem}
			wait={wait}
			onClose={onClose}
			onSubmit={() => {
				setTouched(true);
				if (missing) return false;
				onSubmit(text.trim());
				return true;
			}}
		>
			<Field
				label="Note"
				hint={`It goes to their history, marked as from ${meetingTitle}.`}
				error={touched && missing ? "Write the note first." : null}
			>
				<Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} rows={4} autoFocus />
			</Field>
		</RecordDialog>
	);
}
