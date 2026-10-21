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
import { useId, useRef, useState, type ReactNode } from "react";
import { keyFor, type KeyedPayload, type Outcome } from "../model.ts";
import { fresh, problemText } from "../parts.tsx";
import { withRecord } from "./model.ts";

/** Why a record was not saved, or may not be, in words. `busy` means another change to this person is still saving. */
export function recordProblem(code: string): string {
	switch (code) {
		case "busy":
			return "Another change to this person is still saving. Try again in a moment.";
		case "lost":
			return "We did not hear back from the server, so this may already be saved. Save again: it will not be saved twice.";
		case "future_date":
			return "This date is after today at your church. Choose today or an earlier date.";
		case "storage_unavailable":
			return "Document storage is not set up yet. Save without the document, or try again later.";
		case "upload_failed":
			return "The document did not upload, and nothing was saved. Check that it is a PDF, JPG or PNG under 10 MB, then try again.";
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
	onClose: () => void;
	/** Returns false when the form has missing answers. */
	onSubmit: () => boolean;
	children: ReactNode;
}) {
	const alert = useRef<HTMLDivElement>(null);
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
						if (!onSubmit()) focusFirstProblem(e.currentTarget);
					}}
				>
					<DialogHeader icon={icon} tone={tone} title={title} description={description} />
					<DialogBody className="flex flex-col gap-5 pb-1">
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
						<Button variant="secondary" type="button" onClick={onClose}>
							Cancel
						</Button>
						<Button variant={tone === "magenta" ? "danger" : "primary"} type="submit">
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
export function useHistory<R extends Dated>(
	initial: Page<R> | null,
	load: (page: number) => Promise<Outcome<Page<R>>>,
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
	return { ...page, setPage, add, more, loading: state === "loading", failed: state === "failed" };
}

/** What a failed save keeps for its next try: its key after a lost answer, none after a refusal (a final answer). */
export const keptKey = (r: Outcome<unknown> | null, key: KeyedPayload) =>
	r === null || r.status === "lost" ? key : undefined;

/**
 * One card's record form and the saves it sends. A save closes the form at once. When it fails, the form opens again
 * with the reason only if the person has not opened or closed a form since that save. Otherwise the newer form stays
 * as it is, and the failed one waits in the card's own notice, so a late reply never replaces newer work.
 */
export function useRecordForm<E extends { problem?: string; key?: KeyedPayload }>() {
	const [editing, setEditing] = useState<E | null>(null);
	const [failed, setFailed] = useState<E | null>(null);
	const intent = useRef(0);
	const open = (e: E) => {
		intent.current++;
		setEditing(e);
	};
	const close = () => {
		intent.current++;
		setEditing(null);
	};
	/**
	 * Closes the form for a save. The token says whether the form is still the person's latest when the save fails. The
	 * key is this save intent's own request key: the one its earlier lost try used when the payload is the same, so a
	 * failed save resumed later (even after another save succeeded) can never be saved twice.
	 */
	const send = () => {
		const prior = editing?.key ?? null;
		close();
		return { token: intent.current, prior, keyFor: (payload: unknown) => keyFor(prior, payload, fresh) };
	};
	const fail = (token: number, e: E) => {
		if (token === intent.current) setEditing(e);
		else setFailed(e);
	};
	const resume = () => {
		if (!failed) return;
		open(failed);
		setFailed(null);
	};
	return { editing, open, close, send, fail, failed, resume, dismiss: () => setFailed(null) };
}

/** A save that failed while the person worked on something else: its reason and a way back to its form. */
export function FailedSave({
	what,
	problem,
	onResume,
	onDismiss,
}: {
	what: string;
	problem?: string;
	onResume: () => void;
	onDismiss: () => void;
}) {
	return (
		<div
			role="alert"
			className="mb-4 flex flex-col items-start gap-2.5 rounded-md bg-magenta-50 px-3.5 py-3 text-sm text-magenta-600"
		>
			<p className="flex items-start gap-2">
				<Icon icon={Alert02Icon} size={16} className="mt-px flex-none" />
				<span>
					{what} {problem ? recordProblem(problem) : null}
				</span>
			</p>
			<div className="flex flex-wrap gap-2">
				<Button size="sm" variant="secondary" onClick={onResume}>
					Open it again
				</Button>
				<Button size="sm" variant="ghost" onClick={onDismiss}>
					Dismiss
				</Button>
			</div>
		</div>
	);
}
