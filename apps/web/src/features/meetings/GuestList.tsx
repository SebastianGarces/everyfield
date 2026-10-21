"use client";

import {
	CheckmarkCircle02Icon,
	Delete02Icon,
	MoreHorizontalIcon,
	Note01Icon,
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
import type * as c from "@everyfield/contracts/meetings";
import { useOptimistic, useState, useTransition } from "react";
import type { z } from "zod";
import {
	clearCard,
	correctRsvp,
	createGuestContact,
	inviteGuest,
	recordCard,
	removeGuest,
	setInviter,
} from "./actions.ts";
import { PersonPicker, ReasonDialog, type PickedPerson } from "./dialogs.tsx";
import {
	CARD_LABEL,
	CARD_RESPONSES,
	problemText,
	RSVP_LABEL,
	RSVP_SOURCE_LABEL,
	RSVP_TONE,
	rsvpCounts,
	type CardResponse,
	type Detail,
	type Guest,
	type Outcome,
	type Rsvp,
} from "./model.ts";
import { IntentLink, Problem, problemOf, useSave } from "./parts.tsx";

type CardEntry = z.infer<typeof c.card>;
type Filter = "all" | Rsvp;
type Dialogs =
	| { kind: "add" }
	| { kind: "inviter"; guest: Guest }
	| { kind: "card"; guest: Guest }
	| { kind: "clear"; guest: Guest }
	| { kind: "remove"; guest: Guest }
	| null;

const STATE_NOTE = { retired: "Retired", merged: "Merged", live: null } as const;
const ACCEPTS_REPLIES = ["planning", "ready", "in_progress"];

/**
 * The guest list (REQ-MTG-007, REQ-MTG-019): each guest's RSVP, who invited them and, for Vision meetings, their
 * response card. Owners and Admins correct an RSVP from the row menu (REQ-MTG-008, not drawn: composed from Menu): the
 * badge changes at once and the answer confirms it or puts it back with the reason.
 */
export function GuestList({
	meeting,
	guests,
	cards,
	canWrite,
	onGuest,
	onRemoved,
	onCard,
	onStale,
}: {
	meeting: Detail;
	guests: Guest[] | null;
	cards: CardEntry[] | null;
	canWrite: boolean;
	onGuest: (guest: Guest) => void;
	onRemoved: (guestId: string) => void;
	onCard: (personId: string, card: CardEntry | null) => void;
	onStale: () => void;
}) {
	const toast = useToast();
	const [filter, setFilter] = useState<Filter>("all");
	const [dialog, setDialog] = useState<Dialogs>(null);
	const [, startTransition] = useTransition();
	const [shown, override] = useOptimistic(guests ?? [], (all: Guest[], change: { id: string; rsvp: Rsvp }) =>
		all.map((g) => (g.id === change.id ? { ...g, rsvp: change.rsvp, rsvpSource: "admin" as const } : g)),
	);
	const vision = meeting.type === "vision_meeting";
	const counts = rsvpCounts(shown);
	const cardOf = new Map((cards ?? []).map((c) => [c.personId, c]));
	const rows = filter === "all" ? shown : shown.filter((g) => g.rsvp === filter);
	const open = ACCEPTS_REPLIES.includes(meeting.status);

	function correct(guest: Guest, rsvp: Rsvp) {
		startTransition(async () => {
			override({ id: guest.id, rsvp });
			const r = await correctRsvp(
				crypto.randomUUID(),
				guest.revision,
				meeting.id,
				guest.person.personId,
				rsvp === "pending" ? null : rsvp,
			).catch(() => ({ status: "lost" }) as const);
			if (r.status === "ok") {
				startTransition(() => onGuest(r.value.guest));
				toast({ message: `${guest.person.displayName}: RSVP set to ${RSVP_LABEL[rsvp]}.`, tone: "success" });
			} else {
				const code = problemOf(r)!;
				toast({
					message: `The RSVP for ${guest.person.displayName} was not changed. ${problemText(code)}`,
					tone: "error",
				});
				if (code === "conflict") onStale();
			}
		});
	}

	const columns: Column<Guest>[] = [
		{
			key: "guest",
			header: "Guest",
			cell: (g) => (
				<div className="flex items-center gap-3">
					<Avatar name={g.person.displayName} size="sm" decorative />
					<div className="min-w-0">
						{g.person.state === "live" ? (
							<IntentLink
								href={`/people/${g.person.personId}`}
								className="font-medium text-ink underline-offset-4 hover:underline focus-visible:underline"
							>
								{g.person.displayName}
							</IntentLink>
						) : (
							<span className="font-medium text-ink">{g.person.displayName}</span>
						)}
						{STATE_NOTE[g.person.state] ? <p className="text-sm text-text-3">{STATE_NOTE[g.person.state]}</p> : null}
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
						cell: (g: Guest) => (
							<Menu>
								<MenuTrigger asChild>
									<IconButton icon={MoreHorizontalIcon} label={`Actions for ${g.person.displayName}`} size="sm" />
								</MenuTrigger>
								<MenuContent align="end">
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
									<MenuItem icon={UserSwitchIcon} onSelect={() => setDialog({ kind: "inviter", guest: g })}>
										Change who invited them
									</MenuItem>
									{vision ? (
										<>
											<MenuItem icon={Note01Icon} onSelect={() => setDialog({ kind: "card", guest: g })}>
												{cardOf.has(g.person.personId) ? "Correct response card" : "Record response card"}
											</MenuItem>
											{cardOf.has(g.person.personId) ? (
												<MenuItem icon={Note01Icon} onSelect={() => setDialog({ kind: "clear", guest: g })}>
													Clear response card
												</MenuItem>
											) : null}
										</>
									) : null}
									<MenuSeparator />
									<MenuItem icon={Delete02Icon} danger onSelect={() => setDialog({ kind: "remove", guest: g })}>
										Remove from guest list
									</MenuItem>
								</MenuContent>
							</Menu>
						),
					},
				]
			: []),
	];

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
					minWidth={560}
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
					<Button variant="ghost" size="sm" icon={UserAdd01Icon} onClick={() => setDialog({ kind: "add" })}>
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
					<AddGuestDialog
						open={dialog?.kind === "add"}
						onOpenChange={(o) => !o && setDialog(null)}
						meeting={meeting}
						guestIds={shown.map((g) => g.person.personId)}
						onAdded={(g) => {
							onGuest(g);
							toast({ message: `${g.person.displayName} is on the guest list.`, tone: "success" });
						}}
					/>
					<InviterDialog
						guest={dialog?.kind === "inviter" ? dialog.guest : null}
						meetingId={meeting.id}
						onClose={() => setDialog(null)}
						onSaved={onGuest}
						onStale={onStale}
					/>
					<CardDialog
						guest={dialog?.kind === "card" ? dialog.guest : null}
						card={dialog?.kind === "card" ? (cardOf.get(dialog.guest.person.personId) ?? null) : null}
						meeting={meeting}
						onClose={() => setDialog(null)}
						onSaved={(guestPersonId, card, guest) => {
							onCard(guestPersonId, card);
							onGuest(guest);
						}}
						onStale={onStale}
					/>
					<ReasonDialog
						open={dialog?.kind === "clear"}
						onOpenChange={(o) => !o && setDialog(null)}
						title={dialog?.kind === "clear" ? `Clear ${dialog.guest.person.displayName}'s response card?` : ""}
						consequences={["The card counts as unknown again.", "The history keeps that a card was cleared."]}
						confirmLabel="Clear card"
						onConfirm={async (reason, save) => {
							if (dialog?.kind !== "clear") return false;
							const g = dialog.guest;
							const r = await save({ g: g.id, reason }, (key) =>
								clearCard(key, g.revision, meeting.id, g.person.personId, reason),
							);
							if (r?.status !== "ok") {
								if (r?.status === "refused" && r.code === "conflict") onStale();
								return false;
							}
							onCard(g.person.personId, null);
							onGuest({ ...g, revision: String(BigInt(g.revision) + 1n) as Guest["revision"], hasCard: false });
							return true;
						}}
					/>
					<ConfirmDialog
						open={dialog?.kind === "remove"}
						onOpenChange={(o) => !o && setDialog(null)}
						tone="danger"
						title={dialog?.kind === "remove" ? `Remove ${dialog.guest.person.displayName}?` : ""}
						consequences={[
							"They leave this meeting's guest list and get no more reminders for it.",
							"Their open RSVP link stops working.",
							"Their person record and history stay.",
						]}
						confirmLabel="Remove guest"
						onConfirm={async () => {
							if (dialog?.kind !== "remove") return;
							const g = dialog.guest;
							const r: Outcome<unknown> = await removeGuest(
								crypto.randomUUID(),
								g.revision,
								meeting.id,
								g.person.personId,
							).catch(() => ({ status: "lost" }) as const);
							if (r.status !== "ok") {
								if (r.status === "refused" && r.code === "conflict") onStale();
								throw new Error(problemText(problemOf(r)!));
							}
							onRemoved(g.id);
							toast({ message: `${g.person.displayName} was removed from the guest list.`, tone: "success" });
						}}
					/>
				</>
			) : null}
		</Card>
	);
}

/**
 * Add guest (REQ-MTG-011): someone already in People, with who invited them, or someone new with a name and optional
 * contact details. A new person starts as a prospect from this meeting. Nothing here gives them a login.
 */
function AddGuestDialog({
	open,
	onOpenChange,
	meeting,
	guestIds,
	onAdded,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	meeting: Detail;
	guestIds: string[];
	onAdded: (guest: Guest) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{open ? (
				<AddGuestForm meeting={meeting} guestIds={guestIds} onAdded={onAdded} onClose={() => onOpenChange(false)} />
			) : null}
		</Dialog>
	);
}

function AddGuestForm({
	meeting,
	guestIds,
	onAdded,
	onClose,
}: {
	meeting: Detail;
	guestIds: string[];
	onAdded: (guest: Guest) => void;
	onClose: () => void;
}) {
	const [mode, setMode] = useState<"existing" | "new">("existing");
	const [person, setPerson] = useState<PickedPerson | null>(null);
	const [inviter, setInviterChoice] = useState<PickedPerson | null>(null);
	const [contact, setContact] = useState({ displayName: "", email: "", phone: "" });
	const [touched, setTouched] = useState(false);
	const { save, pending, problem } = useSave();
	const nameMissing = contact.displayName.trim() === "";
	const emailBad = contact.email.trim() !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email.trim());

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		setTouched(true);
		if (mode === "existing") {
			if (!person) return;
			const input = { meetingId: meeting.id, personId: person.id, inviterPersonId: inviter?.id ?? null };
			const r = await save(input, (key) => inviteGuest(key, input));
			if (r?.status === "ok") {
				onAdded(r.value.guest);
				onClose();
			}
			return;
		}
		if (nameMissing || emailBad) return;
		const input = {
			meetingId: meeting.id,
			displayName: contact.displayName.trim(),
			email: contact.email.trim() || null,
			phone: contact.phone.trim() || null,
			country: "US",
		};
		const r = await save(input, (key) => createGuestContact(key, input));
		if (r?.status === "ok") {
			onAdded(r.value.guest);
			onClose();
		}
	}

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
function InviterDialog({
	guest,
	meetingId,
	onClose,
	onSaved,
	onStale,
}: {
	guest: Guest | null;
	meetingId: string;
	onClose: () => void;
	onSaved: (guest: Guest) => void;
	onStale: () => void;
}) {
	return (
		<Dialog open={guest !== null} onOpenChange={(o) => !o && onClose()}>
			{guest ? (
				<InviterForm guest={guest} meetingId={meetingId} onClose={onClose} onSaved={onSaved} onStale={onStale} />
			) : null}
		</Dialog>
	);
}

function InviterForm({
	guest,
	meetingId,
	onClose,
	onSaved,
	onStale,
}: {
	guest: Guest;
	meetingId: string;
	onClose: () => void;
	onSaved: (guest: Guest) => void;
	onStale: () => void;
}) {
	const [inviter, setChoice] = useState<PickedPerson | null>(
		guest.inviter ? { id: guest.inviter.personId, name: guest.inviter.displayName } : null,
	);
	const { save, pending, problem } = useSave();
	return (
		<DialogContent aria-busy={pending || undefined}>
			<form
				noValidate
				className="contents"
				onSubmit={async (e) => {
					e.preventDefault();
					const id = inviter?.id ?? null;
					const r = await save({ id }, (key) => setInviter(key, guest.revision, meetingId, guest.person.personId, id));
					if (r?.status === "ok") {
						onSaved(r.value.guest);
						onClose();
					} else if (r?.status === "refused" && r.code === "conflict") onStale();
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
function CardDialog({
	guest,
	card,
	meeting,
	onClose,
	onSaved,
	onStale,
}: {
	guest: Guest | null;
	card: CardEntry | null;
	meeting: Detail;
	onClose: () => void;
	onSaved: (personId: string, card: CardEntry, guest: Guest) => void;
	onStale: () => void;
}) {
	return (
		<Dialog open={guest !== null} onOpenChange={(o) => !o && onClose()}>
			{guest ? (
				<CardForm guest={guest} card={card} meeting={meeting} onClose={onClose} onSaved={onSaved} onStale={onStale} />
			) : null}
		</Dialog>
	);
}

function CardForm({
	guest,
	card,
	meeting,
	onClose,
	onSaved,
	onStale,
}: {
	guest: Guest;
	card: CardEntry | null;
	meeting: Detail;
	onClose: () => void;
	onSaved: (personId: string, card: CardEntry, guest: Guest) => void;
	onStale: () => void;
}) {
	const [response, setResponse] = useState<CardResponse | null>(card?.response ?? null);
	const [notes, setNotes] = useState(card?.notes ?? "");
	const [touched, setTouched] = useState(false);
	const { save, pending, problem } = useSave();
	return (
		<DialogContent aria-busy={pending || undefined}>
			<form
				noValidate
				className="contents"
				onSubmit={async (e) => {
					e.preventDefault();
					setTouched(true);
					if (!response) return;
					const input = {
						meetingId: meeting.id,
						personId: guest.person.personId,
						response,
						notes: notes.trim() || null,
					};
					const r = await save(input, (key) => recordCard(key, guest.revision, input));
					if (r?.status === "ok" && r.value.card) {
						const saved = r.value.card;
						onSaved(guest.person.personId, saved, { ...guest, revision: saved.revision, hasCard: true });
						onClose();
					} else if (r?.status === "refused" && r.code === "conflict") onStale();
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
