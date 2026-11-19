"use client";

import {
	Add01Icon,
	Delete02Icon,
	FilterHorizontalIcon,
	LockKeyIcon,
	MoreHorizontalIcon,
	PencilEdit02Icon,
	SortByDown01Icon,
	Task01Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardTitle,
	Checkbox,
	ConfirmDialog,
	EmptyState,
	FilterChip,
	IconButton,
	Menu,
	MenuContent,
	MenuItem,
	MenuLabel,
	MenuRadioGroup,
	MenuRadioItem,
	MenuSeparator,
	MenuTrigger,
	PageHeader,
	SearchInput,
	SegmentedControl,
	toast,
	buttonVariants,
	IntentLink,
} from "@everyfield/ui/controls";
import { KeyValue, KeyValueList, Pagination, StatusBadge } from "@everyfield/ui/display";
import { cn, createDebouncer, Icon } from "@everyfield/ui/foundations";
import { usePathname, useRouter } from "next/navigation";
import { useId, useOptimistic, useState, useSyncExternalStore, useTransition, type ReactNode } from "react";
import { writeAddress } from "../../components/location.ts";
import type { SaveLane, SaveSpec, Wait } from "../../components/save/model.ts";
import { NoticeInDialog, SaveNotice } from "../../components/save/parts.tsx";
import { useLocalStore, useShallow, useStore } from "../../components/store.ts";
import {
	addStep,
	bulkComplete,
	bulkReschedule,
	changeTaskStatus,
	deleteTask,
	removeStep,
	setPrerequisites,
	setRecurrence,
	setStep,
	type StatusAction,
} from "./actions.ts";
import { BulkBar, BulkReport, type Report } from "./bulk.tsx";
import { loadBlocking, loadRows, loadTask, relationOptions, type Loaded as TaskLoad } from "./fetch.ts";
import {
	blocks,
	withBlockers,
	type Blocker,
	dueText,
	previewOverdue,
	matches,
	NO_PENDING,
	PENDING_PREFIX,
	bulkActions,
	shownRows,
	withChange,
	CATEGORIES,
	CATEGORY_LABEL,
	clearFilters,
	countsAfter,
	DUE_KIND_LABEL,
	DUE_KINDS,
	groupsOf,
	isFiltered,
	isSettled,
	OPEN_STATUSES,
	pageCount,
	PRIORITIES,
	PRIORITY_LABEL,
	parseQuery,
	problemText,
	querySearch,
	rangeText,
	RELATION_LABEL,
	RELATIONS,
	SORT_LABEL,
	SORTS,
	STATUS_LABEL,
	STATUSES,
	tallyOf,
	withFilters,
	type Group,
	type Outcome,
	type Saved,
	type Status,
	type TaskCounts,
	type TaskDetail,
	type TaskItem,
	type TaskQuery,
	type BulkResult,
	type OpenOffer,
	type DueInput,
	type Prerequisite,
	type Rule,
	type Step,
	type Viewer,
} from "./model.ts";
import { DescriptionPreview } from "./description.ts";
import { Assignee, DoneBox, intentHandlers, MetaLine, StatusItems } from "./parts.tsx";
import type { StepAssignee } from "./structure.tsx";
import { warmAssignees } from "./AssigneePicker.tsx";
import { TaskDialog, type Commit, type EditForm } from "./TaskDialog.tsx";
import { TaskSheet, type DetailState } from "./TaskSheet.tsx";
import {
	BULK,
	createTasksPageStore,
	createTasksStore,
	NEW,
	type TaskForm,
	type TasksPageState,
} from "./TasksScreen.store.ts";
import { PhaseOffer } from "./PhaseOffer.tsx";
import { Templates } from "./Templates.tsx";

export type TasksAnswer = {
	query: TaskQuery;
	page: { items: TaskItem[]; total: number; page: number };
	counts: TaskCounts;
	opened: TaskLoad | null;
	offer: OpenOffer | null;
};

const GROUP: Record<Group["key"], { label: string; tone: "risk" | "measured" | "unknown" | "positive" } | null> = {
	overdue: { label: "Overdue", tone: "risk" },
	upcoming: { label: "Upcoming", tone: "measured" },
	undated: { label: "No due date", tone: "unknown" },
	settled: { label: "Closed", tone: "positive" },
	all: null,
};
const lost = { status: "lost" } as const;
const targetOf = (a: StatusAction): Status =>
	a.kind === "complete"
		? "complete"
		: a.kind === "reopen"
			? "not_started"
			: a.kind === "waive"
				? "no_longer_needed"
				: a.status;

const doneOf = (a: StatusAction): string =>
	a.kind === "complete"
		? "marked done"
		: a.kind === "reopen"
			? "reopened"
			: a.kind === "waive"
				? "closed as no longer needed"
				: `moved to ${STATUS_LABEL[a.status]}`;
const STALE = new Set(["conflict", "open_successor"]);
const pageFields = ({ items, counts, total, selected, report, badgesStale }: TasksPageState) => ({
	items,
	counts,
	total,
	selected,
	report,
	badgesStale,
});

const noticeOf = (lane: SaveLane<TaskForm> | null) => ({
	notice: lane?.get().notice ?? null,
	busy: lane ? lane.wait() === "saving" : false,
	onDismiss: () => lane?.dismiss(),
});
function Notices({ lanes }: { lanes: [string, SaveLane<TaskForm>][] }) {
	return lanes.map(([id, lane]) => <SaveNotice key={id} dialogOpen={false} className="mb-3" {...noticeOf(lane)} />);
}

export function TasksScreen({ loaded, viewer, year }: { loaded: TasksAnswer; viewer: Viewer; year: number }) {
	const router = useRouter();
	const pathname = usePathname();
	const admin = viewer.role !== "member";
	const [navigating, startNav] = useTransition();
	const [, startAction] = useTransition();

	const [list, setList] = useState(() => ({ answer: loaded, store: createTasksPageStore(loaded) }));
	if (list.answer !== loaded) setList({ answer: loaded, store: createTasksPageStore(loaded) });
	const pageStore = list.store;
	const { items, counts, total, selected, report, badgesStale } = useStore(pageStore, useShallow(pageFields));
	const changePage = pageStore.getState().actions.change;
	const setItems = (change: (rows: TaskItem[]) => TaskItem[]) => changePage((p) => ({ items: change(p.items) }));
	const setCounts = (change: (c: TaskCounts) => TaskCounts) => changePage((p) => ({ counts: change(p.counts) }));
	const setTotal = (change: (t: number) => number) => changePage((p) => ({ total: change(p.total) }));
	const setSelected = (change: ReadonlySet<string> | ((s: ReadonlySet<string>) => ReadonlySet<string>)) =>
		changePage((p) => ({ selected: typeof change === "function" ? change(p.selected) : change }));
	const setReport = (report: Report | null) => changePage(() => ({ report }));
	const listed = () => pageStore.getState().items;

	const store = useLocalStore(() => createTasksStore({ opened: loaded.opened }));
	const details = useStore(store, (s) => s.details);
	const openId = useStore(store, (s) => s.openId);
	const dialogFor = useStore(store, (s) => s.dialogFor);
	const deleting = useStore(store, (s) => s.deleting);
	const { lanes, actions } = store.getState();
	useSyncExternalStore(lanes.subscribe, lanes.version, lanes.version);
	const known = () => store.getState().details;
	const setDetails = actions.details;
	const { openForm, closeForm, leaveForm } = actions;
	const setDeleting = actions.confirmDelete;

	const [pending, setPending] = useOptimistic(NO_PENDING, withChange);
	const shown = shownRows(items, pending);
	const query = loaded.query;
	const addTasks = (tasks: TaskItem[]) => {
		const fresh = tasks.filter((t) => matches(query, t, viewer.accountId));
		if (!fresh.length) return;
		setItems((rows) => [...fresh, ...rows]);
		setCounts((c) => fresh.reduce((n, t) => countsAfter(n, null, t), c));
		setTotal((t) => t + fresh.length);
	};

	const go = (next: TaskQuery, replace = false) =>
		startNav(() => (replace ? router.replace : router.push)(pathname + querySearch(next), { scroll: false }));

	const address = (id: string | null) => {
		const url = new URL(window.location.href);
		if (id) url.searchParams.set("task", id);
		else url.searchParams.delete("task");
		writeAddress(url.pathname + url.search, { replace: true });
	};
	const warm = (id: string) => {
		const cached = known()[id];
		if (cached?.status === "ok" && cached.history.status === "ok") return;
		if (!actions.startLoading(id)) return;
		setDetails((d) => ({ ...d, [id]: { status: "loading" } }));
		loadTask(id)
			.catch(() => lost)
			.then((r: Outcome<TaskLoad>) => {
				actions.stopLoading(id);
				setDetails((d) => ({
					...d,
					[id]:
						r.status === "ok"
							? { status: "ok", ...r.value }
							: { status: "failed", code: r.status === "lost" ? "lost" : r.code },
				}));
			});
	};
	const open = (id: string) => {
		warm(id);
		if (id !== store.getState().openId) leaveForm(id);
		actions.show(id);
		address(id);
	};
	const close = () => {
		leaveForm();
		actions.show(null);
		address(null);
	};

	const confirm = (before: TaskItem | null, saved: Saved, fields = false) => {
		const task = {
			...saved.task,
			followUpOwners: saved.task.followUpOwners.map(
				(o) => before?.followUpOwners.find((b) => b.accountId === o.accountId) ?? o,
			),
			followUpOrigin: saved.task.followUpOrigin ?? before?.followUpOrigin ?? null,
		};
		if (!before && task.category === "follow_up" && task.relation?.kind === "person" && !task.followUpOrigin)
			void refresh(task.id);
		const wasIn = before !== null && listed().some((r) => r.id === task.id);
		const nowIn = task.deleted ? false : fields ? matches(query, task, viewer.accountId) : wasIn;
		if (wasIn || nowIn) {
			setItems((rows) =>
				!nowIn
					? rows.filter((r) => r.id !== task.id)
					: rows.some((r) => r.id === task.id)
						? rows.map((r) => (r.id === task.id ? task : r))
						: before
							? rows
							: [task, ...rows],
			);
			if (saved.changed && (wasIn || !before))
				setCounts((c) => countsAfter(c, wasIn ? before : null, nowIn ? task : null));
			if (!before && nowIn) setTotal((t) => t + 1);
			if (wasIn && !nowIn) setTotal((t) => Math.max(0, t - 1));
		}
		setDetails((d) => {
			const cur = d[task.id];
			if (task.deleted) {
				const { [task.id]: _, ...rest } = d;
				void _;
				return rest;
			}
			if (cur?.status !== "ok") return d;
			const moved = saved.changed && before && before.status !== task.status;
			const occurrence = moved || cur.task.recurrence?.seriesId !== task.recurrence?.seriesId ? null : cur.occurrence;
			const history =
				moved && cur.history.status === "ok" && cur.history.value.next === null
					? {
							status: "ok" as const,
							value: {
								...cur.history.value,
								items: [
									...cur.history.value.items,
									{
										id: saved.receiptId as never,
										occurredAt: new Date().toISOString() as never,
										from: before.status,
										to: task.status,
										actor: { kind: "account" as const, accountId: viewer.accountId as never, displayName: viewer.name },
										source: "person" as const,
									},
								],
							},
						}
					: cur.history;
			return { ...d, [task.id]: { ...cur, task, history, occurrence } };
		});
		if (before && (task.deleted || isSettled(before.status) !== isSettled(task.status)))
			blockersChanged([{ id: task.id, status: task.status, deleted: task.deleted }]);
	};

	const blockersChanged = (changed: Blocker[]) => {
		const by = new Set(changed.map((c) => c.id));
		const recount = (st: DetailState) =>
			st.status === "ok" && st.prerequisites ? withBlockers(st.prerequisites.items, changed) : null;
		const counts = new Map<string, number>();
		for (const [id, st] of Object.entries(known())) {
			const r = recount(st);
			if (r) counts.set(id, r.open);
		}
		setDetails((d) =>
			Object.fromEntries(
				Object.entries(d).map(([id, st]) => {
					const r = recount(st);
					if (!r || st.status !== "ok") return [id, st];
					return [
						id,
						{
							...st,
							task: { ...st.task, openPrerequisites: r.open },
							prerequisites: { taskId: st.task.id, items: r.items, blocked: r.open > 0 },
						},
					];
				}),
			),
		);
		if (counts.size)
			setItems((rows) => rows.map((r) => (counts.has(r.id) ? { ...r, openPrerequisites: counts.get(r.id)! } : r)));
		const reopened = changed.some((c) => !c.deleted && !isSettled(c.status));
		const unknown = listed().some((r) => {
			const st = known()[r.id];
			const held = st?.status === "ok" && st.prerequisites !== null;
			return !held && !by.has(r.id) && !isSettled(r.status) && (reopened || r.openPrerequisites > 0);
		});
		if (unknown || pageStore.getState().readingBadges) readBadges();
	};
	const readBadges = (retry = true) => {
		const { badgeReads } = pageStore.getState();
		const read = badgeReads.start(window.location.search);
		const current = () => badgeReads.applies(read, window.location.search);
		const held = (id: string) => {
			const st = known()[id];
			return st?.status === "ok" && st.prerequisites !== null;
		};
		const ids = listed()
			.filter((row) => !held(row.id))
			.map((row) => row.id);
		if (!ids.length) {
			changePage(() => ({ readingBadges: false }));
			return badgeReads.end();
		}
		changePage(() => ({ readingBadges: true, badgesStale: false }));
		loadBlocking(ids).then((r) => {
			if (!current()) return;
			if (r.status !== "ok" && retry) return readBadges(false);
			if (r.status !== "ok") return changePage(() => ({ readingBadges: false, badgesStale: true }));
			changePage(() => ({ readingBadges: false }));
			const fresh = new Map(r.value.map((t) => [t.id, t.openPrerequisites]));
			setItems((rows) =>
				rows.map((row) =>
					fresh.has(row.id) && !held(row.id) && fresh.get(row.id) !== row.openPrerequisites
						? { ...row, openPrerequisites: fresh.get(row.id)! }
						: row,
				),
			);
		});
	};

	const addSuccessor = (pred: Pick<TaskItem, "id">, next: TaskDetail) => {
		if (matches(query, next, viewer.accountId) && !listed().some((r) => r.id === next.id)) {
			setItems((rows) =>
				rows.some((r) => r.id === pred.id)
					? rows.flatMap((r) => (r.id === pred.id ? [r, next] : [r]))
					: [next, ...rows],
			);
			setCounts((c) => countsAfter(c, null, next));
			setTotal((t) => t + 1);
		}
		const seriesId = next.recurrence?.seriesId;
		if (seriesId)
			setDetails((d) => {
				const cur = d[pred.id];
				if (cur?.status !== "ok") return d;
				const open = {
					taskId: next.id,
					occurrence: Number(next.occurrenceId) || 1,
					predecessorId: pred.id,
					revision: next.revision,
				};
				return { ...d, [pred.id]: { ...cur, occurrence: { status: "series", seriesId, open } } };
			});
	};
	const succeeded = (pred: Pick<TaskItem, "id">, next: TaskDetail) => {
		addSuccessor(pred, next);
		const when = dueText(next.due, year);
		toast({
			tone: "success",
			message: when ? `Added the next “${next.title}”, due ${when}.` : `Added the next “${next.title}”.`,
			action: { label: "Open it", onSelect: () => open(next.id) },
		});
	};

	const gone = (id: string, code: string) => {
		if (code !== "unavailable") return;
		setItems((rows) => rows.filter((x) => x.id !== id));
		setTotal((t) => Math.max(0, t - 1));
	};
	const refresh = (id: string): Promise<void> =>
		loadTask(id)
			.catch(() => lost)
			.then((r) => {
				if (r.status !== "ok") return;
				setItems((rows) => rows.map((x) => (x.id === id ? r.value.task : x)));
				setDetails((d) => ({ ...d, [id]: { status: "ok", ...r.value } }));
			});

	const refreshRows = (ids: string[]): void => {
		if (!ids.length) return;
		const again = new Set(ids);
		void loadRows(ids)
			.catch(() => lost)
			.then((r) => {
				if (r.status !== "ok") return;
				const fresh = new Map(r.value.items.map((t) => [t.id, t]));
				setItems((rows) => rows.map((x) => fresh.get(x.id) ?? x));
				const shown = store.getState().openId;
				setDetails((d) => Object.fromEntries(Object.entries(d).filter(([id]) => !again.has(id) || id === shown)));
				if (shown && again.has(shown)) void refresh(shown);
			});
	};

	const stepSaved = (parentId: string, step: TaskDetail) => {
		const cur = known()[parentId];
		const before = cur?.status === "ok" ? cur.task.checklistItems.find((x) => x.id === step.id) : undefined;
		const total = step.deleted ? -Number(Boolean(before)) : before ? 0 : 1;
		const complete = Number(!step.deleted && step.status === "complete") - Number(before?.status === "complete");
		const saved: Step = {
			id: step.id,
			revision: step.revision,
			title: step.title,
			status: step.status,
			assignees: step.assignees,
		};
		setDetails((d) => {
			const c = d[parentId];
			if (c?.status !== "ok") return d;
			const list = c.task.checklistItems;
			const checklistItems = step.deleted
				? list.filter((x) => x.id !== step.id)
				: list.some((x) => x.id === step.id)
					? list.map((x) => (x.id === step.id ? saved : x))
					: [...list, saved];
			return { ...d, [parentId]: { ...c, task: { ...c.task, checklistItems } } };
		});
		if (!total && !complete) return;
		const bump = (k: TaskItem["checklist"]) => ({ total: k.total + total, complete: k.complete + complete });
		setItems((rows) => rows.map((r) => (r.id === parentId ? { ...r, checklist: bump(r.checklist) } : r)));
		if (listed().some((r) => r.id === parentId))
			setCounts((c) => ({
				...c,
				childTaskTotal: c.childTaskTotal + total,
				childTaskComplete: c.childTaskComplete + complete,
			}));
	};
	const run = <T,>(id: string, show: () => void, spec: SaveSpec<TaskForm, T>) => {
		const lane = lanes.of(id);
		if (lane.wait() !== null) return void lane.save(spec);
		startAction(async () => {
			show();
			await lane.save({ ...spec, ok: (value, checked) => startAction(() => spec.ok(value, checked)) });
		});
	};
	const reread = async <T,>(id: string, sent: Promise<Outcome<T>>, stale = (code: string) => STALE.has(code)) => {
		const r = await sent;
		if (r.status === "refused" && stale(r.code)) await refresh(id);
		return r;
	};

	const act = (task: TaskItem, action: StatusAction) =>
		run(task.id, () => setPending({ kind: "status", id: task.id, status: targetOf(action) }), {
			what: `“${task.title}”`,
			done: doneOf(action),
			send: (key) => reread(task.id, changeTaskStatus(key, task.revision, task.id, action)),
			ok: (value: Saved) => {
				confirm(task, value);
				if (value.successor) succeeded(task, value.successor);
				if (action.kind === "waive") toast({ tone: "success", message: `Closed “${task.title}” as no longer needed.` });
			},
			refused: (code) => gone(task.id, code),
		});

	const tickStep = (parentId: string, step: Step, complete: boolean) =>
		run(step.id, () => setPending({ kind: "status", id: step.id, status: complete ? "complete" : "not_started" }), {
			what: `The step “${step.title}”`,
			done: complete ? "marked done" : "reopened",
			send: (key) => reread(parentId, setStep(key, step.revision, parentId, step.id, complete), () => true),
			ok: (value: Saved) => stepSaved(parentId, value.task),
		});
	const addStepTo = (parent: TaskItem, title: string, who: StepAssignee) => {
		const assignees =
			who.kind === "inherit"
				? parent.assignees
				: who.kind === "nobody"
					? []
					: [{ accountId: who.accountId as never, displayName: who.name }];
		const shownStep: Step = {
			id: (PENDING_PREFIX + crypto.randomUUID()) as never,
			revision: "0" as never,
			title,
			status: "not_started",
			assignees,
		};
		const holder = who.kind === "inherit" ? undefined : who.kind === "nobody" ? [] : [who.accountId];
		run(shownStep.id, () => setPending({ kind: "step", parentId: parent.id, step: shownStep }), {
			what: `The step “${title}”`,
			done: "added",
			send: (key) => reread(parent.id, addStep(key, parent.revision, parent.id, title, holder)),
			ok: (value: Saved) => stepSaved(parent.id, value.task),
		});
	};
	const removeStepFrom = (parentId: string, step: Step) =>
		run(step.id, () => setPending({ kind: "row", id: step.id, row: null }), {
			what: `The step “${step.title}”`,
			done: "removed",
			send: (key) => reread(parentId, removeStep(key, step.revision, parentId, step.id), () => true),
			ok: (value: Saved) => {
				stepSaved(parentId, value.task);
				toast({ tone: "success", message: `Removed the step “${step.title}”. Its history is kept.` });
			},
		});

	const savePrerequisites = (task: TaskItem, list: Prerequisite[]) => {
		const openCount = list.filter(blocks).length;
		run(
			task.id,
			() => {
				setPending({ kind: "panel", id: task.id, panel: { prerequisites: list } });
				const row = listed().find((r) => r.id === task.id);
				if (row) setPending({ kind: "row", id: task.id, row: { ...row, openPrerequisites: openCount } });
			},
			{
				what: `What “${task.title}” waits for`,
				form: { kind: "prerequisites", draft: list },
				send: (key) =>
					reread(
						task.id,
						setPrerequisites(
							key,
							task.revision,
							task.id,
							list.map((p) => p.id),
						),
					),
				ok: (value: Saved) => {
					confirm(task, value);
					setDetails((d) => {
						const cur = d[task.id];
						return cur?.status === "ok"
							? { ...d, [task.id]: { ...cur, prerequisites: { taskId: task.id, items: list, blocked: openCount > 0 } } }
							: d;
					});
				},
			},
		);
	};
	const saveRepeat = (task: TaskItem, before: TaskDetail["recurrence"], rule: Rule | null) => {
		const shownRule: TaskDetail["recurrence"] = rule
			? { ...rule, seriesId: before?.seriesId ?? (PENDING_PREFIX as never), stopped: false }
			: before && { ...before, stopped: true };
		run(task.id, () => setPending({ kind: "panel", id: task.id, panel: { recurrence: shownRule } }), {
			what: `How “${task.title}” repeats`,
			form: { kind: "repeat", draft: rule },
			send: (key) => reread(task.id, setRecurrence(key, task.revision, task.id, rule)),
			ok: (value: Saved) => confirm(task, value),
		});
	};

	const runBulk = (kind: Report["kind"], due: DueInput | null, selectedTasks: TaskItem[]) => {
		const chosen = selectedTasks.filter((t) => !isSettled(t.status));
		if (!chosen.length) return;
		setReport(null);
		const items = chosen.map((t) => ({ taskId: t.id, expectedRevision: t.revision }));
		const after = (t: TaskItem, revision: string): TaskItem =>
			kind === "complete"
				? { ...t, revision: revision as never, status: "complete", completedAt: new Date().toISOString() as never }
				: { ...t, revision: revision as never, due: due as TaskItem["due"], overdue: previewOverdue(due!) };
		actions.startBulk(
			selectedTasks.map((t) => t.id),
			() =>
				run(
					BULK,
					() => {
						actions.holdBulk(chosen.map((t) => t.id));
						for (const t of chosen)
							if (kind === "complete") setPending({ kind: "status", id: t.id, status: "complete" });
							else setPending({ kind: "row", id: t.id, row: after(t, t.revision) });
					},
					{
						what: `The change to ${chosen.length} ${chosen.length === 1 ? "task" : "tasks"}`,
						send: (key) => (kind === "complete" ? bulkComplete(key, items) : bulkReschedule(key, items, due)),
						ok: (result: BulkResult) => {
							const byId = new Map(chosen.map((t) => [t.id, t]));
							const outcome = new Map(result.items.map((i) => [i.taskId, i]));
							const gone = new Set(
								result.items.filter((i) => i.outcome === "deleted" || i.outcome === "not_found").map((i) => i.taskId),
							);
							const rows = listed();
							let moved = 0;
							const nextCounts = (c: TaskCounts) =>
								rows.reduce((acc, row) => {
									const i = outcome.get(row.id);
									if (i?.outcome === "changed") return countsAfter(acc, row, after(row, i.revision!));
									if (gone.has(row.id)) return countsAfter(acc, row, null);
									return acc;
								}, c);
							for (const row of rows) if (gone.has(row.id)) moved++;
							setItems((list) =>
								list.flatMap((row) => {
									const i = outcome.get(row.id);
									if (gone.has(row.id)) return [];
									return i?.outcome === "changed" ? [after(row, i.revision!)] : [row];
								}),
							);
							setCounts(nextCounts);
							if (moved) setTotal((t) => Math.max(0, t - moved));
							for (const i of result.items) if (i.successor) addSuccessor({ id: i.taskId }, i.successor);
							const changed = new Set<string>(result.items.filter((i) => i.outcome === "changed").map((i) => i.taskId));
							if (kind === "complete" && changed.size)
								blockersChanged([...changed].map((id) => ({ id, status: "complete" as const, deleted: false })));
							const shownTask = store.getState().openId;
							setDetails((d) =>
								Object.fromEntries(Object.entries(d).filter(([id]) => !changed.has(id) || id === shownTask)),
							);
							if (shownTask && changed.has(shownTask)) refresh(shownTask);
							refreshRows(result.items.filter((i) => i.outcome === "stale").map((i) => i.taskId));
							setSelected(new Set(result.remaining));
							const unchanged = result.items
								.filter((i) => i.outcome !== "changed")
								.map((i) => ({ id: i.taskId, title: byId.get(i.taskId)?.title ?? "A task", outcome: i.outcome }));
							if (!unchanged.length) {
								const n = result.changed;
								return toast({
									tone: "success",
									message: `${kind === "complete" ? "Completed" : "Rescheduled"} ${n} ${n === 1 ? "task" : "tasks"}.`,
								});
							}
							setReport({ kind, changed: result.changed, unchanged, remaining: result.remaining.length });
						},
					},
				),
		);
	};

	const commit = (c: Commit) => {
		const before = c.before;
		const id = before?.id ?? NEW;
		const form: EditForm = { kind: "edit", task: before, draft: c.draft };
		run(
			id,
			() => {
				const fits = matches(query, c.preview, viewer.accountId);
				if (before) setPending({ kind: "row", id, row: fits ? c.preview : null });
				else if (fits) setPending({ kind: "add", row: c.preview });
			},
			{
				what: `“${before?.title ?? c.preview.title}”`,
				done: before ? "saved" : "added",
				form,
				send: async (key) => {
					const r = await (before ? reread(before.id, c.send(key)) : c.send(key));
					if (r.status === "refused" && r.error?.code === "ambiguous_local_time")
						form.choices = r.error.details.choices;
					return r;
				},
				ok: (value: Saved) => saved(before, value),
				refused: (code) => before && gone(before.id, code),
			},
		);
	};
	const saved = (before: TaskItem | null, value: Saved) => {
		confirm(before, value, true);
		const inView = matches(query, value.task, viewer.accountId);
		const what = before ? `Saved “${value.task.title}”.` : `Added “${value.task.title}”.`;
		toast({
			tone: "success",
			message: inView ? what : `${what} It does not match this list’s view or filters, so it is not shown here.`,
			action: inView
				? undefined
				: {
						label: "Show it",
						onSelect: () => open(value.task.id),
					},
		});
	};
	const toggle = (task: TaskItem) => act(task, isSettled(task.status) ? { kind: "reopen" } : { kind: "complete" });
	const canAct = (task: Pick<TaskItem, "assignees">) =>
		admin || task.assignees.some((a) => a.accountId === viewer.accountId);

	const remove = (task: TaskItem) => {
		if (openId === task.id) close();
		run(task.id, () => setPending({ kind: "row", id: task.id, row: null }), {
			what: `“${task.title}”`,
			done: "deleted",
			send: (key) => reread(task.id, deleteTask(key, task.revision, task.id)),
			ok: (value: Saved) => {
				confirm(task, value);
				toast({ tone: "success", message: `Deleted “${task.title}”. Its history is kept.` });
			},
			refused: (code) => gone(task.id, code),
		});
	};
	const edit = (task: TaskItem) => {
		const d = details[task.id];
		if (d?.status === "ok") return openForm(task.id, { kind: "edit", task: d.task });
		warmAssignees();
		loadTask(task.id)
			.catch(() => lost)
			.then((r) =>
				r.status === "ok"
					? openForm(task.id, { kind: "edit", task: r.value.task })
					: toast({
							tone: "error",
							message: `“${task.title}” did not open. ${r.status === "lost" ? "Check your connection and try again." : problemText(r.code)}`,
						}),
			);
	};

	const openState = openId ? (details[openId] ?? { status: "loading" }) : null;
	const openDetail = openState?.status === "ok" ? openState.task : null;
	const openTask = openId
		? (shown.find((t) => t.id === openId) ??
			(openDetail ? { ...openDetail, status: pending.status[openDetail.id] ?? openDetail.status } : null))
		: null;
	const dialogLane = dialogFor ? lanes.of(dialogFor) : null;
	const dialogForm = dialogLane?.get().editing?.kind === "edit" ? (dialogLane.get().editing as EditForm) : null;
	const panelForm = openId ? lanes.of(openId).get().editing : null;
	const modal = openId !== null || dialogForm !== null;
	const sheetNotices = lanes
		.notices()
		.filter(([id]) => !(dialogForm && id === dialogFor))
		.sort(([a], [b]) => Number(b === openId) - Number(a === openId));
	const listNotices = modal ? [] : lanes.notices().filter(([id]) => id === NEW || id === BULK);
	const groups = groupsOf(shown, query.sort);
	const filtered = isFiltered(query);
	const selectable = shown.filter((t) => !t.id.startsWith(PENDING_PREFIX));
	const chosen = selectable.filter((t) => selected.has(t.id));
	const bulkWait = chosen.some((t) => lanes.of(t.id).wait() !== null) ? "saving" : lanes.of(BULK).wait();
	const toggleSelected = (id: string) =>
		setSelected((s) => {
			const n = new Set(s);
			if (!n.delete(id)) n.add(id);
			return n;
		});

	return (
		<>
			<PageHeader
				size="xl"
				title="Tasks"
				subtitle="Follow-ups, checklists and your own to-dos."
				actions={
					<>
						<SegmentedControl
							label="Whose tasks"
							value={query.view}
							onValueChange={(view) => go(withFilters(query, { view }))}
							options={[
								{ value: "my", label: "Mine" },
								{ value: "all", label: "All" },
							]}
						/>
						<IntentLink href="/tasks/follow-ups" className={buttonVariants({ variant: "secondary" })}>
							Follow-ups
						</IntentLink>
						{admin ? <Templates year={year} onImported={addTasks} /> : null}
						{admin ? (
							<Button
								variant="primary"
								icon={Add01Icon}
								onClick={() => openForm(NEW, { kind: "edit", task: null })}
								{...intentHandlers(warmAssignees)}
							>
								New task
							</Button>
						) : null}
					</>
				}
			/>
			{admin && loaded.offer ? (
				<PhaseOffer key={loaded.offer.transition.id} initial={loaded.offer} year={year} onAdded={addTasks} />
			) : null}
			<div className="grid grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)] items-start gap-5 max-app-md:grid-cols-1">
				<Card className="gap-2 px-[18px]">
					<Toolbar query={query} go={go} admin={admin} rows={items} />
					{report ? <BulkReport report={report} onOpen={open} onClose={() => setReport(null)} /> : null}
					<Notices lanes={listNotices} />
					<div role="status" className="empty:hidden">
						{badgesStale ? (
							<p className="mx-1.5 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-surface px-4 py-2 text-sm text-text-2">
								Some “Blocked by” notes on this page may be out of date. We could not check them.
								<Button variant="ghost" size="sm" onClick={() => readBadges()}>
									Check again
								</Button>
							</p>
						) : null}
					</div>
					<div aria-busy={navigating || undefined} className="transition-opacity duration-150 aria-busy:opacity-60">
						{shown.length === 0 ? (
							<Empty
								query={query}
								filtered={filtered}
								admin={admin}
								go={go}
								onNew={() => openForm(NEW, { kind: "edit", task: null })}
							/>
						) : (
							groups.map((g) => (
								<section key={g.key} aria-labelledby={GROUP[g.key] ? `group-${g.key}` : undefined}>
									{GROUP[g.key] ? (
										<h2
											id={`group-${g.key}`}
											className="flex items-center gap-2 px-3 pt-[18px] pb-2 font-sans text-sm font-semibold tracking-normal text-text-2"
										>
											<StatusBadge status={GROUP[g.key]!.tone} size="sm">
												{GROUP[g.key]!.label}
											</StatusBadge>
											<span className="font-normal text-text-3">
												{g.items.length}
												<span className="sr-only"> {g.items.length === 1 ? "task" : "tasks"}</span>
											</span>
										</h2>
									) : null}
									<ul aria-label={GROUP[g.key]?.label ?? "Tasks"}>
										{g.items.map((t) => (
											<TaskRow
												key={t.id}
												task={t}
												year={year}
												you={viewer.accountId}
												admin={admin}
												canAct={canAct(t) && !t.id.startsWith(PENDING_PREFIX)}
												selected={admin && !t.id.startsWith(PENDING_PREFIX) ? selected.has(t.id) : null}
												onSelect={() => toggleSelected(t.id)}
												wait={lanes.of(t.id).wait()}
												notice={noticeOf(lanes.of(t.id))}
												modal={modal}
												onToggle={() => toggle(t)}
												onAction={(a) => act(t, a)}
												onOpen={() => !t.id.startsWith(PENDING_PREFIX) && open(t.id)}
												onWarm={() => !t.id.startsWith(PENDING_PREFIX) && warm(t.id)}
												onEdit={() => edit(t)}
												onDelete={() => setDeleting(t)}
											/>
										))}
									</ul>
								</section>
							))
						)}
					</div>
					{admin && chosen.length ? (
						<BulkBar
							count={chosen.length}
							all={chosen.length === selectable.length}
							onAll={() =>
								setSelected(chosen.length === selectable.length ? new Set() : new Set(selectable.map((t) => t.id)))
							}
							onClear={() => setSelected(new Set())}
							wait={bulkWait}
							actions={bulkActions(chosen.map((t) => t.status))}
							onKeepOpen={() => setSelected(new Set(chosen.filter((t) => !isSettled(t.status)).map((t) => t.id)))}
							onComplete={() => runBulk("complete", null, chosen)}
							onReschedule={(due) => runBulk("reschedule", due, chosen)}
						/>
					) : null}
					{total > 0 ? (
						<div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-line px-3 pt-4">
							<span className="text-sm text-text-3" role="status">
								{rangeText(query, items.length, total)}
							</span>
							<Pagination
								page={query.page}
								pageCount={pageCount(total)}
								onPageChange={(n) => go({ ...query, page: n })}
							/>
						</div>
					) : null}
				</Card>
				<aside aria-label="Task summary" className="flex flex-col gap-5">
					<Summary counts={counts} query={query} />
					{admin ? null : <MemberCallout />}
				</aside>
			</div>
			<TaskSheet
				task={openTask}
				state={openState}
				open={openId !== null}
				onClose={close}
				year={year}
				viewer={viewer}
				canAct={openTask ? canAct(openTask) : false}
				wait={openId ? lanes.of(openId).wait() : null}
				onAction={(a) => openTask && act(openTask, a)}
				onEdit={() => openId && openState?.status === "ok" && openForm(openId, { kind: "edit", task: openState.task })}
				onDelete={() => openTask && setDeleting(openTask)}
				onRetry={() => openId && warm(openId)}
				pending={pending}
				canActStep={(step) => canAct(step)}
				stepWait={(id) => lanes.of(id).wait()}
				onStep={(step, complete) => openId && tickStep(openId, step, complete)}
				onAddStep={(title, who) => openTask && addStepTo(openTask, title, who)}
				onRemoveStep={(step) => openId && removeStepFrom(openId, step)}
				edit={panelForm?.kind === "prerequisites" || panelForm?.kind === "repeat" ? panelForm : null}
				onEditPanel={(form) => openId && (form ? openForm(openId, form) : closeForm(openId))}
				onPrerequisites={(list) => openTask && savePrerequisites(openTask, list)}
				onRepeat={(rule) => openTask && openDetail && saveRepeat(openTask, openDetail.recurrence, rule)}
				onOpenTask={open}
				notices={<Notices lanes={sheetNotices} />}
			/>
			{admin ? (
				<NoticeInDialog {...noticeOf(dialogLane)}>
					<TaskDialog
						form={dialogForm}
						latest={
							dialogFor && details[dialogFor]?.status === "ok"
								? (details[dialogFor] as { task: TaskDetail }).task
								: null
						}
						viewer={viewer}
						wait={dialogLane?.wait() ?? null}
						problem={dialogForm?.problem ? problemText(dialogForm.problem as never) : undefined}
						onClose={() => {
							if (dialogFor) closeForm(dialogFor);
							actions.dialog(null);
						}}
						onCommit={commit}
					/>
				</NoticeInDialog>
			) : null}
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={deleting ? `Delete “${deleting.title}”?` : "Delete task?"}
				description="The task leaves every list and stops sending reminders."
				consequences={[
					...(deleting && deleting.checklist.total > 0
						? [
								`Its ${deleting.checklist.total} ${deleting.checklist.total === 1 ? "step is" : "steps are"} deleted with it.`,
							]
						: []),
					"Its status history is kept.",
					...(deleting?.managed ? ["The meeting will not create this task again."] : []),
				]}
				confirmLabel="Delete task"
				tone="danger"
				onConfirm={() => void (deleting && remove(deleting))}
			/>
		</>
	);
}

function TaskRow({
	task,
	year,
	you,
	admin,
	canAct,
	selected,
	onSelect,
	wait,
	notice,
	modal,
	onToggle,
	onAction,
	onOpen,
	onWarm,
	onEdit,
	onDelete,
}: {
	task: TaskItem;
	year: number;
	you: string;
	admin: boolean;
	canAct: boolean;
	selected: boolean | null;
	onSelect: () => void;
	wait: Wait;
	notice: ReturnType<typeof noticeOf>;
	modal: boolean;
	onToggle: () => void;
	onAction: (a: StatusAction) => void;
	onOpen: () => void;
	onWarm: () => void;
	onEdit: () => void;
	onDelete: () => void;
}) {
	const settled = isSettled(task.status);
	const hint = useId();
	const waiting = canAct && wait !== null;
	return (
		<li
			data-done={settled || undefined}
			data-selected={selected || undefined}
			className="group/row flex flex-wrap items-center gap-x-3.5 rounded-card border-t border-line px-3 py-3.5 first:border-t-0 data-selected:bg-surface-raised data-selected:shadow-[inset_0_0_0_1.5px_var(--ef-ink)] max-app-sm:gap-2 max-app-sm:px-2 [[data-selected]+&]:border-t-transparent"
		>
			{selected !== null ? (
				<label className="-m-3 grid size-11 flex-none place-items-center">
					<Checkbox aria-label={`Select ${task.title}`} checked={selected} onCheckedChange={onSelect} />
				</label>
			) : null}
			<DoneBox task={task} canAct={canAct} wait={wait} describedBy={waiting ? hint : undefined} onToggle={onToggle} />
			<div className="min-w-0 flex-1">
				<button
					type="button"
					onClick={onOpen}
					{...intentHandlers(onWarm)}
					className={cn(
						"rounded-xs text-left font-medium text-ink decoration-text-3 underline-offset-[3px] hover:underline",
						settled && "text-text-3 line-through",
					)}
				>
					{task.title}
				</button>
				{waiting ? (
					<span id={hint} className="ml-2 text-xs whitespace-nowrap text-text-2">
						{wait === "saving" ? "Saving…" : "Check the last save first."}
					</span>
				) : null}
				<DescriptionPreview value={task.excerpt} />
				<MetaLine task={task} year={year} />
			</div>
			<Assignee task={task} you={you} />
			{admin && !settled && task.followUpOwners.some((o) => !o.eligible) ? (
				<Button variant="outline" size="sm" onClick={onEdit}>
					Reassign
				</Button>
			) : null}
			{canAct ? (
				<Menu>
					<MenuTrigger asChild>
						<IconButton
							icon={MoreHorizontalIcon}
							label={`More for ${task.title}`}
							size="sm"
							aria-describedby={waiting ? hint : undefined}
						/>
					</MenuTrigger>
					<MenuContent align="end">
						<StatusItems task={task} disabled={wait !== null} onAction={onAction} />
						{admin ? (
							<>
								<MenuSeparator />
								<MenuItem icon={PencilEdit02Icon} onSelect={onEdit}>
									Edit
								</MenuItem>
								<MenuItem icon={Delete02Icon} danger disabled={wait !== null} onSelect={onDelete}>
									Delete
								</MenuItem>
							</>
						) : null}
					</MenuContent>
				</Menu>
			) : (
				<span aria-hidden="true" className="size-[34px] flex-none" />
			)}
			<SaveNotice {...notice} dialogOpen={modal} className="basis-full pt-2.5 pl-[58px] max-app-sm:pl-0" />
		</li>
	);
}

function SearchBox({ query, go }: { query: TaskQuery; go: (q: TaskQuery, replace?: boolean) => void }) {
	const [box, setBox] = useState({ text: query.search, shown: query.search, sent: [] as readonly string[] });
	if (box.shown !== query.search)
		setBox(
			box.sent.includes(query.search)
				? { text: box.text, shown: query.search, sent: box.sent.slice(box.sent.indexOf(query.search) + 1) }
				: { text: query.search, shown: query.search, sent: [] },
		);
	const [{ run: afterPause, cancelOnDetach }] = useState(() => createDebouncer(300));
	return (
		<div className="w-[280px] max-app-sm:w-full">
			<SearchInput
				ref={cancelOnDetach}
				aria-label="Search tasks by title"
				placeholder="Search tasks"
				value={box.text}
				maxLength={200}
				onChange={(e) => {
					const next = e.target.value;
					setBox((b) => ({ ...b, text: next }));
					afterPause(() => {
						const current = parseQuery(new URLSearchParams(window.location.search));
						if (next.trim() === current.search) return;
						setBox((b) => ({ ...b, sent: [...b.sent, next.trim()] }));
						go(withFilters(current, { search: next.trim() }), true);
					});
				}}
			/>
		</div>
	);
}

function Toolbar({
	query,
	go,
	admin,
	rows,
}: {
	query: TaskQuery;
	go: (q: TaskQuery, replace?: boolean) => void;
	admin: boolean;
	rows: readonly TaskItem[];
}) {
	const single = <T extends string>(list: readonly T[], v: string[]) => list.find((x) => x === v.at(-1));
	const [teams, setTeams] = useState<{ id: string; label: string }[] | "loading" | "failed" | null>(null);
	const loadTeams = () => {
		setTeams("loading");
		relationOptions("team", "").then((r) => setTeams(r.status === "ok" ? r.value.items : "failed"));
	};
	const warmTeams = () => void (admin && teams === null && loadTeams());
	const seen = rows.flatMap((r) =>
		r.relation?.kind === "team" ? [{ id: r.relation.id, label: r.relation.label }] : [],
	);
	const known = [...(Array.isArray(teams) ? teams : []), ...seen].filter(
		(t, i, all) => all.findIndex((x) => x.id === t.id) === i,
	);
	const teamOptions = [
		...known.map((t) => ({ value: t.id, label: t.label })),
		...(query.teamId && !known.some((t) => t.id === query.teamId)
			? [{ value: query.teamId, label: "Chosen team" }]
			: []),
	];
	return (
		<div className="flex flex-wrap items-center gap-2.5 px-1.5 pb-1.5">
			<SearchBox key={query.search === "" ? "empty" : "search"} query={query} go={go} />
			<FilterChip
				label="Status"
				icon={FilterHorizontalIcon}
				searchLabel="Search statuses"
				anyText="Any"
				options={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
				value={query.statuses}
				onValueChange={(v) => go(withFilters(query, { statuses: STATUSES.filter((s) => v.includes(s)) }))}
			/>
			<FilterChip
				label="Priority"
				searchLabel="Search priorities"
				options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
				value={query.priorities}
				onValueChange={(v) => go(withFilters(query, { priorities: PRIORITIES.filter((p) => v.includes(p)) }))}
			/>
			<FilterChip
				label="Category"
				searchLabel="Search categories"
				options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))}
				value={query.categories}
				onValueChange={(v) => go(withFilters(query, { categories: CATEGORIES.filter((c) => v.includes(c)) }))}
			/>
			<FilterChip
				label="Linked to"
				searchLabel="Search links"
				multiple={false}
				options={RELATIONS.map((r) => ({ value: r, label: RELATION_LABEL[r] }))}
				value={query.relation === "any" ? [] : [query.relation]}
				onValueChange={(v) => go(withFilters(query, { relation: single(RELATIONS, v) ?? "any" }))}
			/>
			<span className="contents" onPointerOver={warmTeams} onFocusCapture={warmTeams}>
				<FilterChip
					label="Team"
					searchLabel="Search teams"
					multiple={false}
					loading={teams === "loading"}
					error={teams === "failed" ? { message: "The teams did not load.", onRetry: loadTeams } : undefined}
					emptyText={admin ? "No active teams" : "No team is named on this page"}
					options={teamOptions}
					value={query.teamId ? [query.teamId] : []}
					onValueChange={(v) => go(withFilters(query, { teamId: v.at(-1) ?? null }))}
				/>
			</span>
			<FilterChip
				label="Due"
				searchLabel="Search due kinds"
				multiple={false}
				options={DUE_KINDS.map((d) => ({ value: d, label: DUE_KIND_LABEL[d] }))}
				value={query.due === "any" ? [] : [query.due]}
				onValueChange={(v) => go(withFilters(query, { due: single(DUE_KINDS, v) ?? "any" }))}
			/>
			<span className="grow" />
			<Menu>
				<MenuTrigger asChild>
					<Button variant="ghost" size="sm" icon={SortByDown01Icon}>
						<span className="sr-only">Sort by </span>
						{SORT_LABEL[query.sort]}
						{query.direction === "desc" ? <span className="text-text-3">, newest first</span> : null}
					</Button>
				</MenuTrigger>
				<MenuContent align="end">
					<MenuLabel>Sort by</MenuLabel>
					<MenuRadioGroup
						value={query.sort}
						onValueChange={(v) => {
							const sort = SORTS.find((s) => s === v);
							if (sort) go(withFilters(query, { sort }));
						}}
					>
						{SORTS.map((s) => (
							<MenuRadioItem key={s} value={s}>
								{SORT_LABEL[s]}
							</MenuRadioItem>
						))}
					</MenuRadioGroup>
					<MenuSeparator />
					<MenuRadioGroup
						value={query.direction}
						onValueChange={(v) => go(withFilters(query, { direction: v === "desc" ? "desc" : "asc" }))}
					>
						<MenuRadioItem value="asc">{query.sort === "due" ? "Soonest first" : "Ascending"}</MenuRadioItem>
						<MenuRadioItem value="desc">{query.sort === "due" ? "Latest first" : "Descending"}</MenuRadioItem>
					</MenuRadioGroup>
				</MenuContent>
			</Menu>
		</div>
	);
}

function Empty({
	query,
	filtered,
	admin,
	go,
	onNew,
}: {
	query: TaskQuery;
	filtered: boolean;
	admin: boolean;
	go: (q: TaskQuery) => void;
	onNew: () => void;
}) {
	if (filtered)
		return (
			<EmptyState
				icon={Task01Icon}
				title="No tasks match"
				action={
					<Button variant="secondary" onClick={() => go(clearFilters(query))}>
						Clear filters
					</Button>
				}
			>
				Try a different search or remove a filter.
			</EmptyState>
		);
	if (query.view === "my")
		return (
			<EmptyState
				icon={Task01Icon}
				title="Nothing on your list"
				action={
					<Button variant="secondary" onClick={() => go(withFilters(query, { view: "all" }))}>
						Show all tasks
					</Button>
				}
			>
				No open task is assigned to you. All shows the church’s other tasks.
			</EmptyState>
		);
	return (
		<EmptyState
			icon={Task01Icon}
			title="No open tasks"
			action={
				admin ? (
					<Button variant="primary" icon={Add01Icon} onClick={onNew}>
						New task
					</Button>
				) : null
			}
		>
			{admin
				? "Add the first thing that needs doing. Meetings add their follow-ups here too."
				: "When an Owner or Admin adds tasks, they appear here."}
		</EmptyState>
	);
}

function Summary({ counts, query }: { counts: TaskCounts; query: TaskQuery }) {
	const open = OPEN_STATUSES.reduce((n, s) => n + tallyOf(counts.byStatus, s), 0);
	const rows: [ReactNode, number][] = STATUSES.filter(
		(s) => query.statuses.length === 0 || query.statuses.includes(s),
	).map((s) => [STATUS_LABEL[s], tallyOf(counts.byStatus, s)]);
	return (
		<Card>
			<CardTitle size="sm">{query.view === "my" ? "Your tasks" : "All tasks"}</CardTitle>
			<div className="mt-3 flex items-end gap-3">
				<span className="num font-display text-[40px] leading-[0.95] tracking-[-0.03em] text-ink">{open}</span>
				<span className="pb-1 text-sm text-text-2">
					{open === 1 ? "open task" : "open tasks"}
					{isFiltered(query) ? " match the filters" : ""}
				</span>
			</div>
			<KeyValueList className="mt-4">
				{rows.map(([k, v], i) => (
					<KeyValue key={i} k={k} value={v} size="sm" />
				))}
				{counts.childTaskTotal > 0 ? (
					<KeyValue
						k="Checklist steps done"
						value={`${counts.childTaskComplete} of ${counts.childTaskTotal}`}
						size="sm"
					/>
				) : null}
			</KeyValueList>
		</Card>
	);
}

function MemberCallout() {
	const item = (icon: typeof Tick02Icon, text: string, muted = false) => (
		<li className="flex items-start gap-2.5 py-2.5 text-sm">
			<Icon icon={icon} size={16} className={cn("mt-0.5 flex-none", muted ? "text-text-3" : "text-green-700")} />
			<span className={muted ? "text-text-2" : "text-ink"}>{text}</span>
		</li>
	);
	return (
		<Card>
			<CardTitle size="sm">What your Member seat can do</CardTitle>
			<ul className="mt-2">
				{item(Tick02Icon, "Complete, reopen or change the status of a task assigned to you")}
				{item(Tick02Icon, "Add steps under your own task, one level deep")}
				{item(Tick02Icon, "Read every task and its history")}
				{item(LockKeyIcon, "New tasks, assigning, rescheduling and other people’s tasks need an Owner or Admin", true)}
			</ul>
		</Card>
	);
}
