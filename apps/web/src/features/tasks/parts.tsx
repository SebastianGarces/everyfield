"use client";

import {
	ArrowTurnBackwardIcon,
	Calendar03Icon,
	Cancel01Icon,
	CheckListIcon,
	Clock01Icon,
	Link04Icon,
	UserGroupIcon,
	Tick02Icon,
	UserIcon,
} from "@hugeicons/core-free-icons";
import { Checkbox, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator } from "@everyfield/ui/controls";
import { Avatar, StatusBadge, type Status as Tone } from "@everyfield/ui/display";
import { cn, Icon, type IconSvgElement } from "@everyfield/ui/foundations";
import type { PointerEvent, ReactNode } from "react";
import type { Wait } from "../../components/save/model.ts";
import type { StatusAction } from "./actions.ts";
import { originText } from "../followups/model.ts";
import { When } from "../people/parts.tsx";
import {
	assigneeNames,
	assigneeSummary,
	blockedText,
	dueText,
	isSettled,
	OPEN_STATUSES,
	ownerText,
	PRIORITY_LABEL,
	STATUS_LABEL,
	type Status,
	type TaskItem,
} from "./model.ts";

const RELATION_ICON: Record<NonNullable<TaskItem["relation"]>["kind"], IconSvgElement> = {
	person: UserIcon,
	meeting: Calendar03Icon,
	team: UserGroupIcon,
};
export const STATUS_TONE: Record<Status, Tone> = {
	not_started: "unknown",
	in_progress: "measured",
	blocked: "attention",
	complete: "positive",
	no_longer_needed: "unknown",
};

export function intentHandlers(warm: () => void) {
	return {
		onPointerMove: (e: PointerEvent) => void (e.pointerType === "mouse" && warm()),
		onTouchStart: warm,
		onFocus: (e: { currentTarget: Element }) => void (e.currentTarget.matches(":focus-visible") && warm()),
	};
}

export function DoneBox({
	task,
	canAct,
	wait,
	describedBy,
	onToggle,
}: {
	task: Pick<TaskItem, "title" | "status">;
	canAct: boolean;
	describedBy?: string;
	wait: Wait;
	onToggle: () => void;
}) {
	if (!canAct) return <span aria-hidden="true" className="size-11 flex-none" />;
	const settled = isSettled(task.status);
	return (
		<label className="-m-3 grid size-11 flex-none place-items-center rounded-full">
			<Checkbox
				shape="round"
				aria-label={`${settled ? "Reopen" : "Complete"} ${task.title}`}
				aria-busy={wait === "saving" || undefined}
				aria-describedby={describedBy}
				disabled={wait !== null}
				className={wait === "saving" ? "disabled:opacity-100" : undefined}
				checked={task.status === "complete" ? true : task.status === "no_longer_needed" ? "indeterminate" : false}
				onCheckedChange={onToggle}
			/>
		</label>
	);
}

export function DueLine({ task, year }: { task: Pick<TaskItem, "due" | "overdue" | "status">; year: number }) {
	const text = dueText(task.due, year);
	if (!text) return null;
	const late = task.overdue && !isSettled(task.status);
	return (
		<span className={cn("inline-flex items-center gap-1.5", late && "font-medium text-magenta-600")}>
			<Icon icon={task.due.kind === "resolved_instant" ? Clock01Icon : Calendar03Icon} size={16} />
			{late ? `Overdue · ${text}` : text}
		</span>
	);
}

export function Assignee({ task, you }: { task: Pick<TaskItem, "assignees" | "followUpOwners">; you: string }) {
	const names = assigneeNames(task.assignees);
	const [firstName] = names;
	if (firstName === undefined)
		return (
			<StatusBadge status="attention" size="sm" className="max-app-sm:hidden">
				Needs owner
			</StatusBadge>
		);
	const own = task.assignees.some((a) => a.accountId === you);
	const who = task.assignees.map((a) => {
		const view = task.followUpOwners.find((o) => o.accountId === a.accountId);
		return view && !view.eligible ? ownerText(view) : assigneeNames([a])[0];
	});
	const label = own && task.assignees.length === 1 ? "Assigned to you" : `Assigned to ${who.join(", ")}`;
	const full = names.join(", ");
	const room = full.length <= 28;
	return (
		<span
			className="inline-flex max-w-[260px] min-w-0 items-center gap-2 max-app-sm:max-w-[120px]"
			title={who.join(", ")}
		>
			<Avatar name={firstName} label={label} size="xs" ring={own} />
			<span className="min-w-0 truncate text-sm text-text-2" aria-hidden="true">
				<span className="max-app-sm:hidden">{room ? full : assigneeSummary(task.assignees)}</span>
				<span className="app-sm:hidden">{assigneeSummary(task.assignees)}</span>
			</span>
		</span>
	);
}

export function MetaLine({ task, year }: { task: TaskItem; year: number }) {
	const parts: ReactNode[] = [];
	if (!task.assignees.length)
		parts.push(
			<StatusBadge key="owner" status="attention" size="sm" className="app-sm:hidden">
				Needs owner
			</StatusBadge>,
		);
	if (!isSettled(task.status))
		for (const o of task.followUpOwners.filter((x) => !x.eligible))
			parts.push(
				<StatusBadge key={`ineligible-${o.accountId}`} status="attention" size="sm">
					{ownerText(o)}
				</StatusBadge>,
			);
	if (task.followUpOrigin && !isSettled(task.status))
		parts.push(<span key="origin">{originText(task.followUpOrigin)}</span>);
	if (task.status === "complete" && task.completedAt)
		parts.push(
			<span key="done">
				Done <When at={task.completedAt} />
			</span>,
		);
	else if (task.status === "no_longer_needed") parts.push(<span key="nln">No longer needed</span>);
	else parts.push(<DueLine key="due" task={task} year={year} />);
	if (task.status === "in_progress" || task.status === "blocked")
		parts.push(
			<StatusBadge key="status" status={STATUS_TONE[task.status]} size="sm">
				{STATUS_LABEL[task.status]}
			</StatusBadge>,
		);
	if (task.openPrerequisites > 0 && !isSettled(task.status))
		parts.push(
			<span key="waits" className="inline-flex items-center gap-1.5">
				<Icon icon={Link04Icon} size={16} />
				{blockedText(task.openPrerequisites)}
			</span>,
		);
	if (task.priority === "urgent" || task.priority === "high")
		parts.push(
			<StatusBadge
				key="priority"
				status={task.priority === "urgent" ? "risk" : "attention"}
				size="sm"
				plain
				fill="soft"
			>
				{PRIORITY_LABEL[task.priority]}
			</StatusBadge>,
		);
	if (task.relation)
		parts.push(
			<span key="rel" className="inline-flex min-w-0 items-center gap-1.5">
				<Icon icon={RELATION_ICON[task.relation.kind]} size={16} />
				<span className="truncate">{task.relation.label}</span>
			</span>,
		);
	if (task.checklist.total > 0)
		parts.push(
			<span key="steps" className="inline-flex items-center gap-1.5">
				<Icon icon={CheckListIcon} size={16} />
				{task.checklist.complete} of {task.checklist.total} steps
			</span>,
		);
	const shown = parts.filter(Boolean);
	if (!shown.length) return null;
	return <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-3">{shown}</div>;
}

export function StatusItems({
	task,
	disabled = false,
	onAction,
}: {
	task: Pick<TaskItem, "status">;
	disabled?: boolean;
	onAction: (a: StatusAction) => void;
}) {
	if (isSettled(task.status))
		return (
			<MenuItem icon={ArrowTurnBackwardIcon} disabled={disabled} onSelect={() => onAction({ kind: "reopen" })}>
				Reopen
			</MenuItem>
		);
	return (
		<>
			<MenuItem icon={Tick02Icon} disabled={disabled} onSelect={() => onAction({ kind: "complete" })}>
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
					<MenuRadioItem key={s} value={s} disabled={disabled}>
						{STATUS_LABEL[s]}
					</MenuRadioItem>
				))}
			</MenuRadioGroup>
			<MenuSeparator />
			<MenuItem icon={Cancel01Icon} disabled={disabled} onSelect={() => onAction({ kind: "waive", reason: null })}>
				Close as no longer needed
			</MenuItem>
		</>
	);
}
