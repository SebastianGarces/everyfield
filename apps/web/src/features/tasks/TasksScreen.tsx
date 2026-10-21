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
import { changeTaskStatus, deleteTask, type StatusAction } from "./actions.ts";
import { loadTask, relationOptions } from "./fetch.ts";
import {
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
	type TaskHistory,
	type TaskItem,
	type TaskQuery,
} from "./model.ts";
import { Assignee, DoneBox, intentHandlers, MetaLine } from "./parts.tsx";
import { TaskDialog, warmAssignees, type Commit, type Draft } from "./TaskDialog.tsx";
import { TaskSheet, type DetailState } from "./TaskSheet.tsx";

export type Viewer = { accountId: string; role: "owner" | "admin" | "member"; name: string | null };
type Loaded = {
	query: TaskQuery;
	page: { items: TaskItem[]; total: number; page: number };
	counts: TaskCounts;
	opened: { task: TaskDetail; history: TaskHistory | null } | null;
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

/**
 * Tasks (REQ-TSK-001 to 003, 015): My and All views, search, filters, sort and pages in the address, with counts over
 * the same scope. Completing, reopening and status changes show at once and are confirmed or rolled back with a
 * message; a confirmed answer replaces the row and moves the counts, so nothing reads the page again. Owners and
 * Admins create, edit and delete; a Member acts only on a task they hold (REQ-IDN-029).
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
	if (server !== loaded) {
		setServer(loaded);
		setItems(loaded.page.items);
		setCounts(loaded.counts);
		setTotal(loaded.page.total);
	}
	// Changes in flight (status, edit, delete, new task). They show at once and fall away when the write settles.
	const [pending, setPending] = useOptimistic(NO_PENDING, withChange);
	const shown = shownRows(items, pending);
	// The confirmed rows, for writes that settle after a later render.
	const listed = useRef(items);
	useEffect(() => {
		listed.current = items;
	}, [items]);
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
			.then((r: Outcome<{ task: TaskDetail; history: TaskHistory | null }>) => {
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
	const open = (id: string) => {
		warm(id);
		setOpenId(id);
		address(id);
	};
	const close = () => {
		setOpenId(null);
		address(null);
	};

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
			return { ...d, [task.id]: { status: "ok", task, history } };
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
		toast({
			tone: "error",
			message: `“${task.title}” did not change. ${problemText(code)}`,
			action:
				retry && r.status === "lost"
					? { label: "Try again", altText: "Try the change again", onSelect: retry }
					: undefined,
		});
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

	/** A step's confirmed status: the open panel's checklist and the parent row's step count follow it. */
	const confirmStep = (parentId: string, before: Pick<TaskItem, "status">, saved: Saved) => {
		const step = saved.task;
		const delta = Number(step.status === "complete") - Number(before.status === "complete");
		setDetails((d) => {
			const cur = d[parentId];
			if (cur?.status !== "ok") return d;
			const checklistItems = cur.task.checklistItems.map((s) =>
				s.id === step.id
					? { id: s.id, revision: step.revision, title: step.title, status: step.status, assignee: step.assignee }
					: s,
			);
			return { ...d, [parentId]: { ...cur, task: { ...cur.task, checklistItems } } };
		});
		if (!delta) return;
		setItems((rows) =>
			rows.map((r) =>
				r.id === parentId ? { ...r, checklist: { ...r.checklist, complete: r.checklist.complete + delta } } : r,
			),
		);
		setCounts((c) => ({ ...c, childTaskComplete: c.childTaskComplete + delta }));
	};

	// One write per task at a time, in the order the person asked: a later change waits for the earlier one and sends
	// the revision it saved, so a quick second change is neither dropped nor refused as out of date.
	const queue = useRef(new Map<string, Promise<void>>());
	const revisions = useRef(new Map<string, string>());
	const revisionOf = (task: Pick<TaskItem, "id" | "revision">) => {
		const known = revisions.current.get(task.id);
		return known && BigInt(known) > BigInt(task.revision) ? known : task.revision;
	};
	/**
	 * Runs one write for a task: `show` puts the change on screen, `send` makes the request, `settle` confirms or rolls
	 * back. The optimistic change lasts exactly as long as the request.
	 */
	const serial = <T,>(
		id: string,
		show: () => void,
		send: () => Promise<Outcome<T>>,
		settle: (r: Outcome<T>) => void,
	) => {
		setBusy((b) => new Set(b).add(id));
		const run: Promise<void> = (queue.current.get(id) ?? Promise.resolve()).then(
			() =>
				new Promise<void>((resolve) =>
					startAction(async () => {
						show();
						const r = await send().catch(() => lost);
						resolve();
						startAction(() => {
							if (queue.current.get(id) === run) {
								queue.current.delete(id);
								setBusy((b) => {
									const n = new Set(b);
									n.delete(id);
									return n;
								});
							}
							settle(r);
						});
					}),
				),
		);
		queue.current.set(id, run);
	};
	/** One request of a save intent: a retry of a lost answer resends the intent's key and revision. */
	const keyed = (
		id: string,
		intent: Intent,
		call: (key: string, revision: string) => Promise<Outcome<Saved>>,
		revision: () => string,
	) => {
		const sent = intent.send(revision);
		return call(sent.key, sent.revision).then((r) => {
			if (r.status === "ok") revisions.current.set(id, r.value.task.revision);
			return r;
		});
	};

	const act = (
		task: Pick<TaskItem, "id" | "revision" | "title" | "status">,
		action: StatusAction,
		parentId?: string,
		intent = new Intent(),
	) =>
		serial(
			task.id,
			() => setPending({ kind: "status", id: task.id, status: targetOf(action) }),
			() =>
				keyed(
					task.id,
					intent,
					(key, rev) => changeTaskStatus(key, rev, task.id, action),
					() => revisionOf(task),
				),
			(r) => {
				if (r.status === "ok") {
					if (parentId) confirmStep(parentId, task, r.value);
					else confirm(task as TaskItem, r.value);
					if (action.kind === "waive")
						toast({ tone: "success", message: `Closed “${task.title}” as no longer needed.` });
				} else fail(task, r, () => act(task, action, parentId, intent), parentId);
			},
		);

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
			() => keyed(id, intent, c.send, () => (before ? revisionOf(before) : "0")),
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
					task.id,
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
				onStep={(step, a) => openId && act(step, a, openId)}
				overlay={pending.status}
				canActStep={(step) => canAct(step)}
				stepBusy={(id) => busy.has(id)}
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
			className="group/row flex items-center gap-3.5 rounded-card border-t border-line px-3 py-3.5 first:border-t-0 max-app-sm:gap-3 max-app-sm:px-2"
		>
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
				{item(Tick02Icon, "Read every task and its history")}
				{item(LockKeyIcon, "New tasks, assigning, rescheduling and other people’s tasks need an Owner or Admin", true)}
			</ul>
		</Card>
	);
}
