"use client";
import type { Outcome } from "@everyfield/contracts/common";

import { Mail01Icon } from "@hugeicons/core-free-icons";
import { Button, ConfirmDialog, EmptyState, Field, Input, Select } from "@everyfield/ui/controls";
import { useMinuteClock } from "@everyfield/ui/foundations";
import { useState, type ReactNode } from "react";
import { currentAddress } from "../../components/location.ts";
import { createRead, useRead } from "../../components/read.tsx";
import { useLocalStore, useStore } from "../../components/store.ts";
import {
	cancelScheduled,
	reconcileDelivery,
	replaceScheduled,
	rescheduleDispatched,
	saveResend,
	sendReviewed,
} from "./actions.ts";
import {
	openMessage,
	readDraft,
	readHistory,
	readMeetingHistory,
	readMeetingTracking,
	readPersonHistory,
	reviewResend,
} from "./fetch.ts";
import { MailingAddressPrompt } from "./MailingAddressPrompt.tsx";
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
	type PersonHistory,
	type ResendReview,
	type TrackingRow,
} from "./model.ts";
import { plural } from "./composeModel.ts";
import { pickSampleName } from "./fields.ts";
import { insideWindow, windowBounds } from "./scheduleWindow.ts";
import { createHistoryStore } from "./HistoryPanel.store.ts";
import { useKeys } from "./useKeys.ts";
import { READ_FAILED } from "../../components/read-failed.ts";
import type { ReadFailure } from "../../components/get-reads.ts";

type PersonName = { id: string; displayName: string; email: string | null };

function problem(result: Outcome<unknown> | ReadFailure): string {
	if (result.status === "failed") return READ_FAILED;
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

export type ListQuery =
	| { kind: "hub"; query: string; state: string; channel: string }
	| { kind: "person"; personId: string }
	| { kind: "meeting"; meetingId: string };

type MoreItems = { items: HistoryItem[]; page: HistoryPage };

const lost = <T,>(): Outcome<T> => ({ status: "lost" });

function loadPage(list: ListQuery, cursor: string | null): Promise<Outcome<HistoryPage | PersonHistory> | ReadFailure> {
	if (list.kind === "person") return readPersonHistory(list.personId, cursor ?? undefined);
	if (list.kind === "meeting") return readMeetingHistory(list.meetingId, cursor ?? undefined);
	return readHistory({
		limit: 50,
		...(cursor ? { cursor } : {}),
		...(list.query.trim() ? { query: list.query.trim() } : {}),
		...(list.state !== "any" ? { state: list.state } : {}),
		...(list.channel !== "any" ? { channel: list.channel } : {}),
	});
}

const firstPages = createRead((list: ListQuery) => loadPage(list, null), {
	failed: lost<HistoryPage | PersonHistory>,
});
const messages = createRead((id: string) => openMessage(id), { failed: lost<MessageView> });
const meetingTrackings = createRead((meetingId: string) => readMeetingTracking(meetingId), {
	failed: lost<{ items: TrackingRow[] }>,
});

const patchItems = (items: HistoryItem[], id: string, view: MessageView) =>
	items.map((item) =>
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
	);

function useHistory(list: ListQuery) {
	const first = useRead(firstPages, list);
	const [more, setMore] = useState<MoreItems | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);
	const [moreError, setMoreError] = useState<string | null>(null);
	const listPending = first.value === undefined || first.status === "loading";
	const firstPage = first.value?.status === "ok" ? first.value.value : null;
	const items = listPending && !firstPage ? [] : [...(firstPage?.items ?? []), ...(more?.items ?? [])];
	const page = more?.page ?? firstPage;
	const error = listPending ? null : first.value && first.value.status !== "ok" ? problem(first.value) : moreError;
	const pending = listPending ? ("list" as const) : loadingMore ? ("more" as const) : null;

	const loadMore = () => {
		if (!page?.nextCursor || pending) return;
		const cursor = page.nextCursor;
		setLoadingMore(true);
		void loadPage(list, cursor)
			.catch(lost<HistoryPage>)
			.then((result) => {
				setLoadingMore(false);
				if (result.status !== "ok") {
					setMoreError(problem(result));
					return;
				}
				setMoreError(null);
				setMore((current) => ({ items: [...(current?.items ?? []), ...result.value.items], page: result.value }));
			});
	};

	const reload = () => {
		setMore(null);
		setMoreError(null);
		first.reload();
	};

	const patch = (id: string, view: MessageView) => {
		firstPages.patch(
			(current) =>
				current.status === "ok"
					? { ...current, value: { ...current.value, items: patchItems(current.value.items, id, view) } }
					: current,
			list,
		);
		setMore((current) => current && { ...current, items: patchItems(current.items, id, view) });
	};

	return { items, page, error, pending, more: loadMore, reload, patch };
}

const stateTone: Record<HubState, string> = {
	draft: "bg-surface-2 text-text-2",
	scheduled: "bg-amber-100 text-amber-600",
	held: "bg-magenta-50 text-magenta-600",
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
			className="flex min-h-[72px] w-full flex-col items-start gap-1 rounded-md px-3 py-2.5 text-left hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ef-focus)] aria-[current=true]:bg-surface-2"
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

const handoffCounts = (totals: MessageView["totals"]) =>
	`Accepted ${totals.accepted}. Refused ${totals.failed}. No answer ${totals.unknown}.${unsubscribedNote(totals.unsubscribed)}`;

function heldStatus(view: MessageView): { title: string; body: string } {
	const { totals, detail } = view;
	const went = sentNote(totals.sent);
	switch (totals.state) {
		case "scheduled":
			return {
				title: `Scheduled for ${when(detail.scheduledAt)}`,
				body: `It goes to ${plural(totals.reachable, "person", "people")} then. Anyone who unsubscribes before then gets nothing.${unsubscribedNote(totals.unsubscribed)}`,
			};
		case "held":
			return {
				title: "Held: no mailing address",
				body: `It was due ${when(detail.scheduledAt)} and has not gone out. Add your church's mailing address in Church profile and it goes out within a minute. You can also cancel it.`,
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
	const now = useMinuteClock();
	const bounds = now === null ? null : windowBounds(new Date(now));
	const busy = actions.pending !== null;
	const state = view.totals.state;
	const status = heldStatus(view);
	const requestedAt = view.detail.requestedAt;
	const held = state === "scheduled" || state === "time_unconfirmed" || state === "held";
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
			{state === "held" ? (
				<MailingAddressPrompt>
					Every email from this church shows its mailing address at the bottom. This one waits until the address is set.
				</MailingAddressPrompt>
			) : null}
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
			{(held && state !== "held") || state === "not_scheduled" ? (
				<div className="flex flex-wrap items-end gap-3">
					<Field label="Change send time" hint="From now through the next 30 days." error={error}>
						<Input
							type="datetime-local"
							value={when_}
							min={bounds?.min}
							max={bounds?.max}
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
	mailingAddress,
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
	mailingAddress: string | null;
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
	const sample = pickSampleName(detail.communicationId);
	const as = named[Math.min(shownAs, Math.max(0, named.length - 1))]?.name ?? sample;
	const totals = view.totals;
	const heldStates: HubState[] = ["scheduled", "held", "time_unconfirmed", "cancel_unconfirmed"];
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
					input={{
						bodyHtml: detail.bodyHtml,
						name: as,
						hasMeeting: detail.meetingId !== null,
						origin,
						churchName,
						mailingAddress,
					}}
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
	list: ListQuery;
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
	mailingAddress: string | null;
	origin: string;
	banner?: string | null;
};

function Browser({
	canWrite,
	title,
	intro,
	emptyTitle,
	emptyBody,
	list,
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
	mailingAddress,
	origin,
	banner,
}: BrowserProps) {
	const history = useHistory(list);
	const keys = useKeys();
	const opened = useRead(selected ? messages : null, selected ?? "");
	const [acting, setActing] = useState<string | null>(null);
	const [reviewed, setReviewed] = useState<{ id: string; review: ResendReview | null; error: string | null } | null>(
		null,
	);
	const [confirm, setConfirm] = useState<null | "follow-up" | "send" | "cancel">(null);
	const [noticed, setNoticed] = useState<{ id: string; notice: Notice } | null>(null);

	const openedView = opened.value?.status === "ok" ? opened.value.value : null;
	const followUp = openedView !== null && openedView.detail.state === "reviewed" && onCompose !== undefined;
	const view = followUp ? null : openedView;
	const detailError = opened.value && opened.value.status !== "ok" ? problem(opened.value) : null;
	const opening = selected !== null && (opened.value === undefined || followUp);
	const detailPending = acting ?? (opening ? "open" : null);
	const review = reviewed && reviewed.id === selected ? reviewed.review : null;
	const reviewError = reviewed && reviewed.id === selected ? reviewed.error : null;
	const notice = noticed && noticed.id === selected ? noticed.notice : null;
	const setNotice = (id: string, next: Notice | null) => setNoticed(next ? { id, notice: next } : null);

	const count = (state: HubState) => history.items.filter((item) => item.state === state).length;

	const select = (item: HistoryItem) => {
		if (item.state === "draft" && onCompose && canWrite) {
			onCompose(item.id, "write", false);
			return;
		}
		setNoticed(null);
		onSelected(item.id);
		if (!onCompose) return;
		void messages.get(item.id).then((result) => {
			const shown = new URL(currentAddress(), window.location.origin).searchParams.get("message");
			if (result.status === "ok" && result.value.detail.state === "reviewed" && shown === item.id)
				onCompose(item.id, "review", true);
		});
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
		const fresh = await openMessage(id).catch(lost<MessageView>);
		if (fresh.status !== "ok") return;
		messages.patch(() => fresh, id);
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
		setNotice(id, null);
		try {
			const result = await call().catch(lost<T>);
			keys.settle(name, result);
			if (result.status !== "ok") {
				setNotice(id, { text: outcomeText(result) ?? "Unable to finish. Try again.", tone: "alert" });
				return;
			}
			setNotice(id, text(result.value));
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
							mailingAddress={mailingAddress}
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
					setNotice(id, {
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
					setNotice(id, {
						text: cancelText(result.value),
						tone: result.value.scheduledCancel === "reconcile" ? "alert" : "status",
					});
					await refresh(id);
				}}
			/>
		</div>
	);
}

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
	mailingAddress,
	origin,
	banner = null,
}: {
	canWrite: boolean;
	personId: string | null;
	meetingId: string | null;
	onOpen: (draft: Draft, people: PersonName[]) => void;
	keepScope?: boolean;
	selected?: string | null;
	onSelected?: (id: string | null) => void;
	onCompose?: (id: string, step: "write" | "review", replace: boolean) => void;
	onNew?: () => void;
	churchName: string;
	mailingAddress: string | null;
	origin: string;
	banner?: string | null;
}) {
	const store = useLocalStore(() =>
		createHistoryStore({
			scope: personId ? { kind: "person", personId } : meetingId ? { kind: "meeting", meetingId } : { kind: "hub" },
		}),
	);
	const { scope, filters, query, ownSelected, actions } = useStore(store, (state) => state);
	const openId = selected === undefined ? ownSelected : selected;
	const choose = onSelected ?? actions.choose;
	const list: ListQuery =
		scope.kind === "hub"
			? { kind: "hub", query: filters.query, state: filters.state, channel: filters.channel }
			: scope;
	const first = useRead(firstPages, list);
	const personPage =
		scope.kind === "person" && first.value?.status === "ok" ? (first.value.value as PersonHistory) : null;
	const tracked = useRead(
		scope.kind === "meeting" ? meetingTrackings : null,
		scope.kind === "meeting" ? scope.meetingId : "",
	);
	const tracking = tracked.value?.status === "ok" ? tracked.value.value.items : null;
	const scopeNote = tracked.value && tracked.value.status !== "ok" ? problem(tracked.value) : null;

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
						<Input value={query} placeholder="Launch Sunday" onChange={(event) => actions.type(event.target.value)} />
					</Field>
					<Field label="Status">
						<Select
							value={filters.state}
							onValueChange={(state) => actions.filter({ state })}
							options={[
								{ value: "any", label: "Any status" },
								...hubStates.map((state) => ({ value: state, label: hubLabel[state] })),
							]}
						/>
					</Field>
					<Field label="Channel">
						<Select
							value={filters.channel}
							onValueChange={(channel) => actions.filter({ channel })}
							options={[
								{ value: "any", label: "Any recorded channel" },
								{ value: "email", label: "Email" },
							]}
						/>
					</Field>
				</div>
			) : keepScope ? null : (
				<Button variant="ghost" onClick={() => actions.show({ kind: "hub" })}>
					All messages
				</Button>
			)}
			{scope.kind === "hub" && filtered ? (
				<Button variant="ghost" onClick={actions.clear}>
					Clear filters
				</Button>
			) : null}
			{scopeNote ? (
				<p role="alert" className="text-sm font-medium text-magenta-600">
					{scopeNote}
				</p>
			) : null}
			<Browser
				key={firstPages.key(list)}
				canWrite={canWrite}
				selected={openId}
				onSelected={choose}
				onCompose={onCompose}
				onNew={onNew}
				churchName={churchName}
				mailingAddress={mailingAddress}
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
				list={list}
				onOpen={onOpen}
				onPerson={(id) => actions.show({ kind: "person", personId: id })}
				onMeeting={(id) => actions.show({ kind: "meeting", meetingId: id })}
				keepScope={keepScope}
				header={
					personPage ? (
						<div className="flex flex-col gap-4">
							{personPage.emailOptOutAt ? <OptOutNote at={personPage.emailOptOutAt} churchName={churchName} /> : null}
							<ContactLog contacts={personPage.contacts} lastConfirmedContactAt={personPage.lastConfirmedContactAt} />
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
