"use client";

import { Mail01Icon } from "@hugeicons/core-free-icons";
import { Button, ConfirmDialog, EmptyState, Field, Input, Select } from "@everyfield/ui/controls";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
	cancelScheduled,
	openMessage,
	readDraft,
	readHistory,
	readMeetingHistory,
	readMeetingTracking,
	readPersonHistory,
	reconcileDelivery,
	replaceScheduled,
	rescheduleDispatched,
	reviewResend,
	saveResend,
	sendReviewed,
} from "./actions.ts";
import { PreviewStage } from "./EmailFrame.tsx";
import { deliveryName, Tile, Totals, when } from "./SentTotals.tsx";
import {
	cancelText,
	contactLabel,
	deliveryText,
	hubLabel,
	hubStates,
	outcomeText,
	rateText,
	refusedAllText,
	replaceText,
	rescheduleText,
	sentNote,
	unsubscribedNote,
	type ContactRow,
	type DeliveryReport,
	type DetailRecipient,
	type Draft,
	type HistoryItem,
	type HistoryPage,
	type HubState,
	type MessageView,
	type Outcome,
	type ResendReview,
	type TrackingRow,
} from "./model.ts";
import { plural } from "./composeModel.ts";
import { pickSampleName } from "./fields.ts";
import { insideWindow, windowBounds } from "./scheduleWindow.ts";
import { useKeys } from "./useKeys.ts";

// History is the message hub. A follow-up saves a new reviewed message and leaves the original alone.
// Times use the clock on this device. The church zone is not on this page.

type PersonName = { id: string; displayName: string; email: string | null };
type Scope = { kind: "hub" } | { kind: "person"; personId: string } | { kind: "meeting"; meetingId: string };
type Filters = { query: string; state: string; channel: string };

const emptyFilters: Filters = { query: "", state: "any", channel: "any" };

function problem(result: Outcome<unknown>): string {
	if (result.status === "lost") return "Unable to reach the church records. Try again in a moment.";
	if (result.status === "refused" && result.code === "not_found") return "That record is no longer here.";
	if (result.status === "refused" && result.code === "access_denied")
		return "An Owner or Admin seat is required to change messages.";
	if (result.status === "refused" && result.code === "invalid_input")
		return "That link is not valid. Check it and try again.";
	return outcomeText(result) ?? "Unable to load history. Try again.";
}

function listed(items: string[], max = 8): string {
	if (items.length === 0) return "None";
	if (items.length <= max) return items.join(", ");
	return `${items.slice(0, max).join(", ")}, and ${items.length - max} more`;
}

function useHistory(load: (cursor: string | null) => Promise<Outcome<HistoryPage>>) {
	const [items, setItems] = useState<HistoryItem[]>([]);
	const [page, setPage] = useState<HistoryPage | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState<"list" | "more" | null>("list");
	const loadRef = useRef(load);

	useEffect(() => {
		loadRef.current = load;
	});

	useEffect(() => {
		let cancel = false;
		void loadRef
			.current(null)
			.then((result) => {
				if (cancel) return;
				setPending(null);
				if (result.status !== "ok") {
					setError(problem(result));
					setItems([]);
					setPage(null);
					return;
				}
				setPage(result.value);
				setItems(result.value.items);
			})
			.catch(() => {
				if (cancel) return;
				setPending(null);
				setError("Unable to reach the church records. Try again in a moment.");
				setItems([]);
				setPage(null);
			});
		return () => {
			cancel = true;
		};
	}, []);

	const more = () => {
		if (!page?.nextCursor || pending) return;
		const cursor = page.nextCursor;
		setPending("more");
		void loadRef
			.current(cursor)
			.then((result) => {
				setPending(null);
				if (result.status !== "ok") {
					setError(problem(result));
					return;
				}
				setPage(result.value);
				setItems((current) => [...current, ...result.value.items]);
			})
			.catch(() => {
				setPending(null);
				setError("Unable to reach the church records. Try again in a moment.");
			});
	};

	const reload = () => {
		setPending("list");
		setError(null);
		void loadRef.current(null).then((result) => {
			setPending(null);
			if (result.status !== "ok") {
				setError(problem(result));
				setItems([]);
				setPage(null);
				return;
			}
			setPage(result.value);
			setItems(result.value.items);
		});
	};

	/** The open message's row follows its fresh detail after an action, so the list never keeps an old state. */
	const patch = (id: string, view: MessageView) =>
		setItems((current) =>
			current.map((item) =>
				item.id === id
					? {
							...item,
							state: view.totals.state,
							scheduledAt: view.detail.scheduledAt,
							sentAt: view.detail.sentAt,
							reachable: view.totals.reachable,
							delivered: view.totals.delivered,
							rate: view.totals.rate,
						}
					: item,
			),
		);

	return { items, page, error, pending, more, reload, patch };
}

const stateTone: Record<HubState, string> = {
	draft: "bg-surface-2 text-text-2",
	scheduled: "bg-amber-100 text-amber-600",
	not_scheduled: "bg-magenta-50 text-magenta-600",
	unsubscribed: "bg-surface-2 text-text-2",
	sending: "bg-amber-100 text-amber-600",
	sent: "bg-green-100 text-green-700",
	logged: "bg-surface-2 text-text-2",
	cancelled: "bg-surface-2 text-text-2",
	cancel_unconfirmed: "bg-magenta-50 text-magenta-600",
	time_unconfirmed: "bg-magenta-50 text-magenta-600",
	failed: "bg-magenta-50 text-magenta-600",
	unknown: "bg-surface-2 text-text-2",
};

function StateBadge({ state }: { state: HubState }) {
	return (
		<span
			className={`inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-xs font-medium whitespace-nowrap ${stateTone[state]}`}
		>
			{hubLabel[state]}
		</span>
	);
}

/** The time a row shows: sent, else scheduled, else when it was created. */
function rowTime(item: HistoryItem): string {
	if (item.sentAt) return when(item.sentAt);
	if (item.scheduledAt) return `For ${when(item.scheduledAt)}`;
	return when(item.createdAt);
}

function MessageButton({
	item,
	selected,
	onSelect,
}: {
	item: HistoryItem;
	selected: boolean;
	onSelect: (item: HistoryItem) => void;
}) {
	return (
		<button
			type="button"
			aria-current={selected ? "true" : undefined}
			onClick={() => onSelect(item)}
			className="flex min-h-[72px] w-full cursor-pointer flex-col items-start gap-1 rounded-md px-3 py-2.5 text-left hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ef-focus)] aria-[current=true]:bg-surface-2"
		>
			<span className="flex w-full items-center justify-between gap-2">
				<span className="min-w-0 truncate font-medium text-ink">{item.subject?.trim() || "No subject"}</span>
				<StateBadge state={item.state} />
			</span>
			<span className="text-sm text-text-3">
				{rowTime(item)} · {recipientCount(item.reachable, item.state)}
			</span>
		</button>
	);
}

/** A message that has not gone out has no recipient records yet, so a zero there would mislead. */
const recipientCount = (n: number, state: HubState) =>
	n === 0 && (state === "draft" || state === "scheduled") ? "Not sent yet" : plural(n, "recipient", "recipients");

function AddressFact({ label, value }: { label: string; value: string | null }) {
	return (
		<p className="text-sm text-text-2">
			<span className="text-ink-2">{label}: </span>
			{value ?? "Not available"}
		</p>
	);
}

type Notice = { text: string; tone: "alert" | "status" };
type ScheduledActions = {
	pending: string | null;
	notice: Notice | null;
	onSendNow: () => void;
	onCancel: () => void;
	onCheckCancel: () => void;
	onReconcile: () => void;
	onReplace: () => void;
	onReschedule: (instant: Date) => void;
};

/** The handoff counts every scheduled state names. Refused here is the email service's refusal, never a bounce. */
const handoffCounts = (totals: MessageView["totals"]) =>
	`Accepted ${totals.accepted}. Refused ${totals.failed}. No answer ${totals.unknown}.${unsubscribedNote(totals.unsubscribed)}`;

/** Headline and detail for the message's state at the email service. Each line comes only from confirmed answers. */
function heldStatus(view: MessageView): { title: string; body: string } {
	const { totals, detail } = view;
	const went = sentNote(totals.sent);
	switch (totals.state) {
		case "scheduled":
			return {
				title: `Scheduled for ${when(detail.scheduledAt)}`,
				body: `It goes to ${plural(totals.reachable, "person", "people")} then. Anyone who unsubscribes before then gets nothing.${unsubscribedNote(totals.unsubscribed)}`,
			};
		case "unsubscribed":
			return {
				title: "Not sent: unsubscribed",
				body: "Every recipient unsubscribed from this church's email, so it does not go out. This is not an error.",
			};
		case "not_scheduled":
			return {
				title: "Not scheduled",
				body: `${refusedAllText(totals.unsubscribed, totals.failed)} ${handoffCounts(totals)} The message stays saved.`,
			};
		case "cancel_unconfirmed":
			return {
				title: "Cancel not confirmed",
				body: `Confirmed ${totals.cancelled}. Not confirmed ${totals.cancelOpen}.${went} A replacement stays blocked until every recipient is confirmed cancelled.`,
			};
		case "time_unconfirmed":
			return {
				title: "Time change not confirmed",
				body: `You asked for ${when(detail.requestedAt)}. The email service still holds ${when(detail.scheduledAt)}.`,
			};
		case "cancelled":
			return {
				title: "Cancelled",
				body: `Cancelled for ${plural(totals.cancelled, "person", "people")}. No email went out to them.${went}`,
			};
		case "failed":
			return {
				title: "Not sent",
				body:
					totals.unsubscribed === 0
						? `The email service refused all ${totals.failed}. The message stays saved.`
						: `${refusedAllText(totals.unsubscribed, totals.failed)} ${handoffCounts(totals)} The message stays saved.`,
			};
		case "unknown":
			return { title: "Not confirmed", body: `The email service gave no answer. ${handoffCounts(totals)}` };
		default:
			return { title: "Sending", body: `The email service accepted it. ${handoffCounts(totals)}` };
	}
}

/** An action's result. It stays after the scheduled panel closes, as when every email already went out. */
function ResultNotice({ notice }: { notice: Notice }) {
	return (
		<p
			role={notice.tone}
			className={notice.tone === "alert" ? "text-sm font-medium text-magenta-600" : "text-md text-ink"}
		>
			{notice.text}
		</p>
	);
}

function ScheduledPanel({ view, actions }: { view: MessageView; actions: ScheduledActions }) {
	const [when_, setWhen] = useState("");
	const [error, setError] = useState<string | undefined>();
	const bounds = useMemo(() => windowBounds(), []);
	const busy = actions.pending !== null;
	const state = view.totals.state;
	const status = heldStatus(view);
	const requestedAt = view.detail.requestedAt;
	// The email service holds at least one recipient: cancel and time change go to it, and Send now would not.
	const held = state === "scheduled" || state === "time_unconfirmed";
	const unconfirmed = state === "cancel_unconfirmed" || state === "time_unconfirmed";
	const action = (name: string, label: string, run: () => void, variant: "primary" | "secondary" = "secondary") => (
		<Button
			variant={variant}
			onClick={run}
			loading={actions.pending === name}
			disabled={busy && actions.pending !== name}
		>
			{label}
		</Button>
	);
	return (
		<section aria-label="Scheduled message" className="flex flex-col gap-4 rounded-lg bg-surface p-5">
			<div className="flex flex-col gap-1">
				<h3 className={`text-md font-medium ${unconfirmed ? "text-magenta-600" : "text-ink"}`}>{status.title}</h3>
				<p className="text-sm text-text-2">{status.body}</p>
			</div>
			{actions.notice ? <ResultNotice notice={actions.notice} /> : null}
			<div className="flex flex-wrap gap-2">
				{state === "cancel_unconfirmed" ? action("cancel", "Check again", actions.onCheckCancel, "primary") : null}
				{state === "time_unconfirmed" && requestedAt
					? action("reschedule", "Check again", () => actions.onReschedule(new Date(requestedAt)), "primary")
					: null}
				{!held && !unconfirmed && state !== "cancelled" && state !== "unsubscribed" ? (
					<Button variant="primary" onClick={actions.onSendNow} disabled={busy}>
						Send now
					</Button>
				) : null}
				{held ? (
					<Button variant="danger" onClick={actions.onCancel} disabled={busy}>
						Cancel scheduled email
					</Button>
				) : null}
				{state === "unknown" || state === "sending" ? action("reconcile", "Check result", actions.onReconcile) : null}
				{state === "cancelled" || state === "cancel_unconfirmed"
					? action("replace", "Check replacement", actions.onReplace)
					: null}
			</div>
			{held || state === "not_scheduled" ? (
				<div className="flex flex-wrap items-end gap-3">
					<Field label="Change send time" hint="From now through the next 30 days." error={error}>
						<Input
							type="datetime-local"
							value={when_}
							min={bounds.min}
							max={bounds.max}
							suppressHydrationWarning
							onChange={(event) => {
								setWhen(event.target.value);
								setError(undefined);
							}}
						/>
					</Field>
					{action("reschedule", "Change send time", () => {
						const at = when_ ? new Date(when_) : null;
						if (!at || !insideWindow(at)) {
							setError("Choose a send time from now through the next 30 days.");
							return;
						}
						actions.onReschedule(at);
					})}
				</div>
			) : null}
		</section>
	);
}

function Detail({
	view,
	canWrite,
	review,
	reviewError,
	pending,
	onReview,
	onConfirm,
	onPerson,
	onMeeting,
	keepScope,
	churchName,
	origin,
	scheduled,
	notice,
}: {
	view: MessageView;
	canWrite: boolean;
	review: ResendReview | null;
	reviewError: string | null;
	pending: string | null;
	onReview: () => void;
	onConfirm: () => void;
	onPerson: (personId: string) => void;
	onMeeting: (meetingId: string) => void;
	keepScope: boolean;
	churchName: string;
	origin: string;
	scheduled: ScheduledActions | null;
	notice: Notice | null;
}) {
	const detail = view.detail;
	const names = new Map(view.recipients.map((row) => [row.personId, row.name]));
	const shown = view.recipientsComplete ? detail.recipients : detail.recipients.slice(0, view.recipients.length);
	const nameFor = (row: DetailRecipient, index: number) => {
		const named = view.recipients[index];
		if (named && named.personId === row.personId && named.name) return named.name;
		if (!row.personId) return "No linked person";
		return names.get(row.personId) ?? "Person";
	};
	const addressChanged =
		detail.deliveryAddress !== null &&
		detail.currentPersonAddress !== null &&
		detail.deliveryAddress !== detail.currentPersonAddress;
	const meetingId = detail.meetingId;
	const named = view.recipients.filter((row) => row.name);
	const [shownAs, setShownAs] = useState(0);
	const [sample] = useState(() => pickSampleName(detail.communicationId));
	const as = named[Math.min(shownAs, Math.max(0, named.length - 1))]?.name ?? sample;
	const totals = view.totals;
	const heldStates: HubState[] = ["scheduled", "time_unconfirmed", "cancel_unconfirmed"];
	const stateWhen = detail.sentAt
		? `Sent ${when(detail.sentAt)}`
		: detail.scheduledAt && heldStates.includes(totals.state)
			? `Scheduled for ${when(detail.scheduledAt)}`
			: hubLabel[totals.state];
	return (
		<div className="flex flex-col gap-8">
			<div className="flex flex-col gap-3">
				<div className="flex flex-wrap items-center gap-3">
					<StateBadge state={totals.state} />
				</div>
				<h2 className="font-title text-title-md leading-[1.2] tracking-[-0.02em] text-balance text-ink">
					{detail.subject?.trim() || "No subject"}
				</h2>
				<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-md">
					<dt className="text-text-3">When</dt>
					<dd className="text-ink">{stateWhen}</dd>
					<dt className="text-text-3">Sender</dt>
					<dd className="text-ink">{detail.senderName ?? "Not recorded"}</dd>
					<dt className="text-text-3">Recipients</dt>
					<dd className="text-ink">{recipientCount(totals.reachable, totals.state)}</dd>
					<dt className="text-text-3">Delivery</dt>
					<dd className="text-ink">
						{hubLabel[totals.state]}. {rateText(totals.delivered, totals.reachable, totals.rate)}
					</dd>
				</dl>
				{detail.recipients.length === 1 ? (
					<>
						<AddressFact label="Address at send" value={detail.deliveryAddress} />
						<AddressFact label="Address now" value={detail.currentPersonAddress} />
						{addressChanged ? (
							<p className="text-sm text-text-2">The address now is not the address used for this send.</p>
						) : null}
					</>
				) : detail.recipients.length > 1 ? (
					<p className="text-sm text-text-2">Each person has an address in the list below.</p>
				) : null}
				{meetingId && !keepScope ? (
					<div>
						<Button variant="ghost" onClick={() => onMeeting(meetingId)}>
							Show this meeting
						</Button>
					</div>
				) : null}
			</div>
			{scheduled ? (
				<ScheduledPanel view={view} actions={scheduled} />
			) : notice ? (
				<ResultNotice notice={notice} />
			) : null}
			<Totals totals={view.totals} />
			{detail.bodyHtml ? (
				<PreviewStage
					input={{ bodyHtml: detail.bodyHtml, name: as, hasMeeting: detail.meetingId !== null, origin, churchName }}
					chrome={{ from: churchName, to: as, subject: detail.subject ?? "" }}
					toolbar={
						named.length > 1 ? (
							<div className="w-52">
								<Select
									aria-label="Shown as"
									value={String(Math.min(shownAs, named.length - 1))}
									onValueChange={(value) => setShownAs(Number(value))}
									options={named.map((row, i) => ({ value: String(i), label: `Shown as ${row.name}` }))}
								/>
							</div>
						) : null
					}
				/>
			) : (
				<section className="flex flex-col gap-2">
					<p className="text-sm text-text-2">This message was saved as plain text.</p>
					{detail.bodyText ? (
						<p className="rounded-md bg-surface px-4 py-3 text-md whitespace-pre-wrap text-ink">{detail.bodyText}</p>
					) : (
						<p className="text-sm text-text-2">The plain text of this message was not stored.</p>
					)}
				</section>
			)}
			<div className="flex flex-col gap-3">
				<h3 className="text-sm font-medium text-ink-2">Recipients</h3>
				{shown.length === 0 ? (
					<p className="text-sm text-text-2">No recipient record for this message.</p>
				) : (
					<ul className="flex flex-col gap-4">
						{shown.map((row, index) => {
							const personId = row.personId;
							return (
								<li key={`${personId ?? "none"}-${row.sentAt ?? index}`} className="flex flex-col gap-1">
									<p className="font-medium text-ink">{nameFor(row, index)}</p>
									<p className="text-sm text-text-2">
										{deliveryName(row.deliveryStatus, !heldStates.includes(totals.state))}
									</p>
									<AddressFact label="Address at send" value={row.deliveryAddress} />
									<AddressFact label="Address now" value={row.currentPersonAddress} />
									<p className="text-sm text-text-3">
										Sent {when(row.sentAt)} · Delivered {when(row.deliveredAt)} · Opened {when(row.openedAt)} · Clicked{" "}
										{when(row.clickedAt)}
									</p>
									{personId && !keepScope ? (
										<div>
											<Button variant="ghost" onClick={() => onPerson(personId)}>
												Show this person
											</Button>
										</div>
									) : null}
								</li>
							);
						})}
					</ul>
				)}
				{view.recipientsComplete ? null : (
					<p className="text-sm text-text-2">More than 100 recipients. The first 100 are listed.</p>
				)}
			</div>
			{canWrite && view.totals.state === "sent" ? (
				<div className="flex flex-col gap-3">
					<h3 className="text-sm font-medium text-ink-2">Follow-up</h3>
					<p className="text-sm text-text-2">
						Open tracking is not certain. A person can receive the email and still be listed as not opened.
					</p>
					<div>
						<Button
							variant="secondary"
							onClick={onReview}
							loading={pending === "review"}
							disabled={pending !== null && pending !== "review"}
						>
							Review follow-up
						</Button>
					</div>
					{reviewError ? (
						<p role="alert" className="text-sm font-medium text-magenta-600">
							{reviewError}
						</p>
					) : null}
					{review ? (
						<div className="flex flex-col items-start gap-2 text-sm text-text-2">
							<p>{review.confirmedDelivery ? "At least one delivery is confirmed." : "No delivery is confirmed."}</p>
							<p>Will receive the follow-up: {listed(review.eligibleNames)}.</p>
							<p>Excluded: {listed(review.excludedNames)}.</p>
							<Button
								variant="primary"
								onClick={onConfirm}
								disabled={pending !== null || review.eligibleIds.length === 0 || !review.confirmedDelivery}
							>
								Save follow-up
							</Button>
							{review.eligibleIds.length === 0 || !review.confirmedDelivery ? (
								<p>No delivered non-opener can receive this follow-up. Nothing was saved.</p>
							) : (
								<p>Saving creates a new reviewed message. It does not send email. The original stays as it is.</p>
							)}
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}

type BrowserProps = {
	canWrite: boolean;
	title: string;
	intro: string;
	emptyTitle: string;
	emptyBody: string;
	load: (cursor: string | null) => Promise<Outcome<HistoryPage>>;
	header?: ReactNode;
	onOpen: (draft: Draft, people: PersonName[]) => void;
	onPerson: (personId: string) => void;
	onMeeting: (meetingId: string) => void;
	keepScope: boolean;
	selected: string | null;
	onSelected: (id: string | null) => void;
	onCompose?: (id: string, step: "write" | "review", replace: boolean) => void;
	onNew?: () => void;
	churchName: string;
	origin: string;
	banner?: string | null;
};

function Browser({
	canWrite,
	title,
	intro,
	emptyTitle,
	emptyBody,
	load,
	header,
	onOpen,
	onPerson,
	onMeeting,
	keepScope,
	selected,
	onSelected,
	onCompose,
	onNew,
	churchName,
	origin,
	banner,
}: BrowserProps) {
	const history = useHistory(load);
	const keys = useKeys();
	const [detail, setDetail] = useState<{ id: string; view: MessageView | null; error: string | null } | null>(null);
	const [acting, setActing] = useState<string | null>(null);
	const [reviewed, setReviewed] = useState<{ id: string; review: ResendReview | null; error: string | null } | null>(
		null,
	);
	const [confirm, setConfirm] = useState<null | "follow-up" | "send" | "cancel">(null);
	const [notice, setNotice] = useState<Notice | null>(null);

	const current = detail !== null && detail.id === selected ? detail : null;
	const view = current?.view ?? null;
	const detailError = current?.error ?? null;
	const opening = selected !== null && current === null;
	const detailPending = acting ?? (opening ? "open" : null);
	const review = reviewed && reviewed.id === selected ? reviewed.review : null;
	const reviewError = reviewed && reviewed.id === selected ? reviewed.error : null;

	const count = (state: HubState) => history.items.filter((item) => item.state === state).length;

	const composeRef = useRef(onCompose);
	useEffect(() => {
		composeRef.current = onCompose;
	});

	useEffect(() => {
		if (!selected) return;
		let live = true;
		void openMessage(selected)
			.then((result) => {
				if (!live) return;
				if (result.status !== "ok") {
					setDetail({ id: selected, view: null, error: problem(result) });
					return;
				}
				// A saved follow-up is a Reviewed message. It opens at the Review step.
				if (result.value.detail.state === "reviewed" && composeRef.current) {
					composeRef.current(selected, "review", true);
					return;
				}
				setDetail({ id: selected, view: result.value, error: null });
				setNotice(null);
			})
			.catch(() => {
				if (live)
					setDetail({ id: selected, view: null, error: "Unable to reach the church records. Try again in a moment." });
			});
		return () => {
			live = false;
		};
	}, [selected]);

	const select = (item: HistoryItem) => {
		// A draft goes back to Write. Anything else opens in the detail pane.
		if (item.state === "draft" && onCompose && canWrite) onCompose(item.id, "write", false);
		else onSelected(item.id);
	};

	const onReview = () => {
		if (!selected || detailPending) return;
		const id = selected;
		setActing("review");
		setReviewed({ id, review: null, error: null });
		void reviewResend(id)
			.then((result) => {
				setReviewed(
					result.status === "ok"
						? { id, review: result.value, error: null }
						: { id, review: null, error: problem(result) },
				);
			})
			.catch(() => {
				setReviewed({ id, review: null, error: "Unable to reach the church records. Try again in a moment." });
			})
			.finally(() => setActing(null));
	};

	const refresh = async (id: string) => {
		const fresh = await openMessage(id);
		if (fresh.status !== "ok") return;
		setDetail({ id, view: fresh.value, error: null });
		history.patch(id, fresh.value);
	};

	const act = async <T,>(
		name: string,
		call: () => Promise<Outcome<T>>,
		text: (value: T) => { text: string; tone: "alert" | "status" },
	) => {
		if (!view || detailPending) return;
		const id = view.detail.communicationId;
		setActing(name);
		setNotice(null);
		try {
			const result = await call();
			keys.settle(name, result);
			if (result.status !== "ok") {
				setNotice({ text: outcomeText(result) ?? "Unable to finish. Try again.", tone: "alert" });
				return;
			}
			setNotice(text(result.value));
			await refresh(id);
		} finally {
			setActing(null);
		}
	};

	const scheduledShown =
		canWrite &&
		view !== null &&
		view.detail.state === "scheduled" &&
		view.totals.state !== "sent" &&
		view.totals.state !== "draft";

	const actions: ScheduledActions | null =
		scheduledShown && view
			? {
					pending: detailPending,
					notice,
					onSendNow: () => setConfirm("send"),
					onCancel: () => setConfirm("cancel"),
					onCheckCancel: () =>
						void act(
							"cancel",
							() => cancelScheduled(keys.take("cancel"), view.detail.revision, view.detail.communicationId),
							(report) => ({
								text: cancelText(report),
								tone: report.scheduledCancel === "reconcile" ? "alert" : "status",
							}),
						),
					onReconcile: () =>
						void act(
							"reconcile",
							async () => {
								const result = await reconcileDelivery(
									keys.take("reconcile"),
									view.detail.revision,
									view.detail.communicationId,
								);
								if (result.status === "refused" && result.code === "not_found") {
									return { status: "ok", value: null } as Outcome<DeliveryReport | null>;
								}
								return result;
							},
							(report) =>
								report
									? { text: deliveryText(report), tone: report.status === "accepted" ? "status" : "alert" }
									: { text: "The email service has no send for this email yet.", tone: "status" },
						),
					onReplace: () =>
						void act(
							"replace",
							() => replaceScheduled(keys.take("replace"), view.detail.revision, view.detail.communicationId),
							(report) => ({ text: replaceText(report), tone: "status" }),
						),
					onReschedule: (instant) =>
						void act(
							"reschedule",
							() =>
								rescheduleDispatched(
									keys.take("reschedule"),
									view.detail.revision,
									view.detail.communicationId,
									instant.toISOString(),
								),
							(report) => ({
								text: rescheduleText(report, when),
								tone: report.rescheduleStatus === "unknown" ? "alert" : "status",
							}),
						),
				}
			: null;

	return (
		<div className="flex flex-col gap-6">
			{header}
			{banner ? (
				<p role="status" className="rounded-md bg-surface px-4 py-3 text-md text-ink">
					{banner}
				</p>
			) : null}
			{history.items.length > 0 ? (
				<div className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="Message counts">
					<Tile label="Messages shown" value={history.items.length} />
					<Tile label="Sent" value={count("sent")} />
					<Tile label="Scheduled" value={count("scheduled")} />
					<Tile label="Drafts" value={count("draft")} />
				</div>
			) : null}
			<div className="grid items-start gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
				<section aria-label={title} className="flex min-w-0 flex-col gap-3 rounded-lg bg-surface p-3">
					<div className="px-2 pt-1">
						<h2 className="font-title text-title-sm tracking-[-0.01em] text-ink">{title}</h2>
						<p className="text-sm text-text-3">{intro}</p>
					</div>
					{history.pending === "list" ? (
						<p role="status" className="px-2 text-sm text-text-2">
							Loading history.
						</p>
					) : null}
					{history.error ? (
						<div className="flex flex-col items-start gap-3 px-2">
							<p role="alert" className="text-sm font-medium text-magenta-600">
								{history.error}
							</p>
							<Button variant="secondary" onClick={history.reload}>
								Try again
							</Button>
						</div>
					) : null}
					{history.pending !== "list" && !history.error && history.items.length === 0 ? (
						<EmptyState icon={Mail01Icon} title={emptyTitle}>
							{emptyBody}
							{onNew && canWrite ? (
								<span className="mt-3 block">
									<Button variant="primary" onClick={onNew}>
										New message
									</Button>
								</span>
							) : null}
						</EmptyState>
					) : null}
					{history.items.length > 0 ? (
						<ul className="flex flex-col gap-0.5">
							{history.items.map((item) => (
								<li key={item.id}>
									<MessageButton item={item} selected={item.id === selected} onSelect={select} />
								</li>
							))}
						</ul>
					) : null}
					{history.page && !history.page.complete ? (
						<Button
							variant="secondary"
							onClick={history.more}
							loading={history.pending === "more"}
							disabled={history.pending !== null && history.pending !== "more"}
						>
							Load more
						</Button>
					) : null}
					{history.page ? <p className="px-2 text-sm text-text-3">Counts as of {when(history.page.asOf)}.</p> : null}
				</section>
				<section
					aria-label="Message"
					aria-live="polite"
					className="flex min-w-0 flex-col gap-5 rounded-lg bg-surface p-6"
				>
					{detailPending === "open" ? (
						<p role="status" className="text-sm text-text-2">
							Loading the message.
						</p>
					) : null}
					{detailError ? (
						<p role="alert" className="text-sm font-medium text-magenta-600">
							{detailError}
						</p>
					) : null}
					{view ? (
						<Detail
							view={view}
							canWrite={canWrite}
							review={review}
							reviewError={reviewError}
							pending={detailPending}
							onReview={onReview}
							onConfirm={() => setConfirm("follow-up")}
							onPerson={onPerson}
							onMeeting={onMeeting}
							keepScope={keepScope}
							churchName={churchName}
							origin={origin}
							scheduled={actions}
							notice={notice}
						/>
					) : detailPending === "open" || detailError ? null : (
						<EmptyState icon={Mail01Icon} title="Choose a message">
							The email as sent, its time, sender and each recipient result open here.
						</EmptyState>
					)}
				</section>
			</div>
			<ConfirmDialog
				open={confirm === "follow-up"}
				onOpenChange={(next) => !next && setConfirm(null)}
				title="Save a follow-up for people who did not open it?"
				description="This saves a new reviewed message. It does not send email."
				consequences={[
					"The original message stays as it is.",
					"Open tracking is not certain.",
					review ? `People: ${listed(review.eligibleNames)}.` : "No people are selected.",
				]}
				confirmLabel="Save follow-up"
				onConfirm={async () => {
					if (!selected || !review || review.eligibleIds.length === 0 || !review.confirmedDelivery)
						throw new Error("Review the follow-up before you save it.");
					const result = await saveResend(keys.take("resend"), selected);
					keys.settle("resend", result);
					if (result.status !== "ok") throw new Error(problem(result));
					const fresh = await readDraft(result.value.communicationId);
					if (fresh.status !== "ok") {
						setReviewed({
							id: selected,
							review,
							error: `${problem(fresh)} The follow-up was saved. Reload Messages, then open it from the list.`,
						});
						return;
					}
					onOpen(
						fresh.value,
						result.value.eligibleIds.map((id, index) => ({
							id,
							displayName: result.value.eligibleNames[index] || "Person on this message",
							email: null,
						})),
					);
				}}
			/>
			<ConfirmDialog
				open={confirm === "send"}
				onOpenChange={(next) => !next && setConfirm(null)}
				title="Send this email now?"
				description="The email service receives this email now."
				consequences={[
					"It does not wait for the send time.",
					"Acceptance by the email service is not arrival in an inbox.",
					"If this email was already handed off, it is not sent again.",
				]}
				confirmLabel="Send email"
				onConfirm={async () => {
					if (!view) throw new Error("Open a scheduled email before you send it.");
					const id = view.detail.communicationId;
					const result = await sendReviewed(keys.take("send"), view.detail.revision, id);
					keys.settle("send", result);
					if (result.status !== "ok") throw new Error(outcomeText(result) ?? "Unable to send the email.");
					setNotice({
						text: deliveryText(result.value),
						tone: result.value.status === "accepted" ? "status" : "alert",
					});
					await refresh(id);
					if (result.value.status === "failed") throw new Error(deliveryText(result.value));
				}}
			/>
			<ConfirmDialog
				open={confirm === "cancel"}
				onOpenChange={(next) => !next && setConfirm(null)}
				title="Cancel the scheduled email?"
				description="This asks the email service to cancel each recipient. The message stays here."
				consequences={[
					"Email that already went out cannot be recalled.",
					"It shows as cancelled only when the email service confirms every recipient.",
				]}
				confirmLabel="Cancel scheduled email"
				tone="danger"
				onConfirm={async () => {
					if (!view) throw new Error("Open a scheduled email before you cancel it.");
					const id = view.detail.communicationId;
					const result = await cancelScheduled(keys.take("cancel"), view.detail.revision, id);
					keys.settle("cancel", result);
					if (result.status !== "ok") throw new Error(outcomeText(result) ?? "Unable to cancel the scheduled email.");
					setNotice({
						text: cancelText(result.value),
						tone: result.value.scheduledCancel === "reconcile" ? "alert" : "status",
					});
					await refresh(id);
				}}
			/>
		</div>
	);
}

/**
 * The person's own opt-out from this church's email (D-284). Staff see it and when, and nothing here can clear it. The
 * Unsubscribe page offered the person an Undo for one hour after they pressed Unsubscribe; opening the link again later
 * only shows that they are unsubscribed.
 */
function OptOutNote({ at, churchName }: { at: string; churchName: string }) {
	return (
		<div className="flex flex-col gap-1 rounded-md bg-surface-2 px-3.5 py-3">
			<p className="font-medium text-ink">Unsubscribed from email</p>
			<p className="text-sm text-text-2">
				They unsubscribed from {churchName.trim() || "this church"}&rsquo;s email on {when(at)}. Messages are not sent
				to them. They could undo it for one hour on the page their Unsubscribe link opened; it can&rsquo;t be undone
				here.
			</p>
		</div>
	);
}

function ContactLog({
	contacts,
	lastConfirmedContactAt,
}: {
	contacts: ContactRow[];
	lastConfirmedContactAt: string | null;
}) {
	return (
		<div className="flex flex-col gap-3">
			<h2 className="text-sm font-medium text-ink-2">Contact log</h2>
			<p className="text-sm text-text-2">A contact is a typed outcome for this person. It is not an email delivery.</p>
			<p className="text-sm text-text-2">
				Last confirmed contact: {lastConfirmedContactAt ? when(lastConfirmedContactAt) : "None"}.
			</p>
			{contacts.length === 0 ? (
				<p className="text-sm text-text-2">No typed contact yet. An email delivery does not fill this log.</p>
			) : (
				<ul className="flex flex-col gap-3">
					{contacts.map((row) => (
						<li key={row.outcomeId} className="flex flex-col gap-0.5">
							<p className="font-medium text-ink">{contactLabel[row.outcome]}</p>
							<p className="text-sm text-text-3">
								{when(row.occurredAt)}
								{row.taskId ? " · Linked to a task" : ""}
								{row.voided ? " · Corrected. This row stays in the log." : ""}
							</p>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

export function History({
	canWrite,
	personId,
	meetingId,
	onOpen,
	keepScope = false,
	selected,
	onSelected,
	onCompose,
	onNew,
	churchName,
	origin,
	banner = null,
}: {
	canWrite: boolean;
	personId: string | null;
	meetingId: string | null;
	onOpen: (draft: Draft, people: PersonName[]) => void;
	/** Stay on the opened person or meeting. The person tab uses this so the tab does not open the church list. */
	keepScope?: boolean;
	/** The opened message, from the address. Without it the list keeps its own choice (the person tab). */
	selected?: string | null;
	onSelected?: (id: string | null) => void;
	onCompose?: (id: string, step: "write" | "review", replace: boolean) => void;
	onNew?: () => void;
	churchName: string;
	origin: string;
	banner?: string | null;
}) {
	const [ownSelected, setOwnSelected] = useState<string | null>(null);
	const openId = selected === undefined ? ownSelected : selected;
	const choose = onSelected ?? setOwnSelected;
	const [scope, setScope] = useState<Scope>(
		personId ? { kind: "person", personId } : meetingId ? { kind: "meeting", meetingId } : { kind: "hub" },
	);
	const [filters, setFilters] = useState<Filters>(emptyFilters);
	const [query, setQuery] = useState("");
	const [contacts, setContacts] = useState<ContactRow[] | null>(null);
	const [lastContact, setLastContact] = useState<string | null>(null);
	const [optOutAt, setOptOutAt] = useState<string | null>(null);
	const [tracking, setTracking] = useState<TrackingRow[] | null>(null);
	const [scopeNote, setScopeNote] = useState<string | null>(null);

	useEffect(() => {
		const timer = setTimeout(() => setFilters((current) => ({ ...current, query })), 300);
		return () => clearTimeout(timer);
	}, [query]);

	useEffect(() => {
		if (scope.kind !== "meeting") return;
		let cancel = false;
		void readMeetingTracking(scope.meetingId).then((result) => {
			if (cancel) return;
			if (result.status !== "ok") {
				setScopeNote(problem(result));
				setTracking(null);
				return;
			}
			setScopeNote(null);
			setTracking(result.value.items);
		});
		return () => {
			cancel = true;
		};
	}, [scope]);

	const reloadKey =
		scope.kind === "hub"
			? `hub:${filters.query}:${filters.state}:${filters.channel}`
			: scope.kind === "person"
				? `person:${scope.personId}`
				: `meeting:${scope.meetingId}`;

	const load = async (cursor: string | null) => {
		if (scope.kind === "person") {
			const result = await readPersonHistory(scope.personId, cursor ?? undefined);
			if (!cursor && result.status === "ok") {
				setContacts(result.value.contacts);
				setLastContact(result.value.lastConfirmedContactAt);
				setOptOutAt(result.value.emailOptOutAt);
			}
			return result;
		}
		if (scope.kind === "meeting") return readMeetingHistory(scope.meetingId, cursor ?? undefined);
		return readHistory({
			limit: 50,
			...(cursor ? { cursor } : {}),
			...(filters.query.trim() ? { query: filters.query.trim() } : {}),
			...(filters.state !== "any" ? { state: filters.state } : {}),
			...(filters.channel !== "any" ? { channel: filters.channel } : {}),
		});
	};

	const filtered = filters.query.trim() !== "" || filters.state !== "any" || filters.channel !== "any";
	const emptyTitle =
		scope.kind === "person"
			? "No email for this person"
			: scope.kind === "meeting"
				? "No email for this meeting"
				: filtered
					? "No messages match"
					: "No messages yet";
	const emptyBody =
		scope.kind === "person"
			? "Email sent to this person is listed here. A typed contact stays in the log above."
			: scope.kind === "meeting"
				? "Email linked to this meeting is listed here."
				: filtered
					? "Change the filters, or write a new message."
					: "A message you write appears here once you save it.";

	return (
		<div className="flex flex-col gap-4">
			<p className="text-sm text-text-3">Times use the clock on this device.</p>
			{scope.kind === "hub" ? (
				<div className="grid gap-4 md:grid-cols-3">
					<Field label="Subject or message">
						<Input value={query} placeholder="Launch Sunday" onChange={(event) => setQuery(event.target.value)} />
					</Field>
					<Field label="Status">
						<Select
							value={filters.state}
							onValueChange={(state) => setFilters((current) => ({ ...current, state }))}
							options={[
								{ value: "any", label: "Any status" },
								...hubStates.map((state) => ({ value: state, label: hubLabel[state] })),
							]}
						/>
					</Field>
					<Field label="Channel">
						<Select
							value={filters.channel}
							onValueChange={(channel) => setFilters((current) => ({ ...current, channel }))}
							options={[
								{ value: "any", label: "Any recorded channel" },
								{ value: "email", label: "Email" },
							]}
						/>
					</Field>
				</div>
			) : keepScope ? null : (
				<Button
					variant="ghost"
					onClick={() => {
						setScope({ kind: "hub" });
						setScopeNote(null);
						setContacts(null);
						setTracking(null);
					}}
				>
					All messages
				</Button>
			)}
			{scope.kind === "hub" && filtered ? (
				<Button
					variant="ghost"
					onClick={() => {
						setQuery("");
						setFilters(emptyFilters);
					}}
				>
					Clear filters
				</Button>
			) : null}
			{scopeNote ? (
				<p role="alert" className="text-sm font-medium text-magenta-600">
					{scopeNote}
				</p>
			) : null}
			<Browser
				key={reloadKey}
				canWrite={canWrite}
				selected={openId}
				onSelected={choose}
				onCompose={onCompose}
				onNew={onNew}
				churchName={churchName}
				origin={origin}
				banner={banner}
				title={
					scope.kind === "person"
						? "This person's email"
						: scope.kind === "meeting"
							? "This meeting's email"
							: "History"
				}
				intro={
					scope.kind === "person"
						? "Email for this person. The contact log above is separate from delivery."
						: scope.kind === "meeting"
							? "Email linked to this meeting, with recipient tracking above."
							: "Filter the church message history. Open a row for recipient results."
				}
				emptyTitle={emptyTitle}
				emptyBody={emptyBody}
				load={load}
				onOpen={onOpen}
				onPerson={(id) => {
					setScope({ kind: "person", personId: id });
					setScopeNote(null);
					setContacts(null);
					setTracking(null);
				}}
				onMeeting={(id) => {
					setScope({ kind: "meeting", meetingId: id });
					setScopeNote(null);
					setContacts(null);
					setTracking(null);
				}}
				keepScope={keepScope}
				header={
					scope.kind === "person" && contacts ? (
						<div className="flex flex-col gap-4">
							{optOutAt ? <OptOutNote at={optOutAt} churchName={churchName} /> : null}
							<ContactLog contacts={contacts} lastConfirmedContactAt={lastContact} />
						</div>
					) : scope.kind === "meeting" && tracking ? (
						<div className="flex flex-col gap-3">
							<h2 className="text-sm font-medium text-ink-2">Recipient tracking</h2>
							{tracking.length === 0 ? (
								<p className="text-sm text-text-2">No recipient tracking for this meeting.</p>
							) : (
								<ul className="flex flex-col gap-2">
									{tracking.map((row) => (
										<li key={row.personId} className="flex flex-wrap items-baseline justify-between gap-2">
											<span className="font-medium text-ink">{row.name}</span>
											<span className="text-sm text-text-2">{deliveryName(row.deliveryStatus)}</span>
										</li>
									))}
								</ul>
							)}
						</div>
					) : null
				}
			/>
		</div>
	);
}
