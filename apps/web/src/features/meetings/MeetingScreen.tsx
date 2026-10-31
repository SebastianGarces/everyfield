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
import { localDate } from "@everyfield/contracts/common";
import { statusTransitions } from "@everyfield/contracts/meetings";
import {
	Button,
	buttonVariants,
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	Field,
	IconButton,
	Input,
	IntentLink,
	Menu,
	MenuContent,
	MenuItem,
	MenuLabel,
	MenuSeparator,
	MenuTrigger,
	PageHeader,
	Tab,
	Tabs,
	TabsList,
	TabsPanel,
	useToast,
} from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { cn, Icon } from "@everyfield/ui/foundations";
import { useRouter, useSearchParams } from "next/navigation";
import { averageOf } from "@everyfield/contracts/meetings";
import { useOptimistic, useState, useTransition } from "react";
import { FixedFrame } from "../../components/frame/FixedFrame.tsx";
import type { Wait } from "../../components/save/model.ts";
import {
	NoticeInDialog,
	RecordDialog,
	SaveNotice,
	useSaveIntent,
	type SaveIntent,
} from "../../components/save/parts.tsx";
import {
	changeStatus,
	completePractice,
	correctOccurrence,
	correctPractice,
	reloadMeeting,
	correctEvaluation,
	recordEvaluation,
	saveOwnRsvp,
	settleAttendance,
} from "./actions.ts";
import {
	AttendanceCard,
	attendanceAfter,
	HELD,
	EvaluationCard,
	EvaluationDialog,
	HistoryDialog,
	settledText,
	SettleDialog,
	useEvaluationHistory,
	usePresence,
	warmSeats,
	type EvaluationEditing,
	type EvaluationInput,
	type SettleEditing,
	type SettleInput,
	type ShownEvaluation,
} from "./Attendance.tsx";
import { AgendaCard } from "./Agenda.tsx";
import { ReasonDialog } from "./dialogs.tsx";
import { GuestList } from "./GuestList.tsx";
import { KitCard } from "./Kit.tsx";
import {
	CARD_LABEL,
	CARD_RESPONSES,
	problemText,
	rsvpCounts,
	RSVP_LABEL,
	STATUS_ACTION,
	STATUS_LABEL,
	TYPE_LABEL,
	whenText,
	type Detail,
	type MeetingStatus,
	type Outcome,
	type Issue,
	type Scores,
} from "./model.ts";
import { MeetingStatusBadge, RsvpBar } from "./parts.tsx";
import { defaultTab, nextStep, pickTab, type Primary, type TabId } from "./next-step.ts";
import { deleteFromList } from "./deletions.ts";
import { applyChange, withAttendees, type Change, type GuestRow, type PageView } from "./page-state.ts";
import { PlanMeetingDialog } from "./PlanMeetingDialog.tsx";
import type { MeetingPageData } from "./server.ts";

// Width-gated classes for the Kit tab's fill height. Tailwind reads class names as literals, so each is spelled out.
const FILL_FRAME = "app-md:-mb-[72px] app-md:flex app-md:h-[var(--frame-h,calc(100dvh-420px))] app-md:flex-col";
const FILL_GRID = "app-md:min-h-0 app-md:flex-1 app-md:grid-rows-[auto_minmax(0,1fr)] app-md:items-stretch";
const FILL_PANEL = "app-md:flex app-md:min-h-0 app-md:flex-col";
// Beside the content the tab bar takes row 1; the panels and the rail share row 2, so the rail starts where the
// panel's first card starts. The row gap replaces the panel's top padding (pt-6) at that width.
const PANEL_CELL = "app-md:col-start-1 app-md:row-start-2 app-md:pt-0";
const FILL_ASIDE = "app-md:-mx-1 app-md:min-h-0 app-md:overflow-y-auto app-md:px-1 app-md:pb-1";

type Reason = "void" | "restore" | "not_held";
/** The meeting's open form, with what was entered when a refusal opens it again. */
type MeetingForm = ({ kind: "held"; at: string } | { kind: "reason"; reason: Reason; why: string }) & {
	problem?: string;
};

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
	const [deleting, setDeleting] = useState(false);
	const [, startTransition] = useTransition();
	const [status, setOptimisticStatus] = useOptimistic(data.meeting.status);
	// One optimistic page state: a write projects its change at once into every place it shows, then the confirmed
	// data replaces it, or the page goes back when the write fails (page-state.ts).
	const [view, project] = useOptimistic<PageView, Change>(
		{ guests: data.guests, cards: data.cards, own: data.own, agenda: data.meeting.agenda, attendance: data.attendance },
		applyChange,
	);
	// The page's save lanes (components/save, C68): one save at a time in each, a lost answer replayed once with the same
	// request key, then Check again. The meeting itself (status, edit, held, occurrence corrections), the viewer's own
	// answer, finalizing or correcting attendance, and the evaluation each have one.
	const meetingLane = useSaveIntent<MeetingForm>({ explain: problemText });
	const ownLane = useSaveIntent({ explain: problemText });
	const settleLane = useSaveIntent<SettleEditing>({ explain: problemText });
	const evaluationLane = useSaveIntent<EvaluationEditing>({ explain: problemText });
	function chooseOwn(rsvp: "confirmed" | "declined") {
		if (ownLane.wait) return;
		startTransition(async () => {
			project({ kind: "own", rsvp });
			await ownLane.save({
				what: "Your answer",
				send: (key) => saveOwnRsvp(key, m.id, rsvp),
				ok: ({ guest: g }) =>
					startTransition(() =>
						setData((d) => ({
							...d,
							guests: d.guests?.map((x) => (x.id === g.id ? g : x)) ?? null,
							own: d.own ? { ...d.own, rsvp: g.rsvp, revision: g.revision } : null,
						})),
					),
				refused: (code) => code === "conflict" && stale(),
			});
		});
	}
	// An edit in flight: the page shows the edited meeting until the answer arrives.
	const [preview, setPreview] = useState<Detail | null>(null);
	const m = { ...(preview ?? data.meeting), status, agenda: view.agenda };
	const thisYear = Number(data.now.slice(0, 4));
	const vision = m.type === "vision_meeting";
	const practice = m.type === "prelaunch_practice";

	const setMeeting = (meeting: Detail) => setData((d) => ({ ...d, meeting }));
	/** After a refusal as out of date: the latest page data, shown and returned; null when it did not load. */
	const stale = () =>
		reloadMeeting(m.id).then(
			(r) => {
				if (r.status !== "ok" || r.value.status !== "found") return null;
				setData(r.value);
				return r.value;
			},
			() => null,
		);
	/** One save of the meeting itself. An answer shows the saved meeting; out of date reads the page again. */
	function saveMeeting(save: {
		what: string;
		done?: string;
		form?: MeetingForm;
		send: (key: string) => Promise<Outcome<{ meeting: Detail }>>;
		ok?: () => void;
	}) {
		return meetingLane.save({
			...save,
			ok: (value) => {
				setMeeting(value.meeting);
				save.ok?.();
			},
			refused: (code) => code === "conflict" && stale(),
		});
	}

	function moveTo(to: MeetingStatus) {
		if (meetingLane.wait) return;
		startTransition(async () => {
			setOptimisticStatus(to);
			await saveMeeting({
				what: "The status",
				done: "changed",
				send: (key) => changeStatus(key, m.revision, m.id, to),
				ok: () =>
					toast({ message: `${m.displayTitle}: ${STATUS_ACTION[to].toLowerCase()} is saved.`, tone: "success" }),
			});
		});
	}

	// Attendance (WP-022) ------------------------------------------------------------------------------------------
	const presence = usePresence({
		meetingId: data.meeting.id,
		onSaved: (a) => setData((d) => withAttendees(d, a.attendees, a.attendanceRevision)),
		onStale: () => stale(),
	});
	const final = data.attendance?.finalized != null;
	// Owners, Admins and the leader of a team meeting mark attendance (C74); the server read says who may.
	const marker = data.attendance?.viewerCanMarkAttendance === true;
	function submitSettle(input: SettleInput) {
		const mode = settleLane.editing!.mode;
		const attendance = data.attendance!;
		const body = {
			meetingId: m.id,
			attendeeIds: input.attendeeIds,
			followUpAssigneeIds: input.followUpAssigneeIds,
			...(mode === "finalize" ? { evaluationAssigneeIds: input.evaluationAssigneeIds } : { reason: input.reason }),
		};
		void settleLane.save({
			what: "Attendance",
			done: mode === "finalize" ? "finalized" : "corrected",
			form: { mode, input },
			send: (key) => settleAttendance(mode, key, attendance.attendanceRevision, body),
			ok: ({ result, analytics }) => {
				setData((d) => {
					const next = d.attendance ? attendanceAfter(d.attendance, result) : null;
					const present = new Map(next?.items.map((a) => [a.person.personId, a]));
					return {
						...d,
						attendance: next,
						analytics: analytics ?? d.analytics,
						guests:
							d.guests?.map((g) => {
								const a = present.get(g.person.personId);
								return a ? { ...g, presence: a.presence } : g;
							}) ?? null,
					};
				});
				toast({ message: settledText(result, m.displayTitle, mode), tone: "success" });
			},
			// Out of date (F6): reload, then review again. A finalize starts from who is marked now; a correction keeps
			// only the people this person added and removed, applied to the current list, and its reason.
			refused: (code) => {
				if (code !== "conflict") return;
				const base = new Set(attended(attendance));
				void stale().then((latest) => {
					const now = latest?.attendance ? attended(latest.attendance) : null;
					const ids =
						mode === "reconcile" && now
							? [
									...now.filter((id) => !base.has(id) || input.attendeeIds.includes(id)),
									...input.attendeeIds.filter((id) => !base.has(id) && !now.includes(id)),
								]
							: null;
					settleLane.open({
						mode,
						input: ids ? { ...input, attendeeIds: ids } : null,
						problem: !latest ? "conflict_unloaded" : ids ? "conflict_kept" : "conflict",
					});
				});
			},
		});
	}

	const saved = data.evaluation?.status === "available" ? data.evaluation.evaluation : null;
	// What the person asked for, shown while its save is on its way or unknown; the answer replaces it.
	const [draft, setDraft] = useState<ShownEvaluation | null>(null);
	/** The named problems of the last refused evaluation, shown on the form's fields. */
	const [issues, setIssues] = useState<Issue[]>([]);
	const shownEvaluation = evaluationLane.wait !== null && draft ? draft : saved;
	function submitEvaluation(input: EvaluationInput) {
		const scores = { ...saved?.scores, ...input.scores } as Scores;
		const before = saved;
		const changed = before
			? Object.fromEntries(Object.entries(input.scores).filter(([k, v]) => before.scores[k as keyof Scores] !== v))
			: input.scores;
		setDraft({
			evaluatedOn: before?.evaluatedOn ?? localDate.parse(data.now.slice(0, 10)),
			corrections: before?.corrections ?? { count: 0, lastAt: null },
			scores,
			average: averageOf(scores),
			notes: input.notes || null,
		});
		void evaluationLane.save({
			what: before ? "The corrected evaluation" : "The evaluation",
			form: { input },
			send: async (key) => {
				const r = await (before
					? correctEvaluation(key, before.revision, {
							meetingId: m.id,
							changes: changed,
							...(input.notes !== (before.notes ?? "") ? { notes: input.notes || null } : {}),
							reason: input.reason,
						})
					: recordEvaluation(key, { meetingId: m.id, scores: input.scores, notes: input.notes || null }));
				setIssues(r.status === "refused" ? (r.issues ?? []) : []);
				return r;
			},
			ok: (value) => {
				setDraft(null);
				const e = value.evaluation;
				setData((d) => ({
					...d,
					evaluation: { status: "available", evaluation: e },
					analytics: d.analytics && {
						...d.analytics,
						evaluation: d.analytics.evaluation && compareWith(d.analytics.evaluation, e.average, before !== null),
						tasks: value.taskCompleted
							? {
									...d.analytics.tasks,
									evaluation: d.analytics.tasks.evaluation && { ...d.analytics.tasks.evaluation, status: "complete" },
								}
							: d.analytics.tasks,
					},
				}));
				toast({
					message: before
						? "The evaluation is corrected."
						: `The evaluation is saved.${value.taskCompleted ? " Its task is complete." : ""}`,
					tone: "success",
				});
			},
			// Out of date (F6): reload, then review again from the scores saved now, with only the factors and notes this
			// person changed laid over them, and their reason. A colleague's correction stays.
			refused: (code) => {
				setDraft(null);
				if (code !== "conflict") return;
				void stale().then((latest) => {
					const now = latest?.evaluation?.status === "available" ? latest.evaluation.evaluation : null;
					const notesChanged = input.notes !== (before?.notes ?? "");
					evaluationLane.open({
						input: now
							? {
									scores: { ...now.scores, ...changed },
									notes: notesChanged ? input.notes : (now.notes ?? ""),
									reason: input.reason,
								}
							: null,
						problem: !latest ? "conflict_unloaded" : now ? "conflict_kept" : "conflict",
					});
				});
			},
		});
	}
	const history = useEvaluationHistory(m.id);
	const [historyOpen, setHistoryOpen] = useState(false);

	const moves = (statusTransitions[m.status] ?? []).filter((to) => !(practice && to === "completed"));
	const held = m.occurrence.heldAt !== null;
	// The next step (next-step.ts): one primary action and at most two secondary buttons.
	const guestList = view.guests ?? [];
	const attendedCount = guestList.filter((g) => g.presence === "attended").length;
	const cardOwners = new Set<string | null>((view.cards ?? []).map((c) => c.personId));
	const cardsIn = guestList.filter((g) => g.presence === "attended" && cardOwners.has(g.person.personId)).length;
	// Check-in has its own page and moves no status (F04 decision): attendance marked while the meeting is still
	// planning or ready is shown as its own fact, not as a change of status.
	const checkInStarted = attendedCount > 0 && !final && (m.status === "planning" || m.status === "ready");
	const canSettle = m.status !== "cancelled" && !m.occurrence.voidedAt;
	const next = nextStep({
		status: m.status,
		canWrite,
		checkIn: marker && !final && canSettle,
		guestCount: guestList.length,
		final,
		canSettle,
		attendedWithoutCard: vision ? attendedCount - cardsIn : 0,
		evaluationSaved: saved !== null,
		vision,
	});

	// The tab is in the address (?tab=). The first one follows the meeting's state. A tab change writes the
	// address with replaceState and asks the server for nothing.
	const tabs: TabId[] = vision ? ["guests", "kit", "results"] : ["guests", "results"];
	const search = useSearchParams();
	const [tab, setTab] = useState<TabId>(() => pickTab(search.get("tab"), tabs, defaultTab(m.status, final)));
	// The Kit tab fills the height below its own top, where the two columns show (F02): the checklist scrolls in its card.
	const fill = vision && tab === "kit";
	function selectTab(to: TabId) {
		setTab(to);
		const url = new URL(window.location.href);
		url.searchParams.set("tab", to);
		window.history.replaceState(window.history.state, "", url);
	}
	const [request, setRequest] = useState<{ kind: "add" | "cards"; n: number }>({ kind: "add", n: 0 });
	function runPrimary(p: Primary) {
		if (p === "add-guest" || p === "cards") {
			selectTab("guests");
			setRequest((r) => ({ kind: p === "cards" ? "cards" : "add", n: r.n + 1 }));
		} else if (p === "finalize") {
			if (settleLane.wait === null && !presence.busy) settleLane.open({ mode: "finalize", input: null });
		} else if (p === "evaluation") {
			selectTab("results");
			if (evaluationLane.wait === null) evaluationLane.open({ input: null });
		}
	}
	// Finalizing waits for presence saves and for its own save (C68); the button says so instead of ignoring a click.
	const waiting = settleLane.wait !== null || presence.busy;
	const inviteHref = `/communication?meeting=${m.id}&template=invitation&recipients=guests`;
	const checkInHref = `/meetings/${m.id}/check-in`;
	const primary = next.primary ? (
		next.primary === "send-invites" || next.primary === "check-in" ? (
			<IntentLink
				href={next.primary === "check-in" ? checkInHref : inviteHref}
				className={buttonVariants({ variant: "primary" })}
			>
				{PRIMARY_LABEL[next.primary]}
			</IntentLink>
		) : (
			<Button
				variant="primary"
				aria-disabled={waiting && next.primary === "finalize" ? true : undefined}
				className={HELD}
				onClick={() => runPrimary(next.primary!)}
			>
				{PRIMARY_LABEL[next.primary]}
			</Button>
		)
	) : null;
	const secondary = next.secondary.map((s) =>
		s === "check-in" ? (
			<IntentLink key={s} href={checkInHref} className={buttonVariants({ variant: "secondary" })}>
				Start check-in
			</IntentLink>
		) : (
			<Button
				key={s}
				variant="secondary"
				aria-disabled={waiting ? true : undefined}
				className={HELD}
				onClick={() => runPrimary("finalize")}
			>
				Finalize attendance
			</Button>
		),
	);
	const actions = canWrite ? (
		<>
			{primary}
			{secondary}
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
						<MenuItem
							key={to}
							icon={CheckmarkCircle02Icon}
							disabled={meetingLane.wait !== null}
							onSelect={() => moveTo(to)}
							danger={to === "cancelled"}
						>
							{STATUS_ACTION[to]}
						</MenuItem>
					))}
					{practice && m.status === "in_progress" ? (
						<MenuItem
							icon={Clock01Icon}
							disabled={meetingLane.wait !== null}
							onSelect={() => meetingLane.open({ kind: "held", at: heldDefault(m, data.now) })}
						>
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
			<Button
				variant="secondary"
				icon={Edit02Icon}
				disabled={meetingLane.wait !== null}
				onClick={() => setEditing(true)}
			>
				Edit
			</Button>
			<Menu>
				<MenuTrigger asChild>
					<IconButton icon={MoreHorizontalIcon} label="More actions" />
				</MenuTrigger>
				<MenuContent align="end">
					{m.status === "completed" && practice ? (
						<MenuItem
							icon={Undo02Icon}
							disabled={meetingLane.wait !== null}
							onSelect={() => meetingLane.open({ kind: "reason", reason: "not_held", why: "" })}
						>
							Mark as not held
						</MenuItem>
					) : null}
					{m.status === "completed" && held && !m.occurrence.voidedAt ? (
						<MenuItem
							icon={CalendarRemove01Icon}
							disabled={meetingLane.wait !== null}
							onSelect={() => meetingLane.open({ kind: "reason", reason: "void", why: "" })}
						>
							Void this occurrence
						</MenuItem>
					) : null}
					{m.occurrence.voidedAt ? (
						<MenuItem
							icon={Undo02Icon}
							disabled={meetingLane.wait !== null}
							onSelect={() => meetingLane.open({ kind: "reason", reason: "restore", why: "" })}
						>
							Restore this occurrence
						</MenuItem>
					) : null}
					{m.status === "completed" ? <MenuSeparator /> : null}
					<MenuItem icon={Delete02Icon} danger onSelect={() => setDeleting(true)}>
						Delete meeting
					</MenuItem>
				</MenuContent>
			</Menu>
		</>
	) : (
		<>
			{primary}
			{secondary}
		</>
	);

	return (
		<>
			<PageHeader
				breadcrumb={[{ label: "Meetings", href: "/meetings" }, { label: m.displayTitle }]}
				title={
					<span className="inline-flex flex-wrap items-center gap-3">
						{m.displayTitle}
						<MeetingStatusBadge status={m.status} className="font-sans tracking-normal" />
						{checkInStarted ? (
							<StatusBadge status="attention" fill="soft" className="font-sans tracking-normal">
								Check-in started · {attendedCount} attended
							</StatusBadge>
						) : null}
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

			<SaveNotice {...meetingLane.noticeProps} dialogOpen={meetingLane.editing !== null || editing} />
			<div className="flex flex-col gap-5">
				{m.status === "cancelled" ? (
					<Card as="section" aria-label="Cancelled">
						<p className="font-semibold text-ink">This meeting is cancelled. Reopen it from the Status menu.</p>
					</Card>
				) : null}
				{view.own && !final && m.status !== "completed" ? (
					<OwnRsvp own={view.own} title={m.displayTitle} lane={ownLane} onChoose={chooseOwn} />
				) : null}
				<FixedFrame fixed={fill} className={FILL_FRAME}>
					<div
						className={cn(
							"grid grid-cols-[minmax(0,1fr)_320px] items-start gap-5 app-md:gap-y-6 max-app-md:grid-cols-1",
							fill && FILL_GRID,
						)}
					>
						<Tabs value={tab} onValueChange={(v) => selectTab(v as TabId)} className="min-w-0 app-md:contents">
							<TabsList aria-label="Meeting work" className="app-md:col-start-1 app-md:row-start-1">
								<Tab value="guests" count={view.guests ? guestList.length : undefined}>
									Guests
								</Tab>
								{vision ? <Tab value="kit">Kit</Tab> : null}
								<Tab value="results">Results</Tab>
							</TabsList>
							{/* Every panel stays mounted: a tab switch keeps the guest filter and any open form. */}
							<TabsPanel
								value="guests"
								forceMount
								className={cn("flex flex-col gap-5 data-[state=inactive]:hidden", PANEL_CELL)}
							>
								<RsvpSummary guests={view.guests} attended={attendedCount} started={checkInStarted} />
								<GuestList
									meeting={m}
									guests={view.guests && presence.shown(view.guests)}
									cards={view.cards}
									attendance={view.attendance}
									presence={presence}
									canMark={marker && !final && m.status !== "cancelled"}
									canWrite={canWrite}
									project={project}
									request={request}
									invitesHref={next.toolbarInvites ? inviteHref : undefined}
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
							</TabsPanel>
							{vision ? (
								<TabsPanel
									value="kit"
									forceMount
									className={cn("data-[state=inactive]:hidden", PANEL_CELL, fill && FILL_PANEL)}
								>
									<KitCard
										fill={fill}
										meeting={m}
										kit={data.kit}
										canWrite={canWrite}
										onKit={(kit) => setData((d) => ({ ...d, kit: d.kit ? { ...d.kit, ...kit } : null }))}
										onMeeting={setMeeting}
										onStale={stale}
									/>
								</TabsPanel>
							) : null}
							<TabsPanel
								value="results"
								forceMount
								className={cn("flex flex-col gap-5 data-[state=inactive]:hidden", PANEL_CELL)}
							>
								<AttendanceCard
									meeting={m}
									attendance={view.attendance && { ...view.attendance, items: presence.shown(view.attendance.items) }}
									analytics={data.analytics}
									canWrite={canWrite}
									lane={settleLane}
									blocked={presence.busy}
									headerFinalize={next.primary === "finalize" || next.secondary.includes("finalize")}
									onSettle={(mode) =>
										settleLane.wait === null && !presence.busy && settleLane.open({ mode, input: null })
									}
									onPrefetch={warmSeats}
								/>
								{vision ? <CardsSummary guests={view.guests} cards={view.cards} /> : null}
								{vision ? (
									<EvaluationCard
										evaluation={shownEvaluation}
										analytics={data.analytics}
										finalized={final}
										canWrite={canWrite}
										lane={evaluationLane}
										headerRecord={next.primary === "evaluation"}
										onRecord={() => evaluationLane.wait === null && evaluationLane.open({ input: null })}
										onCorrect={() => evaluationLane.wait === null && evaluationLane.open({ input: null })}
										onHistory={() => {
											if (saved) history.load(saved.revision);
											setHistoryOpen(true);
										}}
										onPrefetchHistory={() => saved && history.load(saved.revision)}
									/>
								) : null}
								{final ? (
									<p className="text-md text-text-2">
										The follow-up work from this meeting is in{" "}
										<IntentLink href="/tasks" className="font-medium text-ink underline underline-offset-4">
											Tasks
										</IntentLink>
										.
									</p>
								) : null}
							</TabsPanel>
						</Tabs>
						<aside
							aria-label="Agenda and notes"
							tabIndex={fill ? 0 : undefined}
							className={cn("flex min-w-0 flex-col gap-5 app-md:col-start-2 app-md:row-start-2", fill && FILL_ASIDE)}
						>
							<AgendaCard
								meeting={m}
								canWrite={canWrite}
								printable={data.agendaTemplate !== null}
								project={project}
								onSaved={(agenda) =>
									setData((d) => ({ ...d, meeting: { ...d.meeting, agenda, revision: agenda.revision } }))
								}
							/>
							<NotesCard notes={m.notes} />
						</aside>
					</div>
				</FixedFrame>
			</div>

			{saved ? (
				<HistoryDialog
					open={historyOpen}
					onOpenChange={setHistoryOpen}
					history={history.got}
					revision={saved.revision}
					onRetry={() => history.load(saved.revision)}
				/>
			) : null}
			{canWrite ? (
				<>
					{data.attendance && data.guests && settleLane.editing ? (
						<NoticeInDialog {...settleLane.noticeProps}>
							<SettleDialog
								open
								mode={settleLane.editing.mode}
								meeting={m}
								guests={data.guests}
								attendance={data.attendance}
								onSeats={warmSeats}
								initial={settleLane.editing.input}
								problem={settleLane.problem}
								onClose={settleLane.close}
								onSubmit={submitSettle}
							/>
						</NoticeInDialog>
					) : null}
					{vision && evaluationLane.editing ? (
						<NoticeInDialog {...evaluationLane.noticeProps}>
							<EvaluationDialog
								open
								evaluation={saved}
								title={m.displayTitle}
								initial={evaluationLane.editing.input}
								problem={evaluationLane.problem}
								issues={evaluationLane.editing.problem ? issues : []}
								onClose={evaluationLane.close}
								onSubmit={submitEvaluation}
							/>
						</NoticeInDialog>
					) : null}
					<PlanMeetingDialog
						open={editing}
						onOpenChange={setEditing}
						lane={meetingLane}
						meeting={preview ?? data.meeting}
						onSaved={setMeeting}
						onPreview={setPreview}
					/>
					<NoticeInDialog {...meetingLane.noticeProps}>
						{meetingLane.editing?.kind === "held" ? (
							<HeldForm
								meeting={m}
								initial={meetingLane.editing.at}
								problem={meetingLane.problem}
								wait={meetingLane.wait}
								now={data.now}
								onClose={meetingLane.close}
								onSubmit={(at, occurredAt) =>
									void saveMeeting({
										what: "The held time",
										form: { kind: "held", at },
										send: (key) => completePractice(key, m.revision, m.id, occurredAt),
									})
								}
							/>
						) : meetingLane.editing?.kind === "reason" ? (
							<OccurrenceDialog
								reason={meetingLane.editing.reason}
								initial={meetingLane.editing.why}
								problem={meetingLane.problem}
								wait={meetingLane.wait}
								onClose={meetingLane.close}
								onSubmit={(reason, why) =>
									void saveMeeting({
										what: REASON_WHAT[reason],
										form: { kind: "reason", reason, why },
										send: (key) =>
											reason === "not_held"
												? correctPractice(key, m.revision, { meetingId: m.id, state: "not_completed", reason: why })
												: correctOccurrence(key, m.revision, m.id, reason === "void", why),
									})
								}
							/>
						) : null}
					</NoticeInDialog>
					{deleting ? (
						<ReasonDialog
							danger
							title={`Delete ${m.displayTitle}?`}
							consequences={[
								"It leaves the meetings list for everyone.",
								"Its guests, answers and history are kept.",
								...(practice && held ? ["A practice that really happened still counts toward Launch."] : []),
							]}
							confirmLabel="Delete meeting"
							onClose={() => setDeleting(false)}
							onSubmit={(why) => {
								// The list opens at once without this meeting; the answer confirms it or brings it back.
								const { id, displayTitle, revision } = m;
								deleteFromList({ id, title: displayTitle, revision }, why, toast);
								router.push("/meetings");
							}}
						/>
					) : null}
				</>
			) : null}
		</>
	);
}

const PRIMARY_LABEL: Record<Primary, string> = {
	"add-guest": "Add guest",
	"send-invites": "Send invites",
	"check-in": "Start check-in",
	finalize: "Finalize attendance",
	cards: "Record response cards",
	evaluation: "Record evaluation",
};

const REASON_WHAT: Record<Reason, string> = {
	void: "Voiding this occurrence",
	restore: "Restoring this occurrence",
	not_held: "Marking this practice as not held",
};

/** Void or restore an occurrence, or mark a practice as not held: each needs a reason in the history. */
function OccurrenceDialog({
	reason,
	...props
}: {
	reason: Reason;
	initial: string;
	problem: string | undefined;
	wait: Wait;
	onClose: () => void;
	onSubmit: (reason: Reason, why: string) => void;
}) {
	return (
		<ReasonDialog
			{...props}
			title={
				reason === "void"
					? "Void this occurrence?"
					: reason === "restore"
						? "Restore this occurrence?"
						: "Mark this practice as not held?"
			}
			consequences={
				reason === "void"
					? ["Use this when the meeting did not really happen as recorded.", "It no longer counts as held."]
					: reason === "restore"
						? ["It counts as held again."]
						: ["It goes back to Planning with no held time.", "It no longer counts toward Launch."]
			}
			confirmLabel={
				reason === "void" ? "Void occurrence" : reason === "restore" ? "Restore occurrence" : "Mark as not held"
			}
			onSubmit={(why) => props.onSubmit(reason, why)}
		/>
	);
}

/**
 * Yes, No and Pending for this meeting, from the guest list. While check-in is under way before the meeting is marked
 * started, the attended count shows here too.
 */
function RsvpSummary({ guests, attended, started }: { guests: GuestRow[] | null; attended: number; started: boolean }) {
	const c = rsvpCounts(guests ?? []);
	const total = guests?.length ?? 0;
	return (
		<Card as="section" aria-labelledby="rsvps-title">
			<CardHeader className="mb-3.5">
				<CardHeading>
					<CardTitle id="rsvps-title">RSVPs</CardTitle>
					<CardDescription>
						{guests ? `${total} invited${started ? ` · ${attended} attended so far` : ""}` : "Did not load"}
					</CardDescription>
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
function CardsSummary({ guests, cards }: { guests: GuestRow[] | null; cards: MeetingPageData["cards"] }) {
	if (!guests || !cards)
		return (
			<Card as="section" aria-labelledby="cards-title">
				<CardTitle id="cards-title">Response cards</CardTitle>
				<CardDescription>Did not load. Reload the page in a moment.</CardDescription>
			</Card>
		);
	const attended = new Set(guests.filter((g) => g.presence === "attended").map((g) => g.person.personId));
	const fromAttended = cards.filter((c) => attended.has(c.personId));
	const fromOthers = cards.filter((c) => !attended.has(c.personId));
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
				<>
					<Breakdown label="From attended guests" cards={fromAttended} />
					{fromOthers.length > 0 ? (
						<Breakdown
							label={`From guests not recorded as attending · ${fromOthers.length}`}
							cards={fromOthers}
							className="mt-4"
						/>
					) : null}
				</>
			)}
		</Card>
	);
}

function NotesCard({ notes }: { notes: string | null }) {
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

/** One response tally, every response listed, so zero counts show as zero. */
function Breakdown({
	label,
	cards,
	className,
}: {
	label: string;
	cards: NonNullable<MeetingPageData["cards"]>;
	className?: string;
}) {
	return (
		<div className={className}>
			<h3 className="mb-1 font-sans text-xs font-semibold tracking-[0.04em] text-text-3 uppercase">{label}</h3>
			<dl className="flex flex-col">
				{CARD_RESPONSES.map((r) => (
					<div
						key={r}
						className="flex items-center justify-between gap-3 border-t border-line py-2 text-sm first:border-t-0"
					>
						<dt className="text-text-2">{CARD_LABEL[r]}</dt>
						<dd className="font-semibold text-ink tabular-nums">{cards.filter((c) => c.response === r).length}</dd>
					</div>
				))}
			</dl>
		</div>
	);
}

/** The signed-in guest's own answer (REQ-MTG-009). It shows at once; the answer confirms it or puts it back. */
function OwnRsvp({
	own,
	title,
	lane,
	onChoose,
}: {
	own: NonNullable<MeetingPageData["own"]>;
	title: string;
	lane: SaveIntent;
	onChoose: (rsvp: "confirmed" | "declined") => void;
}) {
	const answer = own.rsvp;
	// Once answered, the banner shrinks to one line with the answer and a way to change it.
	const [changing, setChanging] = useState(false);
	const notice = <SaveNotice {...lane.noticeProps} dialogOpen={false} />;
	if (answer !== "pending" && !changing)
		return (
			<div className="flex flex-col gap-2">
				{notice}
				<p
					aria-label="Your RSVP"
					role="region"
					aria-live="polite"
					className="flex flex-wrap items-center gap-x-3 text-md text-text-2"
				>
					{answer === "confirmed" ? "You're coming." : "You can't make it."}
					{own.responseAllowed ? (
						<Button variant="ghost" size="sm" disabled={lane.wait !== null} onClick={() => setChanging(true)}>
							Change
						</Button>
					) : null}
				</p>
			</div>
		);
	return (
		<Card variant="callout" tone="green" as="section" aria-labelledby="own-rsvp">
			{notice}
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
					<div className="flex flex-wrap gap-2.5">
						<Button
							variant={answer === "confirmed" ? "primary" : "secondary"}
							aria-pressed={answer === "confirmed"}
							disabled={lane.wait !== null}
							onClick={() => {
								setChanging(false);
								onChoose("confirmed");
							}}
						>
							Yes, I&apos;ll come
						</Button>
						<Button
							variant={answer === "declined" ? "primary" : "secondary"}
							aria-pressed={answer === "declined"}
							disabled={lane.wait !== null}
							onClick={() => {
								setChanging(false);
								onChoose("declined");
							}}
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

/** "2026-10-21T18:30" in the browser's zone, for a datetime-local input. */
const localInput = (at: Date) => {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}T${p(at.getHours())}:${p(at.getMinutes())}`;
};
/** The held time a new form starts from: the meeting's start, or the page's render time when the start is ahead. */
const heldDefault = (m: Detail, now: string) => localInput(new Date(Math.min(Date.parse(m.startsAt), Date.parse(now))));

/**
 * Mark a practice as held (REQ-MTG-002): it records when it actually happened, which cannot be in the future. Three
 * held practices meet the Launch criterion.
 */
function HeldForm({
	meeting,
	initial,
	problem,
	wait,
	now,
	onClose,
	onSubmit,
}: {
	meeting: Detail;
	initial: string;
	problem: string | undefined;
	wait: Wait;
	now: string;
	onClose: () => void;
	/** The form's value and the instant it names. */
	onSubmit: (at: string, occurredAt: string) => void;
}) {
	const [value, setValue] = useState(initial);
	const [future, setFuture] = useState(false);
	return (
		<RecordDialog
			icon={Clock01Icon}
			tone="green"
			size="sm"
			title="Mark as held"
			description={meeting.displayTitle}
			action="Mark as held"
			problem={problem}
			wait={wait}
			onClose={onClose}
			onSubmit={() => {
				const at = new Date(value);
				const bad = Number.isNaN(at.getTime()) || at.getTime() > Date.now();
				setFuture(bad);
				if (bad) return false;
				onSubmit(value, at.toISOString());
				return true;
			}}
		>
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
		</RecordDialog>
	);
}

/** The people marked attended in an attendance list. */
const attended = (a: NonNullable<MeetingPageData["attendance"]>): string[] =>
	a.items.filter((x) => x.presence === "attended").map((x) => x.person.personId);

/** The comparison after a new or corrected evaluation: the baseline stays, the delta is rounded from it (REQ-MTG-016). */
function compareWith(
	c: NonNullable<NonNullable<MeetingPageData["analytics"]>["evaluation"]>,
	average: number,
	corrected: boolean,
) {
	return {
		...c,
		current: { status: "known" as const, value: average },
		delta:
			c.baseline.status === "known"
				? { status: "known" as const, value: Math.round((average - c.baseline.value) * 10) / 10 }
				: c.delta,
		corrected: c.corrected || corrected,
	};
}
