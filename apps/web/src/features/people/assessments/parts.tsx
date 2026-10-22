"use client";

import { Alert02Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	SegmentedControl,
} from "@everyfield/ui/controls";
import { cn, Icon, type IconSvgElement } from "@everyfield/ui/foundations";
import { createContext, use, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Outcome } from "../model.ts";
import { fresh, problemText } from "../parts.tsx";
import {
	formChecking,
	formClose,
	formDismiss,
	formOpen,
	formRefused,
	formSend,
	formSettled,
	formStart,
	formUnknown,
	withCorrections,
	withRecord,
	type FormState,
	type Notice,
	type Wait,
} from "./model.ts";

/** Why a record was not saved, or may not be, in words. `busy` means another change to this person is still saving. */
export function recordProblem(code: string): string {
	switch (code) {
		case "busy":
			return "Another save on this card was still running, so nothing was sent. Save it again when that save ends.";
		case "future_date":
			return "This date is after today at your church. Choose today or an earlier date.";
		case "storage_unavailable":
			return "Document storage is not set up yet. Save without the document, or try again later.";
		case "upload_unreadable":
			return "This file could not be read as a PDF, JPG or PNG, so nothing was saved. Choose another file of 10 MB or less.";
		case "date_or_file":
			return "This card was not saved. Check that the signed date is not after today and that the file is a readable PDF, JPG or PNG.";
		case "upload_failed":
			return "The document did not upload, and nothing was saved. Try again in a moment.";
		case "upload_lost":
			return "The document upload did not finish, and nothing was saved. Try again.";
		default:
			return problemText(code);
	}
}

/**
 * After a submit with missing answers, moves focus to the first control marked invalid, or into the first invalid
 * choice group, once React has drawn the errors.
 */
function focusFirstProblem(form: HTMLFormElement) {
	requestAnimationFrame(() => {
		const bad = form.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid="true"]');
		const target = bad?.matches("input, textarea, button, select")
			? bad
			: bad?.querySelector<HTMLElement>('input, textarea, button, [tabindex]:not([tabindex="-1"])');
		target?.focus();
	});
}

/** The code a failed save shows: null (another save running) reads as busy. */
export const codeOf = (r: Outcome<unknown> | null): string =>
	r === null ? "busy" : r.status === "refused" ? r.code : r.status === "lost" ? "lost" : "";

/**
 * A record form in a dialog. When the dialog opens again after a failed save, focus starts on the reason, so a screen
 * reader reads it first and a keyboard user is next to the fields. A submit with missing answers moves focus to the
 * first one.
 */
export function RecordDialog({
	icon,
	tone,
	title,
	description,
	action,
	problem,
	size = "md",
	wait = null,
	onClose,
	onSubmit,
	children,
}: {
	icon: IconSvgElement;
	tone: "green" | "blue" | "violet" | "amber" | "magenta";
	title: string;
	description?: ReactNode;
	action: string;
	problem?: string;
	size?: "md" | "lg";
	/** The card's last save is in flight or unknown (C68): the form keeps its answers and cannot submit yet. */
	wait?: Wait;
	onClose: () => void;
	/** Returns false when the form has missing answers. */
	onSubmit: () => boolean;
	children: ReactNode;
}) {
	const alert = useRef<HTMLDivElement>(null);
	const busyId = useId();
	return (
		<Dialog open onOpenChange={(next) => !next && onClose()}>
			<DialogContent
				size={size}
				onOpenAutoFocus={(e) => {
					if (!alert.current) return;
					e.preventDefault();
					alert.current.focus();
				}}
			>
				<form
					noValidate
					className="contents"
					onSubmit={(e) => {
						e.preventDefault();
						if (wait) return;
						if (!onSubmit()) focusFirstProblem(e.currentTarget);
					}}
				>
					<DialogHeader icon={icon} tone={tone} title={title} description={description} />
					<DialogBody className="flex flex-col gap-5 pb-1">
						<DialogNotice />
						{problem ? (
							<div
								ref={alert}
								role="alert"
								tabIndex={-1}
								className="flex items-start gap-2 rounded-md bg-magenta-50 px-3.5 py-2.5 text-sm text-magenta-600 outline-none focus-visible:shadow-[0_0_0_2px_var(--ef-focus)]"
							>
								<Icon icon={Alert02Icon} size={16} className="mt-px flex-none" />
								{recordProblem(problem)}
							</div>
						) : null}
						{children}
					</DialogBody>
					<DialogFooter>
						{wait ? (
							<p id={busyId} className="mr-auto text-xs text-text-2 max-app-sm:basis-full">
								{wait === "saving" ? "Waiting for the last save." : "Check the last save first."}
							</p>
						) : null}
						<Button variant="secondary" type="button" onClick={onClose}>
							Cancel
						</Button>
						<Button
							variant={tone === "magenta" ? "danger" : "primary"}
							type="submit"
							disabled={wait !== null}
							aria-describedby={wait ? busyId : undefined}
						>
							{action}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/**
 * One required choice from a few (a score, a rating), as a labelled segmented group. A missing choice marks the group
 * invalid, so the form's focus step lands on its first option.
 */
export function ChoiceField<V extends string>({
	label,
	value,
	options,
	onChange,
	error,
	aside,
}: {
	label: string;
	value: V | "";
	options: readonly { value: V; label: string }[];
	onChange: (value: V) => void;
	error?: string | null;
	aside?: ReactNode;
}) {
	const id = useId();
	// The group names itself (with its error); the visible label repeats that name for sighted readers.
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<div className="flex items-center justify-between gap-3">
				<span aria-hidden="true" className="text-sm font-medium text-ink-2">
					{label}
				</span>
				{aside}
			</div>
			<div data-invalid={error ? "true" : undefined} className="min-w-0">
				<SegmentedControl
					label={error ? `${label}. ${error}` : label}
					value={value as V}
					onValueChange={onChange}
					options={options.map((o) => ({ value: o.value, label: o.label }))}
					className={cn(
						"w-full *:flex-1 *:justify-center",
						error && "shadow-[inset_0_0_0_1.5px_var(--ef-magenta-500)]",
					)}
				/>
			</div>
			<div aria-live="polite" className="empty:hidden">
				{error ? (
					<p id={`${id}-error`} className="text-xs font-medium text-magenta-600">
						{error}
					</p>
				) : null}
			</div>
		</div>
	);
}

/** "Show earlier" under a history: reads the next page and adds it below. */
export function ShowEarlier({ loading, failed, onClick }: { loading: boolean; failed: boolean; onClick: () => void }) {
	return (
		<div className="mt-2 flex flex-wrap items-center gap-3">
			<Button size="sm" variant="ghost" loading={loading} onClick={onClick}>
				Show earlier
			</Button>
			<span aria-live="polite" className="text-xs text-text-3 empty:hidden">
				{failed ? "Earlier records did not load. Try again." : ""}
			</span>
		</div>
	);
}

/** Who recorded an entry: "you", or a team member without naming another account. */
export function recorder(actor: { kind: string; accountId?: string }, accountId: string): string {
	if (actor.kind === "current_account") return actor.accountId === accountId ? "you" : "a team member";
	return "a former team member";
}

type Page<R> = { items: R[]; next: number | null; total: number };
type Dated = { id: string; occurredOn: string; recordedAt: string };

/**
 * A record history, latest first: the first page from the person page, later pages on "Show earlier", and records
 * this page saved. A page that arrives after a save never removes or replaces that record: pages only add the records
 * they bring, and a record already shown keeps its place.
 */
export function useHistory<R extends Dated & { revision: string }>(
	initial: Page<R> | null,
	load: (page: number) => Promise<Outcome<Page<R>>>,
	/** Records saved elsewhere on the page (corrections); each replaces the shown copy of that record when newer. */
	pushed: readonly R[] = [],
) {
	const [page, setPage] = useState<Page<R>>(initial ?? { items: [], next: null, total: 0 });
	const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
	const add = (record: R) =>
		setPage((p) => ({
			...p,
			items: withRecord(p.items, record),
			total: p.items.some((r) => r.id === record.id) ? p.total : p.total + 1,
		}));
	async function more() {
		const next = page.next;
		if (next === null || state === "loading") return;
		setState("loading");
		const r = await load(next).catch((): Outcome<Page<R>> => ({ status: "lost" }));
		if (r.status !== "ok") return setState("failed");
		setState("idle");
		setPage((p) => ({
			items: [...p.items, ...r.value.items.filter((x) => !p.items.some((y) => y.id === x.id))],
			next: p.next === next ? r.value.next : p.next,
			total: Math.max(p.total, r.value.total),
		}));
	}
	const items = withCorrections(page.items, pushed);
	return { ...page, items, setPage, add, more, loading: state === "loading", failed: state === "failed" };
}

/**
 * One card's record form and the notice of a save that failed or whose result is unknown, over the rules in model.ts.
 * The ref is the latest state, read synchronously by a save or a late answer; the state copy renders the card.
 */
export function useRecordForm<E extends { problem?: string }>() {
	const state = useRef<FormState<E>>(formStart<E>());
	const [view, setView] = useState<FormState<E>>(formStart<E>);
	const apply = (next: FormState<E>) => {
		state.current = next;
		setView(next);
	};
	return {
		editing: view.editing,
		notice: view.notice,
		open: (e: E) => apply(formOpen(state.current, e)),
		close: () => apply(formClose(state.current)),
		/** Closes the form for a save and gives its token and its own new request key. */
		send: () => {
			const sent = formSend(state.current);
			apply(sent.state);
			return { token: sent.token, key: { key: fresh(), body: "" } };
		},
		refused: (token: number, e: E, id: string, what: string) => {
			// Save is disabled while the card waits (C68), so a save that could not start is unexpected: log it (C69).
			if (e.problem === "busy")
				console.error(JSON.stringify({ component: "people/records", outcome: "save_not_started", id }));
			apply(formRefused(state.current, token, e, { id, what }));
		},
		unknown: (id: string, what: string, check: () => void) =>
			apply(
				formUnknown(state.current, id, what, () => {
					apply(formChecking(state.current));
					check();
				}),
			),
		settled: (id: string) => apply(formSettled(state.current, id)),
		dismiss: () => apply(formDismiss(state.current)),
	};
}

/** The notice in words. Only a server answer says "not saved". */
function noticeText(notice: Notice): string {
	switch (notice.tone) {
		case "unknown":
			return `${notice.what} may already be saved. We did not hear back from the server. Check again to find out; it will not be saved twice.`;
		case "refused":
			return `${notice.what} was not saved. ${recordProblem(notice.problem)}`;
	}
}

type NoticeProps = {
	notice: Notice | null;
	/** Another change to this person is saving: Check again waits until it ends. */
	busy: boolean;
	onDismiss: () => void;
};
/** The card's notice for its open dialog (NoticeInDialog). Null outside a card's dialog. */
const NoticeContext = createContext<NoticeProps | null>(null);
/** Notices already read out, by request key and state: moving between the card and a dialog does not repeat one. */
const announced = new Set<string>();
const noticeKey = (n: Notice) => `${n.id}:${n.tone}:${n.tone === "unknown" && n.checking}`;

/**
 * The card's notice of a save that was not saved, or whose result is unknown. It sits in an assertive live region on
 * the card. While one of the card's dialogs is open, the notice moves into that dialog (DialogNotice), because a modal
 * dialog is all a screen reader reads then: it is announced there without moving focus or changing the open form.
 */
export function SaveNotice({ dialogOpen, ...props }: NoticeProps & { dialogOpen: boolean }) {
	return <NoticeRegion {...props} notice={dialogOpen ? null : props.notice} className="mb-4" />;
}

/** Wraps a card's dialogs so the card's notice shows inside whichever of them is open. */
export function NoticeInDialog({ children, ...props }: NoticeProps & { children: ReactNode }) {
	return <NoticeContext value={props}>{children}</NoticeContext>;
}

function DialogNotice() {
	const props = use(NoticeContext);
	return props ? <NoticeRegion {...props} /> : null;
}

/**
 * One assertive live region. A notice is read out the first time it appears; one that was already read (it moved
 * between the card and a dialog) sits inside an aria-live="off" wrapper, so it shows without being announced again.
 */
function NoticeRegion({ notice, busy, onDismiss, className }: NoticeProps & { className?: string }) {
	const key = notice ? noticeKey(notice) : null;
	const isNew = key !== null && !announced.has(key);
	useEffect(() => {
		if (key) announced.add(key);
	}, [key]);
	const body = notice ? <NoticeBody notice={notice} busy={busy} onDismiss={onDismiss} /> : null;
	return (
		<div aria-live="assertive" className={cn("empty:hidden", className)}>
			{body && !isNew ? <div aria-live="off">{body}</div> : body}
		</div>
	);
}

function NoticeBody({ notice, busy, onDismiss }: NoticeProps & { notice: Notice }) {
	const hintId = useId();
	return (
		<div
			aria-atomic="true"
			className="flex flex-col items-start gap-2.5 rounded-md bg-magenta-50 px-3.5 py-3 text-sm text-magenta-600"
		>
			<p className="flex items-start gap-2">
				<Icon icon={Alert02Icon} size={16} className="mt-px flex-none" />
				<span>{noticeText(notice)}</span>
			</p>
			<div className="flex flex-wrap gap-2">
				{notice.tone === "unknown" ? (
					<Button
						size="sm"
						variant="secondary"
						type="button"
						loading={notice.checking}
						disabled={busy && !notice.checking}
						aria-describedby={busy && !notice.checking ? hintId : undefined}
						onClick={notice.check}
					>
						Check again
					</Button>
				) : null}
				{notice.tone === "refused" ? (
					<Button size="sm" variant="ghost" type="button" onClick={onDismiss}>
						Dismiss
					</Button>
				) : null}
			</div>
			{notice.tone === "unknown" && busy && !notice.checking ? (
				<p id={hintId} className="text-xs text-magenta-600">
					Check again waits until the other save to this person ends.
				</p>
			) : null}
		</div>
	);
}
