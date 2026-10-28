"use client";

import { ArrowLeft01Icon, CheckListIcon, Tick02Icon, UserAdd01Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Field,
	Input,
	IntentLink,
	iconButtonVariants,
	SearchInput,
	SegmentedControl,
	ToastProvider,
	useToast,
} from "@everyfield/ui/controls";
import { Avatar, StatusBadge } from "@everyfield/ui/display";
import { cn, Icon } from "@everyfield/ui/foundations";
import { useRef, useState } from "react";
import { addWalkIn, reloadCheckIn, setPresence, settleAttendance } from "./actions.ts";
import {
	DialogNotice,
	NoticeInDialog,
	RowNotices,
	SaveNotice,
	useSaveIntent,
	type RowSave,
} from "../../components/save/parts.tsx";
import { attendanceAfter, settledText, SettleDialog, usePresence, useSeats, type SettleInput } from "./Attendance.tsx";
import { PersonPicker, type PickedPerson } from "./dialogs.tsx";
import { problemText, RSVP_LABEL, timeText, type Guest } from "./model.ts";
import { attendeeOf, isPending, PENDING, withAttendees, type GuestRow, type PendingGuest } from "./page-state.ts";
import { Problem, TabStack } from "./parts.tsx";
import type { CheckInData } from "./server.ts";

/**
 * Door check-in (REQ-MTG-010, phone layout): one tap marks a guest here, a second tap takes it back. A walk-in is
 * someone in People or someone new. Each tap shows at once; one save per person runs at a time. Finish reviews and
 * finalizes the attendance. The list never reloads while people arrive.
 */
export function CheckInScreen({ data, admin }: { data: CheckInData; admin: boolean }) {
	return (
		<ToastProvider>
			<CheckIn loaded={data} admin={admin} />
		</ToastProvider>
	);
}

/**
 * `admin` is an Owner or Admin. A team meeting's leader (not admin) marks people here and checks in someone already in
 * People; adding a new person and finalizing stay with Owners and Admins (C74).
 */
function CheckIn({ loaded, admin }: { loaded: CheckInData; admin: boolean }) {
	const toast = useToast();
	const [data, setData] = useState(loaded);
	const [filter, setFilter] = useState<"waiting" | "here">("waiting");
	const [search, setSearch] = useState("");
	const seats = useSeats();
	// A walk-in and Finish both change who attended, so they share one save lane (C68). Presence taps have one per person.
	const door = useSaveIntent<DoorForm>({ explain: problemText });
	// The walk-in row as the person asked for it, shown while its save is on its way or unknown.
	const [draft, setDraft] = useState<PendingGuest | null>(null);
	const m = data.meeting;
	const final = data.attendance?.finalized != null;
	/** The latest guests and attendance after a refusal as out of date. Resolves true once they show. */
	const stale = () =>
		reloadCheckIn(m.id).then(
			(r) => {
				if (r.status !== "ok" || r.value.status !== "found") return false;
				setData(r.value);
				return true;
			},
			() => false,
		);
	const presence = usePresence({
		meetingId: m.id,
		onSaved: (a) => setData((d) => withAttendees(d, a.attendees, a.attendanceRevision)),
		onStale: stale,
	});

	const guests: GuestRow[] = [...presence.shown(data.guests), ...(door.wait !== null && draft ? [draft] : [])];
	// A row whose save is unknown stays in the list where it was tapped, marked Not confirmed, so it is easy to find.
	const before = new Map(data.guests.map((g) => [g.person.personId, g.presence]));
	const stateOf = (g: GuestRow) => (isPending(g) ? undefined : presence.stateOf(g.person.personId));
	const listed = (g: GuestRow) => {
		const st = stateOf(g);
		return (st === "unknown" || st === "checking") && !isPending(g)
			? (before.get(g.person.personId) ?? g.presence)
			: g.presence;
	};
	const here = guests.filter((g) => listed(g) === "attended");
	const waiting = guests.filter((g) => listed(g) !== "attended");
	const q = search.trim().toLowerCase();
	const rows = (filter === "here" ? here : waiting)
		.filter((g) => !q || g.person.displayName.toLowerCase().includes(q))
		.sort((a, b) => rank(a) - rank(b) || a.person.displayName.localeCompare(b.person.displayName));

	function submitWalkIn(input: WalkInInput) {
		const p = input.person;
		const pending: PendingGuest = {
			id: `${PENDING}${crypto.randomUUID()}`,
			revision: null,
			person: { personId: p?.id ?? null, displayName: p?.name ?? input.name, state: "live" },
			inviter: null,
			rsvp: "pending",
			rsvpSource: null,
			rsvpAt: null,
			presence: "attended",
			hasCard: false,
		};
		const done = () => {
			setDraft(null);
			toast({ message: `${pending.person.displayName} is checked in.`, tone: "success" });
		};
		const save = {
			what: pending.person.displayName,
			done: "checked in",
			form: { kind: "walkIn", input } as const,
			refused: () => setDraft(null),
		};
		setDraft(pending);
		setFilter("here");
		if (p)
			return void door.save({
				...save,
				send: (key) => setPresence(key, m.id, p.id, "attended"),
				ok: (value) => {
					const a = value.attendees[0]!;
					const g: Guest = {
						id: a.guestId,
						revision: a.revision,
						person: a.person,
						inviter: null,
						rsvp: a.rsvp,
						rsvpSource: null,
						rsvpAt: null,
						presence: a.presence,
						hasCard: a.hasCard,
					};
					setData((d) => withAttendees({ ...d, guests: [...d.guests, g] }, value.attendees, value.attendanceRevision));
					done();
				},
			});
		const body = {
			meetingId: m.id,
			displayName: input.name.trim(),
			email: input.email.trim() || null,
			phone: input.phone.trim() || null,
			country: "US",
		};
		void door.save({
			...save,
			send: (key) => addWalkIn(key, body),
			ok: ({ guest: g }) => {
				setData((d) => ({
					...d,
					guests: [...d.guests, g],
					attendance: d.attendance && { ...d.attendance, items: [...d.attendance.items, attendeeOf(g)] },
				}));
				done();
			},
		});
	}

	function finish() {
		if (door.wait !== null || presence.busy) return;
		seats.load();
		door.open({ kind: "settle", input: null });
	}
	function submitSettle(input: SettleInput) {
		const attendance = data.attendance!;
		void door.save({
			what: "Attendance",
			done: "finalized",
			form: { kind: "settle", input },
			send: (key) =>
				settleAttendance("finalize", key, attendance.attendanceRevision, {
					meetingId: m.id,
					attendeeIds: input.attendeeIds,
					followUpAssigneeId: input.followUpAssigneeId,
					evaluationAssigneeId: input.evaluationAssigneeId,
				}),
			ok: ({ result }) => {
				setData((d) => ({ ...d, attendance: d.attendance && attendanceAfter(d.attendance, result) }));
				toast({ message: settledText(result, m.displayTitle, "finalize"), tone: "success" });
			},
			// Out of date: review again from who is marked now, never from the earlier list (F6).
			refused: (code) => {
				if (code !== "conflict") return;
				void stale().then((shown) =>
					door.open({ kind: "settle", input: null, problem: shown ? "conflict" : "conflict_unloaded" }),
				);
			},
		});
	}
	const doorBusy = door.wait !== null;

	return (
		<div className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col bg-frame [--control-edge:var(--ef-edge)]">
			<header className="sticky top-0 z-10 flex flex-col gap-3 bg-frame px-4 pt-3 pb-3">
				<div className="flex items-center justify-between gap-3">
					<IntentLink
						href={`/meetings/${m.id}`}
						aria-label={`Back to ${m.displayTitle}`}
						className={iconButtonVariants({ size: "sm" })}
					>
						<Icon icon={ArrowLeft01Icon} size={16} />
					</IntentLink>
					<div className="min-w-0 text-center">
						<h1 className="font-semibold text-ink">Check-in</h1>
						<p className="truncate text-xs text-text-3">
							{m.displayTitle} · {timeText(m.localTime)}
						</p>
					</div>
					<StatusBadge status="positive" size="sm">
						<span className="tabular-nums">{here.length}</span>
						<span className="sr-only"> here</span>
					</StatusBadge>
				</div>
				{final ? (
					<p role="status" className="rounded-md bg-green-50 px-3.5 py-2.5 text-sm text-green-700">
						Attendance is final. To change it, use Correct attendance on{" "}
						<IntentLink href={`/meetings/${m.id}`} className="font-medium underline underline-offset-4">
							the meeting page
						</IntentLink>
						.
					</p>
				) : null}
				<SearchInput
					aria-label="Find a name"
					placeholder="Find a name"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					className="h-[46px]"
				/>
				<SegmentedControl
					label="Show"
					value={filter}
					onValueChange={setFilter}
					className="flex w-full [&>*]:flex-1 [&>*]:justify-center"
					options={[
						{ value: "waiting", label: "Not here yet", count: waiting.length },
						{ value: "here", label: "Here", count: here.length },
					]}
				/>
			</header>

			<main className="flex flex-1 flex-col px-4 pb-4">
				<SaveNotice {...door.noticeProps} dialogOpen={door.editing !== null} className="mb-3" />
				<RowNotices lanes={presence.lanes} className="mb-3" />
				<h2 className="sr-only">{filter === "here" ? "Here" : "Not here yet"}</h2>
				{rows.length === 0 ? (
					<p className="px-1 py-8 text-center text-md text-text-3" aria-live="polite">
						{q
							? "No one on the list matches. Add them as a walk-in."
							: filter === "here"
								? "Nobody is checked in yet."
								: guests.length === 0
									? "The guest list is empty. Add people as they arrive."
									: "Everyone on the list is here."}
					</p>
				) : (
					<ul className="flex flex-col gap-2">
						{rows.map((g) => (
							<li key={g.id}>
								<Row
									guest={g}
									disabled={final || isPending(g) || g.person.state !== "live"}
									state={isPending(g) ? (door.saving ? "saving" : "unknown") : stateOf(g)}
									onToggle={() =>
										!isPending(g) && presence.set(g.person, g.presence === "attended" ? "absent" : "attended")
									}
								/>
							</li>
						))}
					</ul>
				)}
			</main>

			{final ? null : (
				<footer className="sticky bottom-0 flex flex-col gap-2 bg-frame px-4 pt-2 pb-[max(16px,env(safe-area-inset-bottom))]">
					{admin ? null : (
						<p className="text-center text-sm text-text-2">
							An Owner or Admin finalizes attendance on the meeting page.
						</p>
					)}
					<div className={admin ? "grid grid-cols-2 gap-2" : "grid grid-cols-1 gap-2"}>
						<Button
							variant="outline"
							icon={UserAdd01Icon}
							className="h-12"
							disabled={doorBusy}
							onClick={() => !doorBusy && door.open({ kind: "walkIn", input: null })}
						>
							Add a walk-in
						</Button>
						{admin ? (
							<Button
								variant="primary"
								icon={CheckListIcon}
								className="h-12"
								loading={door.saving && !draft}
								disabled={doorBusy || presence.busy}
								onClick={finish}
								onPointerEnter={seats.load}
								onFocus={seats.load}
								onTouchStart={seats.load}
							>
								Finish check-in
							</Button>
						) : null}
					</div>
				</footer>
			)}

			<NoticeInDialog {...door.noticeProps}>
				{door.editing?.kind === "walkIn" ? (
					<WalkInDialog
						initial={door.editing.input}
						problem={door.problem}
						exclude={guests.flatMap((g) => (g.person.personId ? [g.person.personId] : []))}
						allowNew={admin}
						onClose={door.close}
						onSubmit={submitWalkIn}
					/>
				) : door.editing?.kind === "settle" && data.attendance ? (
					<SettleDialog
						open
						mode="finalize"
						meeting={m}
						guests={data.guests}
						attendance={data.attendance}
						seats={seats.seats}
						onSeats={seats.load}
						initial={door.editing.input}
						problem={door.problem}
						onClose={door.close}
						onSubmit={submitSettle}
					/>
				) : null}
			</NoticeInDialog>
		</div>
	);
}

/** Guests who said yes come first, then pending, then no. */
const rank = (g: GuestRow) => (g.rsvp === "confirmed" ? 0 : g.rsvp === "pending" ? 1 : 2);

/** One guest at the door: a 58px toggle button. Pressed means here. */
function Row({
	guest: g,
	disabled,
	state,
	onToggle,
}: {
	guest: GuestRow;
	disabled: boolean;
	/** This row's save: on its way, unknown or being checked again. Undefined when the row takes a tap. */
	state: RowSave | undefined;
	onToggle: () => void;
}) {
	const here = g.presence === "attended";
	const saving = state !== undefined;
	const detail = [
		state === "unknown" ? "Not confirmed" : saving ? "Saving…" : null,
		g.person.state !== "live" ? (g.person.state === "merged" ? "Merged" : "Retired") : null,
		g.rsvp !== "pending" ? `RSVP ${RSVP_LABEL[g.rsvp]}` : null,
		g.inviter ? `invited by ${g.inviter.displayName}` : null,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<button
			type="button"
			aria-pressed={here}
			aria-busy={state === "saving" || state === "checking" || undefined}
			aria-disabled={disabled || saving || undefined}
			onClick={() => !saving && !disabled && onToggle()}
			className={cn(
				"flex min-h-[58px] w-full cursor-pointer items-center gap-3 rounded-card px-3.5 py-2 text-left transition-[background-color,box-shadow] duration-150 focus-visible:shadow-[0_0_0_2px_var(--ef-ink)] focus-visible:outline-none aria-disabled:cursor-default",
				here
					? "bg-green-50 shadow-edge"
					: "bg-surface-raised shadow-edge hover:bg-surface-2 aria-disabled:hover:bg-surface-raised",
			)}
		>
			<Avatar name={g.person.displayName} size="sm" decorative />
			<span className="min-w-0 flex-1">
				<span className="block truncate font-medium text-ink">{g.person.displayName}</span>
				{detail ? <span className="block truncate text-xs text-text-3">{detail}</span> : null}
			</span>
			<span
				aria-hidden="true"
				className={cn(
					"grid size-8 flex-none place-items-center rounded-full transition-[background-color,box-shadow] duration-150",
					here ? "bg-green-500 text-ink-fixed" : "shadow-edge-inset",
				)}
			>
				{here ? <Icon icon={Tick02Icon} size={16} /> : null}
			</span>
		</button>
	);
}

type WalkInInput = { person: PickedPerson | null; name: string; email: string; phone: string };
/** The door's open form, with what was entered when a refusal opens it again. */
type DoorForm = ({ kind: "walkIn"; input: WalkInInput | null } | { kind: "settle"; input: SettleInput | null }) & {
	problem?: string;
};

/**
 * A walk-in (REQ-MTG-010, REQ-MTG-011): someone in People who is not on the list, or someone new. Someone new joins
 * People as a prospect from this meeting with their attendance in the same save; nothing gives them a login.
 */
function WalkInDialog({
	initial,
	problem,
	exclude,
	allowNew,
	onClose,
	onSubmit,
}: {
	initial: WalkInInput | null;
	/** Why the last check-in was refused, in words. */
	problem: string | undefined;
	exclude: string[];
	/** Only an Owner or Admin adds someone new to People; a team leader picks someone already there. */
	allowNew: boolean;
	onClose: () => void;
	onSubmit: (input: WalkInInput) => void;
}) {
	const initialMode = initial && !initial.person ? "new" : "existing";
	const [mode, setMode] = useState<"existing" | "new">(initialMode);
	const [input, setInput] = useState<WalkInInput>(initial ?? { person: null, name: "", email: "", phone: "" });
	const [touched, setTouched] = useState(false);
	const body = useRef<HTMLDivElement>(null);
	const nameMissing = input.name.trim() === "";
	const emailBad = input.email.trim() !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim());
	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent size="sm" className="[--control-edge:var(--ef-edge)]">
				<form
					noValidate
					className="contents"
					onSubmit={(e) => {
						e.preventDefault();
						setTouched(true);
						// Focus goes to the first field to fix (F5).
						const focus = (name: string) =>
							body.current?.querySelector<HTMLElement>(`[data-field="${name}"] input`)?.focus();
						if (mode === "existing")
							return input.person ? onSubmit({ ...input, name: input.person.name }) : focus("person");
						if (nameMissing) return focus("name");
						if (emailBad) return focus("email");
						onSubmit({ ...input, person: null });
					}}
				>
					<DialogHeader icon={UserAdd01Icon} tone="green" title="Add a walk-in" />
					<DialogBody ref={body} className="flex flex-col gap-4">
						<DialogNotice />
						{allowNew ? (
							<SegmentedControl
								label="Who"
								value={mode}
								onValueChange={setMode}
								className="flex w-full [&>*]:flex-1 [&>*]:justify-center"
								options={[
									{ value: "existing", label: "In People" },
									{ value: "new", label: "Someone new" },
								]}
							/>
						) : null}
						<TabStack
							active={mode}
							className="gap-4"
							panels={{
								existing: (
									<div data-field="person" className="contents">
										<Field label="Person" error={touched && !input.person ? "Choose who came." : null}>
											<PersonPicker
												label="Person"
												value={input.person}
												onChange={(person) => setInput((i) => ({ ...i, person }))}
												exclude={exclude}
												autoFocus={initialMode === "existing"}
											/>
										</Field>
									</div>
								),
								...(allowNew && {
									new: (
										<>
											<div data-field="name" className="contents">
												<Field label="Name" error={touched && nameMissing ? "Enter the name people call them." : null}>
													<Input
														value={input.name}
														maxLength={255}
														autoComplete="off"
														onChange={(e) => setInput((i) => ({ ...i, name: e.target.value }))}
														autoFocus={initialMode === "new"}
													/>
												</Field>
											</div>
											<div data-field="email" className="contents">
												<Field
													label="Email"
													optional
													error={touched && emailBad ? "Enter a full email address." : null}
												>
													<Input
														type="email"
														inputMode="email"
														value={input.email}
														maxLength={320}
														autoComplete="off"
														onChange={(e) => setInput((i) => ({ ...i, email: e.target.value }))}
													/>
												</Field>
											</div>
											<Field label="Phone" optional hint="Country: United States (US).">
												<Input
													type="tel"
													value={input.phone}
													maxLength={40}
													autoComplete="off"
													onChange={(e) => setInput((i) => ({ ...i, phone: e.target.value }))}
												/>
											</Field>
											<p className="text-sm text-text-2">
												They join People as a prospect from this meeting. If they are already in People, choose In
												People.
											</p>
										</>
									),
								}),
							}}
						/>
						<Problem text={problem} />
					</DialogBody>
					<DialogFooter>
						<Button variant="outline" type="button" onClick={onClose}>
							Cancel
						</Button>
						<Button variant="primary" type="submit">
							Check in
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
