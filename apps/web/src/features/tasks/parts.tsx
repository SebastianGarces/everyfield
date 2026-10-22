"use client";

import {
	Calendar03Icon,
	CheckListIcon,
	Clock01Icon,
	Link04Icon,
	UserGroupIcon,
	UserIcon,
} from "@hugeicons/core-free-icons";
import { Checkbox } from "@everyfield/ui/controls";
import { Avatar, StatusBadge, type Status as Tone } from "@everyfield/ui/display";
import { cn, Icon, type IconSvgElement } from "@everyfield/ui/foundations";
import type { PointerEvent, ReactNode } from "react";
import type { Wait } from "../../components/save/model.ts";
import { When } from "../people/parts.tsx";
import { blockedText, dueText, isSettled, PRIORITY_LABEL, STATUS_LABEL, type Status, type TaskItem } from "./model.ts";

// Small pieces the task row and the task panel share.

export const RELATION_ICON: Record<NonNullable<TaskItem["relation"]>["kind"], IconSvgElement> = {
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

/**
 * Intent to open a task: the mouse moves over it, a finger touches it, or keyboard focus reaches it. Focus that code
 * restores after a dialog closes is not intent and sends nothing (the People rule from D68).
 */
export function intentHandlers(warm: () => void) {
	return {
		onPointerMove: (e: PointerEvent) => void (e.pointerType === "mouse" && warm()),
		onTouchStart: warm,
		onFocus: (e: { currentTarget: Element }) => void (e.currentTarget.matches(":focus-visible") && warm()),
	};
}

/**
 * The round box that completes or reopens a task, in a 44px hit area. A closed-as-not-needed task shows a dash. A
 * person who cannot act on the task sees no box, so nothing looks clickable that is not.
 */
export function DoneBox({
	task,
	canAct,
	wait,
	onToggle,
}: {
	task: Pick<TaskItem, "title" | "status">;
	canAct: boolean;
	/** The task's last save is in flight or unknown: the box waits (C68). */
	wait: Wait;
	onToggle: () => void;
}) {
	if (!canAct) return <span aria-hidden="true" className="size-11 flex-none" />;
	const settled = isSettled(task.status);
	return (
		<label className="-m-3 grid size-11 flex-none cursor-pointer place-items-center rounded-full has-[:disabled]:cursor-default">
			<Checkbox
				shape="round"
				aria-label={`${settled ? "Reopen" : "Complete"} ${task.title}`}
				aria-busy={wait === "saving" || undefined}
				disabled={wait !== null}
				// A save takes a moment: the box keeps its new state at full strength instead of flashing dim.
				className={wait === "saving" ? "disabled:cursor-progress disabled:opacity-100" : undefined}
				checked={task.status === "complete" ? true : task.status === "no_longer_needed" ? "indeterminate" : false}
				onCheckedChange={onToggle}
			/>
		</label>
	);
}

/** Due words with the overdue state in words and color, so the state never depends on color alone. */
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

/** The assignee's initials, or "Needs owner" for a task no one holds (REQ-TSK-017). */
export function Assignee({ task, you }: { task: Pick<TaskItem, "assignee">; you: string }) {
	// On a phone the badge moves under the title (MetaLine), so the title keeps its width.
	if (!task.assignee)
		return (
			<StatusBadge status="attention" size="sm" className="max-app-sm:hidden">
				Needs owner
			</StatusBadge>
		);
	const name = task.assignee.displayName || "Former member";
	const own = task.assignee.accountId === you;
	return <Avatar name={name} label={own ? `Assigned to you` : `Assigned to ${name}`} size="xs" ring={own} />;
}

/** The facts under a task title: due, status, priority, link, steps and completion. */
export function MetaLine({ task, year }: { task: TaskItem; year: number }) {
	const parts: ReactNode[] = [];
	if (!task.assignee)
		parts.push(
			<StatusBadge key="owner" status="attention" size="sm" className="app-sm:hidden">
				Needs owner
			</StatusBadge>,
		);
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
	// The advisory badge from unfinished prerequisites, in words and with its own icon, apart from the Blocked status.
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
