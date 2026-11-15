"use client";

import { Alert02Icon } from "@hugeicons/core-free-icons";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@everyfield/ui/controls";
import { cn, Icon, useFocusRequest, type IconSvgElement } from "@everyfield/ui/foundations";
import { createContext, use, useId, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { SaveLane, waitOf, type LaneOptions, type Notice, type SaveSpec, type Wait } from "./model.ts";

export function useSaveIntent<E extends { problem?: string }>(options: Pick<LaneOptions, "explain" | "busy">) {
	const [lane] = useState(() => new SaveLane<E>({ ...options, report: (line) => console.error(line) }));
	const state = useSyncExternalStore(lane.subscribe, lane.get, lane.get);
	const busy = options.busy?.() ?? false;
	return {
		editing: state.editing,
		notice: state.notice,
		saving: state.saving,
		wait: waitOf(state.saving || busy, state.notice),
		open: lane.open,
		close: lane.close,
		dismiss: lane.dismiss,
		save: lane.save as <T>(spec: SaveSpec<E, T>) => Promise<void>,
		problem: state.editing?.problem ? options.explain(state.editing.problem) : undefined,
		noticeProps: { notice: state.notice, busy, onDismiss: lane.dismiss },
	};
}

export type RowSave = "saving" | "unknown" | "checking";

export function useRowLanes(explain: (code: string) => string) {
	const [lanes] = useState(() => new Map<string, SaveLane<{ problem?: string }>>());
	const [, render] = useReducer((n: number) => n + 1, 0);
	const stateOf = (row: string): RowSave | undefined => {
		const s = lanes.get(row)?.get();
		const unknown = s?.notice?.tone === "unknown";
		if (s?.saving) return unknown ? "checking" : "saving";
		return unknown ? "unknown" : undefined;
	};
	return {
		async save<T>(row: string, spec: SaveSpec<{ problem?: string }, T>): Promise<void> {
			let lane = lanes.get(row);
			if (!lane) {
				lane = new SaveLane({ explain, report: (line) => console.error(line) });
				lane.subscribe(render);
				lanes.set(row, lane);
			}
			if (lane.wait() !== null) return;
			const l = lane;
			await l.save({ ...spec, refused: (code) => (l.dismiss(), spec.refused?.(code)) });
		},
		stateOf,
		unknown: [...lanes.values()].flatMap((l) => {
			const n = l.get().notice;
			return n?.tone === "unknown" ? [n] : [];
		}),
		busy: [...lanes.keys()].some((row) => stateOf(row) !== undefined),
	};
}
export type RowLanes = ReturnType<typeof useRowLanes>;

export function RowNotices({ lanes, className = "mb-4" }: { lanes: RowLanes; className?: string }) {
	return lanes.unknown.map((n) => (
		<NoticeRegion key={n.id} notice={n} busy={false} onDismiss={() => {}} className={className} />
	));
}

export type SaveIntent<E extends { problem?: string } = { problem?: string }> = ReturnType<typeof useSaveIntent<E>>;

export function focusFirstProblem(form: HTMLFormElement) {
	requestAnimationFrame(() => firstProblem(form)?.focus());
}
const FOCUSABLE =
	'input:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';
function firstProblem(root: HTMLElement): HTMLElement | null {
	const bad = root.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid="true"]');
	return (bad?.matches("input, textarea, button, select") ? bad : bad?.querySelector<HTMLElement>(FOCUSABLE)) ?? null;
}

export function RecordDialog({
	icon,
	tone = "ink",
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
	icon?: IconSvgElement;
	tone?: "ink" | "green" | "blue" | "violet" | "amber" | "magenta";
	title: string;
	description?: ReactNode;
	action: string;
	problem?: string;
	size?: "sm" | "md" | "lg";
	wait?: Wait;
	disabled?: boolean;
	onClose: () => void;
	onSubmit: () => boolean;
	children: ReactNode;
}) {
	const alert = useRef<HTMLDivElement>(null);
	const fields = useRef<HTMLDivElement>(null);
	const [incomplete, setIncomplete] = useState(0);
	const focusProblem = useFocusRequest<HTMLFormElement>(incomplete, firstProblem);
	return (
		<Dialog open onOpenChange={(next) => !next && onClose()}>
			<DialogContent
				size={size}
				onOpenAutoFocus={(e) => {
					const root = fields.current;
					if (!root) return;
					const target = alert.current
						? (firstProblem(root) ?? alert.current)
						: root.querySelector<HTMLElement>(FOCUSABLE);
					if (!target) return;
					e.preventDefault();
					target.focus();
				}}
			>
				<form
					ref={focusProblem}
					noValidate
					className="contents"
					onSubmit={(e) => {
						e.preventDefault();
						if (wait || disabled) return;
						if (!onSubmit()) setIncomplete((n) => n + 1);
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
						<div ref={fields} className="contents">
							{children}
						</div>
					</DialogBody>
					<DialogFooter>
						<Button variant="secondary" type="button" onClick={onClose}>
							Cancel
						</Button>
						<SaveButton wait={wait} disabled={disabled} variant={tone === "magenta" ? "danger" : "primary"}>
							{action}
						</SaveButton>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

const WAIT_HINT = { saving: "Waiting for the last save.", unknown: "Check the last save first." } as const;

export function SaveButton({
	wait,
	saving = false,
	blocked = null,
	disabled = false,
	variant = "primary",
	className,
	children,
}: {
	wait: Wait;
	saving?: boolean;
	blocked?: string | null;
	disabled?: boolean;
	variant?: "primary" | "danger";
	className?: string;
	children: ReactNode;
}) {
	const hint = useId();
	const why = saving ? null : wait ? WAIT_HINT[wait] : blocked;
	return (
		<>
			{why ? (
				<p id={hint} className="mr-auto text-xs text-text-2 max-app-sm:basis-full">
					{why}
				</p>
			) : null}
			<Button
				type="submit"
				variant={variant}
				loading={saving}
				disabled={wait !== null || blocked !== null || disabled}
				aria-describedby={why ? hint : undefined}
				className={className}
			>
				{children}
			</Button>
		</>
	);
}

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
	busy: boolean;
	onDismiss: () => void;
};
const NoticeContext = createContext<NoticeProps | null>(null);
const announced = new Set<string>();
const noticeKey = (n: Notice) => `${n.id}:${n.tone}:${n.tone === "unknown" && n.checking}`;

function recordShown(region: HTMLElement) {
	for (const shown of region.querySelectorAll<HTMLElement>("[data-notice]")) announced.add(shown.dataset.notice!);
}

function recordAnnounced(region: HTMLDivElement | null) {
	if (!region) return;
	recordShown(region);
	const changes = new MutationObserver(() => recordShown(region));
	changes.observe(region, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-notice"] });
	return () => changes.disconnect();
}

export function SaveNotice({
	dialogOpen,
	className = "mb-4",
	...props
}: NoticeProps & { dialogOpen: boolean; className?: string }) {
	return <NoticeRegion {...props} notice={dialogOpen ? null : props.notice} className={className} />;
}

export function NoticeInDialog({ children, ...props }: NoticeProps & { children: ReactNode }) {
	return <NoticeContext value={props}>{children}</NoticeContext>;
}

export function DialogNotice() {
	const props = use(NoticeContext);
	return props ? <NoticeRegion {...props} /> : null;
}

function NoticeRegion({ notice, busy, onDismiss, className }: NoticeProps & { className?: string }) {
	const key = notice ? noticeKey(notice) : null;
	const [shown, setShown] = useState<{ key: string | null; isNew: boolean }>({ key: null, isNew: false });
	const now = shown.key === key ? shown : { key, isNew: key !== null && !announced.has(key) };
	if (now !== shown) setShown(now);
	const isNew = now.isNew;
	const body = notice ? <NoticeBody notice={notice} busy={busy} onDismiss={onDismiss} /> : null;
	return (
		<div ref={recordAnnounced} aria-live="assertive" className={cn("empty:hidden", className)}>
			{body && !isNew ? <div aria-live="off">{body}</div> : body}
		</div>
	);
}

function NoticeBody({ notice, busy, onDismiss }: NoticeProps & { notice: Notice }) {
	const hintId = useId();
	return (
		<div
			data-notice={noticeKey(notice)}
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
