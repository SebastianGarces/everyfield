"use client";

import { Mail01Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	ConfirmDialog,
	EmptyState,
	Field,
	Input,
	Select,
} from "@everyfield/ui/controls";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
	openMessage,
	readDraft,
	readHistory,
	readMeetingHistory,
	readMeetingTracking,
	readPersonHistory,
	reviewResend,
	saveResend,
} from "./actions.ts";
import {
	contactLabel,
	hubLabel,
	hubStates,
	outcomeText,
	rateText,
	type ContactRow,
	type DetailRecipient,
	type Draft,
	type HistoryItem,
	type HistoryPage,
	type MessageView,
	type Outcome,
	type ResendReview,
	type TrackingRow,
} from "./model.ts";

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

function when(iso: string | null): string {
	if (!iso) return "Not recorded";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function listed(items: string[], max = 8): string {
	if (items.length === 0) return "None";
	if (items.length <= max) return items.join(", ");
	return `${items.slice(0, max).join(", ")}, and ${items.length - max} more`;
}

function deliveryName(status: string): string {
	const labels: Record<string, string> = {
		delivered: "Delivered",
		sent: "Sent",
		accepted: "Accepted",
		dispatched: "Sending",
		pending: "Waiting",
		scheduled: "Scheduled",
		refused: "Refused",
		failed: "Failed",
		cancelled: "Cancelled",
		unknown: "Unknown",
	};
	return labels[status] ?? status;
}

function recordLabel(state: Draft["state"]): string {
	if (state === "draft") return "Draft";
	if (state === "reviewed") return "Reviewed";
	return "Scheduled";
}

function useKeys() {
	const keys = useRef<Record<string, string>>({});
	return {
		take(name: string) {
			return (keys.current[name] ??= crypto.randomUUID());
		},
		settle(name: string, result: Outcome<unknown>) {
			if (result.status !== "lost") keys.current[name] = crypto.randomUUID();
		},
	};
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

	return { items, page, error, pending, more, reload };
}

function MessageButton({
	item,
	selected,
	onSelect,
}: {
	item: HistoryItem;
	selected: boolean;
	onSelect: (id: string) => void;
}) {
	const reached =
		item.rate === null ? "No reachable recipients" : `${item.delivered} delivered of ${item.reachable} reachable`;
	return (
		<button
			type="button"
			aria-current={selected ? "true" : undefined}
			onClick={() => onSelect(item.id)}
			className="flex min-h-11 w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ef-focus)] aria-[current=true]:bg-surface-2"
		>
			<span className="w-full truncate font-medium text-ink">{item.subject?.trim() || "No subject"}</span>
			<span className="text-sm text-text-3">
				{hubLabel[item.state]} · Email · {when(item.createdAt)}
			</span>
			<span className="text-sm text-text-3">{reached}</span>
		</button>
	);
}

function Totals({ view }: { view: MessageView }) {
	const totals = view.totals;
	const groups: { title: string; rows: { label: string; value: number }[] }[] = [
		{
			title: "Delivery",
			rows: [
				{ label: "Selected", value: totals.selected },
				{ label: "Reachable", value: totals.reachable },
				{ label: "Attempted", value: totals.attempted },
				{ label: "Accepted", value: totals.accepted },
				{ label: "Sent", value: totals.sent },
				{ label: "Delivered", value: totals.delivered },
			],
		},
		{
			title: "Engagement",
			rows: [
				{ label: "Opened", value: totals.opened },
				{ label: "Clicked", value: totals.clicked },
			],
		},
		{
			title: "Not delivered",
			rows: [
				{ label: "Bounced", value: totals.bounced },
				{ label: "Failed", value: totals.failed },
				{ label: "Suppressed", value: totals.suppressed },
				{ label: "Unknown", value: totals.unknown },
			],
		},
	];
	return (
		<div className="flex flex-col gap-6">
			<p className="text-sm text-text-2">Counts as of {when(totals.asOf)}. A draft or an unknown result is not sent.</p>
			{groups.map((group) => (
				<div key={group.title} className="flex flex-col gap-3">
					<h3 className="text-sm font-medium text-ink-2">{group.title}</h3>
					<dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
						{group.rows.map((row) => (
							<div key={row.label}>
								<dt className="text-sm text-text-3">{row.label}</dt>
								<dd className="text-md font-medium text-ink tabular-nums">{row.value}</dd>
							</div>
						))}
					</dl>
				</div>
			))}
			<p className="text-sm text-text-2">{rateText(totals.delivered, totals.reachable, totals.rate)}</p>
			<p className="text-sm text-text-2">An open and a click stay separate. Neither one is a typed contact.</p>
			{totals.unknown > 0 ? (
				<p className="text-sm text-text-2">Some recipients have no result yet. Unknown is not delivered.</p>
			) : null}
			<p className="text-sm text-text-2">
				{totals.sentForAll ? "Every recipient record is sent." : "Not every recipient record is sent."}
				{totals.outcomes.length > 0 ? ` Provider words: ${totals.outcomes.map(deliveryName).join(", ")}.` : ""}
			</p>
		</div>
	);
}

function AddressFact({ label, value }: { label: string; value: string | null }) {
	return (
		<p className="text-sm text-text-2">
			<span className="text-ink-2">{label}: </span>
			{value ?? "Not available"}
		</p>
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
	return (
		<div className="flex flex-col gap-8">
			<div className="flex flex-col gap-3">
				<p className="text-sm text-text-3">
					Record: {recordLabel(detail.state)} · Delivery: {hubLabel[view.totals.state]}
				</p>
				<h2 className="text-title-md text-balance text-ink">{detail.subject?.trim() || "No subject"}</h2>
				{detail.bodyText ? (
					<p className="text-md whitespace-pre-wrap text-ink">{detail.bodyText}</p>
				) : (
					<p className="text-sm text-text-2">The plain text of this message was not stored.</p>
				)}
				<p className="text-sm text-text-3">
					The subject and body above are the saved send. A later address change is separate.
				</p>
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
				{meetingId ? (
					<Button variant="ghost" onClick={() => onMeeting(meetingId)}>
						Show this meeting
					</Button>
				) : null}
			</div>
			<Totals view={view} />
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
									<p className="text-sm text-text-2">{deliveryName(row.deliveryStatus)}</p>
									<AddressFact label="Address at send" value={row.deliveryAddress} />
									<AddressFact label="Address now" value={row.currentPersonAddress} />
									<p className="text-sm text-text-3">
										Sent {when(row.sentAt)} · Delivered {when(row.deliveredAt)} · Opened {when(row.openedAt)} · Clicked{" "}
										{when(row.clickedAt)}
									</p>
									{personId ? (
										<Button variant="ghost" onClick={() => onPerson(personId)}>
											Show this person
										</Button>
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
					<Button
						variant="secondary"
						onClick={onReview}
						loading={pending === "review"}
						disabled={pending !== null && pending !== "review"}
					>
						Review follow-up
					</Button>
					{reviewError ? (
						<p role="alert" className="text-sm font-medium text-magenta-600">
							{reviewError}
						</p>
					) : null}
					{review ? (
						<div className="flex flex-col gap-2 text-sm text-text-2">
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
}: {
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
}) {
	const history = useHistory(load);
	const keys = useKeys();
	const [selected, setSelected] = useState<string | null>(null);
	const [view, setView] = useState<MessageView | null>(null);
	const [detailError, setDetailError] = useState<string | null>(null);
	const [detailPending, setDetailPending] = useState<string | null>(null);
	const [review, setReview] = useState<ResendReview | null>(null);
	const [reviewError, setReviewError] = useState<string | null>(null);
	const [confirm, setConfirm] = useState(false);
	const openSeq = useRef(0);

	const delivered = history.items.reduce((sum, item) => sum + item.delivered, 0);
	const reachable = history.items.reduce((sum, item) => sum + item.reachable, 0);

	const open = (id: string) => {
		const token = ++openSeq.current;
		setSelected(id);
		setView(null);
		setReview(null);
		setReviewError(null);
		setDetailError(null);
		setDetailPending("open");
		void openMessage(id)
			.then((result) => {
				if (token !== openSeq.current) return;
				setDetailPending(null);
				if (result.status !== "ok") {
					setDetailError(problem(result));
					return;
				}
				setView(result.value);
			})
			.catch(() => {
				if (token !== openSeq.current) return;
				setDetailPending(null);
				setDetailError("Unable to reach the church records. Try again in a moment.");
			});
	};

	const onReview = () => {
		if (!selected || detailPending) return;
		const token = openSeq.current;
		const id = selected;
		setDetailPending("review");
		setReviewError(null);
		void reviewResend(id)
			.then((result) => {
				if (token !== openSeq.current) return;
				if (result.status !== "ok") {
					setReviewError(problem(result));
					return;
				}
				setReview(result.value);
			})
			.catch(() => {
				if (token !== openSeq.current) return;
				setReviewError("Unable to reach the church records. Try again in a moment.");
			})
			.finally(() => {
				if (token !== openSeq.current) return;
				setDetailPending(null);
			});
	};

	return (
		<div className="flex flex-col gap-6">
			{header}
			<div className="grid items-start gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
				<Card as="section" className="flex min-w-0 flex-col gap-4">
					<CardHeader>
						<CardHeading>
							<CardTitle>{title}</CardTitle>
							<CardDescription>{intro}</CardDescription>
						</CardHeading>
					</CardHeader>
					{history.pending === "list" ? (
						<p role="status" className="text-sm text-text-2">
							Loading history.
						</p>
					) : null}
					{history.error ? (
						<div className="flex flex-col items-start gap-3">
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
						</EmptyState>
					) : null}
					{history.items.length > 0 ? (
						<ul className="flex flex-col gap-1">
							{history.items.map((item) => (
								<li key={item.id}>
									<MessageButton item={item} selected={item.id === selected} onSelect={open} />
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
					{history.items.length > 0 ? (
						<p role="status" className="text-sm text-text-3">
							{history.items.length === 1 ? "1 message shown." : `${history.items.length} messages shown.`}{" "}
							{rateText(delivered, reachable, reachable > 0 ? delivered / reachable : null)}
							{history.page ? ` Counts as of ${when(history.page.asOf)}.` : ""}
						</p>
					) : null}
				</Card>
				<Card as="section" aria-live="polite" className="flex min-w-0 flex-col gap-5">
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
							onConfirm={() => setConfirm(true)}
							onPerson={onPerson}
							onMeeting={onMeeting}
						/>
					) : detailPending === "open" || detailError ? null : (
						<EmptyState icon={Mail01Icon} title="Choose a message">
							The saved subject, the address at send, and each recipient result open here.
						</EmptyState>
					)}
				</Card>
			</div>
			<ConfirmDialog
				open={confirm}
				onOpenChange={setConfirm}
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
						setReviewError(`${problem(fresh)} The follow-up was saved. Reload Messages, then open it from Compose.`);
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
}: {
	canWrite: boolean;
	personId: string | null;
	meetingId: string | null;
	onOpen: (draft: Draft, people: PersonName[]) => void;
}) {
	const [scope, setScope] = useState<Scope>(
		personId ? { kind: "person", personId } : meetingId ? { kind: "meeting", meetingId } : { kind: "hub" },
	);
	const [filters, setFilters] = useState<Filters>(emptyFilters);
	const [query, setQuery] = useState("");
	const [contacts, setContacts] = useState<ContactRow[] | null>(null);
	const [lastContact, setLastContact] = useState<string | null>(null);
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
					? "Change the filters, or write a message from Compose."
					: "Write a message from Compose. It appears here after you save it.";

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
			) : (
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
				header={
					scope.kind === "person" && contacts ? (
						<ContactLog contacts={contacts} lastConfirmedContactAt={lastContact} />
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
