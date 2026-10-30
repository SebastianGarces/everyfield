"use client";

import {
	Add01Icon,
	ArrowRight01Icon,
	Call02Icon,
	Delete02Icon,
	Edit02Icon,
	MoreHorizontalIcon,
	TaskDone01Icon,
} from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
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
	IntentLink,
	Menu,
	MenuContent,
	MenuItem,
	MenuTrigger,
	Textarea,
} from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { Icon } from "@everyfield/ui/foundations";
import { useRef, useState } from "react";
import { LocalDay, When } from "../people/parts.tsx";
import { ownerText } from "../tasks/model.ts";
import { correctOutcome, recordOutcome } from "./actions.ts";
import { AddFollowUpDialog, AssignMenu, DutyFacts } from "./duties.tsx";
import { loadDuties, loadHistory, loadObligations, loadPersonFollowUps, prefetchOwners, warmOn } from "./fetch.ts";
import { OutcomeFields } from "./fields.tsx";
import {
	draftOf,
	emptyDraft,
	measurementText,
	needsOwner,
	OUTCOME_LABEL,
	OUTCOMES,
	outcomeInput,
	problemText,
	reasonOf,
	withOutcome,
	type ContactHistory,
	type Draft,
	type DraftErrors,
	type DutyItem,
	type ObligationItem,
	type OutcomeItem,
	type OutcomeMutation,
	type Outcome,
} from "./model.ts";
import { actorName, EntryFacts, LastContact, OutcomeBadge, useOpener } from "./parts.tsx";
import {
	DialogNotice,
	focusFirstProblem,
	NoticeInDialog,
	SaveButton,
	SaveNotice,
	useSaveIntent,
	type SaveIntent,
} from "../../components/save/parts.tsx";
import type { PersonFollowUps } from "./server.ts";

/**
 * The Person page's follow-up part (REQ-MTG-021, REQ-MTG-022, REQ-PPL-022, REQ-TSK-012): their open follow-ups with
 * owners, their Vision follow-ups with the 48-hour result, and the contact log. Each card has its own save lane.
 */
export function PersonFollowUps({
	initial,
	person,
	accountId,
	admin,
	live,
}: {
	initial: PersonFollowUps;
	person: { id: string; label: string };
	accountId: string;
	admin: boolean;
	/** The person is live; a retired person keeps their history and takes no new follow-up or outcome. */
	live: boolean;
}) {
	return (
		<>
			<FollowUpsCard initial={initial} person={person} admin={admin} live={live} />
			<ContactLogCard initial={initial.history} person={person} accountId={accountId} admin={admin} live={live} />
		</>
	);
}

const OBLIGATION_STATE: Record<ObligationItem["state"], { text: string; status: "measured" | "positive" | "unknown" }> =
	{
		open: { text: "Open", status: "measured" },
		complete: { text: "Done", status: "positive" },
		no_longer_needed: { text: "No longer needed", status: "unknown" },
		superseded: { text: "Replaced", status: "unknown" },
	};

function FollowUpsCard({
	initial,
	person,
	admin,
	live,
}: {
	initial: PersonFollowUps;
	person: { id: string; label: string };
	admin: boolean;
	live: boolean;
}) {
	const [duties, setDuties] = useState<DutyItem[]>(initial.duties?.items ?? []);
	const [obligations, setObligations] = useState(initial.obligations?.items ?? []);
	const [adding, setAdding] = useState(false);
	const addOpener = useOpener();
	const lane = useSaveIntent({ explain: problemText });
	const failed = initial.duties === null;
	const moreDuties = useMore(
		initial.duties?.next ?? null,
		(page) => loadDuties(person.id, page),
		(items) => setDuties((all) => [...all, ...items.filter((x) => !all.some((y) => y.taskId === x.taskId))]),
	);
	const moreVision = useMore(
		initial.obligations?.next ?? null,
		(page) => loadObligations(person.id, page),
		(items) => setObligations((all) => [...all, ...items.filter((x) => !all.some((y) => y.id === x.id))]),
	);
	const change = (d: DutyItem) => setDuties((all) => all.map((x) => (x.taskId === d.taskId ? d : x)));
	/**
	 * After a refusal because a follow-up was out of date: both lists start again from their first page as the server has
	 * them now, each with its own "Show more" position, so nothing loaded earlier is shown stale or skipped (C58 rule 6).
	 */
	async function reload() {
		const r = await loadPersonFollowUps(person.id);
		if (r.status !== "ok") return;
		const { duties: d, obligations: o } = r.value;
		if (d) {
			setDuties(d.items);
			moreDuties.reset(d.next);
		}
		if (o) {
			setObligations(o.items);
			moreVision.reset(o.next);
		}
	}
	const vision = obligations.filter((o) => o.kind === "first_vision_follow_up");
	return (
		<Card as="section" aria-labelledby="followups-title">
			<CardHeader className="mb-2">
				<CardHeading>
					<CardTitle size="sm" id="followups-title">
						Follow-ups
					</CardTitle>
				</CardHeading>
				{admin && live ? (
					<Button
						size="sm"
						variant="secondary"
						icon={Add01Icon}
						disabled={lane.wait !== null}
						onClick={(e) => {
							addOpener.mark(e);
							setAdding(true);
						}}
						{...warmOn(prefetchOwners)}
					>
						Add follow-up
					</Button>
				) : null}
			</CardHeader>
			<SaveNotice {...lane.noticeProps} dialogOpen={adding} className="mb-3" />
			{failed ? (
				<p className="text-sm text-text-2">Follow-ups did not load. Reload the page to try again.</p>
			) : duties.length === 0 ? (
				<p className="text-sm text-text-3">
					No open follow-up. That is fine: nobody is late. Add one when someone should reach out to {person.label}.
				</p>
			) : (
				<ul className="flex flex-col">
					{duties.map((d) => (
						<li
							key={d.taskId}
							className="flex items-center gap-3 border-t border-line py-3 first:border-t-0 max-app-sm:flex-wrap"
						>
							<span className="min-w-0 flex-1">
								<IntentLink
									href={`/follow-ups/${d.taskId}`}
									className="inline-flex items-center gap-1.5 font-medium text-ink underline-offset-[3px] hover:underline"
								>
									{d.title}
									<Icon icon={ArrowRight01Icon} size={16} className="text-text-3" />
								</IntentLink>
								<span className="mt-0.5 block">
									<DutyFacts duty={d} />
								</span>
							</span>
							<AssignMenu duty={d} lane={lane} canAssign={admin} onChange={change} onConflict={reload} />
						</li>
					))}
				</ul>
			)}
			<ShowMore more={moreDuties} what="follow-ups" />
			{vision.length || moreVision.next ? (
				<div className="mt-4 border-t border-line pt-4">
					<h3 className="mb-1 text-sm font-semibold text-ink-2">After Vision meetings</h3>
					<p className="mb-2 text-xs text-text-3">
						Each first visit gets one follow-up, measured against 48 hours from the meeting’s start.
					</p>
					<ul className="flex flex-col">
						{vision.map((o) => {
							const state = OBLIGATION_STATE[o.state];
							const m = o.measurement ? measurementText(o.measurement) : null;
							return (
								<li key={o.id} className="flex flex-col gap-1.5 border-t border-line py-3 first:border-t-0">
									<span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
										<span className="font-medium text-ink">{o.meeting.label}</span>
										<span className="text-text-2">
											<LocalDay day={o.origin.date} /> · due <LocalDay day={o.dueDate} />
										</span>
									</span>
									<span className="flex flex-wrap items-center gap-1.5">
										<StatusBadge status={state.status} size="sm">
											{state.text}
										</StatusBadge>
										{m ? (
											<StatusBadge status={m.status} size="sm">
												{m.text}
											</StatusBadge>
										) : null}
										<StatusBadge status={o.contacted ? "positive" : "unknown"} size="sm">
											{o.contacted ? "Contacted" : "No contact recorded"}
										</StatusBadge>
										{o.state === "open" && needsOwner(o) ? (
											<StatusBadge status="attention" size="sm">
												Needs owner
											</StatusBadge>
										) : null}
									</span>
									{o.owner ? <span className="text-sm text-text-2">Owner: {ownerText(o.owner)}</span> : null}
									{o.completion ? (
										<span className="text-sm text-text-2">
											Done: {OUTCOME_LABEL[o.completion.outcome]} <When at={o.completion.occurredAt} withTime />
										</span>
									) : null}
									{o.waiver?.reason ? <span className="text-xs text-text-3">Closed: {o.waiver.reason}</span> : null}
								</li>
							);
						})}
					</ul>
					<ShowMore more={moreVision} what="Vision follow-ups" />
				</div>
			) : null}
			{adding ? (
				<AddFollowUpDialog
					returnFocus={addOpener.returnFocus}
					person={person}
					lane={lane}
					onClose={() => setAdding(false)}
					onCreated={(d) => setDuties((all) => [...all.filter((x) => x.taskId !== d.taskId), d])}
				/>
			) : null}
		</Card>
	);
}

type Editing = { kind: "record" } | { kind: "correct"; item: OutcomeItem } | { kind: "withdraw"; item: OutcomeItem };

function ContactLogCard({
	initial,
	person,
	accountId,
	admin,
	live,
}: {
	initial: ContactHistory | null;
	person: { id: string; label: string };
	accountId: string;
	admin: boolean;
	live: boolean;
}) {
	const [log, setLog] = useState(initial);
	const [editing, setEditing] = useState<Editing | null>(null);
	const opener = useOpener();
	const [more, setMore] = useState<"idle" | "loading" | "failed">("idle");
	const lane = useSaveIntent({ explain: problemText });
	const first = person.label.split(" ")[0] || person.label;
	const saved = (m: OutcomeMutation) =>
		setLog((l) =>
			l
				? {
						...l,
						items: withOutcome(l.items, m),
						total: l.items.some((i) => i.id === m.record.id) ? l.total : l.total + 1,
						lastConfirmedContactAt: m.lastConfirmedContactAt,
					}
				: l,
		);
	/** The log again from its first page, after a refusal because it was out of date. Returns the fresh entries. */
	async function reload(): Promise<OutcomeItem[] | null> {
		const r = await loadHistory(person.id, 1);
		if (r.status !== "ok") return null;
		setLog((l) => ({
			...r.value,
			items: [...r.value.items, ...(l?.items ?? []).filter((i) => !r.value.items.some((x) => x.id === i.id))],
		}));
		return r.value.items;
	}
	async function showEarlier() {
		const next = log?.next;
		if (!next || more === "loading") return;
		setMore("loading");
		const r = await loadHistory(person.id, next);
		if (r.status !== "ok") return setMore("failed");
		setMore("idle");
		setLog((l) =>
			l
				? {
						...l,
						items: [...l.items, ...r.value.items.filter((x) => !l.items.some((y) => y.id === x.id))],
						next: r.value.next,
					}
				: r.value,
		);
	}
	const canCorrect = (i: OutcomeItem) =>
		live &&
		i.state === "effective" &&
		(admin || (i.actor.kind === "account" && i.actor.accountId === accountId && i.taskId !== null));

	return (
		<Card as="section" aria-labelledby="contact-log-title" id="contact-log" className="scroll-mt-24">
			<CardHeader className="mb-1">
				<CardHeading>
					<CardTitle size="sm" id="contact-log-title">
						Contact log
					</CardTitle>
				</CardHeading>
				{admin && live ? (
					<Button
						size="sm"
						variant="secondary"
						icon={Call02Icon}
						disabled={lane.wait !== null}
						onClick={(e) => {
							opener.mark(e);
							setEditing({ kind: "record" });
						}}
					>
						Record contact
					</Button>
				) : null}
			</CardHeader>
			{log === null ? (
				<p className="text-sm text-text-2">The contact log did not load. Reload the page to try again.</p>
			) : (
				<>
					<p className="mb-3 text-sm text-text-2">
						<LastContact at={log.lastConfirmedContactAt} />. Only a recorded conversation counts. Emails, tries and
						finished tasks do not.
					</p>
					<SaveNotice {...lane.noticeProps} dialogOpen={editing !== null} className="mb-3" />
					{log.items.length === 0 ? (
						<p className="text-sm text-text-3">Nothing recorded yet.</p>
					) : (
						<ol className="flex flex-col">
							{log.items.map((item) => (
								<li key={item.id} className="flex items-start gap-3 border-t border-line py-3 first:border-t-0">
									<div className="flex min-w-0 flex-1 flex-col gap-1">
										<span className="flex flex-wrap items-center gap-2">
											<OutcomeBadge item={item} />
											{item.state === "corrected" ? (
												<span className="text-xs font-medium text-text-2">Corrected</span>
											) : item.state === "voided" ? (
												<span className="text-xs font-medium text-text-2">Withdrawn</span>
											) : null}
										</span>
										<EntryFacts item={item} />
										{item.notes ? (
											<p className="text-sm whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">{item.notes}</p>
										) : null}
										<p className="text-xs text-text-3">
											Recorded by {actorName(item.actor, accountId)} <When at={item.recordedAt} />
											{item.corrects
												? ` · corrects an earlier entry${item.corrects.reason ? `: ${item.corrects.reason}` : ""}`
												: null}
										</p>
										{item.voided ? (
											<p className="text-xs text-text-3">
												{item.state === "corrected" ? "Replaced" : "Withdrawn"} by{" "}
												{actorName(item.voided.actor, accountId)} <When at={item.voided.at} />
												{item.voided.reason ? `: ${item.voided.reason}` : null}
											</p>
										) : null}
									</div>
									{canCorrect(item) ? (
										<Menu>
											<MenuTrigger asChild>
												<IconButton
													icon={MoreHorizontalIcon}
													label="Change this entry"
													onPointerDown={opener.mark}
													onKeyDown={opener.mark}
													size="sm"
													disabled={lane.wait !== null}
												/>
											</MenuTrigger>
											<MenuContent align="end">
												<MenuItem icon={Edit02Icon} onSelect={() => setEditing({ kind: "correct", item })}>
													Correct
												</MenuItem>
												<MenuItem icon={Delete02Icon} danger onSelect={() => setEditing({ kind: "withdraw", item })}>
													Withdraw
												</MenuItem>
											</MenuContent>
										</Menu>
									) : null}
								</li>
							))}
						</ol>
					)}
					{log.next ? (
						<div className="mt-2 flex flex-wrap items-center gap-3">
							<Button size="sm" variant="ghost" loading={more === "loading"} onClick={showEarlier}>
								Show earlier
							</Button>
							<span aria-live="polite" className="text-xs text-text-3 empty:hidden">
								{more === "failed" ? "Earlier entries did not load. Try again." : ""}
							</span>
						</div>
					) : null}
				</>
			)}
			{editing ? (
				<OutcomeDialog
					returnFocus={opener.returnFocus}
					editing={editing}
					personId={person.id}
					first={first}
					lane={lane}
					onClose={() => setEditing(null)}
					onSaved={saved}
					onConflict={async (item) => {
						const fresh = await reload();
						const now = fresh?.find((i) => i.id === item.id);
						if (now && now.state === "effective")
							setEditing((e) => (e && e.kind !== "record" ? { ...e, item: now } : e));
					}}
				/>
			) : null}
		</Card>
	);
}

const TITLE = { record: "Record a contact", correct: "Correct this entry", withdraw: "Withdraw this entry" } as const;

/**
 * Record a contact with no follow-up task, correct an entry or withdraw it (REQ-MTG-022). A correction or withdrawal
 * needs a reason and keeps the earlier entry in the log. The form keeps its answers while it saves, after a refusal and
 * after a reload because the entry changed; the save's notice is inside the dialog.
 */
function OutcomeDialog({
	editing,
	personId,
	first,
	lane,
	onClose,
	onSaved,
	onConflict,
	returnFocus,
}: {
	editing: Editing;
	/** Focus back to the button that opened the dialog, or its menu's button (useOpener). */
	returnFocus: (e: Event) => void;
	personId: string;
	first: string;
	lane: SaveIntent;
	onClose: () => void;
	onSaved: (m: OutcomeMutation) => void;
	onConflict: (item: OutcomeItem) => Promise<void>;
}) {
	const [draft, setDraft] = useState<Draft>(() => (editing.kind === "correct" ? draftOf(editing.item) : emptyDraft()));
	const [reason, setReason] = useState("");
	const [errors, setErrors] = useState<DraftErrors & { reason?: string }>({});
	const outcomes =
		editing.kind === "correct" && editing.item.taskId !== null
			? OUTCOMES
			: OUTCOMES.filter((o) => o !== "no_longer_needed");

	async function submit(form: HTMLFormElement) {
		const why = editing.kind === "record" ? null : reasonOf(reason);
		const parsed = editing.kind === "withdraw" ? null : outcomeInput(draft, { completable: false });
		const next: typeof errors = {
			...(parsed && !parsed.ok ? parsed.errors : {}),
			...(why && !why.ok ? { reason: why.error } : {}),
		};
		setErrors(next);
		if (Object.keys(next).length) return focusFirstProblem(form);
		const reasonText = why?.ok ? why.reason : "";
		let send: (key: string) => Promise<Awaited<ReturnType<typeof recordOutcome>>>;
		if (editing.kind === "record") {
			if (!parsed?.ok) return;
			const input = { target: { kind: "person", personId }, ...parsed.input, completeTask: false };
			send = (key) => recordOutcome(key, input);
		} else {
			const item = editing.item;
			const correction =
				editing.kind === "withdraw"
					? { kind: "void" }
					: parsed?.ok
						? {
								kind: "replace",
								outcome: parsed.input.outcome,
								...(parsed.input.occurredAt ? { occurredAt: parsed.input.occurredAt } : {}),
								channel: parsed.input.channel,
								notes: parsed.input.notes,
							}
						: null;
			if (!correction) return;
			const input = { outcomeId: item.id, correction, reason: reasonText };
			send = (key) => correctOutcome(key, item.revision, input);
		}
		await lane.save({
			what:
				editing.kind === "record" ? "The contact" : editing.kind === "correct" ? "The correction" : "The withdrawal",
			send,
			ok: (value) => {
				onSaved(value);
				onClose();
			},
			refused: async (code) => {
				if (code === "conflict" && editing.kind !== "record") await onConflict(editing.item);
			},
		});
	}

	return (
		<NoticeInDialog {...lane.noticeProps}>
			<Dialog open onOpenChange={(open) => !open && onClose()}>
				<DialogContent size="md" onCloseAutoFocus={returnFocus}>
					<form
						noValidate
						className="contents"
						onSubmit={(e) => {
							e.preventDefault();
							if (!lane.wait) void submit(e.currentTarget);
						}}
					>
						<DialogHeader
							icon={
								editing.kind === "withdraw" ? Delete02Icon : editing.kind === "correct" ? Edit02Icon : TaskDone01Icon
							}
							tone={editing.kind === "withdraw" ? "magenta" : "green"}
							title={TITLE[editing.kind]}
							description={
								editing.kind === "record"
									? `A contact with ${first} that has no follow-up task.`
									: "The earlier entry stays in the log with who changed it and why."
							}
						/>
						<DialogBody className="flex flex-col gap-5 pb-1">
							<DialogNotice />
							{editing.kind === "withdraw" ? (
								<p className="text-sm text-text-2">
									Withdraw this entry when it should not count, for example when it was recorded on the wrong person. If
									it was their latest contact, the date before it counts again.
								</p>
							) : (
								<OutcomeFields
									draft={draft}
									onDraft={setDraft}
									errors={errors}
									completable={false}
									outcomes={outcomes}
									personName={first}
								/>
							)}
							{editing.kind !== "record" ? (
								<Field label="Reason" error={errors.reason} hint="Kept in the log with your name.">
									<Textarea
										value={reason}
										maxLength={500}
										rows={2}
										className="min-h-16"
										onChange={(e) => setReason(e.target.value)}
									/>
								</Field>
							) : null}
						</DialogBody>
						<DialogFooter>
							<Button variant="secondary" type="button" onClick={onClose}>
								Cancel
							</Button>
							<SaveButton
								wait={lane.wait}
								saving={lane.saving}
								variant={editing.kind === "withdraw" ? "danger" : "primary"}
							>
								{editing.kind === "withdraw"
									? "Withdraw entry"
									: editing.kind === "correct"
										? "Save correction"
										: "Save contact"}
							</SaveButton>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</NoticeInDialog>
	);
}

type More = {
	next: number | null;
	loading: boolean;
	failed: boolean;
	more: () => void;
	reset: (next: number | null) => void;
};
/** The next page of a list on "Show more": its items join the list once, and a failed read can be tried again. */
function useMore<T>(
	first: number | null,
	load: (page: number) => Promise<Outcome<{ items: T[]; next: number | null }>>,
	add: (items: T[]) => void,
): More {
	const [next, setNext] = useState(first);
	const generation = useRef(0);
	const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
	async function more() {
		if (next === null || state === "loading") return;
		setState("loading");
		const started = generation.current;
		const r = await load(next);
		// A page that arrives after the list started again belongs to the old list: drop it.
		if (started !== generation.current) return;
		if (r.status !== "ok") return setState("failed");
		add(r.value.items);
		setNext(r.value.next);
		setState("idle");
	}
	/** Starts the list again: its first page was just replaced, and `next` is that page's continuation. */
	function reset(first: number | null) {
		generation.current++;
		setNext(first);
		setState("idle");
	}
	return { next, loading: state === "loading", failed: state === "failed", more, reset };
}
function ShowMore({ more, what }: { more: More; what: string }) {
	if (more.next === null) return null;
	return (
		<div className="mt-2 flex flex-wrap items-center gap-3">
			<Button size="sm" variant="ghost" loading={more.loading} onClick={more.more}>
				Show more {what}
			</Button>
			<span aria-live="polite" className="text-xs text-text-3 empty:hidden">
				{more.failed ? `More ${what} did not load. Try again.` : ""}
			</span>
		</div>
	);
}
