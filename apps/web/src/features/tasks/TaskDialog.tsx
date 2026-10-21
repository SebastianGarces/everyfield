"use client";

import { Task01Icon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Field,
	Input,
	Radio,
	RadioGroup,
	SearchInput,
	Select,
	Spinner,
	Textarea,
} from "@everyfield/ui/controls";
import { Icon } from "@everyfield/ui/foundations";
import { Alert02Icon } from "@hugeicons/core-free-icons";
import { useEffect, useRef, useState } from "react";
import { assigneeOptions, createTask, editTask, relationOptions } from "./actions.ts";
import {
	CATEGORIES,
	CATEGORY_LABEL,
	DUE_KIND_LABEL,
	dueDraftOf,
	dueInputOf,
	offsetText,
	PRIORITIES,
	PRIORITY_LABEL,
	problemText,
	RequestKeys,
	sameDue,
	timeText,
	type Category,
	type DueDraft,
	type Priority,
	type Saved,
	type TaskDetail,
	type TaskError,
	type TaskItem,
} from "./model.ts";
import type { Viewer } from "./TasksScreen.tsx";

type RelationKind = "person" | "meeting" | "team";
type Relation = { kind: RelationKind; id: string; label: string } | null;
type Draft = {
	title: string;
	description: string;
	priority: Priority;
	category: Category;
	due: DueDraft;
	assigneeId: string;
	relation: Relation;
};
type Choices = Extract<TaskError, { code: "ambiguous_local_time" }>["details"]["choices"];
const NOBODY = "nobody";
const RELATION_NAME = { person: "person", meeting: "meeting", team: "team" } as const;
const RELATION_PLURAL = { person: "people", meeting: "meetings", team: "teams" } as const;

function draftOf(task: TaskDetail | null, viewer: Viewer): Draft {
	if (!task)
		return {
			title: "",
			description: "",
			priority: "medium",
			category: "general",
			due: { kind: "undated", date: "", time: "" },
			assigneeId: viewer.accountId,
			relation: null,
		};
	return {
		title: task.title,
		description: task.description ?? "",
		priority: task.priority,
		category: task.category,
		due: dueDraftOf(task.due),
		assigneeId: task.assignee?.accountId ?? NOBODY,
		relation: task.relation,
	};
}

// The church's seats change rarely, so one read serves the dialog until it closes. Intent on New task starts it.
let seats: ReturnType<typeof assigneeOptions> | null = null;
export const warmAssignees = () => (seats ??= assigneeOptions().catch(() => ({ status: "lost" }) as const));

/**
 * New task and Edit task (REQ-TSK-002, REQ-TSK-018). A due date is a day, a church-local time or nothing. A time the
 * clocks skip is refused with a request for another time; a time the clocks repeat shows both occurrences and saves
 * only after the person picks one (B03-008, B03-009). A task a meeting created keeps its category and link.
 */
export function TaskDialog({
	task,
	viewer,
	onClose,
	onSaved,
	onConflict,
}: {
	task: TaskDetail | "new" | null;
	viewer: Viewer;
	onClose: () => void;
	onSaved: (before: TaskItem | null, saved: Saved) => void;
	onConflict: (id: string) => void;
}) {
	return (
		<Dialog open={task !== null} onOpenChange={(o) => !o && onClose()}>
			{task !== null ? (
				<Form key={task === "new" ? "new" : `${task.id}:${task.revision}`} task={task === "new" ? null : task} {...{ viewer, onClose, onSaved, onConflict }} />
			) : null}
		</Dialog>
	);
}

function Form({
	task,
	viewer,
	onClose,
	onSaved,
	onConflict,
}: {
	task: TaskDetail | null;
	viewer: Viewer;
	onClose: () => void;
	onSaved: (before: TaskItem | null, saved: Saved) => void;
	onConflict: (id: string) => void;
}) {
	const [initial] = useState(() => draftOf(task, viewer));
	const [draft, setDraft] = useState(initial);
	const [pending, setPending] = useState(false);
	const [touched, setTouched] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const [gap, setGap] = useState(false);
	const [fold, setFold] = useState<Choices | null>(null);
	const keys = useRef(new RequestKeys());
	const managed = task?.managed ?? null;
	const set = (patch: Partial<Draft>) => {
		setDraft((d) => ({ ...d, ...patch }));
		setProblem(null);
	};
	const setDue = (patch: Partial<DueDraft>) => {
		// A new day or time is a new question: an earlier occurrence choice or skipped-time warning no longer applies.
		setDraft((d) => ({ ...d, due: { ...d.due, ...patch, offsetSeconds: undefined } }));
		setGap(false);
		setFold(null);
		setProblem(null);
	};

	const title = draft.title.trim();
	const due = dueInputOf(draft.due);
	const titleError = touched && !title ? "Enter what needs doing." : null;
	const dateError = touched && !due.ok && due.field === "date" ? "Pick a day." : null;
	const timeError = gap
		? problemText("nonexistent_local_time")
		: touched && !due.ok && due.field === "time"
			? "Pick a time."
			: null;

	useEffect(() => () => void (seats = null), []);

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		setTouched(true);
		if (!title || !due.ok || pending) return;
		if (fold && draft.due.offsetSeconds === undefined) return setProblem("Choose which time you mean.");
		const assigneeId = draft.assigneeId === NOBODY ? null : draft.assigneeId;
		const relation = draft.relation ? { kind: draft.relation.kind, id: draft.relation.id } : null;
		const description = draft.description.trim() === "" ? null : draft.description;
		let call: (key: string) => ReturnType<typeof createTask>;
		let payload: unknown;
		if (!task) {
			payload = {
				title,
				description,
				priority: draft.priority,
				category: draft.category,
				due: due.due,
				assigneeId,
				relation,
			};
			call = (key) => createTask(key, payload);
		} else {
			const patch: Record<string, unknown> = {};
			if (title !== initial.title) patch.title = title;
			if ((description ?? "") !== initial.description) patch.description = description;
			if (draft.priority !== initial.priority) patch.priority = draft.priority;
			if (draft.category !== initial.category) patch.category = draft.category;
			if (!sameDue(draft.due, initial.due)) patch.due = due.due;
			if (draft.assigneeId !== initial.assigneeId) patch.assigneeId = assigneeId;
			if (draft.relation?.id !== initial.relation?.id || draft.relation?.kind !== initial.relation?.kind)
				patch.relation = relation;
			if (Object.keys(patch).length === 0) return onClose();
			payload = { revision: task.revision, patch };
			call = (key) => editTask(key, task.revision, task.id, patch);
		}
		const slot = task ? `edit:${task.id}` : "create";
		const key = keys.current.for(slot, payload);
		setPending(true);
		const r = await call(key).catch(() => ({ status: "lost" }) as const);
		keys.current.settle(slot, r);
		setPending(false);
		if (r.status === "ok") return onSaved(task, r.value);
		if (r.status === "lost") return setProblem(problemText("lost"));
		if (r.code === "ambiguous_local_time" && r.error?.code === "ambiguous_local_time") {
			setFold([...r.error.details.choices].sort((a, b) => a.instant.localeCompare(b.instant)));
			return setProblem(problemText("ambiguous_local_time"));
		}
		if (r.code === "nonexistent_local_time") return setGap(true);
		if (r.code === "conflict" && task) onConflict(task.id);
		setProblem(problemText(r.code));
	}

	return (
		<DialogContent size="md" aria-busy={pending || undefined}>
			<form onSubmit={submit} noValidate className="contents">
				<DialogHeader
					icon={task ? PencilEdit02Icon : Task01Icon}
					tone="green"
					title={task ? "Edit task" : "New task"}
					description={task ? undefined : "Say what needs doing. Everything else is optional."}
				/>
				<DialogBody className="flex flex-col gap-4">
					<Field label="Title" error={titleError}>
						<Input
							value={draft.title}
							readOnly={pending}
							maxLength={500}
							autoComplete="off"
							autoFocus
							onChange={(e) => set({ title: e.target.value })}
						/>
					</Field>
					<Field label="Description" optional>
						<Textarea
							value={draft.description}
							readOnly={pending}
							maxLength={10_000}
							rows={3}
							onChange={(e) => set({ description: e.target.value })}
						/>
					</Field>
					<div className="grid grid-cols-2 gap-4 max-app-sm:grid-cols-1">
						<Field label="Due">
							<Select
								value={draft.due.kind}
								disabled={pending}
								onValueChange={(kind) => setDue({ kind: kind as DueDraft["kind"] })}
								options={(["undated", "local_date", "resolved_instant"] as const).map((k) => ({
									value: k,
									label: DUE_KIND_LABEL[k],
								}))}
							/>
						</Field>
						<AssigneeField
							value={draft.assigneeId}
							current={task?.assignee ?? null}
							viewer={viewer}
							disabled={pending}
							onChange={(assigneeId) => set({ assigneeId })}
						/>
						{draft.due.kind !== "undated" ? (
							<Field label="Day" error={dateError}>
								<Input type="date" value={draft.due.date} readOnly={pending} onChange={(e) => setDue({ date: e.target.value })} />
							</Field>
						) : null}
						{draft.due.kind === "resolved_instant" ? (
							<Field label="Time" hint="In the church’s time zone." error={timeError}>
								<Input type="time" value={draft.due.time} readOnly={pending} onChange={(e) => setDue({ time: e.target.value })} />
							</Field>
						) : null}
					</div>
					{fold && draft.due.kind === "resolved_instant" ? (
						<fieldset className="flex flex-col gap-1 rounded-md bg-surface px-4 py-3">
							<legend className="text-sm font-medium text-ink-2">Which {timeText(draft.due.time)}?</legend>
							<RadioGroup
								aria-label={`Which ${timeText(draft.due.time)}`}
								value={draft.due.offsetSeconds === undefined ? "" : String(draft.due.offsetSeconds)}
								onValueChange={(v) => {
									setDraft((d) => ({ ...d, due: { ...d.due, offsetSeconds: Number(v) } }));
									setProblem(null);
								}}
							>
								{fold.map((c, i) => (
									<Radio
										key={c.offsetSeconds}
										value={String(c.offsetSeconds)}
										disabled={pending}
										label={`${i === 0 ? "The first" : "The second"} ${timeText(draft.due.time)}`}
										description={`${i === 0 ? "Before" : "After"} the clocks go back (${offsetText(c.offsetSeconds)})`}
									/>
								))}
							</RadioGroup>
						</fieldset>
					) : null}
					<div className="grid grid-cols-2 gap-4 max-app-sm:grid-cols-1">
						<Field label="Priority">
							<Select
								value={draft.priority}
								disabled={pending}
								onValueChange={(v) => set({ priority: v as Priority })}
								options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
							/>
						</Field>
						<Field label="Category" hint={managed ? "Set by the meeting that created this task." : undefined}>
							<Select
								value={draft.category}
								disabled={pending || Boolean(managed)}
								onValueChange={(v) => set({ category: v as Category })}
								options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))}
							/>
						</Field>
					</div>
					<RelationField value={draft.relation} locked={Boolean(managed)} disabled={pending} onChange={(relation) => set({ relation })} />
					<div aria-live="assertive" className="empty:hidden">
						{problem ? (
							<p className="flex items-start gap-2 rounded-md bg-magenta-50 px-3.5 py-2.5 text-sm text-magenta-600">
								<Icon icon={Alert02Icon} size={16} className="mt-px flex-none" />
								{problem}
							</p>
						) : null}
					</div>
				</DialogBody>
				<DialogFooter>
					<Button variant="secondary" type="button" onClick={onClose} disabled={pending}>
						Cancel
					</Button>
					<Button variant="primary" type="submit" loading={pending}>
						{task ? "Save changes" : "Add task"}
					</Button>
				</DialogFooter>
			</form>
		</DialogContent>
	);
}

function AssigneeField({
	value,
	current,
	viewer,
	disabled,
	onChange,
}: {
	value: string;
	current: TaskItem["assignee"];
	viewer: Viewer;
	disabled: boolean;
	onChange: (v: string) => void;
}) {
	const [options, setOptions] = useState<{ value: string; label: string }[] | "failed" | null>(null);
	useEffect(() => {
		let live = true;
		warmAssignees().then((r) => {
			if (!live) return;
			if (r.status !== "ok") {
				seats = null;
				return setOptions("failed");
			}
			setOptions(
				r.value.items.map((s) => ({
					value: s.accountId,
					label: s.accountId === viewer.accountId ? `${s.displayName} (you)` : s.displayName,
				})),
			);
		});
		return () => void (live = false);
	}, [viewer.accountId]);
	// Until the seats arrive, the choice shows the known names, so the field never looks empty.
	const known = [
		{ value: NOBODY, label: "No one yet" },
		...(Array.isArray(options)
			? options
			: [
					{ value: viewer.accountId, label: `${viewer.name ?? "You"} (you)` },
					...(current && current.accountId !== viewer.accountId
						? [{ value: current.accountId, label: current.displayName || "A former member" }]
						: []),
				]),
	];
	if (!known.some((o) => o.value === value) && current?.accountId === value)
		known.push({ value, label: `${current.displayName || "A former member"} (no longer has a seat)` });
	return (
		<Field
			label="Assigned to"
			hint={
				options === "failed"
					? "The list of people did not load. Close the dialog and open it again."
					: value === NOBODY
						? "The task shows Needs owner until someone holds it."
						: undefined
			}
		>
			<Select value={value} disabled={disabled} onValueChange={onChange} options={known} />
		</Field>
	);
}

/** Linked to: nothing, or one live person, meeting or team of the church, found by name. */
function RelationField({
	value,
	locked,
	disabled,
	onChange,
}: {
	value: Relation;
	locked: boolean;
	disabled: boolean;
	onChange: (v: Relation) => void;
}) {
	const [kind, setKind] = useState<RelationKind | "none">(value?.kind ?? "none");
	const [search, setSearch] = useState("");
	const [found, setFound] = useState<{ id: string; label: string }[] | "loading" | "failed">([]);
	const seq = useRef(0);
	useEffect(() => {
		if (kind === "none" || locked) return;
		const n = ++seq.current;
		const timer = setTimeout(
			() => {
				setFound("loading");
				relationOptions(kind, search)
					.catch(() => ({ status: "lost" }) as const)
					.then((r) => n === seq.current && setFound(r.status === "ok" ? r.value.items : "failed"));
			},
			search ? 250 : 0,
		);
		return () => clearTimeout(timer);
	}, [kind, search, locked]);
	if (locked)
		return (
			<Field label="Linked to" hint="Set by the meeting that created this task.">
				<Input value={value ? value.label : "Nothing"} readOnly disabled />
			</Field>
		);
	const choices = Array.isArray(found) ? found : [];
	const listed = value && value.kind === kind && !choices.some((c) => c.id === value.id) ? [value, ...choices] : choices;
	return (
		<div className="flex flex-col gap-3">
			<Field label="Linked to" optional>
				<Select
					value={kind}
					disabled={disabled}
					onValueChange={(k) => {
						setKind(k as RelationKind | "none");
						setSearch("");
						if (k === "none" || k !== value?.kind) onChange(null);
					}}
					options={[
						{ value: "none", label: "Nothing" },
						{ value: "person", label: "A person" },
						{ value: "meeting", label: "A meeting" },
						{ value: "team", label: "A team" },
					]}
				/>
			</Field>
			{kind !== "none" ? (
				<div className="flex flex-col gap-2 rounded-md bg-surface p-3">
					<SearchInput
						aria-label={`Search ${RELATION_PLURAL[kind]}`}
						placeholder={`Search ${RELATION_PLURAL[kind]}`}
						value={search}
						maxLength={200}
						disabled={disabled}
						onChange={(e) => setSearch(e.target.value)}
					/>
					{found === "loading" && listed.length === 0 ? (
						<p className="flex items-center gap-2 px-1 py-2 text-sm text-text-3" role="status">
							<Spinner size={14} /> Looking for {RELATION_PLURAL[kind]}…
						</p>
					) : found === "failed" ? (
						<p className="px-1 py-2 text-sm text-magenta-600" role="alert">
							The {RELATION_PLURAL[kind]} did not load. Change the search to try again.
						</p>
					) : listed.length === 0 ? (
						<p className="px-1 py-2 text-sm text-text-3">No {RELATION_PLURAL[kind]} match.</p>
					) : (
						<RadioGroup
							aria-label={`Choose a ${RELATION_NAME[kind]}`}
							value={value?.kind === kind ? value.id : ""}
							onValueChange={(id) => {
								const hit = listed.find((c) => c.id === id);
								if (hit) onChange({ kind, id: hit.id, label: hit.label });
							}}
							className="max-h-[220px] gap-0 overflow-y-auto px-1"
						>
							{listed.map((c) => (
								<Radio key={c.id} value={c.id} label={c.label} disabled={disabled} className="py-2" />
							))}
						</RadioGroup>
					)}
				</div>
			) : null}
		</div>
	);
}
