"use client";

import { ArrowDown01Icon, Delete02Icon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Menu,
	MenuContent,
	MenuTrigger,
	Sheet,
	Skeleton,
	StatePanel,
} from "@everyfield/ui/controls";
import { KeyValue, KeyValueList, StatusBadge } from "@everyfield/ui/display";
import { cn, Icon } from "@everyfield/ui/foundations";
import { useState } from "react";
import { PersonLink, When } from "../people/parts.tsx";
import { loadHistory, type StatusAction } from "./actions.ts";
import {
	CATEGORY_LABEL,
	isSettled,
	PRIORITY_LABEL,
	problemText,
	STATUS_LABEL,
	type TaskDetail,
	type TaskHistory,
	type TaskItem,
} from "./model.ts";
import { DoneBox, DueLine, STATUS_TONE } from "./parts.tsx";
import { StatusItems, type Viewer } from "./TasksScreen.tsx";

export type DetailState =
	| { status: "loading" }
	| { status: "failed"; code: string }
	| { status: "ok"; task: TaskDetail; history: TaskHistory | null };
type Step = TaskDetail["checklistItems"][number];
type Entry = TaskHistory["items"][number];

const SOURCE: Record<Entry["source"], string> = {
	person: "",
	evry: " through Evry",
	bulk: " in a bulk change",
	generated: " when the meeting was finalized",
	recurrence: " by the repeat schedule",
	correction: " as a correction",
};
const MANAGED = {
	first_vision_follow_up: "A meeting created this follow-up for a first-time guest.",
	meeting_evaluation: "A meeting created this evaluation task.",
} as const;
/** Who made a change. A system cause is never shown as a person (REQ-TSK-015). */
function actorText(a: Entry["actor"]): string {
	if (a.kind === "system") {
		const words = a.cause.replaceAll(/[_.]+/g, " ").trim();
		return `EveryField (${words || "automatic"})`;
	}
	if (a.kind === "former_account") return "A former member";
	return a.displayName ?? "A former member";
}

/**
 * The task panel: what the task is, its steps and its status history (REQ-TSK-015), with the status actions the
 * viewer may take. It opens at once with the row's facts and fills in the rest from one read.
 */
export function TaskSheet({
	task: row,
	state,
	open,
	onClose,
	year,
	viewer,
	canAct,
	busy,
	onAction,
	onEdit,
	onDelete,
	onRetry,
	onStep,
	canActStep,
	stepBusy,
}: {
	task: TaskItem | null;
	state: DetailState | null;
	open: boolean;
	onClose: () => void;
	year: number;
	viewer: Viewer;
	canAct: boolean;
	busy: boolean;
	onAction: (a: StatusAction) => void;
	onEdit: () => void;
	onDelete: () => void;
	onRetry: () => void;
	onStep: (step: Step, a: StatusAction) => void;
	canActStep: (step: Step) => boolean;
	stepBusy: (id: string) => boolean;
}) {
	const detail = state?.status === "ok" ? state.task : null;
	// The row is the latest confirmed or optimistic state; the detail adds description, steps and history.
	const task: TaskItem | null = row ?? detail;
	const admin = viewer.role !== "member";
	return (
		<Sheet
			open={open}
			onOpenChange={(o) => !o && onClose()}
			title={task?.title ?? "Task"}
			description={
				task ? (
					<span className="inline-flex flex-wrap items-center gap-2">
						<StatusBadge status={STATUS_TONE[task.status]} size="sm">
							{STATUS_LABEL[task.status]}
						</StatusBadge>
						{task.managed ? "Created by a meeting" : null}
					</span>
				) : undefined
			}
			footer={
				task && admin && detail ? (
					<>
						<Button variant="secondary" size="sm" icon={PencilEdit02Icon} onClick={onEdit}>
							Edit
						</Button>
						<span className="grow" />
						<Button variant="ghost" size="sm" icon={Delete02Icon} onClick={onDelete} className="text-magenta-600">
							Delete
						</Button>
					</>
				) : undefined
			}
		>
			{!task && state?.status === "failed" ? (
				<StatePanel
					tone="error"
					title="This task did not load"
					headingLevel="h3"
					actions={
						<Button variant="primary" size="sm" onClick={onRetry}>
							Try again
						</Button>
					}
				>
					{problemText(state.code === "lost" ? "lost" : (state.code as never))}
				</StatePanel>
			) : !task ? (
				<Loading />
			) : (
				<div className="flex flex-col gap-6">
					{canAct ? (
						<div className="flex flex-wrap items-center gap-2.5">
							<Button
								variant={isSettled(task.status) ? "secondary" : "primary"}
								size="sm"
								aria-busy={busy || undefined}
								onClick={() => !busy && onAction(isSettled(task.status) ? { kind: "reopen" } : { kind: "complete" })}
							>
								{isSettled(task.status) ? "Reopen" : "Mark done"}
							</Button>
							{isSettled(task.status) ? null : (
								<Menu>
									<MenuTrigger asChild>
										<Button variant="outline" size="sm" disabled={busy}>
											Change status
											<Icon icon={ArrowDown01Icon} size={16} className="-mr-1" />
										</Button>
									</MenuTrigger>
									<MenuContent>
										<StatusItems task={task} onAction={onAction} />
									</MenuContent>
								</Menu>
							)}
						</div>
					) : null}
					{task.managed ? <p className="rounded-md bg-surface px-3.5 py-2.5 text-sm">{MANAGED[task.managed.kind]}</p> : null}
					<KeyValueList>
						<KeyValue
							size="sm"
							k="Due"
							value={task.due.kind === "undated" ? <span className="text-text-3">No due date</span> : <DueLine task={task} year={year} />}
						/>
						<KeyValue
							size="sm"
							k="Assigned to"
							value={
								task.assignee ? (
									task.assignee.accountId === viewer.accountId ? (
										"You"
									) : (
										task.assignee.displayName || "A former member"
									)
								) : (
									<StatusBadge status="attention" size="sm">
										Needs owner
									</StatusBadge>
								)
							}
						/>
						<KeyValue size="sm" k="Priority" value={PRIORITY_LABEL[task.priority]} />
						<KeyValue size="sm" k="Category" value={CATEGORY_LABEL[task.category]} />
						<KeyValue
							size="sm"
							k="Linked to"
							value={
								!task.relation ? (
									<span className="text-text-3">Nothing</span>
								) : task.relation.kind === "person" ? (
									<PersonLink href={`/people/${task.relation.id}`} className="underline underline-offset-[3px]">
										{task.relation.label}
									</PersonLink>
								) : (
									task.relation.label
								)
							}
						/>
						{task.status === "complete" && task.completedAt ? (
							<KeyValue size="sm" k="Done" value={<When at={task.completedAt} withTime />} />
						) : null}
						<KeyValue size="sm" k="Added" value={<When at={task.createdAt} />} />
					</KeyValueList>
					{detail ? (
						<>
							<Section title="Description">
								{detail.description ? (
									<p className="text-md whitespace-pre-wrap text-ink">{detail.description}</p>
								) : (
									<p className="text-sm text-text-3">No description.</p>
								)}
							</Section>
							{detail.checklistItems.length ? (
								<Section title="Steps">
									<ul>
										{detail.checklistItems.map((s) => (
											<li key={s.id} className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0">
												<DoneBox task={s} canAct={canActStep(s)} busy={stepBusy(s.id)} onToggle={() =>
													onStep(s, isSettled(s.status) ? { kind: "reopen" } : { kind: "complete" })
												} />
												<span className={cn("min-w-0 flex-1 text-ink", isSettled(s.status) && "text-text-3 line-through")}>
													{s.title}
												</span>
												<span className="text-sm text-text-3">{s.assignee?.displayName ?? "Needs owner"}</span>
											</li>
										))}
									</ul>
								</Section>
							) : null}
							<History key={detail.id} taskId={detail.id} history={state?.status === "ok" ? state.history : null} />
						</>
					) : state?.status === "failed" ? (
						<StatePanel
							tone="error"
							title="The rest of this task did not load"
							headingLevel="h3"
							actions={
								<Button variant="secondary" size="sm" onClick={onRetry}>
									Try again
								</Button>
							}
						>
							{problemText(state.code === "lost" ? "lost" : (state.code as never))}
						</StatePanel>
					) : (
						<Loading />
					)}
				</div>
			)}
		</Sheet>
	);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="flex flex-col gap-2">
			<h3 className="text-sm font-semibold text-ink-2">{title}</h3>
			{children}
		</section>
	);
}

function Loading() {
	return (
		<div aria-busy="true" className="flex flex-col gap-3">
			<span className="sr-only" role="status">
				Loading the task
			</span>
			<Skeleton className="h-4 w-3/4" />
			<Skeleton className="h-4 w-1/2" />
			<Skeleton className="h-4 w-2/3" />
		</div>
	);
}

/** Every status change, oldest first, with who or what made it and when. Later pages load on request. */
function History({ taskId, history }: { taskId: string; history: TaskHistory | null }) {
	const [more, setMore] = useState<{ items: Entry[]; next: number | null; problem?: string } | null>(null);
	const [loading, setLoading] = useState(false);
	if (!history)
		return (
			<Section title="Status history">
				<p className="text-sm text-text-3">The history did not load. Close and open the task to try again.</p>
			</Section>
		);
	const items = [...history.items, ...(more?.items ?? [])];
	const next = more ? more.next : history.next;
	return (
		<Section title="Status history">
			<ol className="flex flex-col">
				{items.map((e) => (
					<li
						key={e.id}
						className="grid grid-cols-[10px_minmax(0,1fr)] items-start gap-2.5 border-t border-line py-2.5 text-sm first:border-t-0"
					>
						<span
							aria-hidden="true"
							className={cn(
								"mt-1.5 size-2 rounded-full",
								e.to === "complete" ? "bg-green-500" : e.to === "no_longer_needed" ? "bg-text-3" : "bg-blue-500",
							)}
						/>
						<div className="min-w-0">
							<div className="font-medium text-ink">
								{e.from === null ? `Created as ${STATUS_LABEL[e.to].toLowerCase()}` : STATUS_LABEL[e.to]}
							</div>
							<div className="text-xs text-text-3">
								{actorText(e.actor)}
								{SOURCE[e.source]} · <When at={e.occurredAt} withTime />
							</div>
						</div>
					</li>
				))}
			</ol>
			{more?.problem ? <p className="text-sm text-magenta-600">{more.problem}</p> : null}
			{next ? (
				<Button
					variant="ghost"
					size="sm"
					loading={loading}
					className="self-start"
					onClick={async () => {
						setLoading(true);
						const r = await loadHistory(taskId, next).catch(() => ({ status: "lost" }) as const);
						setLoading(false);
						setMore((m) =>
							r.status === "ok"
								? { items: [...(m?.items ?? []), ...r.value.items], next: r.value.next }
								: { items: m?.items ?? [], next, problem: problemText(r.status === "lost" ? "lost" : r.code) },
						);
					}}
				>
					Show more changes
				</Button>
			) : null}
		</Section>
	);
}
