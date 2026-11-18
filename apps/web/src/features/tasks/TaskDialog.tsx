"use client";

import { Task01Icon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { Field, Input, Radio, RadioGroup, SearchInput, Select, Spinner, Textarea } from "@everyfield/ui/controls";
import { DESCRIPTION_EXCERPT, MAX_DESCRIPTION, normalizeDescription } from "@everyfield/contracts/tasks";
import { createDebouncer } from "@everyfield/ui/foundations";
import { useRef, useState } from "react";
import { createRead, useRead } from "../../components/read.tsx";
import { RecordDialog } from "../../components/save/parts.tsx";
import type { Wait } from "../../components/save/model.ts";
import { offsetText } from "../../components/dates.ts";
import { createTask, editTask } from "./actions.ts";
import { AssigneePicker, forgetAssignees } from "./AssigneePicker.tsx";
import { relationOptions } from "./fetch.ts";
import {
	CATEGORIES,
	CATEGORY_LABEL,
	DUE_KIND_LABEL,
	dueDraftOf,
	dueInputOf,
	heldAssignees,
	noticingIneligible,
	PRIORITIES,
	PRIORITY_LABEL,
	problemText,
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
	type Viewer,
} from "./model.ts";

type RelationKind = "person" | "meeting" | "team";
type Relation = { kind: RelationKind; id: string; label: string } | null;
type Draft = {
	title: string;
	description: string;
	priority: Priority;
	category: Category;
	due: DueDraft;
	assigneeIds: string[];
	assigneeNames: Record<string, string>;
	relation: Relation;
	ineligible?: string;
};
export type Commit = {
	before: TaskDetail | null;
	preview: TaskItem;
	send: (key: string) => Promise<Outcome<Saved>>;
	draft: Draft;
};
type Choices = Extract<TaskError, { code: "ambiguous_local_time" }>["details"]["choices"];
type TimeQuestion = { kind: "skipped" } | { kind: "repeated"; choices: Choices } | null;
const RELATION_PLURAL = { person: "people", meeting: "meetings", team: "teams" } as const;
const relations = createRead((kind: RelationKind, search: string) => relationOptions(kind, search), {
	failed: () => ({ status: "lost" }) as const,
});

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

export type EditForm = {
	kind: "edit";
	task: TaskDetail | null;
	draft?: Draft;
	choices?: Choices;
	problem?: string;
};

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
	latest: TaskDetail | null;
	viewer: Viewer;
	wait: Wait;
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
	const initial = draftOf(task, viewer);
	const [draft, setDraft] = useState(() =>
		form.draft ? rebase(form.draft, draftOf(form.task, viewer), initial) : initial,
	);
	const [touched, setTouched] = useState(false);
	const [problem, setProblem] = useState(() =>
		form.problem === "owner_ineligible" && form.draft
			? problemText("owner_ineligible", form.draft.assigneeNames[form.draft.ineligible ?? ""])
			: (refusal ?? null),
	);
	const [asked, setAsked] = useState<TimeQuestion>(() =>
		form.problem === "nonexistent_local_time"
			? { kind: "skipped" }
			: form.choices
				? { kind: "repeated", choices: [...form.choices].sort((a, b) => a.instant.localeCompare(b.instant)) }
				: null,
	);
	const gap = asked?.kind === "skipped";
	const fold = asked?.kind === "repeated" ? asked.choices : null;
	const foldBox = useRef<HTMLDivElement>(null);
	const managed = task?.managed ?? null;
	const set = (patch: Partial<Draft>) => {
		setDraft((d) => ({ ...d, ...patch }));
		setProblem(null);
	};
	const setDue = (patch: Partial<DueDraft>) => {
		setDraft((d) => ({ ...d, due: { ...d.due, ...patch, offsetSeconds: undefined } }));
		setAsked(null);
		setProblem(null);
	};

	const title = draft.title.trim();
	const due = dueInputOf(draft.due);
	const titleError = touched && !title ? "Enter what needs doing." : null;
	const dateError = touched && !due.ok && due.field === "date" ? "Pick a day." : null;
	const timeError = gap ? "Pick another time." : touched && !due.ok && due.field === "time" ? "Pick a time." : null;

	const descriptionLength = normalizeDescription(draft.description).length;
	const descriptionError =
		descriptionLength > MAX_DESCRIPTION
			? `A description can be at most ${MAX_DESCRIPTION.toLocaleString("en-US")} characters. This one has ${descriptionLength.toLocaleString("en-US")}.`
			: null;

	function submit(): boolean {
		setTouched(true);
		if (!title || !due.ok || descriptionError) return false;
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
		const committed: Draft = { ...draft, ineligible: undefined };
		send = noticingIneligible(send, forgetAssignees, (accountId) => (committed.ineligible = accountId));
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
			excerpt: "",
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
			excerpt: normalizeDescription(draft.description).slice(0, DESCRIPTION_EXCERPT),
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
		onCommit({ before: task, preview, send, draft: committed });
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
			<Field
				label="Description"
				optional
				hint="Simple formatting works: lists, **bold**, *italic* and links."
				error={descriptionError}
			>
				<Textarea value={draft.description} rows={3} onChange={(e) => set({ description: e.target.value })} />
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
					names={draft.assigneeNames}
					current={task?.assignees ?? []}
					owners={task?.followUpOwners ?? []}
					refused={draft.ineligible}
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
	names,
	current,
	owners,
	refused,
	viewer,
	onChange,
}: {
	value: string[];
	followUp: boolean;
	names: Record<string, string>;
	current: TaskItem["assignees"];
	refused?: string;
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
				held={heldAssignees(value, names, current, owners, refused)}
				viewerId={viewer.accountId}
			/>
		</Field>
	);
}

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
	const [query, setQuery] = useState("");
	const [{ run: afterPause, cancel, cancelOnDetach }] = useState(() => createDebouncer(250));
	const read = useRead(kind === "none" || locked ? null : relations, kind === "none" ? "person" : kind, query);
	const found =
		read.value === undefined
			? ("loading" as const)
			: read.value.status === "ok"
				? read.value.value.items
				: ("failed" as const);
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
						if (k !== "none" && !locked) relations.prefetch(k as RelationKind, "");
						setKind(k as RelationKind | "none");
						cancel();
						setQuery("");
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
						key={kind}
						ref={cancelOnDetach}
						aria-label={`Search ${RELATION_PLURAL[kind]}`}
						placeholder={`Search ${RELATION_PLURAL[kind]}`}
						maxLength={200}
						onChange={(e) => {
							const text = e.target.value;
							if (text) return afterPause(() => setQuery(text));
							cancel();
							setQuery("");
						}}
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
							aria-label={`Choose a ${kind}`}
							value={value?.kind === kind ? value.id : ""}
							onValueChange={(id) => {
								const hit = listed.find((c) => c.id === id);
								if (hit) onChange({ kind, id: hit.id, label: hit.label });
							}}
							className="max-h-[220px] gap-y-0 overflow-y-auto px-1"
						>
							{listed.map((c) => (
								<Radio key={c.id} value={c.id} label={c.label} />
							))}
						</RadioGroup>
					)}
				</div>
			) : null}
		</div>
	);
}
