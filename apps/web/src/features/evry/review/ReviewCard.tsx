"use client";

import {
	Alert02Icon,
	ArrowRight02Icon,
	Cancel01Icon,
	CheckmarkCircle02Icon,
	Clock01Icon,
	Edit02Icon,
	SquareLock02Icon,
	Tick02Icon,
	UserAdd01Icon,
} from "@hugeicons/core-free-icons";
import { Button, Field, Input, IntentLink, Select, Spinner, Textarea } from "@everyfield/ui/controls";
import { Avatar, StageChip } from "@everyfield/ui/display";
import { cn, Icon, type IconSvgElement } from "@everyfield/ui/foundations";
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react";
import { STAGE_KEY, type StageValue } from "../../people/model.ts";
import type { Reply } from "../conversation/api.ts";
import * as api from "./api.ts";
import {
	actionNotice,
	CHOICES,
	clock,
	consequence,
	editableChanges,
	fieldKind,
	fieldLabel,
	isRequired,
	missingRequired,
	operationTitle,
	phaseOf,
	pollDelay,
	refusalText,
	retryable,
	reviseInput,
	shownChanges,
	valueText,
	type Change,
	type Phase,
	type Review,
} from "./model.ts";

// The Evry review card (WP-053/ui; design/everyfield-ui.html, Evry panel review cards): exactly what a prepared change
// will do, before and after, and who it affects. The owner approves the exact revision, revises a value or cancels.
// An approved change runs once in the background; the card follows it to its saved outcome and says plainly when it
// was refused, expired or closed. Nothing changes in People until the owner approves.

type Action = "approve" | "revise" | "cancel" | "retry";
type Notice = { text: string; tone: "error" | "neutral" };
/** What the card shows: the review's phase, or why there is no review to show. */
type View = Phase | "loading" | "lost" | "unavailable";

function useReview(proposalId: string) {
	const [review, setReview] = useState<Review | null>(null);
	const [load, setLoad] = useState<"loading" | "ready" | "lost" | "unavailable">("loading");
	const [busy, setBusy] = useState<Action | null>(null);
	const [notice, setNotice] = useState<Notice | null>(null);
	const [now, setNow] = useState(() => Date.now());
	// Every action takes a new generation; a read that started before it is dropped when it answers late.
	const generation = useRef(0);
	const inFlight = useRef(false);
	const show = (next: Review) => {
		setReview(next);
		setLoad("ready");
		setNow(Date.now());
	};
	/** The review refused to load: access ended or changed. Its content is not shown again. */
	const gone = () => {
		setLoad("unavailable");
		setNotice(null);
	};
	const read = async () => {
		const g = generation.current;
		const reply = await api.readReview(proposalId);
		if (g !== generation.current) return null;
		if (reply.status === "ok") show(reply.value);
		else if (reply.status === "refused") gone();
		return reply;
	};

	useEffect(() => {
		let live = true;
		void api.readReview(proposalId).then((reply) => {
			if (!live) return;
			if (reply.status === "ok") show(reply.value);
			else setLoad(reply.status === "refused" ? "unavailable" : "lost");
		});
		return () => {
			live = false;
		};
	}, [proposalId]);

	const view: View = load === "ready" && review ? phaseOf(review, now) : load === "ready" ? "loading" : load;

	// The clock only matters at the expiry: one timer flips a pending review to expired, with no request.
	useEffect(() => {
		if (!review) return;
		const left = Date.parse(review.expiresAt) - Date.now();
		if (left <= 0) return;
		const t = setTimeout(() => setNow(Date.now()), Math.min(left + 50, 2 ** 31 - 1));
		return () => clearTimeout(t);
	}, [review]);

	// A running change is read again, quickly at first, until its outcome is saved. A refusal means access ended.
	useEffect(() => {
		if (view !== "running" || busy) return;
		let attempt = 0;
		let live = true;
		let t: ReturnType<typeof setTimeout>;
		const next = () => {
			t = setTimeout(async () => {
				const reply = await read();
				if (live && reply?.status !== "refused") next();
			}, pollDelay(attempt++));
		};
		next();
		return () => {
			live = false;
			clearTimeout(t);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- one poll loop while this revision runs
	}, [view, busy]);

	/**
	 * Runs one action at a time. A reply that arrives is final. After a refusal or a lost reply the review is read once
	 * to show what is true now, and `done` says whether that is what the action wanted: an approval that committed but
	 * whose reply was lost shows as approved, never as "not approved".
	 */
	async function act<T>(
		action: Action,
		send: (review: Review) => Promise<Reply<T>>,
		result: (value: T) => Review,
		done: (now: Review, before: Review) => boolean,
		settled: (now: Review) => Notice | null = () => null,
	) {
		// A ref, not state: three clicks in one frame all see the same render, and only the first may send.
		if (inFlight.current || !review) return false;
		inFlight.current = true;
		const before = review;
		setBusy(action);
		setNotice(null);
		const g = ++generation.current;
		const reply = await send(before);
		let current: Review | null = reply.status === "ok" ? result(reply.value) : null;
		let refused = false;
		if (reply.status !== "ok") {
			const reread = await api.readReview(before.id);
			if (reread.status === "ok") current = reread.value;
			refused = reread.status === "refused";
		}
		inFlight.current = false;
		if (g !== generation.current) return false;
		setBusy(null);
		if (refused) {
			gone();
			return false;
		}
		if (current) show(current);
		if (current && (reply.status === "ok" || done(current, before))) {
			setNotice(settled(current));
			return true;
		}
		// An expired or closed review says so in its own state; only a changed review or an unknown result needs words.
		const code = reply.status === "refused" ? reply.error.code : null;
		if (current && (code === "review_expired" || code === "review_closed")) return false;
		setNotice({ text: actionNotice(reply.status === "refused" ? reply.error : "lost"), tone: "error" });
		return false;
	}

	return {
		review,
		view,
		busy,
		notice,
		now,
		reload: () => {
			setLoad("loading");
			void read().then((reply) => reply?.status === "lost" && setLoad("lost"));
		},
		approve: () =>
			act(
				"approve",
				// The witness is the request key: the same revision and digest, however often it is sent.
				(r) => api.approve(r),
				(v) => v.proposal,
				(now, before) => now.revision === before.revision && now.status === "approved",
			),
		cancel: () =>
			act(
				"cancel",
				(r) => api.cancel(r.id),
				(v) => v.proposal,
				(now) => now.status === "cancelled" || now.outcome !== null || now.executing,
				(now) =>
					now.outcome === "completed"
						? { text: "This change was already saved, so it can't be cancelled.", tone: "neutral" }
						: now.status !== "cancelled" && now.executing
							? { text: "This change is already running. The card shows its result.", tone: "neutral" }
							: null,
			),
		revise: (edits?: Record<string, string>) =>
			act(
				"revise",
				(r) => api.revise(r.id, r.operation, r.revision, reviseInput(r, edits)),
				(v) => v,
				(now, before) => now.revision > before.revision,
			),
		retry: () =>
			act(
				"retry",
				(r) => api.retry(r.id),
				(v) => v.proposal,
				(now) => now.outcome === null || now.outcome === "completed",
			),
		clearNotice: () => setNotice(null),
	};
}

// ---------------------------------------------------------------------------------------------------------------

type Tone = "amber" | "green" | "magenta" | "gray";
const HEAD: Record<Exclude<View, "loading" | "lost">, { icon: IconSvgElement; title: string; tone: Tone }> = {
	pending: { icon: Edit02Icon, title: "Review before saving", tone: "amber" },
	running: { icon: Edit02Icon, title: "Saving…", tone: "amber" },
	completed: { icon: CheckmarkCircle02Icon, title: "Saved", tone: "green" },
	refused: { icon: Alert02Icon, title: "Not saved", tone: "magenta" },
	failed: { icon: Alert02Icon, title: "Not saved", tone: "magenta" },
	unconfirmed: { icon: Alert02Icon, title: "Not confirmed", tone: "magenta" },
	expired: { icon: Clock01Icon, title: "Expired", tone: "gray" },
	cancelled: { icon: Cancel01Icon, title: "Cancelled", tone: "gray" },
	withheld: { icon: SquareLock02Icon, title: "No longer available", tone: "gray" },
	unavailable: { icon: SquareLock02Icon, title: "Not available to you", tone: "gray" },
};
const HEAD_TONE: Record<Tone, string> = {
	amber: "bg-amber-50 text-amber-600 border-b-[color-mix(in_srgb,var(--ef-amber-500)_20%,transparent)]",
	green: "bg-green-50 text-green-700 border-b-[color-mix(in_srgb,var(--ef-green-500)_20%,transparent)]",
	magenta: "bg-magenta-50 text-magenta-600 border-b-[color-mix(in_srgb,var(--ef-magenta-500)_20%,transparent)]",
	gray: "bg-surface-2 text-text-2 border-b-line",
};

/** The note under the head: why the card is in this state, when that needs saying. Also what is announced. */
function note(view: View, review: Review | null, now: number): string | null {
	const who = review?.review.target?.label ?? null;
	switch (view) {
		case "pending":
			return review && review.revision > 1
				? `You revised this change. Only revision ${review.revision} can be approved.`
				: null;
		case "running":
			return "Saving in the background. You can keep working. This card shows the result.";
		case "refused":
			return refusalText(review?.receipt?.code, who);
		case "failed":
			return review && retryable(review, now)
				? "Saving failed and nothing was changed. Try again."
				: "Saving failed and nothing was changed. The approval expired, so ask Evry to prepare it again.";
		case "unconfirmed":
			return review && retryable(review, now)
				? "Evry can't confirm that this was saved. Try again. A change that was saved is not saved twice."
				: "Evry can't confirm that this was saved, and the approval expired. Open the person to check.";
		case "expired":
			return "This review expired, so nothing was changed. Prepare it again to check the current values.";
		case "cancelled":
			return "You cancelled this change. Nothing was changed.";
		case "withheld":
			return "The person in this change is no longer available to you. Nothing was changed.";
		case "unavailable":
			return "You can't review this change now. Changes to people need an Owner or Admin seat in this church. Nothing was changed.";
		default:
			return null;
	}
}

/** What a screen reader hears when the card changes after it loaded. */
function announcement(view: View, review: Review | null, now: number) {
	const head = view === "loading" || view === "lost" ? "" : HEAD[view].title.replace("…", "");
	if (view === "pending" && !(review && review.revision > 1)) return "";
	if (view === "running") return "Approved. Saving in the background.";
	if (view === "completed")
		return review?.review.target ? `Saved. ${review.review.target.label} is updated.` : "Saved.";
	return [head, note(view, review, now)].filter(Boolean).join(". ");
}

export function ReviewCard({ proposalId, target }: { proposalId: string; target: string | null }) {
	const r = useReview(proposalId);
	// The revision being revised: a new revision, or a change of state, closes the form on its own.
	const [editing, setEditing] = useState<number | null>(null);
	const headId = useId();
	const card = useRef<HTMLElement>(null);
	const head = useRef<HTMLHeadingElement>(null);
	const noticeRef = useRef<HTMLParagraphElement>(null);
	const reviseButton = useRef<HTMLButtonElement>(null);
	const focusInside = useRef(false);
	const { review, view, notice } = r;

	// A change of view after the card loaded is announced once (the previous-value pattern, no effect).
	const key = `${view}:${review?.revision ?? 0}`;
	const [seen, setSeen] = useState(key);
	const [announce, setAnnounce] = useState("");
	if (seen !== key) {
		setSeen(key);
		setAnnounce(seen.startsWith("loading") ? "" : announcement(view, review, r.now));
	}
	// Focus that was on a control the change removed goes to the card's head, so keyboard users stay in the card
	// (PR 197, finding F2).
	useLayoutEffect(() => {
		const active = document.activeElement;
		if (focusInside.current && (!active || active === document.body || !card.current?.contains(active)))
			head.current?.focus();
	}, [key]);
	useEffect(() => {
		if (notice?.tone === "error") noticeRef.current?.focus();
	}, [notice]);

	const why = note(view, review, r.now);
	const h = view === "loading" || view === "lost" ? HEAD.pending : HEAD[view];
	const title = view === "loading" || view === "lost" ? (target ? `Change for ${target}` : "Prepared change") : h.title;
	const meta =
		view === "completed" && review?.approvedAt
			? clock(review.approvedAt)
			: view === "pending" && review && review.revision > 1
				? `Revision ${review.revision}`
				: null;

	return (
		<section
			ref={card}
			data-proposal={proposalId}
			data-state={view}
			aria-labelledby={headId}
			aria-busy={view === "loading" || undefined}
			onFocus={() => (focusInside.current = true)}
			onBlur={(e) => {
				if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) focusInside.current = false;
			}}
			className="overflow-hidden rounded-card bg-surface-raised shadow-[inset_0_0_0_1px_var(--ef-line),var(--ef-shadow-raised)]"
		>
			<CardHead id={headId} ref={head} icon={h.icon} tone={h.tone} title={title} spinning={view === "running"}>
				{meta}
			</CardHead>
			{why ? <p className="bg-surface-2 px-4 py-2.5 text-sm text-text-2">{why}</p> : null}

			{view === "loading" ? (
				<p className="flex items-center gap-2 px-4 py-3.5 text-sm text-text-2">
					<Spinner size={16} /> Loading the review…
				</p>
			) : view === "lost" ? (
				<div className="flex flex-col items-start gap-3 px-4 py-3.5 text-sm text-text-2">
					<p>The review did not load. Check your connection, then try again. Nothing changes until you approve it.</p>
					<Button size="sm" variant="outline" onClick={r.reload}>
						Try again
					</Button>
				</div>
			) : view === "unavailable" || view === "withheld" || !review ? null : view === "pending" &&
			  editing === review.revision ? (
				<ReviseForm
					review={review}
					busy={r.busy === "revise"}
					notice={notice}
					noticeRef={noticeRef}
					onSubmit={(edits) => void r.revise(edits)}
					onClose={() => {
						setEditing(null);
						r.clearNotice();
						requestAnimationFrame(() => reviseButton.current?.focus());
					}}
				/>
			) : (
				<>
					<div
						className={cn(
							"flex flex-col gap-3 px-4 py-3.5",
							(view === "expired" || view === "cancelled") && "opacity-60",
						)}
					>
						<Affects review={review} />
						<Changes review={review} />
						{consequence(review) ? <p className="text-sm text-text-2">{consequence(review)}</p> : null}
						{view === "pending" ? (
							<p className="text-xs text-text-3">
								Nothing changes until you approve. Approve by {clock(review.expiresAt)}.
							</p>
						) : null}
					</div>
					{notice ? (
						<p
							ref={noticeRef}
							tabIndex={-1}
							className={cn(
								"mx-4 mb-3 rounded-md px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus",
								notice.tone === "error" ? "bg-magenta-50 text-magenta-600" : "bg-surface-2 text-text-2",
							)}
						>
							{notice.text}
						</p>
					) : null}
					<Footer
						view={view}
						review={review}
						r={r}
						reviseButton={reviseButton}
						onRevise={() => {
							r.clearNotice();
							setEditing(review.revision);
						}}
					/>
				</>
			)}
			<p role="status" className="sr-only">
				{announce}
			</p>
		</section>
	);
}

function Footer({
	view,
	review,
	r,
	reviseButton,
	onRevise,
}: {
	view: Phase;
	review: Review;
	r: ReturnType<typeof useReview>;
	reviseButton: Ref<HTMLButtonElement>;
	onRevise: () => void;
}) {
	const who = review.review.target;
	const other = (action: string) => r.busy !== null && r.busy !== action;
	const cancel = (
		<Button
			size="sm"
			variant="ghost"
			loading={r.busy === "cancel"}
			disabled={other("cancel")}
			onClick={() => void r.cancel()}
		>
			Cancel
		</Button>
	);
	let body: ReactNode = null;
	if (view === "pending")
		body = (
			<>
				<Button
					size="sm"
					variant="primary"
					icon={Tick02Icon}
					loading={r.busy === "approve"}
					disabled={other("approve")}
					onClick={() => void r.approve()}
				>
					Approve
				</Button>
				{editableChanges(review).length ? (
					<Button ref={reviseButton} size="sm" variant="secondary" disabled={r.busy !== null} onClick={onRevise}>
						Revise
					</Button>
				) : null}
				<span className="flex-1" />
				{cancel}
			</>
		);
	else if (view === "running")
		body = (
			<>
				<span className="flex-1 text-xs whitespace-nowrap text-text-3">Approved by you</span>
				{cancel}
			</>
		);
	else if (view === "completed")
		body = (
			<>
				<span className="flex-1 text-xs whitespace-nowrap text-text-3">Approved by you</span>
				{who && review.operation !== "people.deletePerson" && !review.review.withheld ? (
					<Button size="sm" variant="ghost" asChild>
						<IntentLink href={`/people/${who.id}`}>
							Open {who.label}
							<Icon icon={ArrowRight02Icon} size={16} />
						</IntentLink>
					</Button>
				) : null}
			</>
		);
	else if ((view === "failed" || view === "unconfirmed") && retryable(review, r.now))
		body = (
			<Button size="sm" variant="secondary" loading={r.busy === "retry"} onClick={() => void r.retry()}>
				Try again
			</Button>
		);
	else if (view === "expired" && review.outcome === null)
		body = (
			<Button size="sm" variant="secondary" loading={r.busy === "revise"} onClick={() => void r.revise()}>
				Prepare again
			</Button>
		);
	// Keyed by view: a control never turns into another one under the keyboard focus (Approve into Prepare again).
	return body ? (
		<div key={view} className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
			{body}
		</div>
	) : null;
}

function CardHead({
	id,
	ref,
	icon,
	title,
	tone,
	spinning,
	children,
}: {
	id: string;
	ref: Ref<HTMLHeadingElement>;
	icon: IconSvgElement;
	title: string;
	tone: Tone;
	spinning?: boolean;
	children?: ReactNode;
}) {
	return (
		<h3
			id={id}
			ref={ref}
			tabIndex={-1}
			className={cn(
				"flex items-center gap-2.5 border-b px-4 py-3 font-sans text-sm font-semibold tracking-normal outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset",
				HEAD_TONE[tone],
			)}
		>
			{spinning ? <Spinner size={16} /> : <Icon icon={icon} size={16} />}
			<span className="min-w-0 flex-1">{title}</span>
			{children ? <span className="font-medium tabular-nums">{children}</span> : null}
		</h3>
	);
}

/** Who the change affects: the person, or the new person a create adds. */
function Affects({ review }: { review: Review }) {
	const create = review.operation === "people.createPerson";
	const name = create
		? String(review.review.changes.find((c) => c.field === "displayName")?.after ?? "New person")
		: (review.review.target?.label ?? "Not available");
	return (
		<div className="flex items-center gap-3">
			{create ? (
				<span className="grid size-8 flex-none place-items-center rounded-full bg-surface-2 text-text-2">
					<Icon icon={UserAdd01Icon} size={16} />
				</span>
			) : (
				<Avatar name={name} size="sm" decorative />
			)}
			<span className="min-w-0">
				<span className="block truncate font-medium text-ink">{name}</span>
				<span className="block text-xs text-text-3">{operationTitle(review.operation)}</span>
			</span>
		</div>
	);
}

function Value({ field, value, before }: { field: string; value: unknown; before?: boolean }) {
	const text = valueText(field, value);
	if (text === null) return <span className="text-text-3 italic">Empty</span>;
	if (field === "stage" && typeof value === "string" && value in STAGE_KEY)
		return <StageChip stage={STAGE_KEY[value as StageValue]}>{text}</StageChip>;
	return <span className={cn("break-words", before ? "text-text-2" : "font-medium text-ink")}>{text}</span>;
}

/** Each changed field: its value now, then what it will be. A new person and a reason have no before. */
function Changes({ review }: { review: Review }) {
	const changes = shownChanges(review.review.changes);
	if (!changes.length) return null;
	const create = review.operation === "people.createPerson";
	return (
		<dl className="flex flex-col gap-2 rounded-md bg-surface-2 px-3 py-2.5 text-sm">
			{changes.map((c: Change) => (
				<div key={c.field} className="grid grid-cols-[minmax(88px,auto)_1fr] items-baseline gap-x-3">
					<dt className="text-text-2">{fieldLabel(c.field)}</dt>
					<dd className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
						{create || c.field === "reason" ? null : (
							<>
								<span className="sr-only">from </span>
								<Value field={c.field} value={c.before} before />
								<Icon icon={ArrowRight02Icon} size={16} className="text-text-3" />
								<span className="sr-only"> to </span>
							</>
						)}
						<Value field={c.field} value={c.after} />
					</dd>
				</div>
			))}
		</dl>
	);
}

function ReviseForm({
	review,
	busy,
	notice,
	noticeRef,
	onSubmit,
	onClose,
}: {
	review: Review;
	busy: boolean;
	notice: Notice | null;
	noticeRef: Ref<HTMLParagraphElement>;
	onSubmit: (edits: Record<string, string>) => void;
	onClose: () => void;
}) {
	const fields = editableChanges(review);
	const [edits, setEdits] = useState<Record<string, string>>(() =>
		Object.fromEntries(fields.map((c) => [c.field, c.after === null || c.after === undefined ? "" : String(c.after)])),
	);
	const [missing, setMissing] = useState<string | null>(null);
	const form = useRef<HTMLFormElement>(null);
	const focusField = (field?: string) =>
		form.current
			?.querySelector<HTMLElement>(
				field ? `[data-field="${field}"] :is(input,textarea,button)` : ":is(input,textarea,button[role=combobox])",
			)
			?.focus();
	useEffect(() => focusField(), []);
	const submit = (e: FormEvent) => {
		e.preventDefault();
		const empty = missingRequired(review, edits);
		setMissing(empty?.field ?? null);
		if (empty) return focusField(empty.field);
		onSubmit(edits);
	};
	return (
		<form ref={form} onSubmit={submit} noValidate aria-label="Revise this change">
			<div className="flex flex-col gap-3 px-4 py-3.5">
				<Affects review={review} />
				{fields.map((c) => {
					const kind = fieldKind(c.field);
					const set = (value: string) => setEdits((all) => ({ ...all, [c.field]: value }));
					const now =
						review.operation === "people.createPerson" || c.field === "reason"
							? undefined
							: `Now: ${valueText(c.field, c.before) ?? "empty"}`;
					return (
						<div key={c.field} data-field={c.field}>
							<Field
								label={fieldLabel(c.field)}
								hint={now}
								error={missing === c.field ? `Enter ${fieldLabel(c.field).toLowerCase()}.` : undefined}
								optional={!isRequired(c.field)}
							>
								{kind === "choice" ? (
									<Select options={CHOICES[c.field]!} value={edits[c.field]} onValueChange={set} disabled={busy} />
								) : kind === "long" ? (
									<Textarea value={edits[c.field]} onChange={(e) => set(e.target.value)} rows={3} disabled={busy} />
								) : (
									<Input
										type={kind === "date" ? "date" : kind === "email" ? "email" : "text"}
										value={edits[c.field]}
										onChange={(e) => set(e.target.value)}
										disabled={busy}
									/>
								)}
							</Field>
						</div>
					);
				})}
				<p className="text-xs text-text-3">Updating makes a new revision. You check it, then approve it.</p>
			</div>
			{notice ? (
				<p
					ref={noticeRef}
					tabIndex={-1}
					className="mx-4 mb-3 rounded-md bg-magenta-50 px-3 py-2 text-sm text-magenta-600 outline-none focus-visible:ring-2 focus-visible:ring-focus"
				>
					{notice.text}
				</p>
			) : null}
			<div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
				<Button size="sm" variant="primary" type="submit" loading={busy}>
					Update review
				</Button>
				<Button size="sm" variant="ghost" type="button" disabled={busy} onClick={onClose}>
					Keep as it is
				</Button>
			</div>
		</form>
	);
}
