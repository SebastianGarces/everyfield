"use client";

import { Add01Icon, Cancel01Icon, Link04Icon, RepeatIcon } from "@hugeicons/core-free-icons";
import { Button, Field, IconButton, Input, SearchInput, Select, Spinner } from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { cn, Icon } from "@everyfield/ui/foundations";
import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { prerequisiteCandidates } from "./fetch.ts";
import {
	blocks,
	FREQUENCIES,
	FREQUENCY_LABEL,
	isSettled,
	PENDING_PREFIX,
	repeatText,
	STATUS_LABEL,
	type Candidate,
	type Frequency,
	type Occurrence,
	type Prerequisite,
	type Rule,
	type Step,
	type TaskDetail,
	type TaskItem,
} from "./model.ts";
import { DoneBox } from "./parts.tsx";
import { warmAssignees } from "./TaskDialog.tsx";

// The task panel's structure sections (REQ-TSK-005 to 007): steps, what the task waits for and how it repeats. Each
// save is one request; the screen shows it at once and confirms or rolls it back.

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-2">
			<div className="flex min-h-[34px] items-center gap-2">
				<h3 className="grow text-sm font-semibold text-ink-2">{title}</h3>
				{action}
			</div>
			{children}
		</section>
	);
}

/**
 * An inline form: Escape inside it closes the form, not the panel around it, and focus goes back to the button that
 * opened it. The panel closes on Escape from a document listener, so this one listens on the window first.
 */
function useInlineForm(form: RefObject<HTMLElement | null>, onClose: () => void) {
	const close = useRef(onClose);
	useEffect(() => {
		close.current = onClose;
	});
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || !form.current?.contains(document.activeElement)) return;
			e.stopPropagation();
			close.current();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [form]);
}
/** Focus returns to a section's button when its form closes and focus would otherwise be lost. */
function useReturnFocus(editing: boolean) {
	const opener = useRef<HTMLButtonElement>(null);
	const was = useRef(editing);
	useEffect(() => {
		if (was.current && !editing && (!document.activeElement || document.activeElement === document.body))
			opener.current?.focus();
		was.current = editing;
	}, [editing]);
	return opener;
}

/** A step's assignee choice: the task's own assignee, no one, or a seat. */
export type StepAssignee = { kind: "inherit" } | { kind: "nobody" } | { kind: "seat"; accountId: string; name: string };
const INHERIT = "inherit",
	NOBODY = "nobody";

/**
 * Steps: one-level child tasks, each with its own assignee and history (REQ-TSK-005). A step is ticked by its own
 * assignee or an Owner/Admin; holding the task does not count. An Owner or Admin adds steps under any task and may
 * name who holds each; a Member adds steps only under their own task, and those steps are theirs.
 */
export function Steps({
	steps,
	taskAssignee,
	canAdd,
	admin,
	you,
	canTick,
	busy,
	onTick,
	onRemove,
	onAdd,
}: {
	steps: Step[];
	taskAssignee: TaskItem["assignee"];
	canAdd: boolean;
	admin: boolean;
	you: string;
	canTick: (s: Step) => boolean;
	busy: (id: string) => boolean;
	onTick: (s: Step, complete: boolean) => void;
	onRemove: (s: Step) => void;
	onAdd: (title: string, assignee: StepAssignee) => void;
}) {
	const [adding, setAdding] = useState(false);
	const opener = useReturnFocus(adding);
	const done = steps.filter((s) => s.status === "complete").length;
	if (!steps.length && !canAdd) return null;
	return (
		<Section
			title={steps.length ? `Steps · ${done} of ${steps.length} done` : "Steps"}
			action={
				canAdd && !adding ? (
					<Button ref={opener} variant="ghost" size="sm" icon={Add01Icon} onClick={() => setAdding(true)}>
						Add a step
					</Button>
				) : null
			}
		>
			{steps.length ? (
				<ul>
					{steps.map((s) => {
						const pending = s.id.startsWith(PENDING_PREFIX);
						return (
							<li key={s.id} className="flex min-h-11 items-center gap-3 border-t border-line py-1.5 first:border-t-0">
								<DoneBox
									task={s}
									canAct={canTick(s) && !pending}
									busy={busy(s.id) || pending}
									onToggle={() => onTick(s, !isSettled(s.status))}
								/>
								<span
									className={cn(
										"min-w-0 flex-1 text-ink [overflow-wrap:anywhere]",
										isSettled(s.status) && "text-text-3 line-through",
										pending && "text-text-2",
									)}
								>
									{s.title}
								</span>
								<span className="max-w-[40%] truncate text-sm text-text-3">
									{s.assignee
										? s.assignee.accountId === you
											? "You"
											: s.assignee.displayName || "A former member"
										: "Needs owner"}
								</span>
								{admin ? (
									<IconButton
										icon={Cancel01Icon}
										label={`Remove step ${s.title}`}
										size="sm"
										className="shadow-none"
										disabled={pending}
										onClick={() => onRemove(s)}
									/>
								) : null}
							</li>
						);
					})}
				</ul>
			) : !adding ? (
				<p className="text-sm text-text-3">
					{admin ? "Break this task into steps. Each step can have its own owner." : "No steps yet."}
				</p>
			) : null}
			{adding ? (
				<AddStep admin={admin} taskAssignee={taskAssignee} you={you} onAdd={onAdd} onClose={() => setAdding(false)} />
			) : null}
		</Section>
	);
}

function AddStep({
	admin,
	taskAssignee,
	you,
	onAdd,
	onClose,
}: {
	admin: boolean;
	taskAssignee: TaskItem["assignee"];
	you: string;
	onAdd: (title: string, assignee: StepAssignee) => void;
	onClose: () => void;
}) {
	const [title, setTitle] = useState("");
	const [who, setWho] = useState(INHERIT);
	const [touched, setTouched] = useState(false);
	const [seats, setSeats] = useState<{ value: string; label: string }[] | "failed" | null>(null);
	const input = useRef<HTMLInputElement>(null);
	const form = useRef<HTMLFormElement>(null);
	useInlineForm(form, onClose);
	useEffect(() => {
		if (!admin) return;
		let live = true;
		warmAssignees().then((r) => {
			if (!live) return;
			setSeats(
				r.status === "ok"
					? r.value.items.map((s) => ({
							value: s.accountId,
							label: s.accountId === you ? `${s.displayName} (you)` : s.displayName,
						}))
					: "failed",
			);
		});
		return () => void (live = false);
	}, [admin, you]);
	const inherited = taskAssignee
		? `Same as the task (${taskAssignee.accountId === you ? "you" : taskAssignee.displayName || "a former member"})`
		: "Same as the task (no one yet)";
	const submit = (e: FormEvent) => {
		e.preventDefault();
		setTouched(true);
		const t = title.trim();
		if (!t) return input.current?.focus();
		const seat = Array.isArray(seats) ? seats.find((s) => s.value === who) : undefined;
		onAdd(
			t,
			who === INHERIT
				? { kind: "inherit" }
				: who === NOBODY
					? { kind: "nobody" }
					: { kind: "seat", accountId: who, name: seat?.label.replace(/ \(you\)$/, "") ?? "" },
		);
		// The form stays open for the next step.
		setTitle("");
		setTouched(false);
		input.current?.focus();
	};
	return (
		<form ref={form} onSubmit={submit} className="flex flex-col gap-3 rounded-md bg-surface p-3" noValidate>
			<Field
				label="New step"
				error={touched && !title.trim() ? "Say what the step is." : null}
				hint={admin ? undefined : "Steps go under your own task and are assigned to you."}
			>
				<Input
					ref={input}
					value={title}
					maxLength={500}
					autoComplete="off"
					autoFocus
					onChange={(e) => setTitle(e.target.value)}
				/>
			</Field>
			{admin ? (
				<Field
					label="Assigned to"
					hint={seats === "failed" ? "The list of people did not load. Close the panel and open it again." : undefined}
				>
					<Select
						value={who}
						onValueChange={setWho}
						options={[
							{ value: INHERIT, label: inherited },
							{ value: NOBODY, label: "No one yet" },
							...(Array.isArray(seats) ? seats : []),
						]}
					/>
				</Field>
			) : null}
			<div className="flex justify-end gap-2">
				<Button variant="ghost" size="sm" onClick={onClose}>
					Done adding
				</Button>
				<Button variant="primary" size="sm" type="submit" icon={Add01Icon}>
					Add step
				</Button>
			</div>
		</form>
	);
}

/**
 * Blocked by: the tasks this one waits for (REQ-TSK-006). A done, no-longer-needed or deleted task no longer holds it
 * back. It is a reminder, not a lock: the task can still be marked done. An Owner or Admin changes the whole list at
 * once; a task that already waits for this one, directly or through others, is never offered.
 */
export function BlockedBy({
	task,
	items,
	admin,
	editing,
	draft,
	onEdit,
	onCancel,
	onSave,
	onOpen,
}: {
	task: Pick<TaskDetail, "id" | "status">;
	/** Null when the list did not load. */
	items: Prerequisite[] | null;
	admin: boolean;
	editing: boolean;
	draft?: Prerequisite[];
	onEdit: () => void;
	onCancel: () => void;
	onSave: (items: Prerequisite[]) => void;
	onOpen: (id: string) => void;
}) {
	const opener = useReturnFocus(editing);
	if (!items) {
		return (
			<Section title="Blocked by">
				<p className="text-sm text-text-3">This list did not load. Close and open the task to try again.</p>
			</Section>
		);
	}
	if (!items.length && !admin) return null;
	const open = items.filter(blocks).length;
	return (
		<Section
			title="Blocked by"
			action={
				admin && !editing ? (
					<Button ref={opener} variant="ghost" size="sm" onClick={onEdit}>
						{items.length ? "Change" : "Add a task"}
					</Button>
				) : null
			}
		>
			{editing ? (
				<PrerequisiteEditor taskId={task.id} initial={draft ?? items} onCancel={onCancel} onSave={onSave} />
			) : (
				<>
					<p className="text-sm text-text-2">
						{!items.length
							? "It does not wait for any task."
							: open
								? isSettled(task.status)
									? `It was closed while ${open === 1 ? "one task was" : `${open} tasks were`} still open.`
									: `It waits for ${open === 1 ? "one task" : `${open} tasks`}. You can still mark it done.`
								: "Nothing holds it back now."}
					</p>
					{items.length ? (
						<ul>
							{items.map((p) => (
								<li
									key={p.id}
									className="flex min-h-11 items-center gap-3 border-t border-line py-1.5 first:border-t-0"
								>
									<Icon
										icon={Link04Icon}
										size={16}
										className={cn("flex-none", blocks(p) ? "text-ink-2" : "text-text-3")}
									/>
									{p.deleted ? (
										<span className="min-w-0 flex-1 text-text-3 line-through">{p.title}</span>
									) : (
										<button
											type="button"
											onClick={() => onOpen(p.id)}
											className={cn(
												"min-w-0 flex-1 cursor-pointer rounded-xs text-left underline-offset-[3px] hover:underline [overflow-wrap:anywhere]",
												blocks(p) ? "text-ink" : "text-text-3 line-through",
											)}
										>
											{p.title}
										</button>
									)}
									<PrerequisiteState p={p} />
								</li>
							))}
						</ul>
					) : null}
				</>
			)}
		</Section>
	);
}

function PrerequisiteState({ p }: { p: Pick<Prerequisite, "status" | "deleted"> }) {
	if (p.deleted) return <span className="text-sm text-text-3">Deleted</span>;
	if (blocks(p))
		return (
			<StatusBadge status="attention" size="sm">
				{p.status === "not_started" ? "Open" : STATUS_LABEL[p.status]}
			</StatusBadge>
		);
	return <span className="text-sm text-text-3">{STATUS_LABEL[p.status]}</span>;
}

function PrerequisiteEditor({
	taskId,
	initial,
	onCancel,
	onSave,
}: {
	taskId: string;
	initial: Prerequisite[];
	onCancel: () => void;
	onSave: (items: Prerequisite[]) => void;
}) {
	const [chosen, setChosen] = useState(initial);
	const form = useRef<HTMLDivElement>(null);
	useInlineForm(form, onCancel);
	const [search, setSearch] = useState("");
	const [found, setFound] = useState<Candidate[] | "loading" | "failed">("loading");
	const seq = useRef(0);
	useEffect(() => {
		const n = ++seq.current;
		const timer = setTimeout(
			() => {
				setFound("loading");
				prerequisiteCandidates(taskId, search).then(
					(r) => n === seq.current && setFound(r.status === "ok" ? r.value.items : "failed"),
				);
			},
			search ? 250 : 0,
		);
		return () => clearTimeout(timer);
	}, [taskId, search]);
	const offered = Array.isArray(found) ? found.filter((c) => !chosen.some((p) => p.id === c.id)) : [];
	const full = chosen.length >= 50;
	const changed = chosen.length !== initial.length || chosen.some((p, i) => initial[i]?.id !== p.id);
	return (
		<div ref={form} className="flex flex-col gap-3 rounded-md bg-surface p-3">
			{chosen.length ? (
				<ul aria-label="Tasks it waits for">
					{chosen.map((p) => (
						<li key={p.id} className="flex min-h-11 items-center gap-2 border-t border-line first:border-t-0">
							<span
								className={cn(
									"min-w-0 flex-1 [overflow-wrap:anywhere]",
									blocks(p) ? "text-ink" : "text-text-3 line-through",
								)}
							>
								{p.title}
							</span>
							<PrerequisiteState p={p} />
							<IconButton
								icon={Cancel01Icon}
								label={`Stop waiting for ${p.title}`}
								size="sm"
								className="shadow-none"
								onClick={() => setChosen((c) => c.filter((x) => x.id !== p.id))}
							/>
						</li>
					))}
				</ul>
			) : (
				<p className="text-sm text-text-3">It waits for no task. Find one below.</p>
			)}
			<SearchInput
				aria-label="Find a task it waits for"
				placeholder="Find a task"
				value={search}
				maxLength={200}
				onChange={(e) => setSearch(e.target.value)}
			/>
			<div aria-live="polite" className="flex flex-col">
				{found === "loading" && offered.length === 0 ? (
					<p className="flex items-center gap-2 px-1 py-2 text-sm text-text-3">
						<Spinner size={14} /> Looking for tasks…
					</p>
				) : found === "failed" ? (
					<p className="px-1 py-2 text-sm text-magenta-600">The tasks did not load. Change the search to try again.</p>
				) : offered.length === 0 ? (
					<p className="px-1 py-2 text-sm text-text-3">
						{search ? "No other task matches." : "No other task can be added."}
					</p>
				) : (
					<ul aria-label="Tasks you can add" className="max-h-[220px] overflow-y-auto">
						{offered.map((c) => (
							<li key={c.id}>
								<button
									type="button"
									disabled={full}
									onClick={() =>
										setChosen((x) => [...x, { ...c, deleted: false, blocking: blocks({ ...c, deleted: false }) }])
									}
									className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-left hover:bg-hover disabled:cursor-not-allowed disabled:opacity-45"
								>
									<Icon icon={Add01Icon} size={16} className="flex-none text-text-3" />
									<span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{c.title}</span>
									{isSettled(c.status) ? <span className="text-sm text-text-3">{STATUS_LABEL[c.status]}</span> : null}
								</button>
							</li>
						))}
					</ul>
				)}
				{full ? <p className="px-1 text-sm text-text-3">A task can wait for at most 50 others.</p> : null}
			</div>
			<div className="flex justify-end gap-2">
				<Button variant="ghost" size="sm" onClick={onCancel}>
					Cancel
				</Button>
				<Button variant="primary" size="sm" disabled={!changed} onClick={() => onSave(chosen)}>
					Save
				</Button>
			</div>
		</div>
	);
}

const NEVER = "never";
type RuleDraft = { frequency: Frequency | typeof NEVER; ends: "never" | "on"; until: string; time: string };
const draftOf = (r: (Rule & { stopped?: boolean }) | null): RuleDraft =>
	r && !r.stopped
		? { frequency: r.frequency, ends: r.until ? "on" : "never", until: r.until ?? "", time: r.localTime ?? "" }
		: { frequency: "weekly", ends: "never", until: "", time: "" };

/**
 * Repeats (REQ-TSK-007). Marking a repeating task done adds the next one, one interval after its due date (or after the
 * day it was done when it has none), with fresh steps. Stopping keeps every earlier occurrence and its history. A task
 * a meeting created cannot repeat. An Owner or Admin changes the rule.
 */
export function Repeats({
	task,
	occurrence,
	canEdit,
	editing,
	draft,
	year,
	onEdit,
	onCancel,
	onSave,
	onOpen,
}: {
	task: Pick<TaskDetail, "id" | "recurrence">;
	occurrence: Occurrence | null;
	canEdit: boolean;
	editing: boolean;
	draft?: Rule | null;
	year: number;
	onEdit: () => void;
	onCancel: () => void;
	onSave: (rule: Rule | null) => void;
	onOpen: (id: string) => void;
}) {
	const opener = useReturnFocus(editing);
	const r = task.recurrence;
	if (!r && !canEdit) return null;
	const live = r && !r.stopped;
	const other =
		occurrence?.status === "series" && occurrence.open && occurrence.open.taskId !== task.id ? occurrence.open : null;
	return (
		<Section
			title="Repeats"
			action={
				canEdit && !editing ? (
					<Button ref={opener} variant="ghost" size="sm" onClick={onEdit}>
						{live ? "Change" : "Make it repeat"}
					</Button>
				) : null
			}
		>
			{editing ? (
				<RepeatEditor
					initial={draftOf(draft === undefined ? r : draft)}
					stoppable={Boolean(live)}
					onCancel={onCancel}
					onSave={onSave}
				/>
			) : (
				<div className="flex flex-col gap-1">
					<p className="flex items-center gap-2 text-ink">
						<Icon icon={RepeatIcon} size={16} className={live ? "text-ink-2" : "text-text-3"} />
						{live ? repeatText(r, year) : r ? "Stopped repeating" : "Does not repeat"}
					</p>
					<p className="text-sm text-text-3">
						{live
							? "Marking it done adds the next one, with fresh steps."
							: r
								? "Earlier occurrences and their history stay."
								: null}
					</p>
					{other ? (
						<p className="flex flex-wrap items-center gap-x-2 text-sm text-text-2">
							Occurrence {other.occurrence} is the open one.
							<Button variant="ghost" size="sm" onClick={() => onOpen(other.taskId)}>
								Open it
							</Button>
						</p>
					) : null}
				</div>
			)}
		</Section>
	);
}

function RepeatEditor({
	initial,
	stoppable,
	onCancel,
	onSave,
}: {
	initial: RuleDraft;
	stoppable: boolean;
	onCancel: () => void;
	onSave: (rule: Rule | null) => void;
}) {
	const [d, setD] = useState(initial);
	const form = useRef<HTMLFormElement>(null);
	useInlineForm(form, onCancel);
	const [touched, setTouched] = useState(false);
	const set = (patch: Partial<RuleDraft>) => setD((x) => ({ ...x, ...patch }));
	const untilError = touched && d.ends === "on" && !/^\d{4}-\d{2}-\d{2}$/.test(d.until) ? "Pick the last day." : null;
	const submit = (e: FormEvent) => {
		e.preventDefault();
		setTouched(true);
		if (d.frequency === NEVER) return onSave(null);
		if (d.ends === "on" && !/^\d{4}-\d{2}-\d{2}$/.test(d.until)) return;
		onSave({
			frequency: d.frequency,
			until: d.ends === "on" ? (d.until as Rule["until"]) : null,
			localTime: /^\d{2}:\d{2}$/.test(d.time) ? d.time : null,
		});
	};
	const repeats = d.frequency !== NEVER;
	return (
		<form ref={form} onSubmit={submit} className="flex flex-col gap-3 rounded-md bg-surface p-3" noValidate>
			<Field label="How often">
				<Select
					value={d.frequency}
					onValueChange={(v) => set({ frequency: v as RuleDraft["frequency"] })}
					options={[
						...FREQUENCIES.map((f) => ({ value: f, label: FREQUENCY_LABEL[f] })),
						...(stoppable ? [{ value: NEVER, label: "Stop repeating" }] : []),
					]}
				/>
			</Field>
			{repeats ? (
				<>
					<div className="grid grid-cols-2 gap-3 max-app-sm:grid-cols-1">
						<Field label="Ends">
							<Select
								value={d.ends}
								onValueChange={(v) => set({ ends: v === "on" ? "on" : "never" })}
								options={[
									{ value: "never", label: "No end date" },
									{ value: "on", label: "On a day" },
								]}
							/>
						</Field>
						{d.ends === "on" ? (
							<Field label="Last day" error={untilError} hint="An occurrence on this day still counts.">
								<Input type="date" value={d.until} onChange={(e) => set({ until: e.target.value })} />
							</Field>
						) : null}
					</div>
					<Field
						label="Time of day"
						optional
						hint="Later occurrences are due at this time in the church’s time zone. Leave it empty to keep this task’s kind of due date."
					>
						<Input type="time" value={d.time} onChange={(e) => set({ time: e.target.value })} />
					</Field>
				</>
			) : (
				<p className="text-sm text-text-2">No more occurrences are added. Earlier ones and their history stay.</p>
			)}
			<div className="flex justify-end gap-2">
				<Button variant="ghost" size="sm" onClick={onCancel}>
					Cancel
				</Button>
				<Button variant="primary" size="sm" type="submit">
					{repeats ? "Save" : "Stop repeating"}
				</Button>
			</div>
		</form>
	);
}
