"use client";

import {
	Add01Icon,
	ArrowTurnBackwardIcon,
	Cancel01Icon,
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
	useToast,
} from "@everyfield/ui/controls";
import { KeyValue, KeyValueList, Pagination, StatusBadge } from "@everyfield/ui/display";
import { cn, Icon } from "@everyfield/ui/foundations";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useOptimistic, useRef, useState, useTransition, type ReactNode } from "react";
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
import { loadTask, relationOptions, type Loaded as TaskLoad } from "./fetch.ts";
import {
	blocks,
	dueText,
	previewOverdue,
	matches,
	NO_PENDING,
	PENDING_PREFIX,
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
	problemText,
	querySearch,
	rangeText,
	RELATION_LABEL,
	RELATIONS,
	Intent,
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
	type DueInput,
	type Prerequisite,
	type Rule,
	type Step,
} from "./model.ts";
import { Assignee, DoneBox, intentHandlers, MetaLine } from "./parts.tsx";
import type { StepAssignee } from "./structure.tsx";
import { TaskDialog, warmAssignees, type Commit, type Draft } from "./TaskDialog.tsx";
import { TaskSheet, type DetailState, type PanelEdit, type PanelProblem } from "./TaskSheet.tsx";

export type Viewer = { accountId: string; role: "owner" | "admin" | "member"; name: string | null };
type Loaded = {
	query: TaskQuery;
	page: { items: TaskItem[]; total: number; page: number };
	counts: TaskCounts;
	opened: TaskLoad | null;
};
type BulkItems = { taskId: string; expectedRevision: string }[];

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

/**
 * Tasks (REQ-TSK-001 to 003, 005 to 008, 015): My and All views, search, filters, sort and pages in the address, with
 * counts over the same scope. Completing, reopening and status changes show at once and are confirmed or rolled back
 * with a message; a confirmed answer replaces the row and moves the counts, so nothing reads the page again. Owners and
 * Admins create, edit and delete, change what a task waits for and how it repeats, and complete or reschedule a
 * selection at once; a Member acts only on a task they hold and adds steps under it (REQ-IDN-029).
 */
export function TasksScreen({ loaded, viewer, year }: { loaded: Loaded; viewer: Viewer; year: number }) {
	const router = useRouter();
	const pathname = usePathname();
	const toast = useToast();
	const admin = viewer.role !== "member";
	const [navigating, startNav] = useTransition();
	const [, startAction] = useTransition();

	// The server's answer is the source until this screen confirms a change. A new answer (filters, page) resets it.
	const [server, setServer] = useState(loaded);
	const [items, setItems] = useState(loaded.page.items);
	const [counts, setCounts] = useState(loaded.counts);
	const [total, setTotal] = useState(loaded.page.total);
	const [details, setDetails] = useState<Record<string, DetailState>>(() =>
		loaded.opened ? { [loaded.opened.task.id]: { status: "ok", ...loaded.opened } } : {},
	);
	const [openId, setOpenId] = useState<string | null>(loaded.opened?.task.id ?? null);
	// Owner and Admin select tasks for a bulk change; the report says what each selected task did.
	const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
	const [report, setReport] = useState<Report | null>(null);
	const [panelEdit, setPanelEdit] = useState<PanelEdit | null>(null);
	// A failure that started in the open panel is told there: the modal panel hides the toasts from assistive
	// technology and keeps keyboard focus inside, so a toast's Try again would be out of reach.
	const [problem, setProblem] = useState<PanelProblem | null>(null);
	if (server !== loaded) {
		setServer(loaded);
		setItems(loaded.page.items);
		setCounts(loaded.counts);
		setTotal(loaded.page.total);
		setSelected(new Set());
		setReport(null);
	}
	// Changes in flight (status, edit, delete, new task). They show at once and fall away when the write settles.
	const [pending, setPending] = useOptimistic(NO_PENDING, withChange);
	const shown = shownRows(items, pending);
	// The confirmed rows, for writes that settle after a later render.
	const listed = useRef(items);
	const known = useRef(details);
	useEffect(() => {
		listed.current = items;
		known.current = details;
	}, [items, details]);
	const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
	const [editing, setEditing] = useState<{ task: TaskDetail | "new"; draft?: Draft } | null>(null);
	const [deleting, setDeleting] = useState<TaskItem | null>(null);
	const loading = useRef(new Set<string>());
	const query = loaded.query;

	const go = (next: TaskQuery, replace = false) =>
		startNav(() => (replace ? router.replace : router.push)(pathname + querySearch(next), { scroll: false }));

	// The open task is in the address, so a reload or a shared link opens it again. Next keeps its router in step with
	// history.replaceState, so this sends no request.
	const address = (id: string | null) => {
		const url = new URL(window.location.href);
		if (id) url.searchParams.set("task", id);
		else url.searchParams.delete("task");
		window.history.replaceState(null, "", url.pathname + url.search);
	};
	const warm = (id: string) => {
		const known = details[id];
		if (loading.current.has(id) || (known?.status === "ok" && known.history !== null)) return;
		loading.current.add(id);
		setDetails((d) => ({ ...d, [id]: { status: "loading" } }));
		loadTask(id)
			.catch(() => lost)
			.then((r: Outcome<TaskLoad>) => {
				loading.current.delete(id);
				setDetails((d) => ({
					...d,
					[id]:
						r.status === "ok"
							? { status: "ok", ...r.value }
							: { status: "failed", code: r.status === "lost" ? "lost" : r.code },
				}));
			});
	};
	const shownId = useRef(openId);
	const open = (id: string) => {
		warm(id);
		if (id !== openId) {
			setPanelEdit(null);
			setProblem(null);
		}
		shownId.current = id;
		setOpenId(id);
		address(id);
	};
	const close = () => {
		shownId.current = null;
		setOpenId(null);
		setPanelEdit(null);
		setProblem(null);
		address(null);
	};
	/** A failure message: in the panel when it shows the task the change was for, else (or for a batch) as a toast. */
	const say = (subject: string | null, message: string, action?: PanelProblem["action"]) =>
		shownId.current === subject ? setProblem({ message, action }) : toast({ tone: "error", message, action });

	/** A confirmed write: the row, the counts and an open panel show the saved task; its history gains the entry. */
	const confirm = (before: TaskItem | null, saved: Saved, fields = false) => {
		const task = saved.task;
		// A task opened from the address may be outside this list (a closed task in the open list): only its panel changes.
		// A status change keeps its row in place, struck through; a new or edited task is listed and counted only when it
		// matches the query (F5), as the server would list it.
		const wasIn = before !== null && listed.current.some((r) => r.id === task.id);
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
			// Nothing cached yet (a new task): the panel reads the task and its history when it opens (F6).
			if (cur?.status !== "ok") return d;
			const moved = saved.changed && before && before.status !== task.status;
			// A status change moves a series' open occurrence; a successor (below) names the new one.
			const occurrence = moved ? null : cur.occurrence;
			const history =
				moved && cur.history && cur.history.next === null
					? {
							...cur.history,
							items: [
								...cur.history.items,
								{
									id: saved.receiptId as never,
									occurredAt: new Date().toISOString() as never,
									from: before.status,
									to: task.status,
									actor: { kind: "account" as const, accountId: viewer.accountId as never, displayName: viewer.name },
									source: "person" as const,
								},
							],
						}
					: cur.history;
			return { ...d, [task.id]: { ...cur, task, history, occurrence } };
		});
	};

	/**
	 * The next occurrence a completed recurring task created: it joins the list next to its predecessor when it matches
	 * the query, the counts move, and the toast offers to open it.
	 */
	const succeeded = (pred: Pick<TaskItem, "id">, next: TaskDetail) => {
		if (matches(query, next, viewer.accountId) && !listed.current.some((r) => r.id === next.id)) {
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
		const when = dueText(next.due, year);
		toast({
			tone: "success",
			message: when ? `Added the next “${next.title}”, due ${when}.` : `Added the next “${next.title}”.`,
			action: { label: "Open it", altText: "Open the next occurrence", onSelect: () => open(next.id) },
		});
	};

	/** A refused or lost write: the row goes back, the message says why, and an out-of-date copy is read again. */
	const fail = (
		task: Pick<TaskItem, "id" | "title">,
		r: Exclude<Outcome<unknown>, { status: "ok" }>,
		retry?: () => void,
		parentId?: string,
	) => {
		const code = r.status === "lost" ? "lost" : r.code;
		const later = r.status === "refused" && r.error?.code === "open_successor" ? r.error.details.successorId : null;
		say(
			parentId ?? task.id,
			`“${task.title}” did not change. ${problemText(code)}`,
			later
				? { label: "Open it", altText: "Open the later occurrence that is still open", onSelect: () => open(later) }
				: retry && r.status === "lost"
					? { label: "Try again", altText: "Try the change again", onSelect: retry }
					: undefined,
		);
		if (parentId) {
			if (code !== "lost") refresh(parentId);
			return;
		}
		if (code === "conflict" || code === "open_successor") refresh(task.id);
		if (code === "unavailable") {
			setItems((rows) => rows.filter((x) => x.id !== task.id));
			setTotal((t) => Math.max(0, t - 1));
		}
	};
	const refresh = (id: string) =>
		loadTask(id)
			.catch(() => lost)
			.then((r) => {
				if (r.status !== "ok") return;
				setItems((rows) => rows.map((x) => (x.id === id ? r.value.task : x)));
				setDetails((d) => ({ ...d, [id]: { status: "ok", ...r.value } }));
			});

	/**
	 * A step's confirmed answer: added, ticked or removed. The open panel's steps, the parent row's step count and the
	 * step counts follow, measured against the steps this screen last confirmed.
	 */
	const stepSaved = (parentId: string, step: TaskDetail) => {
		const cur = known.current[parentId];
		const before = cur?.status === "ok" ? cur.task.checklistItems.find((x) => x.id === step.id) : undefined;
		const total = step.deleted ? -Number(Boolean(before)) : before ? 0 : 1;
		const complete = Number(!step.deleted && step.status === "complete") - Number(before?.status === "complete");
		const saved: Step = {
			id: step.id,
			revision: step.revision,
			title: step.title,
			status: step.status,
			assignee: step.assignee,
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
		if (listed.current.some((r) => r.id === parentId))
			setCounts((c) => ({
				...c,
				childTaskTotal: c.childTaskTotal + total,
				childTaskComplete: c.childTaskComplete + complete,
			}));
	};
	/** A refused or lost write that is not a status change: the message says what did not happen and why. */
	const refused = (
		subject: string | null,
		what: string,
		r: Exclude<Outcome<unknown>, { status: "ok" }>,
		retry: () => void,
		again?: PanelProblem["action"],
	) =>
		say(
			subject,
			`${what} ${problemText(r.status === "lost" ? "lost" : r.code)}`,
			r.status === "lost" ? { label: "Try again", altText: "Try the change again", onSelect: retry } : again,
		);

	// One write per task at a time, in the order the person asked: a later change waits for the earlier one and sends
	// the revision it saved, so a quick second change is neither dropped nor refused as out of date.
	const queue = useRef(new Map<string, Promise<void>>());
	const revisions = useRef(new Map<string, string>());
	const revisionOf = (task: Pick<TaskItem, "id" | "revision">) => {
		const known = revisions.current.get(task.id);
		return known && BigInt(known) > BigInt(task.revision) ? known : task.revision;
	};
	/**
	 * Runs one write for one task, or one bulk write for several: `show` puts the change on screen, `send` makes the
	 * request, `settle` confirms or rolls back. It waits for earlier writes to the same tasks, and later ones wait for it.
	 * The optimistic change lasts exactly as long as the request.
	 */
	const serial = <T,>(
		ids: string | readonly string[],
		show: () => void,
		send: () => Promise<Outcome<T>>,
		settle: (r: Outcome<T>) => void,
	) => {
		const list = typeof ids === "string" ? [ids] : ids;
		setBusy((b) => new Set([...b, ...list]));
		const run: Promise<void> = Promise.all(list.map((id) => queue.current.get(id))).then(
			() =>
				new Promise<void>((resolve) =>
					startAction(async () => {
						show();
						const r = await send().catch(() => lost);
						resolve();
						startAction(() => {
							const done = list.filter((id) => queue.current.get(id) === run);
							for (const id of done) queue.current.delete(id);
							if (done.length)
								setBusy((b) => {
									const n = new Set(b);
									for (const id of done) n.delete(id);
									return n;
								});
							settle(r);
						});
					}),
				),
		);
		for (const id of list) queue.current.set(id, run);
	};
	/** One request of a save intent: a retry of a lost answer resends the intent's key and revision. */
	const keyed = (
		intent: Intent,
		call: (key: string, revision: string) => Promise<Outcome<Saved>>,
		revision: () => string,
	) => {
		const sent = intent.send(revision);
		return call(sent.key, sent.basis).then((r) => {
			if (r.status === "ok") revisions.current.set(r.value.task.id, r.value.task.revision);
			return r;
		});
	};

	const act = (task: TaskItem, action: StatusAction, intent = new Intent()) =>
		serial(
			task.id,
			() => setPending({ kind: "status", id: task.id, status: targetOf(action) }),
			() =>
				keyed(
					intent,
					(key, rev) => changeTaskStatus(key, rev, task.id, action),
					() => revisionOf(task),
				),
			(r) => {
				if (r.status !== "ok") return fail(task, r, () => act(task, action, intent));
				confirm(task, r.value);
				if (r.value.successor) succeeded(task, r.value.successor);
				if (action.kind === "waive") toast({ tone: "success", message: `Closed “${task.title}” as no longer needed.` });
			},
		);

	/** Tick or untick a step, shown at once. Its own assignee or an Owner/Admin may (REQ-TSK-005). */
	const tickStep = (parentId: string, step: Step, complete: boolean, intent = new Intent()) =>
		serial(
			step.id,
			() => setPending({ kind: "status", id: step.id, status: complete ? "complete" : "not_started" }),
			() =>
				keyed(
					intent,
					(key, rev) => setStep(key, rev, parentId, step.id, complete),
					() => revisionOf(step),
				),
			(r) =>
				r.status === "ok"
					? stepSaved(parentId, r.value.task)
					: fail(step, r, () => tickStep(parentId, step, complete, intent), parentId),
		);
	/** Add a step, shown at once under its task until the server names it. */
	const addStepTo = (parent: TaskItem, title: string, who: StepAssignee, intent = new Intent()) => {
		const assignee =
			who.kind === "inherit"
				? parent.assignee
				: who.kind === "nobody"
					? null
					: { accountId: who.accountId as never, displayName: who.name };
		const shownStep: Step = {
			id: (PENDING_PREFIX + crypto.randomUUID()) as never,
			revision: "0" as never,
			title,
			status: "not_started",
			assignee,
		};
		serial(
			parent.id,
			() => setPending({ kind: "step", parentId: parent.id, step: shownStep }),
			() =>
				keyed(
					intent,
					(key, rev) =>
						addStep(
							key,
							rev,
							parent.id,
							title,
							who.kind === "inherit" ? undefined : who.kind === "nobody" ? null : who.accountId,
						),
					() => revisionOf(parent),
				),
			(r) => {
				if (r.status === "ok") return stepSaved(parent.id, r.value.task);
				refused(parent.id, `“${title}” was not added.`, r, () => addStepTo(parent, title, who, intent));
				if (r.status === "refused" && r.code === "conflict") refresh(parent.id);
			},
		);
	};
	/** Remove a step, shown at once. It leaves the list; its history stays. Owner/Admin. */
	const removeStepFrom = (parentId: string, step: Step, intent = new Intent()) =>
		serial(
			step.id,
			() => setPending({ kind: "row", id: step.id, row: null }),
			() =>
				keyed(
					intent,
					(key, rev) => removeStep(key, rev, parentId, step.id),
					() => revisionOf(step),
				),
			(r) => {
				if (r.status === "ok") {
					stepSaved(parentId, r.value.task);
					return toast({ tone: "success", message: `Removed the step “${step.title}”. Its history is kept.` });
				}
				refused(parentId, `The step “${step.title}” was not removed.`, r, () => removeStepFrom(parentId, step, intent));
				if (r.status === "refused") refresh(parentId);
			},
		);

	/**
	 * Replace what a task waits for, shown at once in the panel and the row's badge (REQ-TSK-006). A loop or a stale
	 * copy refuses; the toast offers the person's list again.
	 */
	const savePrerequisites = (task: TaskItem, list: Prerequisite[], intent = new Intent()) => {
		setPanelEdit(null);
		const openCount = list.filter(blocks).length;
		serial(
			task.id,
			() => {
				setPending({ kind: "panel", id: task.id, panel: { prerequisites: list } });
				const row = listed.current.find((r) => r.id === task.id);
				if (row) setPending({ kind: "row", id: task.id, row: { ...row, openPrerequisites: openCount } });
			},
			() =>
				keyed(
					intent,
					(key, rev) =>
						setPrerequisites(
							key,
							rev,
							task.id,
							list.map((p) => p.id),
						),
					() => revisionOf(task),
				),
			(r) => {
				if (r.status === "ok") {
					confirm(task, r.value);
					return setDetails((d) => {
						const cur = d[task.id];
						return cur?.status === "ok"
							? { ...d, [task.id]: { ...cur, prerequisites: { taskId: task.id, items: list, blocked: openCount > 0 } } }
							: d;
					});
				}
				// In the open panel the list opens again with the person's choice; elsewhere the toast offers it.
				const again = () => {
					open(task.id);
					setPanelEdit({ kind: "prerequisites", draft: list });
				};
				const here = shownId.current === task.id;
				if (r.status === "refused" && here) again();
				refused(
					task.id,
					`What “${task.title}” waits for did not change.`,
					r,
					() => savePrerequisites(task, list, intent),
					here
						? undefined
						: {
								label: "Change it again",
								altText: "Open the list with your changes",
								onSelect: again,
							},
				);
				if (r.status === "refused" && r.code === "conflict") refresh(task.id);
			},
		);
	};
	/** Make a task repeat, change its rule or stop it, shown at once in the panel (REQ-TSK-007). */
	const saveRepeat = (task: TaskItem, before: TaskDetail["recurrence"], rule: Rule | null, intent = new Intent()) => {
		setPanelEdit(null);
		const shownRule: TaskDetail["recurrence"] = rule
			? { ...rule, seriesId: before?.seriesId ?? (PENDING_PREFIX as never), stopped: false }
			: before && { ...before, stopped: true };
		serial(
			task.id,
			() => setPending({ kind: "panel", id: task.id, panel: { recurrence: shownRule } }),
			() =>
				keyed(
					intent,
					(key, rev) => setRecurrence(key, rev, task.id, rule),
					() => revisionOf(task),
				),
			(r) => {
				if (r.status === "ok") return confirm(task, r.value);
				const again = () => {
					open(task.id);
					setPanelEdit({ kind: "repeat", draft: rule });
				};
				const here = shownId.current === task.id;
				if (r.status === "refused" && here) again();
				refused(
					task.id,
					`How “${task.title}” repeats did not change.`,
					r,
					() => saveRepeat(task, before, rule, intent),
					here
						? undefined
						: {
								label: "Change it again",
								altText: "Open the repeat settings with your choice",
								onSelect: again,
							},
				);
				if (r.status === "refused" && r.code === "conflict") refresh(task.id);
			},
		);
	};

	/**
	 * Complete or reschedule the selected tasks in one request (REQ-TSK-008). The rows change at once; the answer
	 * confirms each task that changed, rolls back the rest and reports why each one did not. The open ones that did not
	 * change stay selected, and a task that changed since it was selected is loaded again for review.
	 */
	const runBulk = (
		kind: Report["kind"],
		due: DueInput | null,
		chosen: TaskItem[],
		intent = new Intent<BulkItems>(),
	) => {
		if (!chosen.length) return;
		setReport(null);
		const after = (t: TaskItem, revision: string): TaskItem =>
			kind === "complete"
				? { ...t, revision: revision as never, status: "complete", completedAt: new Date().toISOString() as never }
				: { ...t, revision: revision as never, due: due as TaskItem["due"], overdue: previewOverdue(due!) };
		serial(
			chosen.map((t) => t.id),
			() => {
				for (const t of chosen)
					if (kind === "complete") setPending({ kind: "status", id: t.id, status: "complete" });
					else if (!isSettled(t.status)) setPending({ kind: "row", id: t.id, row: after(t, t.revision) });
			},
			() => {
				const sent = intent.send(() => chosen.map((t) => ({ taskId: t.id, expectedRevision: revisionOf(t) })));
				return (
					kind === "complete" ? bulkComplete(sent.key, sent.basis) : bulkReschedule(sent.key, sent.basis, due)
				).then((r: Outcome<BulkResult>) => {
					if (r.status === "ok")
						for (const i of r.value.items)
							if (i.outcome === "changed" && i.revision) revisions.current.set(i.taskId, i.revision);
					return r;
				});
			},
			(r) => {
				if (r.status !== "ok")
					return refused(null, kind === "complete" ? "No tasks were completed." : "No tasks were rescheduled.", r, () =>
						runBulk(kind, due, chosen, intent),
					);
				const result = r.value;
				const byId = new Map(chosen.map((t) => [t.id, t]));
				const outcome = new Map(result.items.map((i) => [i.taskId, i]));
				const gone = new Set(
					result.items.filter((i) => i.outcome === "deleted" || i.outcome === "not_found").map((i) => i.taskId),
				);
				const rows = listed.current;
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
				// A changed task's cached panel no longer matches; the open one reads again, the others on their next open.
				const changed = new Set<string>(result.items.filter((i) => i.outcome === "changed").map((i) => i.taskId));
				const shownTask = shownId.current;
				setDetails((d) => Object.fromEntries(Object.entries(d).filter(([id]) => !changed.has(id) || id === shownTask)));
				if (shownTask && changed.has(shownTask)) refresh(shownTask);
				for (const i of result.items) if (i.outcome === "stale") refresh(i.taskId);
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
		);
	};

	/** New task or edit, shown at once. A refusal puts the row back and offers the form again with the person's text. */
	const commit = (c: Commit, intent = new Intent()) => {
		const before = c.before;
		const id = before?.id ?? c.preview.id;
		serial(
			id,
			() => {
				const fits = matches(query, c.preview, viewer.accountId);
				if (before) setPending({ kind: "row", id, row: fits ? c.preview : null });
				else if (fits) setPending({ kind: "add", row: c.preview });
			},
			() => keyed(intent, c.send, () => (before ? revisionOf(before) : "0")),
			(r) => {
				if (r.status === "ok") return saved(before, r.value);
				const what = before ? `“${before.title}” did not change.` : `“${c.preview.title}” was not added.`;
				toast({
					tone: "error",
					message: `${what} ${problemText(r.status === "lost" ? "lost" : r.code)}`,
					action:
						r.status === "lost"
							? { label: "Try again", altText: "Save the same change again", onSelect: () => commit(c, intent) }
							: {
									label: "Open the form",
									altText: "Open the task form with your changes",
									onSelect: () => setEditing({ task: before ?? "new", draft: c.draft }),
								},
				});
				if (before && r.status === "refused" && r.code === "conflict") refresh(before.id);
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
						altText: "Open the task",
						onSelect: () => open(value.task.id),
					},
		});
	};
	const toggle = (task: TaskItem) => act(task, isSettled(task.status) ? { kind: "reopen" } : { kind: "complete" });
	const canAct = (task: Pick<TaskItem, "assignee">) => admin || task.assignee?.accountId === viewer.accountId;

	/** Delete, shown at once: the row leaves; a refusal brings it back with the reason. */
	const remove = (task: TaskItem, intent = new Intent()) => {
		if (openId === task.id) close();
		serial(
			task.id,
			() => setPending({ kind: "row", id: task.id, row: null }),
			() =>
				keyed(
					intent,
					(key, rev) => deleteTask(key, rev, task.id),
					() => revisionOf(task),
				),
			(r) => {
				if (r.status === "ok") {
					confirm(task, r.value);
					return toast({ tone: "success", message: `Deleted “${task.title}”. Its history is kept.` });
				}
				toast({
					tone: "error",
					message: `“${task.title}” was not deleted. ${problemText(r.status === "lost" ? "lost" : r.code)}`,
					action:
						r.status === "lost"
							? { label: "Try again", altText: "Delete the task again", onSelect: () => remove(task, intent) }
							: undefined,
				});
				if (r.status === "refused" && r.code === "conflict") refresh(task.id);
			},
		);
	};
	/** Edit needs the description, which the list does not carry: one read, then the form. */
	const edit = (task: TaskItem) => {
		const d = details[task.id];
		if (d?.status === "ok") return setEditing({ task: d.task });
		warmAssignees();
		loadTask(task.id).then((r) => (r.status === "ok" ? setEditing({ task: r.value.task }) : fail(task, r)));
	};

	const openState = openId ? (details[openId] ?? { status: "loading" }) : null;
	// The open task is the row when it is listed, else its loaded detail (a link to a task outside these filters).
	const openDetail = openState?.status === "ok" ? openState.task : null;
	const openTask = openId
		? (shown.find((t) => t.id === openId) ??
			(openDetail ? { ...openDetail, status: pending.status[openDetail.id] ?? openDetail.status } : null))
		: null;
	const groups = groupsOf(shown, query.sort);
	const filtered = isFiltered(query);
	const selectable = shown.filter((t) => !t.id.startsWith(PENDING_PREFIX));
	const chosen = selectable.filter((t) => selected.has(t.id));
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
						{admin ? (
							<Button
								variant="primary"
								icon={Add01Icon}
								onClick={() => setEditing({ task: "new" })}
								{...intentHandlers(warmAssignees)}
							>
								New task
							</Button>
						) : null}
					</>
				}
			/>
			<div className="grid grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)] items-start gap-5 max-app-md:grid-cols-1">
				<Card className="gap-2 px-[18px] py-5 max-app-sm:px-3">
					<Toolbar query={query} go={go} admin={admin} rows={items} />
					{report ? <BulkReport report={report} onOpen={open} onClose={() => setReport(null)} /> : null}
					<div aria-busy={navigating || undefined} className="transition-opacity duration-150 aria-busy:opacity-60">
						{shown.length === 0 ? (
							<Empty
								query={query}
								filtered={filtered}
								admin={admin}
								go={go}
								onNew={() => setEditing({ task: "new" })}
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
												busy={busy.has(t.id)}
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
				busy={openId ? busy.has(openId) : false}
				onAction={(a) => openTask && act(openTask, a)}
				onEdit={() => openState?.status === "ok" && setEditing({ task: openState.task })}
				onDelete={() => openTask && setDeleting(openTask)}
				onRetry={() => openId && warm(openId)}
				pending={pending}
				canActStep={(step) => canAct(step)}
				stepBusy={(id) => busy.has(id)}
				onStep={(step, complete) => openId && tickStep(openId, step, complete)}
				onAddStep={(title, who) => openTask && addStepTo(openTask, title, who)}
				onRemoveStep={(step) => openId && removeStepFrom(openId, step)}
				edit={panelEdit}
				onEditPanel={setPanelEdit}
				onPrerequisites={(list) => openTask && savePrerequisites(openTask, list)}
				onRepeat={(rule) => openTask && openDetail && saveRepeat(openTask, openDetail.recurrence, rule)}
				onOpenTask={open}
				problem={problem}
				onDismissProblem={() => setProblem(null)}
			/>
			{admin ? (
				<TaskDialog
					task={editing?.task ?? null}
					draft={editing?.draft}
					viewer={viewer}
					onClose={() => setEditing(null)}
					onCommit={(c) => {
						setEditing(null);
						commit(c);
					}}
					onSaved={(before, value) => {
						setEditing(null);
						saved(before, value);
					}}
					onConflict={(id) => refresh(id)}
				/>
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
	busy,
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
	/** Whether the row is in the bulk selection, or null when the viewer cannot select. */
	selected: boolean | null;
	onSelect: () => void;
	busy: boolean;
	onToggle: () => void;
	onAction: (a: StatusAction) => void;
	onOpen: () => void;
	onWarm: () => void;
	onEdit: () => void;
	onDelete: () => void;
}) {
	const settled = isSettled(task.status);
	return (
		<li
			data-done={settled || undefined}
			data-selected={selected || undefined}
			className="group/row flex items-center gap-3.5 rounded-card border-t border-line px-3 py-3.5 first:border-t-0 data-selected:bg-surface-raised data-selected:shadow-[inset_0_0_0_1.5px_var(--ef-ink)] max-app-sm:gap-2 max-app-sm:px-2 [[data-selected]+&]:border-t-transparent"
		>
			{selected !== null ? (
				<label className="-m-3 grid size-11 flex-none cursor-pointer place-items-center">
					<Checkbox aria-label={`Select ${task.title}`} checked={selected} onCheckedChange={onSelect} />
				</label>
			) : null}
			<DoneBox task={task} canAct={canAct} busy={busy} onToggle={onToggle} />
			<div className="min-w-0 flex-1">
				<button
					type="button"
					onClick={onOpen}
					{...intentHandlers(onWarm)}
					className={cn(
						"cursor-pointer rounded-xs text-left font-medium text-ink decoration-text-3 underline-offset-[3px] hover:underline",
						settled && "text-text-3 line-through",
					)}
				>
					{task.title}
				</button>
				<MetaLine task={task} year={year} />
			</div>
			<Assignee task={task} you={you} />
			{canAct ? (
				<Menu>
					<MenuTrigger asChild>
						<IconButton icon={MoreHorizontalIcon} label={`More for ${task.title}`} size="sm" />
					</MenuTrigger>
					<MenuContent align="end">
						<StatusItems task={task} onAction={onAction} />
						{admin ? (
							<>
								<MenuSeparator />
								<MenuItem icon={PencilEdit02Icon} onSelect={onEdit}>
									Edit
								</MenuItem>
								<MenuItem icon={Delete02Icon} danger onSelect={onDelete}>
									Delete
								</MenuItem>
							</>
						) : null}
					</MenuContent>
				</Menu>
			) : (
				<span aria-hidden="true" className="size-[34px] flex-none" />
			)}
		</li>
	);
}

/** The status choices for one task, shared by the row menu and the task panel. */
export function StatusItems({
	task,
	onAction,
}: {
	task: Pick<TaskItem, "status">;
	onAction: (a: StatusAction) => void;
}) {
	if (isSettled(task.status))
		return (
			<MenuItem icon={ArrowTurnBackwardIcon} onSelect={() => onAction({ kind: "reopen" })}>
				Reopen
			</MenuItem>
		);
	return (
		<>
			<MenuItem icon={Tick02Icon} onSelect={() => onAction({ kind: "complete" })}>
				Mark done
			</MenuItem>
			<MenuLabel>Status</MenuLabel>
			<MenuRadioGroup
				value={task.status}
				onValueChange={(v) => {
					const status = OPEN_STATUSES.find((s) => s === v);
					if (status && status !== task.status) onAction({ kind: "status", status });
				}}
			>
				{OPEN_STATUSES.map((s) => (
					<MenuRadioItem key={s} value={s}>
						{STATUS_LABEL[s]}
					</MenuRadioItem>
				))}
			</MenuRadioGroup>
			<MenuSeparator />
			<MenuItem icon={Cancel01Icon} onSelect={() => onAction({ kind: "waive", reason: null })}>
				Close as no longer needed
			</MenuItem>
		</>
	);
}

function SearchBox({ query, go }: { query: TaskQuery; go: (q: TaskQuery, replace?: boolean) => void }) {
	const [value, setValue] = useState(query.search);
	const latest = useRef(query);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => {
		latest.current = query;
	});
	useEffect(() => () => clearTimeout(timer.current), []);
	// Typing waits for a pause before it changes the address, so each keystroke is not a page load.
	return (
		<div className="w-[280px] max-app-sm:w-full">
			<SearchInput
				aria-label="Search tasks by title"
				placeholder="Search tasks"
				value={value}
				maxLength={200}
				onChange={(e) => {
					const next = e.target.value;
					setValue(next);
					clearTimeout(timer.current);
					timer.current = setTimeout(() => {
						if (next.trim() !== latest.current.search) go(withFilters(latest.current, { search: next.trim() }), true);
					}, 300);
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
	// Team names: an Owner or Admin reads the church's active teams when the chip shows intent; a Member's seat does not
	// list teams, so a Member picks from the teams named on this page.
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
