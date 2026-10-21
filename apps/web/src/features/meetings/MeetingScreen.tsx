"use client";

import {
	ArrowDown01Icon,
	Calendar03Icon,
	CalendarRemove01Icon,
	CheckmarkCircle02Icon,
	Clock01Icon,
	Delete02Icon,
	Edit02Icon,
	Location01Icon,
	MoreHorizontalIcon,
	Undo02Icon,
} from "@hugeicons/core-free-icons";
import { statusTransitions } from "@everyfield/contracts/meetings";
import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
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
	PageHeader,
	useToast,
} from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { Icon } from "@everyfield/ui/foundations";
import { useRouter } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";
import {
	changeStatus,
	completePractice,
	correctOccurrence,
	correctPractice,
	deleteMeeting,
	reloadMeeting,
	saveOwnRsvp,
} from "./actions.ts";
import { AgendaCard } from "./Agenda.tsx";
import { ReasonDialog } from "./dialogs.tsx";
import { GuestList } from "./GuestList.tsx";
import { KitCard } from "./Kit.tsx";
import {
	CARD_LABEL,
	CARD_RESPONSES,
	problemText,
	RSVP_LABEL,
	rsvpCounts,
	STATUS_ACTION,
	STATUS_LABEL,
	TYPE_LABEL,
	whenText,
	type Detail,
	type MeetingStatus,
	type Rsvp,
} from "./model.ts";
import { MeetingStatusBadge, Problem, problemOf, RsvpBar, useSave } from "./parts.tsx";
import { PlanMeetingDialog } from "./PlanMeetingDialog.tsx";
import type { MeetingPageData } from "./server.ts";

type Reason = "delete" | "void" | "restore" | "not_held" | null;

/**
 * One meeting (REQ-MTG-001, -002, -005 to -009, -011, -013, -019). Every change updates this page from its own answer;
 * nothing reloads the page. A change refused as out of date reads the meeting again and says so.
 */
export function MeetingScreen({ data: loaded, canWrite }: { data: MeetingPageData; canWrite: boolean }) {
	const router = useRouter();
	const toast = useToast();
	const [server, setServer] = useState(loaded);
	const [data, setData] = useState(loaded);
	if (server !== loaded) {
		setServer(loaded);
		setData(loaded);
	}
	const [editing, setEditing] = useState(false);
	const [holding, setHolding] = useState(false);
	const [reason, setReason] = useState<Reason>(null);
	const [, startTransition] = useTransition();
	const [status, setOptimisticStatus] = useOptimistic(data.meeting.status);
	const m = { ...data.meeting, status };
	const thisYear = Number(data.now.slice(0, 4));
	const vision = m.type === "vision_meeting";
	const practice = m.type === "prelaunch_practice";

	const setMeeting = (meeting: Detail) => setData((d) => ({ ...d, meeting }));
	/** After a refusal as out of date: the latest meeting, guests, kit and cards, without reloading the page. */
	const stale = () => {
		reloadMeeting(m.id).then((r) => {
			if (r.status === "ok" && r.value.status === "found") setData(r.value);
		});
	};

	function moveTo(to: MeetingStatus) {
		startTransition(async () => {
			setOptimisticStatus(to);
			const r = await changeStatus(crypto.randomUUID(), m.revision, m.id, to).catch(
				() => ({ status: "lost" }) as const,
			);
			if (r.status === "ok") {
				startTransition(() => setMeeting(r.value.meeting));
				toast({ message: `${m.displayTitle}: ${STATUS_ACTION[to].toLowerCase()} is saved.`, tone: "success" });
			} else {
				const code = problemOf(r)!;
				toast({ message: `The status did not change. ${problemText(code)}`, tone: "error" });
				if (code === "conflict") stale();
			}
		});
	}

	const moves = (statusTransitions[m.status] ?? []).filter((to) => !(practice && to === "completed"));
	const held = m.occurrence.heldAt !== null;
	const actions = canWrite ? (
		<>
			<Menu>
				<MenuTrigger asChild>
					<Button variant="secondary">
						Status <span className="font-normal text-text-2">{STATUS_LABEL[m.status]}</span>
						<Icon icon={ArrowDown01Icon} size={16} />
					</Button>
				</MenuTrigger>
				<MenuContent align="end">
					<MenuLabel>Change the status</MenuLabel>
					{moves.map((to) => (
						<MenuItem key={to} icon={CheckmarkCircle02Icon} onSelect={() => moveTo(to)} danger={to === "cancelled"}>
							{STATUS_ACTION[to]}
						</MenuItem>
					))}
					{practice && m.status === "in_progress" ? (
						<MenuItem icon={Clock01Icon} onSelect={() => setHolding(true)}>
							Mark as held
						</MenuItem>
					) : null}
					{moves.length === 0 && !(practice && m.status === "in_progress") ? (
						<MenuItem disabled icon={CheckmarkCircle02Icon}>
							No other status from here
						</MenuItem>
					) : null}
				</MenuContent>
			</Menu>
			<Button variant="secondary" icon={Edit02Icon} onClick={() => setEditing(true)}>
				Edit
			</Button>
			<Menu>
				<MenuTrigger asChild>
					<IconButton icon={MoreHorizontalIcon} label="More actions" />
				</MenuTrigger>
				<MenuContent align="end">
					{m.status === "completed" && practice ? (
						<MenuItem icon={Undo02Icon} onSelect={() => setReason("not_held")}>
							Mark as not held
						</MenuItem>
					) : null}
					{m.status === "completed" && held && !m.occurrence.voidedAt ? (
						<MenuItem icon={CalendarRemove01Icon} onSelect={() => setReason("void")}>
							Void this occurrence
						</MenuItem>
					) : null}
					{m.occurrence.voidedAt ? (
						<MenuItem icon={Undo02Icon} onSelect={() => setReason("restore")}>
							Restore this occurrence
						</MenuItem>
					) : null}
					{m.status === "completed" ? <MenuSeparator /> : null}
					<MenuItem icon={Delete02Icon} danger onSelect={() => setReason("delete")}>
						Delete meeting
					</MenuItem>
				</MenuContent>
			</Menu>
		</>
	) : null;

	return (
		<>
			<PageHeader
				breadcrumb={[{ label: "Meetings", href: "/meetings" }, { label: m.displayTitle }]}
				title={
					<span className="inline-flex flex-wrap items-center gap-3">
						{m.displayTitle}
						<MeetingStatusBadge status={m.status} className="font-sans tracking-normal" />
						{m.occurrence.voidedAt ? (
							<StatusBadge status="risk" fill="soft" className="font-sans tracking-normal">
								Voided
							</StatusBadge>
						) : null}
					</span>
				}
				subtitle={
					<span className="flex flex-wrap gap-x-5 gap-y-1.5">
						<span className="inline-flex items-center gap-2">
							<Icon icon={Calendar03Icon} size={16} className="text-text-3" />
							{whenText(m, thisYear)}
						</span>
						<span className="inline-flex items-center gap-2">
							<Icon icon={Location01Icon} size={16} className="text-text-3" />
							{m.venue ? `${m.venue.name}, ${m.venue.address}` : "No place yet"}
						</span>
						<span className="text-text-3">{TYPE_LABEL[m.type]}</span>
					</span>
				}
				actions={actions}
			/>

			<div className="flex flex-col gap-5">
				{data.own ? <OwnRsvp key={data.own.revision} own={data.own} meetingId={m.id} title={m.displayTitle} /> : null}
				<div
					className={
						vision
							? "grid grid-cols-[1fr_1fr_1.1fr] items-stretch gap-5 max-app-lg:grid-cols-2 max-app-md:grid-cols-1"
							: "grid grid-cols-2 items-stretch gap-5 max-app-md:grid-cols-1"
					}
				>
					<RsvpSummary guests={data.guests} />
					{vision ? (
						<KitCard
							meeting={m}
							kit={data.kit}
							canWrite={canWrite}
							onKit={(kit) => setData((d) => ({ ...d, kit: d.kit ? { ...d.kit, ...kit } : null }))}
							onMeeting={setMeeting}
							onStale={stale}
						/>
					) : (
						<NotesCard notes={m.notes} />
					)}
					{vision ? <CardsSummary guests={data.guests} cards={data.cards} /> : null}
				</div>
				<div className="grid grid-cols-[1fr_1.6fr] items-start gap-5 max-app-lg:grid-cols-1">
					<div className="flex min-w-0 flex-col gap-5">
						<AgendaCard
							meeting={m}
							canWrite={canWrite}
							onSaved={(agenda) =>
								setData((d) => ({ ...d, meeting: { ...d.meeting, agenda, revision: agenda.revision } }))
							}
						/>
						{vision ? <NotesCard notes={m.notes} hideEmpty /> : null}
					</div>
					<GuestList
						meeting={m}
						guests={data.guests}
						cards={data.cards}
						canWrite={canWrite}
						onGuest={(g) =>
							setData((d) => ({
								...d,
								guests: d.guests?.some((x) => x.id === g.id)
									? d.guests.map((x) => (x.id === g.id ? g : x))
									: [...(d.guests ?? []), g],
							}))
						}
						onRemoved={(id) => setData((d) => ({ ...d, guests: d.guests?.filter((g) => g.id !== id) ?? null }))}
						onCard={(personId, card) =>
							setData((d) => ({
								...d,
								cards: [...(d.cards ?? []).filter((c) => c.personId !== personId), ...(card ? [card] : [])],
							}))
						}
						onStale={stale}
					/>
				</div>
			</div>

			{canWrite ? (
				<>
					<PlanMeetingDialog open={editing} onOpenChange={setEditing} meeting={m} onSaved={setMeeting} />
					<HeldDialog open={holding} onOpenChange={setHolding} meeting={m} onSaved={setMeeting} now={data.now} />
					<ReasonDialog
						open={reason !== null}
						onOpenChange={(o) => !o && setReason(null)}
						danger={reason === "delete"}
						title={
							reason === "delete"
								? `Delete ${m.displayTitle}?`
								: reason === "void"
									? "Void this occurrence?"
									: reason === "restore"
										? "Restore this occurrence?"
										: "Mark this practice as not held?"
						}
						consequences={
							reason === "delete"
								? [
										"It leaves the meetings list for everyone.",
										"Its guests, answers and history are kept.",
										...(practice && held ? ["A practice that really happened still counts toward Launch."] : []),
									]
								: reason === "void"
									? ["Use this when the meeting did not really happen as recorded.", "It no longer counts as held."]
									: reason === "restore"
										? ["It counts as held again."]
										: ["It goes back to Planning with no held time.", "It no longer counts toward Launch."]
						}
						confirmLabel={
							reason === "delete"
								? "Delete meeting"
								: reason === "void"
									? "Void occurrence"
									: reason === "restore"
										? "Restore occurrence"
										: "Mark as not held"
						}
						onConfirm={async (why, save) => {
							const r =
								reason === "delete"
									? await save({ reason, why }, (key) => deleteMeeting(key, m.revision, m.id, why))
									: reason === "not_held"
										? await save({ reason, why }, (key) =>
												correctPractice(key, m.revision, { meetingId: m.id, state: "not_completed", reason: why }),
											)
										: await save({ reason, why }, (key) =>
												correctOccurrence(key, m.revision, m.id, reason === "void", why),
											);
							if (r?.status !== "ok") {
								if (r?.status === "refused" && r.code === "conflict") stale();
								return false;
							}
							if (reason === "delete") {
								toast({ message: `${m.displayTitle} was deleted.`, tone: "success" });
								router.push("/meetings");
							} else setMeeting((r.value as { meeting: Detail }).meeting);
							return true;
						}}
					/>
				</>
			) : null}
		</>
	);
}

/** Yes, No and Pending for this meeting, from the guest list. */
function RsvpSummary({ guests }: { guests: MeetingPageData["guests"] }) {
	const c = rsvpCounts(guests ?? []);
	const total = guests?.length ?? 0;
	return (
		<Card as="section" aria-labelledby="rsvps-title">
			<CardHeader className="mb-3.5">
				<CardHeading>
					<CardTitle id="rsvps-title">RSVPs</CardTitle>
					<CardDescription>{guests ? `${total} invited` : "Did not load"}</CardDescription>
				</CardHeading>
			</CardHeader>
			<p className="flex items-end gap-3">
				<span className="font-display text-[40px] leading-none tracking-[-0.02em] text-ink tabular-nums">
					{c.confirmed}
				</span>
				<span className="pb-1.5 text-text-2">said yes</span>
			</p>
			<RsvpBar yes={c.confirmed} no={c.declined} pending={c.pending} size="lg" className="mt-[18px]" />
			<dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
				{(
					[
						["confirmed", "bg-green-500"],
						["declined", "bg-magenta-500"],
						["pending", "bg-amber-500"],
					] as const
				).map(([k, dot]) => (
					<div key={k} className="flex items-center gap-1.5">
						<span aria-hidden="true" className={`size-2 rounded-full ${dot}`} />
						<dt className="text-text-2">{RSVP_LABEL[k]}</dt>
						<dd className="font-semibold text-ink tabular-nums">{c[k]}</dd>
					</div>
				))}
			</dl>
		</Card>
	);
}

/**
 * Response cards (REQ-MTG-013): attended guests are the base; an attended guest without a card is unknown, never a
 * no. Cards from guests who were not recorded as attending are counted apart.
 */
function CardsSummary({ guests, cards }: { guests: MeetingPageData["guests"]; cards: MeetingPageData["cards"] }) {
	if (!guests || !cards)
		return (
			<Card as="section" aria-labelledby="cards-title">
				<CardTitle id="cards-title">Response cards</CardTitle>
				<CardDescription>Did not load. Reload the page in a moment.</CardDescription>
			</Card>
		);
	const attended = new Set(guests.filter((g) => g.presence === "attended").map((g) => g.person.personId));
	const fromAttended = cards.filter((c) => attended.has(c.personId));
	const fromOthers = cards.length - fromAttended.length;
	return (
		<Card as="section" aria-labelledby="cards-title">
			<CardHeader className="mb-3">
				<CardHeading>
					<CardTitle id="cards-title">Response cards</CardTitle>
					<CardDescription>
						{attended.size === 0
							? "No attendance recorded yet"
							: `${fromAttended.length} of ${attended.size} attended guests · ${attended.size - fromAttended.length} unknown`}
					</CardDescription>
				</CardHeading>
			</CardHeader>
			{cards.length === 0 ? (
				<p className="text-md text-text-3">
					No cards yet. After the meeting, record each card from the guest list menu.
				</p>
			) : (
				<dl className="flex flex-col">
					{CARD_RESPONSES.map((r) => {
						const n = cards.filter((c) => c.response === r).length;
						return (
							<div
								key={r}
								className="flex items-center justify-between gap-3 border-t border-line py-2 text-sm first:border-t-0"
							>
								<dt className="text-text-2">{CARD_LABEL[r]}</dt>
								<dd className="font-semibold text-ink tabular-nums">{n}</dd>
							</div>
						);
					})}
				</dl>
			)}
			{fromOthers > 0 ? (
				<p className="mt-3 text-sm text-text-3">
					{fromOthers} {fromOthers === 1 ? "card is" : "cards are"} from guests not recorded as attending.
				</p>
			) : null}
		</Card>
	);
}

function NotesCard({ notes, hideEmpty }: { notes: string | null; hideEmpty?: boolean }) {
	if (!notes && hideEmpty) return null;
	return (
		<Card as="section" aria-labelledby="notes-title">
			<CardHeader className="mb-3">
				<CardHeading>
					<CardTitle id="notes-title">Notes</CardTitle>
				</CardHeading>
			</CardHeader>
			{notes ? (
				<p className="text-md whitespace-pre-line text-text-2">{notes}</p>
			) : (
				<p className="text-md text-text-3">No notes. Add them with Edit.</p>
			)}
		</Card>
	);
}

/** The signed-in guest's own answer (REQ-MTG-009). It shows at once; the answer confirms it or puts it back. */
function OwnRsvp({
	own,
	meetingId,
	title,
}: {
	own: NonNullable<MeetingPageData["own"]>;
	meetingId: string;
	title: string;
}) {
	const toast = useToast();
	const [saved, setSaved] = useState<Rsvp>(own.rsvp);
	const [answer, setAnswer] = useOptimistic(saved);
	const [pending, startTransition] = useTransition();
	const choose = (rsvp: "confirmed" | "declined") =>
		startTransition(async () => {
			setAnswer(rsvp);
			const r = await saveOwnRsvp(crypto.randomUUID(), meetingId, rsvp).catch(() => ({ status: "lost" }) as const);
			if (r.status === "ok") startTransition(() => setSaved(r.value.guest.rsvp));
			else toast({ message: `Your answer was not saved. ${problemText(problemOf(r)!)}`, tone: "error" });
		});
	return (
		<Card variant="callout" tone="green" as="section" aria-labelledby="own-rsvp">
			<div className="flex flex-wrap items-center justify-between gap-4">
				<div>
					<h2 id="own-rsvp" className="font-semibold text-ink">
						You are invited to {title}
					</h2>
					<p className="mt-1 text-md text-text-2" aria-live="polite">
						{answer === "pending"
							? "You have not answered yet."
							: `Your answer: ${answer === "confirmed" ? "Yes, I'll come" : "I can't make it"}.`}
					</p>
				</div>
				{own.responseAllowed ? (
					<div className="flex flex-wrap gap-2.5" aria-busy={pending || undefined}>
						<Button
							variant={answer === "confirmed" ? "primary" : "secondary"}
							aria-pressed={answer === "confirmed"}
							onClick={() => choose("confirmed")}
						>
							Yes, I&apos;ll come
						</Button>
						<Button
							variant={answer === "declined" ? "primary" : "secondary"}
							aria-pressed={answer === "declined"}
							onClick={() => choose("declined")}
						>
							Can&apos;t make it
						</Button>
					</div>
				) : (
					<p className="text-sm text-text-3">This meeting no longer takes answers.</p>
				)}
			</div>
		</Card>
	);
}

/**
 * Mark a practice as held (REQ-MTG-002): it records when it actually happened, which cannot be in the future. Three
 * held practices meet the Launch criterion.
 */
function HeldDialog({
	open,
	onOpenChange,
	meeting,
	onSaved,
	now,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	meeting: Detail;
	onSaved: (meeting: Detail) => void;
	now: string;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{open ? <HeldForm meeting={meeting} onSaved={onSaved} onClose={() => onOpenChange(false)} now={now} /> : null}
		</Dialog>
	);
}

/** "2026-10-21T18:30" in the browser's zone, for a datetime-local input. */
const localInput = (at: Date) => {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}T${p(at.getHours())}:${p(at.getMinutes())}`;
};

function HeldForm({
	meeting,
	onSaved,
	onClose,
	now,
}: {
	meeting: Detail;
	onSaved: (meeting: Detail) => void;
	onClose: () => void;
	now: string;
}) {
	// The meeting's start, or the page's render time when the start is still ahead.
	const [value, setValue] = useState(() =>
		localInput(new Date(Math.min(Date.parse(meeting.startsAt), Date.parse(now)))),
	);
	const [future, setFuture] = useState(false);
	const { save, pending, problem } = useSave();
	return (
		<DialogContent size="sm" aria-busy={pending || undefined}>
			<form
				noValidate
				className="contents"
				onSubmit={async (e) => {
					e.preventDefault();
					const at = new Date(value);
					const bad = Number.isNaN(at.getTime()) || at.getTime() > Date.now();
					setFuture(bad);
					if (bad) return;
					const occurredAt = at.toISOString();
					const r = await save({ occurredAt }, (key) =>
						completePractice(key, meeting.revision, meeting.id, occurredAt),
					);
					if (r?.status === "ok") {
						onSaved(r.value.meeting);
						onClose();
					}
				}}
			>
				<DialogHeader icon={Clock01Icon} tone="green" title="Mark as held" description={meeting.displayTitle} />
				<DialogBody className="flex flex-col gap-4">
					<Field
						label="When it happened"
						hint="In your own time zone. It cannot be later than now."
						error={future ? "Choose a time that has already happened." : null}
					>
						<Input
							type="datetime-local"
							value={value}
							max={localInput(new Date(now))}
							onChange={(e) => setValue(e.target.value)}
						/>
					</Field>
					<Problem code={problem} />
				</DialogBody>
				<DialogFooter>
					<Button variant="secondary" type="button" onClick={onClose} disabled={pending}>
						Cancel
					</Button>
					<Button variant="primary" type="submit" loading={pending}>
						Mark as held
					</Button>
				</DialogFooter>
			</form>
		</DialogContent>
	);
}
