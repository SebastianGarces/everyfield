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
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
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
import { Avatar, DataTable, StatusBadge, type Column } from "@everyfield/ui/display";
import { startTransition, useEffect, useRef, useState } from "react";
import {
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
import { isPending, PENDING, type CardEntry, type Change } from "./page-state.ts";
import { IntentLink, Problem, problemOf, useSave, type SaveCall } from "./parts.tsx";

type Filter = "all" | Rsvp;
/** The open form and its subject. A form stays mounted while its save runs, so a failure reopens it as it was. */
type Form = { kind: "add" } | { kind: "inviter"; guest: Guest } | { kind: "card"; guest: Guest };
type Confirm = { kind: "clear"; guest: Guest } | { kind: "remove"; guest: Guest };

const STATE_NOTE = { retired: "Retired", merged: "Merged", live: null } as const;
const ACCEPTS_REPLIES = ["planning", "ready", "in_progress"];
const lost = () => ({ status: "lost" }) as const;
const nextRevision = (r: string) => String(BigInt(r) + 1n) as Guest["revision"];

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
	onNote,
	canWrite,
	project,
	onGuest,
	onRemoved,
	onCard,
	onStale,
}: {
	meeting: Detail;
	guests: Guest[] | null;
	cards: CardEntry[] | null;
	attendance: Attendance | null;
	presence: ReturnType<typeof usePresence>;
	/** Presence may change: an Owner or Admin, before attendance is final, on a meeting that is not cancelled. */
	canMark: boolean;
	onNote: (guest: Guest) => void;
	canWrite: boolean;
	project: (change: Change) => void;
	onGuest: (guest: Guest) => void;
	onRemoved: (guestId: string) => void;
	onCard: (personId: string, card: CardEntry | null) => void;
	onStale: () => void;
}) {
	const toast = useToast();
	const [filter, setFilter] = useState<Filter>("all");
	const [form, setForm] = useState<(Form & { visible: boolean; key: number }) | null>(null);
	const [confirm, setConfirm] = useState<Confirm | null>(null);
	const shown = guests ?? [];
	const vision = meeting.type === "vision_meeting";
	const counts = rsvpCounts(shown);
	const cardOf = new Map((cards ?? []).map((c) => [c.personId, c]));
	const classOf = new Map((attendance?.items ?? []).map((a) => [a.person.personId, a.classification]));
	const rows = filter === "all" ? shown : shown.filter((g) => g.rsvp === filter);
	const open = ACCEPTS_REPLIES.includes(meeting.status);
	const openForm = (f: Form) => setForm({ ...f, visible: true, key: Date.now() });

	/** One write: show `changes` at once, then keep the answer, or go back and tell why. */
	function run<T>(
		changes: Change[],
		call: () => Promise<Outcome<T> | null>,
		done: (value: T) => void,
		failed: (code: string) => void,
	) {
		startTransition(async () => {
			for (const c of changes) project(c);
			const r = await call().catch(lost);
			if (r?.status === "ok") startTransition(() => done(r.value));
			else if (r) {
				const code = problemOf(r)!;
				if (code === "conflict") onStale();
				failed(code);
			}
		});
	}
	/**
	 * A form's write: the form closes at once. Its answer closes it for good, or reopens it with its input and the reason.
	 * Only that form: when another form opened meanwhile, a failure says so in a message instead.
	 */
	const current = useRef(form);
	useEffect(() => {
		current.current = form;
	});
	function submitForm<T>(changes: Change[], call: SaveCall<T>, done: (value: T) => void, what: string) {
		const key = form?.key;
		setForm((f) => f && { ...f, visible: false });
		run(
			changes,
			call,
			(v) => {
				done(v);
				setForm((f) => (f?.key === key ? null : f));
			},
			(code) => {
				if (current.current?.key === key) setForm((f) => f && { ...f, visible: true });
				else toast({ message: `${what} was not saved. ${problemText(code)}`, tone: "error" });
			},
		);
	}

	function correct(guest: Guest, rsvp: Rsvp) {
		run(
			[{ kind: "guest", guest: { ...guest, rsvp, rsvpSource: "admin" } }],
			() =>
				correctRsvp(
					crypto.randomUUID(),
					guest.revision,
					meeting.id,
					guest.person.personId,
					rsvp === "pending" ? null : rsvp,
				),
			(v) => {
				onGuest(v.guest);
				toast({ message: `${guest.person.displayName}: RSVP set to ${RSVP_LABEL[rsvp]}.`, tone: "success" });
			},
			(code) =>
				toast({
					message: `The RSVP for ${guest.person.displayName} was not changed. ${problemText(code)}`,
					tone: "error",
				}),
		);
	}

	const columns: Column<Guest>[] = [
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
					classification={classOf.get(g.person.personId) ?? null}
					final={attendance?.finalized != null}
					saving={presence.busy.has(g.person.personId)}
				/>
			),
		},
		...(vision
			? [
					{
						key: "card",
						header: "Response card",
						cell: (g: Guest) => {
							const c = cardOf.get(g.person.personId);
							return c ? CARD_LABEL[c.response] : <span className="text-text-3">No card</span>;
						},
					},
				]
			: []),
		...(canWrite
			? [
					{
						key: "actions",
						header: "Actions",
						srOnlyHeader: true,
						align: "right" as const,
						cell: (g: Guest) =>
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
												disabled={!canMark || g.presence === p || presence.busy.has(g.person.personId)}
												onSelect={() => presence.set(g.person, p)}
											>
												Mark as {PRESENCE_LABEL[p].toLowerCase()}
											</MenuItem>
										))}
										{g.presence === "attended" && g.person.state === "live" ? (
											<MenuItem icon={Note01Icon} onSelect={() => onNote(g)}>
												Add a note to their history
											</MenuItem>
										) : null}
										<MenuSeparator />
										<MenuLabel>Correct the RSVP</MenuLabel>
										{(["confirmed", "declined", "pending"] as const).map((r) => (
											<MenuItem
												key={r}
												icon={CheckmarkCircle02Icon}
												disabled={g.rsvp === r || !open}
												onSelect={() => correct(g, r)}
											>
												{r === "pending" ? "Reset to Pending" : `Set to ${RSVP_LABEL[r]}`}
											</MenuItem>
										))}
										<MenuSeparator />
										<MenuItem icon={UserSwitchIcon} onSelect={() => openForm({ kind: "inviter", guest: g })}>
											Change who invited them
										</MenuItem>
										{vision ? (
											<>
												<MenuItem icon={Note01Icon} onSelect={() => openForm({ kind: "card", guest: g })}>
													{cardOf.has(g.person.personId) ? "Correct response card" : "Record response card"}
												</MenuItem>
												{cardOf.has(g.person.personId) ? (
													<MenuItem icon={Note01Icon} onSelect={() => setConfirm({ kind: "clear", guest: g })}>
														Clear response card
													</MenuItem>
												) : null}
											</>
										) : null}
										<MenuSeparator />
										<MenuItem icon={Delete02Icon} danger onSelect={() => setConfirm({ kind: "remove", guest: g })}>
											Remove from guest list
										</MenuItem>
									</MenuContent>
								</Menu>
							),
					},
				]
			: []),
	];

	const closeForm = (o: boolean) => !o && setForm(null);
	const target = confirm?.guest;
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
					<Button variant="ghost" size="sm" icon={UserAdd01Icon} onClick={() => openForm({ kind: "add" })}>
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
				<>
					<Dialog open={form?.visible ?? false} onOpenChange={closeForm}>
						{form?.kind === "add" ? (
							<AddGuestForm
								key={form.key}
								open={form.visible}
								meeting={meeting}
								guestIds={shown.map((g) => g.person.personId)}
								onClose={() => setForm(null)}
								onSubmit={(guest, call) =>
									submitForm(
										[{ kind: "guest", guest }],
										call,
										(v) => {
											onGuest(v.guest);
											toast({ message: `${v.guest.person.displayName} is on the guest list.`, tone: "success" });
										},
										`Adding ${guest.person.displayName}`,
									)
								}
							/>
						) : form?.kind === "inviter" ? (
							<InviterForm
								key={form.key}
								open={form.visible}
								guest={form.guest}
								meetingId={meeting.id}
								onClose={() => setForm(null)}
								onSubmit={(guest, call) =>
									submitForm(
										[{ kind: "guest", guest }],
										call,
										(v) => onGuest(v.guest),
										`Who invited ${guest.person.displayName}`,
									)
								}
							/>
						) : form?.kind === "card" ? (
							<CardForm
								key={form.key}
								open={form.visible}
								guest={form.guest}
								card={cardOf.get(form.guest.person.personId) ?? null}
								meeting={meeting}
								onClose={() => setForm(null)}
								onSubmit={(card, call) =>
									submitForm(
										[
											{ kind: "card", personId: card.personId, card },
											{ kind: "guest", guest: { ...form.guest, hasCard: true } },
										],
										call,
										(v) => {
											if (!v.card) return;
											onCard(v.card.personId, v.card);
											onGuest({ ...form.guest, revision: v.card.revision as Guest["revision"], hasCard: true });
										},
										`The card for ${form.guest.person.displayName}`,
									)
								}
							/>
						) : null}
					</Dialog>
					<ReasonDialog
						open={confirm?.kind === "clear"}
						onOpenChange={(o) => !o && setConfirm(null)}
						title={target ? `Clear ${target.person.displayName}'s response card?` : ""}
						consequences={["The card counts as unknown again.", "The history keeps that a card was cleared."]}
						confirmLabel="Clear card"
						onConfirm={async (reason) => {
							if (confirm?.kind !== "clear") return false;
							const g = confirm.guest;
							run(
								[
									{ kind: "card", personId: g.person.personId, card: null },
									{ kind: "guest", guest: { ...g, hasCard: false } },
								],
								() => clearCard(crypto.randomUUID(), g.revision, meeting.id, g.person.personId, reason),
								() => {
									onCard(g.person.personId, null);
									onGuest({ ...g, revision: nextRevision(g.revision), hasCard: false });
								},
								(code) =>
									toast({
										message: `The card for ${g.person.displayName} was not cleared. ${problemText(code)}`,
										tone: "error",
									}),
							);
							return true;
						}}
					/>
					<ConfirmDialog
						open={confirm?.kind === "remove"}
						onOpenChange={(o) => !o && setConfirm(null)}
						tone="danger"
						title={target ? `Remove ${target.person.displayName}?` : ""}
						consequences={[
							"They leave this meeting's guest list and get no more reminders for it.",
							"Their open RSVP link stops working.",
							"Their person record and history stay.",
						]}
						confirmLabel="Remove guest"
						onConfirm={() => {
							if (confirm?.kind !== "remove") return;
							const g = confirm.guest;
							run(
								[{ kind: "removeGuest", guestId: g.id }],
								() => removeGuest(crypto.randomUUID(), g.revision, meeting.id, g.person.personId),
								() => {
									onRemoved(g.id);
									toast({ message: `${g.person.displayName} was removed from the guest list.`, tone: "success" });
								},
								(code) =>
									toast({
										message: `${g.person.displayName} is still on the guest list. ${problemText(code)}`,
										tone: "error",
									}),
							);
						}}
					/>
				</>
			) : null}
		</Card>
	);
}

/** A guest row shown while its add is saved: no link, no actions, Pending, absent. */
function pendingGuest(person: PickedPerson | null, name: string, inviter: PickedPerson | null): Guest {
	const ref = (p: PickedPerson) => ({ personId: p.id, displayName: p.name, state: "live" as const });
	return {
		id: PENDING + (person?.id ?? crypto.randomUUID()),
		revision: "0",
		person: person ? ref(person) : { personId: PENDING, displayName: name, state: "live" },
		inviter: inviter ? ref(inviter) : null,
		rsvp: "pending",
		rsvpSource: null,
		rsvpAt: null,
		presence: "absent",
		hasCard: false,
	} as unknown as Guest;
}

/**
 * Add guest (REQ-MTG-011): someone already in People, with who invited them, or someone new with a name and optional
 * contact details. A new person starts as a prospect from this meeting, in the United States by default. Nothing here
 * gives them a login.
 */
function AddGuestForm({
	open,
	meeting,
	guestIds,
	onClose,
	onSubmit,
}: {
	open: boolean;
	meeting: Detail;
	guestIds: string[];
	onClose: () => void;
	onSubmit: (guest: Guest, call: SaveCall<{ guest: Guest }>) => void;
}) {
	const [mode, setMode] = useState<"existing" | "new">("existing");
	const [person, setPerson] = useState<PickedPerson | null>(null);
	const [inviter, setInviterChoice] = useState<PickedPerson | null>(null);
	const [contact, setContact] = useState({ displayName: "", email: "", phone: "" });
	const [touched, setTouched] = useState(false);
	const { save, pending, problem } = useSave();
	const nameMissing = contact.displayName.trim() === "";
	const emailBad = contact.email.trim() !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email.trim());

	function submit(event: React.FormEvent) {
		event.preventDefault();
		setTouched(true);
		if (mode === "existing") {
			if (!person) return;
			const input = { meetingId: meeting.id, personId: person.id, inviterPersonId: inviter?.id ?? null };
			return onSubmit(pendingGuest(person, person.name, inviter), () => save(input, (key) => inviteGuest(key, input)));
		}
		if (nameMissing || emailBad) return;
		const input = {
			meetingId: meeting.id,
			displayName: contact.displayName.trim(),
			email: contact.email.trim() || null,
			phone: contact.phone.trim() || null,
			country: "US",
		};
		onSubmit(pendingGuest(null, input.displayName, null), () => save(input, (key) => createGuestContact(key, input)));
	}

	if (!open) return null;
	return (
		<DialogContent aria-busy={pending || undefined}>
			<form onSubmit={submit} noValidate className="contents">
				<DialogHeader icon={UserAdd01Icon} tone="green" title="Add guest" description={meeting.displayTitle} />
				<DialogBody className="flex flex-col gap-4">
					<SegmentedControl
						label="Who"
						value={mode}
						onValueChange={setMode}
						options={[
							{ value: "existing", label: "Someone in People" },
							{ value: "new", label: "Someone new" },
						]}
					/>
					{mode === "existing" ? (
						<>
							<Field label="Guest" error={touched && !person ? "Choose the person to add." : null}>
								<PersonPicker label="Guest" value={person} onChange={setPerson} exclude={guestIds} autoFocus />
							</Field>
							<Field label="Invited by" optional>
								<PersonPicker
									label="Invited by"
									value={inviter}
									onChange={setInviterChoice}
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
									readOnly={pending}
									onChange={(e) => setContact((c) => ({ ...c, displayName: e.target.value }))}
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
										readOnly={pending}
										onChange={(e) => setContact((c) => ({ ...c, email: e.target.value }))}
									/>
								</Field>
								<Field label="Phone" optional hint="Country: United States (US). Change it later on their person page.">
									<Input
										type="tel"
										value={contact.phone}
										maxLength={40}
										autoComplete="off"
										readOnly={pending}
										onChange={(e) => setContact((c) => ({ ...c, phone: e.target.value }))}
									/>
								</Field>
							</div>
							<p className="text-sm text-text-3">
								They join People as a prospect from this meeting. If they are already in People, choose them instead, so
								you do not make a duplicate.
							</p>
						</>
					)}
					<Problem code={problem} />
				</DialogBody>
				<DialogFooter>
					<Button variant="secondary" type="button" onClick={onClose} disabled={pending}>
						Cancel
					</Button>
					<Button variant="primary" type="submit" loading={pending}>
						Add guest
					</Button>
				</DialogFooter>
			</form>
		</DialogContent>
	);
}

/** Who invited a guest (REQ-MTG-019). A guest cannot be their own inviter. */
function InviterForm({
	open,
	guest,
	meetingId,
	onClose,
	onSubmit,
}: {
	open: boolean;
	guest: Guest;
	meetingId: string;
	onClose: () => void;
	onSubmit: (guest: Guest, call: SaveCall<{ guest: Guest }>) => void;
}) {
	const [inviter, setChoice] = useState<PickedPerson | null>(
		guest.inviter ? { id: guest.inviter.personId, name: guest.inviter.displayName } : null,
	);
	const { save, pending, problem } = useSave();
	if (!open) return null;
	return (
		<DialogContent aria-busy={pending || undefined}>
			<form
				noValidate
				className="contents"
				onSubmit={(e) => {
					e.preventDefault();
					const id = inviter?.id ?? null;
					onSubmit(
						{
							...guest,
							inviter: inviter
								? ({ personId: inviter.id, displayName: inviter.name, state: "live" } as Guest["inviter"])
								: null,
						},
						() => save({ id }, (key) => setInviter(key, guest.revision, meetingId, guest.person.personId, id)),
					);
				}}
			>
				<DialogHeader icon={UserSwitchIcon} title="Who invited them?" description={guest.person.displayName} />
				<DialogBody className="flex flex-col gap-4">
					<PersonPicker
						label="Invited by"
						value={inviter}
						onChange={setChoice}
						exclude={[guest.person.personId]}
						none="Not recorded"
						autoFocus
					/>
					<Problem code={problem} />
				</DialogBody>
				<DialogFooter>
					<Button variant="secondary" type="button" onClick={onClose} disabled={pending}>
						Cancel
					</Button>
					<Button variant="primary" type="submit" loading={pending}>
						Save
					</Button>
				</DialogFooter>
			</form>
		</DialogContent>
	);
}

/**
 * A guest's Vision response card (REQ-MTG-013): one response and optional prayer or question notes. Notes are private
 * to Owners and Admins. A card records what the guest wrote; it does not mark them as attended.
 */
function CardForm({
	open,
	guest,
	card,
	meeting,
	onClose,
	onSubmit,
}: {
	open: boolean;
	guest: Guest;
	card: CardEntry | null;
	meeting: Detail;
	onClose: () => void;
	onSubmit: (card: CardEntry, call: SaveCall<{ card: CardEntry | null }>) => void;
}) {
	const [response, setResponse] = useState<CardResponse | null>(card?.response ?? null);
	const [notes, setNotes] = useState(card?.notes ?? "");
	const [touched, setTouched] = useState(false);
	const { save, pending, problem } = useSave();
	if (!open) return null;
	return (
		<DialogContent aria-busy={pending || undefined}>
			<form
				noValidate
				className="contents"
				onSubmit={(e) => {
					e.preventDefault();
					setTouched(true);
					if (!response) return;
					const input = {
						meetingId: meeting.id,
						personId: guest.person.personId,
						response,
						notes: notes.trim() || null,
					};
					const now = new Date().toISOString();
					onSubmit(
						{
							guestId: guest.id,
							personId: guest.person.personId,
							response,
							notes: input.notes,
							occurredAt: card?.occurredAt ?? now,
							recordedAt: now,
							attended: guest.presence === "attended",
							revision: guest.revision,
						} as CardEntry,
						() => save(input, (key) => recordCard(key, guest.revision, input)),
					);
				}}
			>
				<DialogHeader
					icon={Note01Icon}
					title={card ? "Correct response card" : "Record response card"}
					description={guest.person.displayName}
				/>
				<DialogBody className="flex flex-col gap-4">
					<fieldset className="flex flex-col gap-1">
						<legend className="mb-1 text-sm font-medium text-ink-2">What they marked</legend>
						<RadioGroup
							aria-label="What they marked"
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
					<Problem code={problem} />
				</DialogBody>
				<DialogFooter>
					<Button variant="secondary" type="button" onClick={onClose} disabled={pending}>
						Cancel
					</Button>
					<Button variant="primary" type="submit" loading={pending}>
						Save card
					</Button>
				</DialogFooter>
			</form>
		</DialogContent>
	);
}
