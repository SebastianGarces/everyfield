"use client";

import { Alert02Icon } from "@hugeicons/core-free-icons";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@everyfield/ui/controls";
import { cn, Icon, type IconSvgElement } from "@everyfield/ui/foundations";
import {
	createContext,
	use,
	useEffect,
	useId,
	useRef,
	useState,
	useSyncExternalStore,
	type ReactNode,
	type RefObject,
} from "react";
import { SaveLane, waitOf, type LaneOptions, type Notice, type SaveSpec, type Wait } from "./model.ts";

/**
 * One card's saves (model.ts SaveLane): the open form, the notice and one save at a time. `explain` words a refusal
 * code; `busy` is true while a lane the card shares (the person store) runs another save. The lane keeps the functions
 * of its first render, so they read current state (`store.get()`) rather than closing over render values.
 */
export function useSaveIntent<E extends { problem?: string }>(options: Pick<LaneOptions, "explain" | "busy">) {
	const [lane] = useState(() => new SaveLane<E>({ ...options, report: (line) => console.error(line) }));
	const state = useSyncExternalStore(lane.subscribe, lane.get, lane.get);
	const busy = options.busy?.() ?? false;
	return {
		editing: state.editing,
		notice: state.notice,
		/** The card's own save is on its way. */
		saving: state.saving,
		/** Nothing on the card may submit while this is not null (C68). */
		wait: waitOf(state.saving || busy, state.notice),
		open: lane.open,
		close: lane.close,
		dismiss: lane.dismiss,
		save: lane.save as <T>(spec: SaveSpec<E, T>) => Promise<void>,
		/** The refusal of the open form, in words. */
		problem: state.editing?.problem ? options.explain(state.editing.problem) : undefined,
		/** Props for SaveNotice and NoticeInDialog. */
		noticeProps: { notice: state.notice, busy, onDismiss: lane.dismiss },
	};
}

/** One card's save lane as a hook gives it, for a dialog that shares the card's lane. */
export type SaveIntent<E extends { problem?: string }> = ReturnType<typeof useSaveIntent<E>>;

/**
 * After a submit with missing answers, moves focus to the first control marked invalid, or into the first invalid
 * choice group, once React has drawn the errors.
 */
export function focusFirstProblem(form: HTMLFormElement) {
	requestAnimationFrame(() => firstProblem(form)?.focus());
}
function firstProblem(root: HTMLElement): HTMLElement | null | undefined {
	const bad = root.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid="true"]');
	return bad?.matches("input, textarea, button, select")
		? bad
		: bad?.querySelector<HTMLElement>('input, textarea, button, [tabindex]:not([tabindex="-1"])');
}

/**
 * A card's form in a dialog. When the dialog opens again after a refused save, focus starts on the field the reason
 * names (a screen reader reads its error with it), or on the reason when it names no field. A submit with missing
 * answers moves focus to the first one. While the card waits (C68) the form keeps its answers and cannot submit.
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
	disabled = false,
	onClose,
	onSubmit,
	children,
}: {
	icon: IconSvgElement;
	tone: "green" | "blue" | "violet" | "amber" | "magenta";
	title: string;
	description?: ReactNode;
	action: string;
	/** Why the last save of this form was refused, in words. */
	problem?: string;
	size?: "md" | "lg";
	wait?: Wait;
	/** The form has nothing to save (an address copy with no changes). */
	disabled?: boolean;
	onClose: () => void;
	/** Returns false when the form has missing answers. */
	onSubmit: () => boolean;
	children: ReactNode;
}) {
	const alert = useRef<HTMLDivElement>(null);
	const form = useRef<HTMLFormElement>(null);
	const busyId = useId();
	return (
		<Dialog open onOpenChange={(next) => !next && onClose()}>
			<DialogContent size={size}>
				<form
					ref={form}
					noValidate
					className="contents"
					onSubmit={(e) => {
						e.preventDefault();
						if (wait || disabled) return;
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
								{problem}
							</div>
						) : null}
						{children}
						{problem ? <FocusProblem key={problem} form={form} alert={alert} /> : null}
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
							disabled={wait !== null || disabled}
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
 * Moves focus to the field a refusal names, or to the reason, when the reason appears. It mounts after the form's fields
 * and runs before the dialog's own focus step, so it also wins over a field that focuses itself on mount (autoFocus).
 */
function FocusProblem({
	form,
	alert,
}: {
	form: RefObject<HTMLFormElement | null>;
	alert: RefObject<HTMLDivElement | null>;
}) {
	useEffect(() => {
		const field = form.current && firstProblem(form.current);
		(field ?? alert.current)?.focus();
	}, [form, alert]);
	return null;
}

/** The notice in words. Only a server answer says "not saved". */
function noticeText(notice: Notice): string {
	switch (notice.tone) {
		case "unknown":
			return `${notice.what} may already be ${notice.done}. We did not hear back from the server. Check again to find out; it will not be ${notice.done} twice.`;
		case "refused":
			return `${notice.what} was not ${notice.done}. ${notice.reason}`;
	}
}

type NoticeProps = {
	notice: Notice | null;
	/** Another change in a lane the card shares is saving: Check again waits until it ends. */
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
 * the card. While one of the card's dialogs is open, the notice moves into that dialog (C69), because a modal dialog is
 * all a screen reader reads then: it is announced there without moving focus or changing the open form.
 */
export function SaveNotice({
	dialogOpen,
	className = "mb-4",
	...props
}: NoticeProps & { dialogOpen: boolean; className?: string }) {
	return <NoticeRegion {...props} notice={dialogOpen ? null : props.notice} className={className} />;
}

/** Wraps a card's dialogs so the card's notice shows inside whichever of them is open. */
export function NoticeInDialog({ children, ...props }: NoticeProps & { children: ReactNode }) {
	return <NoticeContext value={props}>{children}</NoticeContext>;
}

/** The card's notice inside its open dialog. RecordDialog draws it; a dialog of its own puts it at the top of its body. */
export function DialogNotice() {
	const props = use(NoticeContext);
	return props ? <NoticeRegion {...props} /> : null;
}

/**
 * One assertive live region. A notice is read out the first time it appears; one that was already read (it moved
 * between the card and a dialog) sits inside an aria-live="off" wrapper, so it shows without being announced again.
 */
function NoticeRegion({ notice, busy, onDismiss, className }: NoticeProps & { className?: string }) {
	const key = notice ? noticeKey(notice) : null;
	// Decided once, when this region first shows the notice: later renders keep the same wrapper, so the notice is
	// neither moved nor silenced while it stays here.
	const [shown, setShown] = useState<{ key: string | null; isNew: boolean }>({ key: null, isNew: false });
	const now = shown.key === key ? shown : { key, isNew: key !== null && !announced.has(key) };
	if (now !== shown) setShown(now);
	const isNew = now.isNew;
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
					Check again waits until the other save ends.
				</p>
			) : null}
		</div>
	);
}
