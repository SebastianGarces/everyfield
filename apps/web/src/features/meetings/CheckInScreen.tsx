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
import { startTransition, useOptimistic, useState } from "react";
import { addWalkIn, reloadCheckIn, setPresence, settleAttendance } from "./actions.ts";
import {
	attendanceAfter,
	canSettle,
	settledText,
	SettleDialog,
	usePresence,
	useSeats,
	type SettleInput,
} from "./Attendance.tsx";
import { PersonPicker, type PickedPerson } from "./dialogs.tsx";
import { problemText, RSVP_LABEL, timeText, type Guest } from "./model.ts";
import { attendeeOf, withAttendees, type Change } from "./page-state.ts";
import { Problem, problemOf, sendOnce } from "./parts.tsx";
import type { CheckInData } from "./server.ts";

type View = Pick<CheckInData, "guests" | "attendance">;
type Local = Change | { kind: "walkIn"; guest: Guest };

function apply(v: View, c: Local): View {
	if (c.kind === "walkIn") return { ...v, guests: [...v.guests, c.guest] };
	if (c.kind !== "presence") return v;
	return {
		guests: v.guests.map((g) => (g.person.personId === c.personId ? { ...g, presence: c.presence } : g)),
		attendance: v.attendance && {
			...v.attendance,
			items: v.attendance.items.map((a) => (a.person.personId === c.personId ? { ...a, presence: c.presence } : a)),
		},
	};
}

/**
 * Door check-in (REQ-MTG-010, phone layout): one tap marks a guest here, a second tap takes it back. A walk-in is
 * someone in People or someone new. Each tap shows at once; one save per person runs at a time. Finish reviews and
 * finalizes the attendance. The list never reloads while people arrive.
 */
export function CheckInScreen({ data }: { data: CheckInData }) {
	return (
		<ToastProvider>
			<CheckIn loaded={data} />
		</ToastProvider>
	);
}

function CheckIn({ loaded }: { loaded: CheckInData }) {
	const toast = useToast();
	const [data, setData] = useState(loaded);
	const [view, project] = useOptimistic<View, Local>({ guests: data.guests, attendance: data.attendance }, apply);
	const [filter, setFilter] = useState<"waiting" | "here">("waiting");
	const [search, setSearch] = useState("");
	const [walkIn, setWalkIn] = useState<{ visible: boolean; problem: string | null; input: WalkInInput | null } | null>(
		null,
	);
	const [settle, setSettle] = useState<{ visible: boolean; input: SettleInput | null; problem: string | null } | null>(
		null,
	);
	const [settling, setSettling] = useState(false);
	const [early, setEarly] = useState(false);
	const seats = useSeats();
	const m = data.meeting;
	const final = data.attendance?.finalized != null;
	const stale = () =>
		reloadCheckIn(m.id).then((r) => {
			if (r.status === "ok" && r.value.status === "found") setData(r.value);
		});
	const presence = usePresence({
		meetingId: m.id,
		project,
		onSaved: (a) => setData((d) => withAttendees(d, a.attendees, a.attendanceRevision)),
		onStale: stale,
	});

	const here = view.guests.filter((g) => g.presence === "attended");
	const waiting = view.guests.filter((g) => g.presence !== "attended");
	const q = search.trim().toLowerCase();
	const rows = (filter === "here" ? here : waiting)
		.filter((g) => !q || g.person.displayName.toLowerCase().includes(q))
		.sort((a, b) => rank(a) - rank(b) || a.person.displayName.localeCompare(b.person.displayName));

	function submitWalkIn(input: WalkInInput) {
		setWalkIn((w) => w && { ...w, visible: false, input, problem: null });
		const pending = {
			id: `pending-${crypto.randomUUID()}`,
			revision: "0",
			person: { personId: input.person?.id ?? "pending", displayName: input.person?.name ?? input.name, state: "live" },
			inviter: null,
			rsvp: "pending",
			rsvpSource: null,
			rsvpAt: null,
			presence: "attended",
			hasCard: false,
		} as unknown as Guest;
		startTransition(async () => {
			project({ kind: "walkIn", guest: pending });
			setFilter("here");
			const body = {
				meetingId: m.id,
				displayName: input.name.trim(),
				email: input.email.trim() || null,
				phone: input.phone.trim() || null,
				country: "US",
			};
			const p = input.person;
			const r = p
				? await sendOnce(crypto.randomUUID(), (key) => setPresence(key, m.id, p.id, "attended"))
				: await sendOnce(crypto.randomUUID(), (key) => addWalkIn(key, body));
			if (r?.status === "ok") {
				startTransition(() =>
					setData((d) => {
						if ("guest" in r.value) {
							const g = r.value.guest as Guest;
							return {
								...d,
								guests: [...d.guests, g],
								attendance: d.attendance && { ...d.attendance, items: [...d.attendance.items, attendeeOf(g)] },
							};
						}
						const a = r.value.attendees[0]!;
						const g = { ...pending, id: a.guestId, revision: a.revision, person: a.person } as Guest;
						return withAttendees({ ...d, guests: [...d.guests, g] }, r.value.attendees, r.value.attendanceRevision);
					}),
				);
				setWalkIn(null);
				toast({ message: `${pending.person.displayName} is checked in.`, tone: "success" });
				return;
			}
			const code = r ? problemOf(r)! : "lost";
			if (code === "lost") {
				stale();
				setWalkIn(null);
				toast({ message: problemText("unconfirmed"), tone: "error" });
			} else setWalkIn((w) => w && { ...w, visible: true, problem: code });
		});
	}

	function finish() {
		// The meeting must have started before attendance can be final; the time is read when the person asks.
		if (!canSettle(m, new Date().toISOString())) return setEarly(true);
		setEarly(false);
		seats.load();
		setSettle({ visible: true, input: null, problem: null });
	}
	function submitSettle(input: SettleInput) {
		const attendance = data.attendance!;
		setSettle((s) => s && { ...s, visible: false, input, problem: null });
		setSettling(true);
		startTransition(async () => {
			const r = await sendOnce(crypto.randomUUID(), (key) =>
				settleAttendance("finalize", key, attendance.attendanceRevision, {
					meetingId: m.id,
					attendeeIds: input.attendeeIds,
					followUpAssigneeId: input.followUpAssigneeId,
					evaluationAssigneeId: input.evaluationAssigneeId,
				}),
			);
			setSettling(false);
			if (r?.status === "ok") {
				setData((d) => ({ ...d, attendance: d.attendance && attendanceAfter(d.attendance, r.value.result) }));
				setSettle(null);
				toast({ message: settledText(r.value.result, m.displayTitle, "finalize"), tone: "success" });
				return;
			}
			const code = r ? problemOf(r)! : "lost";
			if (code === "lost" || code === "conflict") stale();
			if (code === "lost") {
				setSettle(null);
				toast({ message: problemText("unconfirmed"), tone: "error" });
			} else setSettle((s) => s && { ...s, visible: true, problem: code });
		});
	}

	return (
		<div className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col bg-frame">
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
				<h2 className="sr-only">{filter === "here" ? "Here" : "Not here yet"}</h2>
				{rows.length === 0 ? (
					<p className="px-1 py-8 text-center text-md text-text-3" aria-live="polite">
						{q
							? "No one on the list matches. Add them as a walk-in."
							: filter === "here"
								? "Nobody is checked in yet."
								: view.guests.length === 0
									? "The guest list is empty. Add people as they arrive."
									: "Everyone on the list is here."}
					</p>
				) : (
					<ul className="flex flex-col gap-2">
						{rows.map((g) => (
							<li key={g.id}>
								<Row
									guest={g}
									disabled={final || g.id.startsWith("pending-") || g.person.state !== "live"}
									saving={g.id.startsWith("pending-") || presence.busy.has(g.person.personId)}
									onToggle={() => presence.set(g.person, g.presence === "attended" ? "absent" : "attended")}
								/>
							</li>
						))}
					</ul>
				)}
			</main>

			{final ? null : (
				<footer className="sticky bottom-0 flex flex-col gap-2 bg-frame px-4 pt-2 pb-[max(16px,env(safe-area-inset-bottom))]">
					{early ? (
						<p role="status" className="text-center text-sm text-text-2">
							You can finish after the meeting starts at {timeText(m.localTime)}.
						</p>
					) : null}
					<div className="grid grid-cols-2 gap-2">
						<Button
							variant="secondary"
							icon={UserAdd01Icon}
							className="h-12"
							onClick={() => setWalkIn({ visible: true, problem: null, input: null })}
						>
							Add a walk-in
						</Button>
						<Button
							variant="primary"
							icon={CheckListIcon}
							className="h-12"
							loading={settling}
							onClick={finish}
							onPointerEnter={seats.load}
							onFocus={seats.load}
							onTouchStart={seats.load}
						>
							Finish check-in
						</Button>
					</div>
				</footer>
			)}

			{walkIn ? (
				<WalkInDialog
					open={walkIn.visible}
					initial={walkIn.input}
					problem={walkIn.problem}
					exclude={view.guests.map((g) => g.person.personId)}
					onClose={() => setWalkIn(null)}
					onSubmit={submitWalkIn}
				/>
			) : null}
			{settle && data.attendance ? (
				<SettleDialog
					open={settle.visible}
					mode="finalize"
					meeting={m}
					guests={data.guests}
					attendance={data.attendance}
					seats={seats.seats}
					onSeats={seats.load}
					initial={settle.input}
					problem={settle.problem}
					onClose={() => setSettle(null)}
					onSubmit={submitSettle}
				/>
			) : null}
		</div>
	);
}

/** Guests who said yes come first, then pending, then no. */
const rank = (g: Guest) => (g.rsvp === "confirmed" ? 0 : g.rsvp === "pending" ? 1 : 2);

/** One guest at the door: a 58px toggle button. Pressed means here. */
function Row({
	guest: g,
	disabled,
	saving,
	onToggle,
}: {
	guest: Guest;
	disabled: boolean;
	saving: boolean;
	onToggle: () => void;
}) {
	const here = g.presence === "attended";
	const detail = [
		g.id.startsWith("pending-") ? "Saving…" : null,
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
			aria-busy={saving || undefined}
			aria-disabled={disabled || undefined}
			onClick={() => !saving && !disabled && onToggle()}
			className={cn(
				"flex min-h-[58px] w-full cursor-pointer items-center gap-3 rounded-card px-3.5 py-2 text-left transition-[background-color,box-shadow] duration-150 focus-visible:shadow-[0_0_0_2px_var(--ef-ink)] focus-visible:outline-none aria-disabled:cursor-default",
				here
					? "bg-green-50 shadow-[inset_0_0_0_1px_var(--ef-green-200)]"
					: "bg-surface-raised shadow-[inset_0_0_0_1px_var(--ef-line)] hover:bg-surface-2 aria-disabled:hover:bg-surface-raised",
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
					here ? "bg-green-500 text-white" : "shadow-[inset_0_0_0_1.5px_var(--ef-line-2)]",
				)}
			>
				{here ? <Icon icon={Tick02Icon} size={16} /> : null}
			</span>
		</button>
	);
}

type WalkInInput = { person: PickedPerson | null; name: string; email: string; phone: string };

/**
 * A walk-in (REQ-MTG-010, REQ-MTG-011): someone in People who is not on the list, or someone new. Someone new joins
 * People as a prospect from this meeting with their attendance in the same save; nothing gives them a login.
 */
function WalkInDialog({
	open,
	initial,
	problem,
	exclude,
	onClose,
	onSubmit,
}: {
	open: boolean;
	initial: WalkInInput | null;
	problem: string | null;
	exclude: string[];
	onClose: () => void;
	onSubmit: (input: WalkInInput) => void;
}) {
	const [mode, setMode] = useState<"existing" | "new">(initial && !initial.person ? "new" : "existing");
	const [input, setInput] = useState<WalkInInput>(initial ?? { person: null, name: "", email: "", phone: "" });
	const [touched, setTouched] = useState(false);
	const nameMissing = input.name.trim() === "";
	const emailBad = input.email.trim() !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim());
	return (
		<Dialog open={open} onOpenChange={(o) => !o && onClose()}>
			<DialogContent size="sm">
				<form
					noValidate
					className="contents"
					onSubmit={(e) => {
						e.preventDefault();
						setTouched(true);
						if (mode === "existing") return input.person && onSubmit({ ...input, name: input.person.name });
						if (nameMissing || emailBad) return;
						onSubmit({ ...input, person: null });
					}}
				>
					<DialogHeader icon={UserAdd01Icon} tone="green" title="Add a walk-in" />
					<DialogBody className="flex flex-col gap-4">
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
						{mode === "existing" ? (
							<Field label="Person" error={touched && !input.person ? "Choose who came." : null}>
								<PersonPicker
									label="Person"
									value={input.person}
									onChange={(person) => setInput((i) => ({ ...i, person }))}
									exclude={exclude}
									autoFocus
								/>
							</Field>
						) : (
							<>
								<Field label="Name" error={touched && nameMissing ? "Enter the name people call them." : null}>
									<Input
										value={input.name}
										maxLength={255}
										autoComplete="off"
										onChange={(e) => setInput((i) => ({ ...i, name: e.target.value }))}
										autoFocus
									/>
								</Field>
								<Field label="Email" optional error={touched && emailBad ? "Enter a full email address." : null}>
									<Input
										type="email"
										inputMode="email"
										value={input.email}
										maxLength={320}
										autoComplete="off"
										onChange={(e) => setInput((i) => ({ ...i, email: e.target.value }))}
									/>
								</Field>
								<Field label="Phone" optional hint="Country: United States (US).">
									<Input
										type="tel"
										value={input.phone}
										maxLength={40}
										autoComplete="off"
										onChange={(e) => setInput((i) => ({ ...i, phone: e.target.value }))}
									/>
								</Field>
								<p className="text-sm text-text-3">
									They join People as a prospect from this meeting. If they are already in People, choose In People.
								</p>
							</>
						)}
						<Problem code={problem} />
					</DialogBody>
					<DialogFooter>
						<Button variant="secondary" type="button" onClick={onClose}>
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
