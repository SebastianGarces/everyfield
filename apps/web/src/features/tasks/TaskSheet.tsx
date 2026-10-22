"use client";

import { Alert02Icon, ArrowDown01Icon, Delete02Icon, Link04Icon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	buttonVariants,
	IntentLink,
	Menu,
	MenuContent,
	MenuTrigger,
	Sheet,
	Skeleton,
	StatePanel,
} from "@everyfield/ui/controls";
import { KeyValue, KeyValueList, StatusBadge } from "@everyfield/ui/display";
import { cn, Icon } from "@everyfield/ui/foundations";
import { useId, useState, type ReactNode } from "react";
import type { Wait } from "../../components/save/model.ts";
import { When } from "../people/parts.tsx";
import type { StatusAction } from "./actions.ts";
import { loadHistory, type Loaded } from "./fetch.ts";
import {
	blockedText,
	CATEGORY_LABEL,
	isSettled,
	PRIORITY_LABEL,
	problemText,
	shownSteps,
	STATUS_LABEL,
	type Pending,
	type Prerequisite,
	type Rule,
	type Step,
	type TaskHistory,
	type TaskItem,
} from "./model.ts";
import { DueLine, STATUS_TONE } from "./parts.tsx";
import { BlockedBy, Repeats, Section, Steps, type StepAssignee } from "./structure.tsx";
import { StatusItems, type Viewer } from "./TasksScreen.tsx";

export type DetailState = { status: "loading" } | { status: "failed"; code: string } | ({ status: "ok" } & Loaded);
/**
 * The panel section being edited, with the person's choice and the refusal code from a refused save to show again.
 */
export type PanelEdit =
	| { kind: "prerequisites"; draft?: Prerequisite[]; problem?: string }
	| { kind: "repeat"; draft?: Rule | null; problem?: string };
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
	wait,
	onAction,
	onEdit,
	onDelete,
	onRetry,
	pending,
	canActStep,
	stepWait,
	onStep,
	onAddStep,
	onRemoveStep,
	edit,
	onEditPanel,
	onPrerequisites,
	onRepeat,
	onOpenTask,
	notices,
}: {
	task: TaskItem | null;
	state: DetailState | null;
	open: boolean;
	onClose: () => void;
	year: number;
	viewer: Viewer;
	canAct: boolean;
	/** The task's last save is in flight or unknown: its status actions and Delete wait (C68). */
	wait: Wait;
	onAction: (a: StatusAction) => void;
	onEdit: () => void;
	onDelete: () => void;
	onRetry: () => void;
	/** Changes still in flight, shown before they are confirmed. */
	pending: Pending;
	canActStep: (step: Step) => boolean;
	stepWait: (id: string) => Wait;
	onStep: (step: Step, complete: boolean) => void;
	onAddStep: (title: string, assignee: StepAssignee) => void;
	onRemoveStep: (step: Step) => void;
	edit: PanelEdit | null;
	onEditPanel: (edit: PanelEdit | null) => void;
	onPrerequisites: (items: Prerequisite[]) => void;
	onRepeat: (rule: Rule | null) => void;
	onOpenTask: (id: string) => void;
	/** The cards' notices: while the panel is open, they show here (C69). */
	notices: ReactNode;
}) {
	const hint = useId();
	const locked = wait !== null;
	const detail = state?.status === "ok" ? state.task : null;
	const panel = detail ? pending.panel[detail.id] : undefined;
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
						{task.openPrerequisites > 0 && !isSettled(task.status) ? (
							<span className="inline-flex items-center gap-1.5">
								<Icon icon={Link04Icon} size={16} />
								{blockedText(task.openPrerequisites)}
							</span>
						) : null}
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
						<Button
							variant="ghost"
							size="sm"
							icon={Delete02Icon}
							disabled={locked}
							aria-describedby={locked ? hint : undefined}
							onClick={onDelete}
							className="text-magenta-600"
						>
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
					<div className="empty:hidden">
						{notices}
						{edit?.problem ? (
							<p
								role="alert"
								className="flex items-start gap-2 rounded-md bg-magenta-50 px-3.5 py-2.5 text-sm text-magenta-600"
							>
								<Icon icon={Alert02Icon} size={16} className="mt-px flex-none" />
								{edit.kind === "prerequisites"
									? `What this task waits for was not saved. ${problemText(edit.problem as never)}`
									: `How this task repeats was not saved. ${problemText(edit.problem as never)}`}
							</p>
						) : null}
					</div>
					{canAct ? (
						<div className="flex flex-wrap items-center gap-2.5">
							<Button
								variant={isSettled(task.status) ? "secondary" : "primary"}
								size="sm"
								aria-busy={wait === "saving" || undefined}
								disabled={locked}
								aria-describedby={locked ? hint : undefined}
								onClick={() => onAction(isSettled(task.status) ? { kind: "reopen" } : { kind: "complete" })}
							>
								{isSettled(task.status) ? "Reopen" : "Mark done"}
							</Button>
							{isSettled(task.status) ? null : (
								<Menu>
									<MenuTrigger asChild>
										<Button variant="outline" size="sm" disabled={locked} aria-describedby={locked ? hint : undefined}>
											Change status
											<Icon icon={ArrowDown01Icon} size={16} className="-mr-1" />
										</Button>
									</MenuTrigger>
									<MenuContent>
										<StatusItems task={task} onAction={onAction} />
									</MenuContent>
								</Menu>
							)}
							{locked ? (
								<p id={hint} className="text-xs text-text-2">
									{wait === "saving" ? "Waiting for the last save." : "Check the last save first."}
								</p>
							) : null}
						</div>
					) : null}
					{task.managed ? (
						<p className="rounded-md bg-surface px-3.5 py-2.5 text-sm">{MANAGED[task.managed.kind]}</p>
					) : null}
					{/* A follow-up with a person records what happened, not just a tick (WP-023, REQ-MTG-022). */}
					{task.relation?.kind === "person" && !task.parentId && !task.deleted ? (
						<IntentLink
							href={`/follow-ups/${task.id}`}
							className={buttonVariants({ variant: "outline", size: "sm", className: "self-start" })}
						>
							Record what happened
						</IntentLink>
					) : null}
					<KeyValueList>
						<KeyValue
							size="sm"
							k="Due"
							value={
								task.due.kind === "undated" ? (
									<span className="text-text-3">No due date</span>
								) : (
									<DueLine task={task} year={year} />
								)
							}
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
									<IntentLink href={`/people/${task.relation.id}`} className="underline underline-offset-[3px]">
										{task.relation.label}
									</IntentLink>
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
							<Steps
								steps={shownSteps(detail.checklistItems, detail.id, pending)}
								taskAssignee={task.assignee}
								canAdd={!detail.parentId && !detail.deleted && (admin || task.assignee?.accountId === viewer.accountId)}
								admin={admin}
								you={viewer.accountId}
								canTick={canActStep}
								wait={stepWait}
								onTick={onStep}
								onRemove={onRemoveStep}
								onAdd={onAddStep}
							/>
							{detail.parentId ? null : (
								<>
									<BlockedBy
										task={task}
										items={
											panel?.prerequisites ?? (state?.status === "ok" ? (state.prerequisites?.items ?? null) : null)
										}
										admin={admin}
										editing={edit?.kind === "prerequisites"}
										locked={locked}
										draft={edit?.kind === "prerequisites" ? edit.draft : undefined}
										onEdit={() => onEditPanel({ kind: "prerequisites" })}
										onCancel={() => onEditPanel(null)}
										onSave={onPrerequisites}
										onOpen={onOpenTask}
									/>
									<Repeats
										task={{
											id: detail.id,
											status: task.status,
											recurrence: panel && "recurrence" in panel ? (panel.recurrence ?? null) : detail.recurrence,
										}}
										occurrence={state?.status === "ok" ? state.occurrence : null}
										canEdit={admin && !detail.managed && !detail.deleted}
										editing={edit?.kind === "repeat"}
										locked={locked}
										draft={edit?.kind === "repeat" ? edit.draft : undefined}
										year={year}
										onEdit={() => onEditPanel({ kind: "repeat" })}
										onCancel={() => onEditPanel(null)}
										onSave={onRepeat}
										onOpen={onOpenTask}
									/>
								</>
							)}
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
