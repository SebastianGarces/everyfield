"use client";

import { Task01Icon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { Field, Input, Radio, RadioGroup, SearchInput, Select, Spinner, Textarea } from "@everyfield/ui/controls";
import { useEffect, useRef, useState } from "react";
import { RecordDialog } from "../../components/save/parts.tsx";
import type { Wait } from "../../components/save/model.ts";
import { createTask, editTask } from "./actions.ts";
import { AssigneePicker } from "./AssigneePicker.tsx";
import { relationOptions } from "./fetch.ts";
import {
	CATEGORIES,
	CATEGORY_LABEL,
	DUE_KIND_LABEL,
	dueDraftOf,
	dueInputOf,
	offsetText,
	ownerWarning,
	PRIORITIES,
	PRIORITY_LABEL,
	previewOverdue,
	rebase,
	sameDue,
	timeText,
	PENDING_PREFIX,
	type Category,
	type Due,
	type DueDraft,
	type Outcome,
	type Priority,
	type Saved,
	type TaskDetail,
	type TaskError,
	type TaskItem,
} from "./model.ts";
import type { Viewer } from "./TasksScreen.tsx";

type RelationKind = "person" | "meeting" | "team";
type Relation = { kind: RelationKind; id: string; label: string } | null;
export type Draft = {
	title: string;
	description: string;
	priority: Priority;
	category: Category;
	due: DueDraft;
	assigneeIds: string[];
	/** Each chosen assignee's name as the form shows it, for the row before the server answers. */
	assigneeNames: Record<string, string>;
	relation: Relation;
};
/**
 * A save the screen shows before the answer: the row as it will be, the request and the person's text (the form opens
 * again with it after a refusal). `send` takes the save intent's request key; the revision is the one the form showed.
 */
export type Commit = {
	before: TaskDetail | null;
	preview: TaskItem;
	send: (key: string) => Promise<Outcome<Saved>>;
	draft: Draft;
};
export type Choices = Extract<TaskError, { code: "ambiguous_local_time" }>["details"]["choices"];
const RELATION_NAME = { person: "person", meeting: "meeting", team: "team" } as const;
const RELATION_PLURAL = { person: "people", meeting: "meetings", team: "teams" } as const;

/** The warning a person already on the task earns beside their name, or null when they may still hold it. */
function heldWarning(accountId: string, owners: TaskItem["followUpOwners"]) {
	const view = owners.find((o) => o.accountId === accountId);
	return view ? ownerWarning(view) : null;
}

function draftOf(task: TaskDetail | null, viewer: Viewer): Draft {
	if (!task)
		return {
			title: "",
			description: "",
			priority: "medium",
			category: "general",
			due: { kind: "undated", date: "", time: "" },
			assigneeIds: [viewer.accountId],
			assigneeNames: { [viewer.accountId]: viewer.name ?? "" },
			relation: null,
		};
	return {
		title: task.title,
		description: task.description ?? "",
		priority: task.priority,
		category: task.category,
		due: dueDraftOf(task.due),
		assigneeIds: task.assignees.map((a) => a.accountId),
		assigneeNames: Object.fromEntries(task.assignees.map((a) => [a.accountId, a.displayName])),
		relation: task.relation,
	};
}

/**
 * The task form on its card's save lane (C58): the task it was opened on, or null for a new task, and after a refused
 * save the person's values with the server's question, so the form opens again where they left it.
 */
export type EditForm = {
	kind: "edit";
	task: TaskDetail | null;
	draft?: Draft;
	/** The two occurrences of a time the clocks repeat, from the server's refusal. */
	choices?: Choices;
	problem?: string;
};

/**
 * New task and Edit task (REQ-TSK-002, REQ-TSK-018). A due date is a day, a church-local time or nothing. A time the
 * clocks skip is refused with a request for another time; a time the clocks repeat shows both occurrences and saves
 * only after the person picks one (B03-008, B03-009). A task a meeting created keeps its category and link. Every save
 * closes the form and shows at once on the list; a refusal opens the form again on the newest copy of the task with
 * the person's own changes on top (R4-2).
 */
export function TaskDialog({
	form,
	latest,
	viewer,
	wait,
	problem,
	onClose,
	onCommit,
}: {
	form: EditForm | null;
	/** The newest copy of the edited task this screen holds (a conflict reads it again), or null for a new task. */
	latest: TaskDetail | null;
	viewer: Viewer;
	/** The card's save in flight or unknown: the form keeps its values and cannot submit (C68). */
	wait: Wait;
	/** Why the last save of this form was refused, in words. */
	problem?: string;
	onClose: () => void;
	onCommit: (c: Commit) => void;
}) {
	if (!form) return null;
	const task = form.task ? (latest ?? form.task) : null;
	return (
		<Form
			key={task ? `${task.id}:${task.revision}` : "new"}
			{...{ form, task, viewer, wait, problem, onClose, onCommit }}
		/>
	);
}

function Form({
	form,
	task,
	viewer,
	wait,
	problem: refusal,
	onClose,
	onCommit,
}: {
	form: EditForm;
	task: TaskDetail | null;
	viewer: Viewer;
	wait: Wait;
	problem?: string;
	onClose: () => void;
	onCommit: (c: Commit) => void;
}) {
	const [initial] = useState(() => draftOf(task, viewer));
	// The person's changes from a refused save, on top of the newest copy: a field they did not touch shows its new value.
	const [draft, setDraft] = useState(() =>
		form.draft ? rebase(form.draft, draftOf(form.task, viewer), initial) : initial,
	);
	const [touched, setTouched] = useState(false);
	const [problem, setProblem] = useState(refusal ?? null);
	const [gap, setGap] = useState(form.problem === "nonexistent_local_time");
	const [fold, setFold] = useState<Choices | null>(() =>
		form.choices ? [...form.choices].sort((a, b) => a.instant.localeCompare(b.instant)) : null,
	);
	const foldBox = useRef<HTMLDivElement>(null);
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
	const timeError = gap ? "Pick another time." : touched && !due.ok && due.field === "time" ? "Pick a time." : null;

	/** Returns false when the form has missing answers. */
	function submit(): boolean {
		setTouched(true);
		if (!title || !due.ok) return false;
		if (fold && draft.due.offsetSeconds === undefined) {
			setProblem("Choose which time you mean.");
			foldBox.current?.querySelector<HTMLElement>("button")?.focus();
			return true;
		}
		const relation = draft.relation ? { kind: draft.relation.kind, id: draft.relation.id } : null;
		const description = draft.description.trim() === "" ? null : draft.description;
		let send: Commit["send"];
		if (!task) {
			const payload = {
				title,
				description,
				priority: draft.priority,
				category: draft.category,
				due: due.due,
				assigneeIds: draft.assigneeIds,
				relation,
			};
			send = (key) => createTask(key, payload);
		} else {
			const patch: Record<string, unknown> = {};
			if (title !== initial.title) patch.title = title;
			if ((description ?? "") !== initial.description) patch.description = description;
			if (draft.priority !== initial.priority) patch.priority = draft.priority;
			if (draft.category !== initial.category) patch.category = draft.category;
			if (!sameDue(draft.due, initial.due)) patch.due = due.due;
			if (JSON.stringify([...draft.assigneeIds].sort()) !== JSON.stringify([...initial.assigneeIds].sort()))
				patch.assigneeIds = draft.assigneeIds;
			if (draft.relation?.id !== initial.relation?.id || draft.relation?.kind !== initial.relation?.kind)
				patch.relation = relation;
			if (Object.keys(patch).length === 0) {
				onClose();
				return true;
			}
			const revision = task.revision;
			send = (key) => editTask(key, revision, task.id, patch);
		}
		// A new time of day shows its day until the server resolves the instant in the church's time zone.
		const shownDue: Due =
			due.due.kind === "undated"
				? { kind: "undated" }
				: due.due.kind === "local_date"
					? { kind: "local_date", date: due.due.date }
					: task && sameDue(draft.due, initial.due)
						? task.due
						: { kind: "local_date", date: due.due.local.slice(0, 10) as never };
		const base: TaskItem = task ?? {
			id: (PENDING_PREFIX + crypto.randomUUID()) as never,
			revision: "0" as never,
			title,
			status: "not_started",
			priority: draft.priority,
			category: draft.category,
			due: shownDue,
			overdue: null,
			assignees: [],
			followUpOwners: [],
			followUpOrigin: null,
			relation: null,
			parentId: null,
			checklist: { total: 0, complete: 0 },
			openPrerequisites: 0,
			managed: null,
			createdAt: new Date().toISOString() as never,
			completedAt: null,
			deleted: false,
		};
		const preview: TaskItem = {
			...base,
			title,
			priority: draft.priority,
			category: draft.category,
			due: shownDue,
			overdue: task && sameDue(draft.due, initial.due) ? task.overdue : previewOverdue(due.due),
			assignees: draft.assigneeIds.map((id) => ({
				accountId: id as never,
				displayName: draft.assigneeNames[id] ?? task?.assignees.find((a) => a.accountId === id)?.displayName ?? "",
			})),
			followUpOwners: task ? task.followUpOwners.filter((o) => draft.assigneeIds.includes(o.accountId)) : [],
			relation: draft.relation as TaskItem["relation"],
		};
		onCommit({ before: task, preview, send, draft });
		return true;
	}

	return (
		<RecordDialog
			icon={task ? PencilEdit02Icon : Task01Icon}
			tone="green"
			title={task ? "Edit task" : "New task"}
			description={task ? undefined : "Say what needs doing. Everything else is optional."}
			action={task ? "Save changes" : "Add task"}
			problem={problem ?? undefined}
			wait={wait}
			onClose={onClose}
			onSubmit={submit}
		>
			<Field label="Title" error={titleError}>
				<Input
					value={draft.title}
					maxLength={500}
					autoComplete="off"
					onChange={(e) => set({ title: e.target.value })}
				/>
			</Field>
			<Field label="Description" optional>
				<Textarea
					value={draft.description}
					maxLength={10_000}
					rows={3}
					onChange={(e) => set({ description: e.target.value })}
				/>
			</Field>
			<div className="grid grid-cols-2 gap-4 max-app-sm:grid-cols-1">
				<Field label="Due">
					<Select
						value={draft.due.kind}
						onValueChange={(kind) => setDue({ kind: kind as DueDraft["kind"] })}
						options={(["undated", "local_date", "resolved_instant"] as const).map((k) => ({
							value: k,
							label: DUE_KIND_LABEL[k],
						}))}
					/>
				</Field>
				{draft.due.kind !== "undated" ? (
					<Field label="Day" error={dateError}>
						<Input type="date" value={draft.due.date} onChange={(e) => setDue({ date: e.target.value })} />
					</Field>
				) : null}
				{draft.due.kind === "resolved_instant" ? (
					<Field label="Time" hint="In the church’s time zone." error={timeError}>
						<Input type="time" value={draft.due.time} onChange={(e) => setDue({ time: e.target.value })} />
					</Field>
				) : null}
			</div>
			{fold && draft.due.kind === "resolved_instant" ? (
				<div ref={foldBox} className="flex flex-col gap-1 rounded-md bg-surface px-4 pt-3 pb-1">
					<p id="fold-question" className="text-sm font-medium text-ink">
						Which {timeText(draft.due.time)}?
					</p>
					<p className="text-sm text-text-2">
						The clocks go back that night, so {timeText(draft.due.time)} happens twice.
					</p>
					<RadioGroup
						aria-labelledby="fold-question"
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
								label={`${i === 0 ? "The first" : "The second"} ${timeText(draft.due.time)}`}
								description={`${i === 0 ? "Before" : "After"} the clocks go back (${offsetText(c.offsetSeconds)})`}
							/>
						))}
					</RadioGroup>
				</div>
			) : null}
			<div className="grid grid-cols-2 gap-4 max-app-sm:grid-cols-1">
				<AssigneeField
					value={draft.assigneeIds}
					followUp={draft.category === "follow_up" && draft.relation?.kind === "person"}
					current={task?.assignees ?? []}
					owners={task?.followUpOwners ?? []}
					viewer={viewer}
					onChange={(assigneeIds, assigneeNames) => set({ assigneeIds, assigneeNames })}
				/>
				<Field label="Priority">
					<Select
						value={draft.priority}
						onValueChange={(v) => set({ priority: v as Priority })}
						options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
					/>
				</Field>
				<Field label="Category" hint={managed ? "Set by the meeting that created this task." : undefined}>
					<Select
						value={draft.category}
						disabled={Boolean(managed)}
						onValueChange={(v) => set({ category: v as Category })}
						options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))}
					/>
				</Field>
			</div>
			<RelationField value={draft.relation} locked={Boolean(managed)} onChange={(relation) => set({ relation })} />
		</RecordDialog>
	);
}

function AssigneeField({
	value,
	followUp,
	current,
	owners,
	viewer,
	onChange,
}: {
	value: string[];
	/** A follow-up with a person offers only seats that may own one (REQ-TSK-012). */
	followUp: boolean;
	current: TaskItem["assignees"];
	/** The follow-up owner views of the people already on the task, for their warnings. */
	owners: TaskItem["followUpOwners"];
	viewer: Viewer;
	onChange: (ids: string[], names: Record<string, string>) => void;
}) {
	return (
		<Field
			label="Assigned to"
			hint={value.length === 0 ? "The task shows Needs owner until someone holds it." : undefined}
		>
			<AssigneePicker
				value={value}
				onChange={onChange}
				purpose={followUp ? "committed_follow_up" : "any"}
				held={current.map((a) => ({
					accountId: a.accountId,
					displayName: a.displayName,
					warning: heldWarning(a.accountId, owners),
				}))}
				viewerId={viewer.accountId}
			/>
		</Field>
	);
}

/** Linked to: nothing, or one live person, meeting or team of the church, found by name. */
function RelationField({
	value,
	locked,
	onChange,
}: {
	value: Relation;
	locked: boolean;
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
	const listed =
		value && value.kind === kind && !choices.some((c) => c.id === value.id) ? [value, ...choices] : choices;
	return (
		<div className="flex flex-col gap-3">
			<Field label="Linked to" optional>
				<Select
					value={kind}
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
								<Radio key={c.id} value={c.id} label={c.label} className="py-2" />
							))}
						</RadioGroup>
					)}
				</div>
			) : null}
		</div>
	);
}
