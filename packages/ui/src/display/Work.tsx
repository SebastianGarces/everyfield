"use client";

import {
	Analytics01Icon,
	ArrowDown01Icon,
	ArrowRight01Icon,
	Cancel01Icon,
	InformationCircleIcon,
	ListViewIcon,
	MoreHorizontalIcon,
	Tick02Icon,
	UserAdd01Icon,
} from "@hugeicons/core-free-icons";
import { Collapsible, Toolbar } from "radix-ui";
import { useId, useState, type ElementType, type ReactNode } from "react";
import { Button, Checkbox, IconButton } from "../controls";
import { cn, Icon, type IconSvgElement } from "../foundations";
import { Avatar, StatusBadge, STAGE_DOT, STAGE_LABEL, type Stage, type Status } from "./Badges";
import { Meter } from "./Stats";
import { TINT, type Tone } from "./tone";
import { formatCount, type Count } from "./values";

export type MilestoneState = "done" | "active" | "blocked" | "todo";
const MILESTONE_WORD: Record<MilestoneState, string> = {
	done: "Done",
	active: "In progress",
	blocked: "Blocked",
	todo: "Not started",
};

function MilestoneMark({ state, progress = 0 }: { state: MilestoneState; progress?: number }) {
	if (state === "active") {
		return (
			<span
				aria-hidden="true"
				className="grid size-6 place-items-center rounded-full"
				style={{ background: `conic-gradient(var(--ef-blue-500) ${progress * 100}%, var(--ef-surface-2) 0)` }}
			>
				<span className="size-4 rounded-full bg-surface" />
			</span>
		);
	}
	return (
		<span
			aria-hidden="true"
			className={cn(
				"grid size-6 place-items-center rounded-full",
				state === "done" && "bg-green-500 text-ink-fixed",
				state === "blocked" && "bg-amber-100 text-amber-600",
				state === "todo" && "shadow-[inset_0_0_0_1.5px_var(--ef-line-2)]",
			)}
		>
			{state === "done" ? <Icon icon={Tick02Icon} size={16} className="size-3.5" /> : null}
			{state === "blocked" ? <Icon icon={InformationCircleIcon} size={16} className="size-3.5" /> : null}
		</span>
	);
}

type MilestoneRowProps = {
	state: MilestoneState;
	title: ReactNode;
	meta?: ReactNode;
	/** Done linked tasks over all linked tasks. */
	tasks: { done: number; total: number };
	/** The owner; null shows the dashed empty seat. */
	owner: { name: string; tone?: Tone } | null;
	/** How far an active milestone is, 0 to 1. */
	progress?: number;
	/** The linked tasks (TaskRows) and the completion guard, shown when the row is expanded. */
	children?: ReactNode;
	/** A link to the milestone when it has no expandable tasks. */
	href?: string;
	linkAs?: ElementType;
	defaultOpen?: boolean;
	className?: string;
};

/**
 * MilestoneRow (components.md): State, Title, Meta, Task count, Owner and Guard; done, active, blocked or todo. With
 * children the row is a disclosure button that opens MilestoneRow.Tasks; otherwise it can link to the milestone.
 */
export function MilestoneRow({
	state,
	title,
	meta,
	tasks,
	owner,
	progress,
	children,
	href,
	linkAs: Link = "a",
	defaultOpen = false,
	className,
}: MilestoneRowProps) {
	const [open, setOpen] = useState(defaultOpen);
	const row = (chevron: IconSvgElement | null) => (
		<>
			<MilestoneMark state={state} progress={progress} />
			<span className="min-w-0">
				<span className="sr-only">{MILESTONE_WORD[state]}: </span>
				<span className="block font-medium text-ink">{title}</span>
				{meta ? <span className="mt-0.5 block text-sm text-text-3">{meta}</span> : null}
			</span>
			<span className="text-sm text-text-2 max-app-sm:hidden">
				{tasks.done} of {tasks.total} {tasks.total === 1 ? "task" : "tasks"}
			</span>
			{owner ? (
				<Avatar name={owner.name} label={`Owner: ${owner.name}`} tone={owner.tone} size="xs" />
			) : (
				<span
					role="img"
					aria-label="No owner"
					className="size-[26px] rounded-full border-[1.5px] border-dashed border-line-2"
				/>
			)}
			{chevron ? <Icon icon={chevron} size={16} className="text-text-3" /> : <span />}
		</>
	);
	const grid =
		"grid w-full grid-cols-[28px_minmax(0,1fr)_150px_70px_20px] items-center gap-3.5 rounded-[16px] px-3 py-3.5 text-left max-app-sm:grid-cols-[28px_minmax(0,1fr)_30px_20px] max-app-sm:gap-2.5";
	if (!children) {
		return href ? (
			<Link
				href={href}
				data-focus-inset=""
				className={cn(grid, "border-t border-line transition-colors first:border-t-0 hover:bg-hover", className)}
			>
				{row(ArrowRight01Icon)}
			</Link>
		) : (
			<div className={cn(grid, "border-t border-line first:border-t-0", className)}>{row(null)}</div>
		);
	}
	return (
		<Collapsible.Root
			open={open}
			onOpenChange={setOpen}
			className={cn(
				"border-t border-line first:border-t-0 data-[state=open]:my-1.5 data-[state=open]:rounded-[18px] data-[state=open]:border-t-0 data-[state=open]:bg-surface-raised data-[state=open]:px-1 data-[state=open]:pt-1 data-[state=open]:pb-3.5 data-[state=open]:shadow-[inset_0_0_0_1px_var(--ef-line)] [&+*]:data-[state=open]:border-t-0",
				className,
			)}
		>
			<Collapsible.Trigger data-focus-inset="" className={cn(grid, "cursor-pointer transition-colors hover:bg-hover")}>
				{row(open ? ArrowDown01Icon : ArrowRight01Icon)}
			</Collapsible.Trigger>
			<Collapsible.Content>{children}</Collapsible.Content>
		</Collapsible.Root>
	);
}

/** MilestoneRow.Tasks: the linked tasks, indented under the row with a rule on the left. */
export function MilestoneTasks({ children }: { children: ReactNode }) {
	return (
		<div className="mr-3 ml-[54px] border-l-[1.5px] border-line-2 pl-3.5 max-app-sm:ml-6 [&>*]:px-2.5 [&>*]:py-[9px]">
			{children}
		</div>
	);
}
MilestoneRow.Tasks = MilestoneTasks;

/**
 * MilestoneRow.Guard: the note before completing a milestone with open tasks ("One linked task is still open...")
 * and its action. Completing is allowed; the guard only says what stays open.
 */
export function MilestoneGuard({ children, action }: { children: ReactNode; action?: ReactNode }) {
	return (
		<div className="mt-2.5 mr-3 ml-[54px] flex flex-wrap items-center gap-2.5 text-sm text-text-2 max-app-sm:ml-6">
			<Icon icon={InformationCircleIcon} size={16} />
			<span className="min-w-0 flex-1">{children}</span>
			{action}
		</div>
	);
}
MilestoneRow.Guard = MilestoneGuard;

/** A labelled group of milestones: "Operations ———— 2 of 3". */
export function MilestoneGroup({ label, count, children }: { label: string; count?: string; children: ReactNode }) {
	const id = useId();
	return (
		<section aria-labelledby={id}>
			<h3
				id={id}
				className="flex items-center gap-2.5 px-1 pt-[18px] pb-2 font-body text-sm font-semibold tracking-normal text-text-2"
			>
				{label}
				<span aria-hidden="true" className="h-px flex-1 bg-line" />
				{count ? <span className="font-normal text-text-3">{count}</span> : null}
			</h3>
			{children}
		</section>
	);
}

/** Journal (components.md): Dot, Title and Meta per event, newest first, joined by a line. */
export function Journal({
	items,
	label,
	className,
}: {
	items: { id: string; title: ReactNode; meta?: ReactNode; tone?: Tone }[];
	label: string;
	className?: string;
}) {
	return (
		<ol aria-label={label} className={cn("flex flex-col", className)}>
			{items.map((item, i) => (
				<li
					key={item.id}
					className={cn(
						"relative grid grid-cols-[14px_minmax(0,1fr)] gap-3 pb-[18px] last:pb-0",
						i < items.length - 1 &&
							"before:absolute before:top-4 before:bottom-0 before:left-1.5 before:w-[1.5px] before:bg-line-2",
					)}
				>
					<span
						aria-hidden="true"
						className={cn(
							"relative mt-1 size-[13px] rounded-full shadow-[0_0_0_3px_var(--ef-surface)]",
							item.tone ? SOLID_DOT[item.tone] : "bg-text-3",
						)}
					/>
					<div>
						<div className="font-medium text-ink">{item.title}</div>
						{item.meta ? <div className="mt-0.5 text-sm text-text-3">{item.meta}</div> : null}
					</div>
				</li>
			))}
		</ol>
	);
}
const SOLID_DOT: Record<Tone, string> = {
	green: "bg-green-500",
	blue: "bg-blue-500",
	amber: "bg-amber-500",
	magenta: "bg-magenta-500",
	violet: "bg-violet-500",
	teal: "bg-teal-500",
	ink: "bg-ink",
};

/**
 * OutcomeField (components.md): Label and Value. Empty means not recorded and is said in words; 0 is a real result
 * and shows as 0. With `onChange` it is a number field: clearing it records nothing (null), typing 0 records zero.
 */
export function OutcomeField({
	label,
	value,
	onChange,
	disabled,
	className,
}: {
	label: string;
	value: Count;
	onChange?: (value: Count) => void;
	disabled?: boolean;
	className?: string;
}) {
	const id = useId();
	const box = "flex items-center justify-between gap-3 rounded-[14px] bg-surface-2 px-3.5 py-3";
	if (!onChange) {
		return (
			<div className={cn(box, className)}>
				<span className="text-text-2">{label}</span>
				<span
					data-recorded={value === null ? "false" : "true"}
					className={cn("font-display text-lg", value === null ? "text-text-3" : "text-ink tabular-nums")}
				>
					{value === null ? "Not recorded" : formatCount(value)}
				</span>
			</div>
		);
	}
	return (
		<div className={cn(box, "focus-within:shadow-[inset_0_0_0_1.5px_var(--ef-ink-2)]", className)}>
			<label htmlFor={id} className="text-text-2">
				{label}
			</label>
			<input
				id={id}
				type="text"
				inputMode="numeric"
				pattern="[0-9]*"
				autoComplete="off"
				disabled={disabled}
				placeholder="Not recorded"
				value={value === null ? "" : String(value)}
				onChange={(e) => {
					const raw = e.target.value.replace(/[^0-9]/g, "");
					onChange(raw === "" ? null : Number(raw));
				}}
				className="w-32 bg-transparent text-right font-display text-lg text-ink tabular-nums outline-none placeholder:text-text-3 disabled:opacity-60"
			/>
		</div>
	);
}

type TaskRowProps = {
	title: ReactNode;
	/** Plain text of the title, for the checkbox names: "Complete Call James Okafor". */
	titleText: string;
	done: boolean;
	onDoneChange?: (done: boolean) => void;
	/** Meta items: due date, kind, linked person. Urgent ones are magenta. */
	meta?: { text: ReactNode; icon?: IconSvgElement; tone?: "urgent" | "soon" }[];
	assignee?: { name: string; tone?: Tone };
	/** Row selection for bulk actions. */
	selected?: boolean;
	onSelectedChange?: (selected: boolean) => void;
	/** The row menu: a Menu whose trigger is this row's "More" button. */
	menu?: (trigger: ReactNode) => ReactNode;
	href?: string;
	linkAs?: ElementType;
	className?: string;
};

/**
 * TaskRow (components.md): Select, Complete, Title, Meta, Assignee and Menu; done and selected. The round box
 * completes the task; the square box, shown with onSelectedChange, selects it for the BulkBar.
 */
export function TaskRow({
	title,
	titleText,
	done,
	onDoneChange,
	meta = [],
	assignee,
	selected,
	onSelectedChange,
	menu,
	href,
	linkAs: Link = "a",
	className,
}: TaskRowProps) {
	return (
		<div
			data-done={done ? "true" : undefined}
			data-selected={selected ? "true" : undefined}
			className={cn(
				"flex items-center gap-3.5 rounded-[16px] px-3 py-3.5 [&+&]:border-t [&+&]:border-line",
				"data-[selected=true]:bg-surface-raised data-[selected=true]:shadow-[inset_0_0_0_1.5px_var(--ef-ink)] data-[selected=true]:[&+*]:border-t-transparent",
				className,
			)}
		>
			{onSelectedChange ? (
				<Checkbox
					aria-label={`Select ${titleText}`}
					checked={selected ?? false}
					onCheckedChange={(on) => onSelectedChange(on === true)}
				/>
			) : null}
			<Checkbox
				shape="round"
				aria-label={done ? `Reopen ${titleText}` : `Complete ${titleText}`}
				checked={done}
				disabled={!onDoneChange}
				onCheckedChange={(on) => onDoneChange?.(on === true)}
			/>
			<div className="min-w-0 flex-1">
				<div className={cn("font-medium", done ? "text-text-3 line-through" : "text-ink")}>
					{href ? (
						<Link href={href} className="hover:underline">
							{title}
						</Link>
					) : (
						title
					)}
				</div>
				{meta.length ? (
					<div className="mt-[3px] flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-3">
						{meta.map((m, i) => (
							<span
								key={i}
								className={cn(
									"inline-flex items-center gap-1",
									m.tone === "urgent" && "text-magenta-600",
									m.tone === "soon" && "text-amber-600",
								)}
							>
								{m.icon ? <Icon icon={m.icon} size={16} className="size-3.5" /> : null}
								{m.text}
							</span>
						))}
					</div>
				) : null}
			</div>
			{assignee ? (
				<Avatar name={assignee.name} label={`Assigned to ${assignee.name}`} tone={assignee.tone} size="xs" />
			) : null}
			{menu
				? menu(
						<IconButton
							icon={MoreHorizontalIcon}
							label={`More for ${titleText}`}
							size="sm"
							variant="default"
							className="shadow-none"
						/>,
					)
				: null}
		</div>
	);
}

/**
 * BulkBar (components.md): Count, Actions and Close on the Toolbar primitive. One Tab stop; arrows move between the
 * actions. The count is announced when it changes. Close clears the selection.
 */
export function BulkBar({
	count,
	noun = ["item", "items"],
	actions,
	onClear,
	className,
}: {
	count: number;
	noun?: [string, string];
	/** Toolbar actions: { label, icon, onClick }. */
	actions: { label: string; icon?: IconSvgElement; onClick: () => void }[];
	onClear: () => void;
	className?: string;
}) {
	if (count === 0) return null;
	return (
		<Toolbar.Root
			aria-label="Bulk actions"
			className={cn(
				"flex flex-wrap items-center gap-3 rounded-[16px] bg-ink py-2 pr-2 pl-[18px] text-on-ink shadow-pop",
				className,
			)}
		>
			<span aria-hidden="true" className="grid size-5 place-items-center rounded-xs bg-on-ink-soft">
				<Icon icon={Tick02Icon} size={16} className="size-3" />
			</span>
			<span role="status" className="min-w-0 flex-1 font-medium">
				{count} {count === 1 ? noun[0] : noun[1]} selected
			</span>
			{actions.map((a) => (
				<Toolbar.Button
					key={a.label}
					onClick={a.onClick}
					className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[12px] px-3 text-sm font-medium text-on-ink transition-colors hover:bg-on-ink-soft"
				>
					{a.icon ? <Icon icon={a.icon} size={16} /> : null}
					<span className={a.icon ? "max-app-sm:sr-only" : undefined}>{a.label}</span>
				</Toolbar.Button>
			))}
			<Toolbar.Button
				aria-label="Clear selection"
				onClick={onClear}
				className="grid size-9 cursor-pointer place-items-center rounded-full text-on-ink transition-colors hover:bg-on-ink-soft"
			>
				<Icon icon={Cancel01Icon} size={16} />
			</Toolbar.Button>
		</Toolbar.Root>
	);
}

/**
 * PersonCard (components.md): Avatar, Name, Meta and Footer; selected or dragging. The name is the link. The
 * dragging look is a prop: the feature owns drag and drop (dnd-kit) and its keyboard alternative.
 */
export function PersonCard({
	name,
	meta,
	tone,
	footer,
	href,
	linkAs: Link = "a",
	selected,
	dragging,
	className,
}: {
	name: string;
	meta?: ReactNode;
	tone?: Tone;
	footer?: ReactNode;
	href?: string;
	linkAs?: ElementType;
	selected?: boolean;
	dragging?: boolean;
	className?: string;
}) {
	return (
		<article
			aria-label={name}
			data-selected={selected ? "true" : undefined}
			data-dragging={dragging ? "true" : undefined}
			className={cn(
				"relative flex flex-col gap-2.5 rounded-[16px] bg-surface-raised p-3 shadow-raised transition-[box-shadow,transform] duration-150",
				selected && "shadow-[var(--ef-shadow-raised),inset_0_0_0_1.5px_var(--ef-ink)]",
				dragging && "rotate-[1.5deg] shadow-pop motion-reduce:rotate-0",
				className,
			)}
		>
			<div className="flex items-center gap-2.5">
				<Avatar name={name} tone={tone} size="sm" decorative />
				<div className="min-w-0">
					<div className="truncate text-sm leading-[1.2] font-semibold text-ink">
						{href ? (
							<Link href={href} className="after:absolute after:inset-0 after:rounded-[16px] hover:underline">
								{name}
							</Link>
						) : (
							name
						)}
					</div>
					{meta ? <div className="truncate text-xs text-text-3">{meta}</div> : null}
				</div>
			</div>
			{footer ? <div className="flex flex-wrap items-center justify-between gap-1.5">{footer}</div> : null}
		</article>
	);
}

/**
 * PipelineColumn (components.md): Header, Count, Cards and DropZone for one stage. `dropTarget` outlines the column
 * while a card is dragged over it; the feature wires dragging. An empty column says so.
 */
export function PipelineColumn({
	stage,
	label,
	count,
	dropTarget,
	children,
	emptyText = "Nobody at this stage",
	className,
}: {
	stage: Stage;
	label?: string;
	count: number;
	dropTarget?: boolean;
	children?: ReactNode;
	emptyText?: string;
	className?: string;
}) {
	const id = useId();
	return (
		<section
			aria-labelledby={id}
			data-drop-target={dropTarget ? "true" : undefined}
			className={cn(
				"relative flex min-h-[420px] min-w-[220px] flex-col gap-2.5 rounded-[22px] bg-surface-2 p-2.5 transition-shadow duration-150",
				dropTarget && "shadow-[inset_0_0_0_2px_var(--ef-green-500)]",
				className,
			)}
		>
			<h3
				id={id}
				className="flex items-center gap-2 px-1.5 pt-1 pb-1.5 font-body text-sm font-semibold tracking-normal text-ink"
			>
				<span aria-hidden="true" className={cn("size-2 rounded-full", STAGE_DOT[stage])} />
				{label ?? STAGE_LABEL[stage]}
				<span className="ml-auto font-medium text-text-3">
					{count}
					<span className="sr-only"> {count === 1 ? "person" : "people"}</span>
				</span>
			</h3>
			{count === 0 && !children ? (
				<p className="rounded-[16px] border-[1.5px] border-dashed border-line-2 px-3 py-6 text-center text-sm text-text-3">
					{emptyText}
				</p>
			) : (
				children
			)}
		</section>
	);
}

/**
 * MinistryCard (components.md): Icon, Status, Leader, Roles meter and Training. The status badge says the state in
 * words; the meter repeats "7 of 8" for assistive technology.
 */
export function MinistryCard({
	name,
	icon,
	tone = "green",
	status,
	statusLabel,
	leader,
	roles,
	training,
	href,
	linkAs: Link = "a",
	className,
}: {
	name: string;
	icon: IconSvgElement;
	tone?: Tone;
	status: Status;
	statusLabel: string;
	leader: { name: string; tone?: Tone } | null;
	roles: { filled: number; total: number };
	/** "5 of 7 trained". */
	training?: ReactNode;
	href?: string;
	linkAs?: ElementType;
	className?: string;
}) {
	return (
		<article
			aria-label={name}
			className={cn(
				"relative flex flex-col rounded-lg border border-[var(--ef-card-edge)] bg-surface px-[22px] py-5 shadow-card",
				href && "transition-shadow hover:shadow-raised",
				className,
			)}
		>
			<div className="flex items-center justify-between">
				<span aria-hidden="true" className={cn("grid size-12 place-items-center rounded-[16px]", TINT[tone])}>
					<Icon icon={icon} size={22} />
				</span>
				<StatusBadge status={status} size="sm">
					{statusLabel}
				</StatusBadge>
			</div>
			<h3 className="mt-4 text-title-sm leading-[1.2] text-ink">
				{href ? (
					<Link href={href} className="after:absolute after:inset-0 after:rounded-lg">
						{name}
					</Link>
				) : (
					name
				)}
			</h3>
			<div className="mt-2 flex items-center gap-2 text-sm text-text-2">
				{leader ? (
					<>
						<Avatar name={leader.name} tone={leader.tone} size="xs" decorative />
						Led by {leader.name}
					</>
				) : (
					<span className="text-magenta-600">No leader yet</span>
				)}
			</div>
			<div className="mt-4 flex justify-between text-sm">
				<span className="text-text-2">Roles filled</span>
				<b className="font-semibold text-ink tabular-nums">
					{roles.filled} of {roles.total}
				</b>
			</div>
			<Meter label={`${name} roles filled`} value={roles.filled} max={roles.total} tone={tone} className="mt-2" />
			{training ? <div className="mt-3 text-sm text-text-3">{training}</div> : null}
		</article>
	);
}

/**
 * RoleSlot (components.md): Avatar, Role, Person, Status and Action; filled or open. An open slot is dashed and its
 * action fills it.
 */
export function RoleSlot({
	role,
	person,
	detail,
	status,
	action,
	className,
}: {
	role: string;
	/** null is an open role. */
	person: { name: string; tone?: Tone } | null;
	/** For an open role: "Open role · 2 h a week". */
	detail?: ReactNode;
	status?: ReactNode;
	action?: ReactNode;
	className?: string;
}) {
	const open = person === null;
	return (
		<div
			data-state={open ? "open" : "filled"}
			className={cn(
				"flex items-center gap-3 rounded-[16px] p-3",
				open
					? "border-[1.5px] border-dashed border-line-2"
					: "bg-surface-raised shadow-[inset_0_0_0_1px_var(--ef-line)]",
				className,
			)}
		>
			{open ? (
				<span
					aria-hidden="true"
					className="grid size-8 flex-none place-items-center rounded-full border-[1.5px] border-dashed border-line-2 text-text-3"
				>
					<Icon icon={UserAdd01Icon} size={16} className="size-3.5" />
				</span>
			) : (
				<Avatar name={person.name} tone={person.tone} size="sm" decorative />
			)}
			<div className="min-w-0 flex-1">
				<div className="font-medium text-ink">{role}</div>
				<div className="text-sm text-text-3">{open ? (detail ?? "Open role") : person.name}</div>
			</div>
			{status}
			{action}
		</div>
	);
}

export type LensState = "positive" | "watch" | "concern" | "unknown";
const LENS: Record<LensState, { on: number; bar: string; icon: string; status: Status }> = {
	positive: { on: 4, bar: "bg-green-500", icon: "bg-green-100 text-green-700", status: "positive" },
	watch: { on: 2, bar: "bg-amber-500", icon: "bg-amber-100 text-amber-600", status: "attention" },
	concern: { on: 1, bar: "bg-magenta-500", icon: "bg-magenta-100 text-magenta-600", status: "risk" },
	unknown: { on: 0, bar: "", icon: "bg-surface-2 text-ink-2", status: "unknown" },
};

/**
 * LensTile (components.md): Name, Standing, Note and Evidence; positive, watch, concern or unknown. Unknown is a
 * dashed tile with empty segments: it is never drawn as a low score. `onExpand` adds the button that lists the plants.
 */
export function LensTile({
	name,
	icon,
	state,
	standing,
	note,
	evidence = "Measured",
	evidenceIcon = Analytics01Icon,
	onExpand,
	className,
}: {
	name: string;
	icon: IconSvgElement;
	state: LensState;
	/** The badge word: "Strong", "Watch", "Concern", "Not enough data". */
	standing: string;
	note: ReactNode;
	evidence?: string;
	evidenceIcon?: IconSvgElement;
	onExpand?: () => void;
	className?: string;
}) {
	const lens = LENS[state];
	return (
		<article
			aria-label={name}
			data-state={state}
			className={cn(
				"flex flex-col gap-3 rounded-[20px] p-[18px]",
				state === "unknown"
					? "border-[1.5px] border-dashed border-line-2 bg-transparent"
					: "border border-line bg-surface-raised shadow-card",
				className,
			)}
		>
			<div className="flex items-center gap-2.5">
				<span
					aria-hidden="true"
					className={cn("grid size-[34px] flex-none place-items-center rounded-full", lens.icon)}
				>
					<Icon icon={icon} size={16} className="size-[17px]" />
				</span>
				<h3 className="min-w-0 flex-1 font-body text-[15px] font-semibold tracking-normal text-ink">{name}</h3>
				<StatusBadge status={lens.status} size="sm">
					{standing}
				</StatusBadge>
			</div>
			<p className="text-sm leading-[1.5] text-text-2">{note}</p>
			<div className="mt-auto flex items-center justify-between gap-2.5">
				<span aria-hidden="true" className="flex gap-1">
					{[0, 1, 2, 3].map((i) => (
						<span
							key={i}
							className={cn(
								"h-1.5 w-[22px] rounded-full",
								state === "unknown"
									? "shadow-[inset_0_0_0_1px_var(--ef-line-2)]"
									: i < lens.on
										? lens.bar
										: "bg-surface-2",
							)}
						/>
					))}
				</span>
				<span className="inline-flex items-center gap-[5px] text-xs font-medium text-text-3">
					<Icon icon={evidenceIcon} size={16} className="size-[13px]" />
					{evidence}
				</span>
				{onExpand ? (
					<button
						type="button"
						onClick={onExpand}
						aria-label={`See the plants behind ${name}`}
						className="grid size-[30px] flex-none cursor-pointer place-items-center rounded-[9px] bg-surface-2 text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
					>
						<Icon icon={ListViewIcon} size={16} />
					</button>
				) : null}
			</div>
		</article>
	);
}

/**
 * DrillPath (components.md): Chip, Separator and Reset. Each step narrows the set ("All people 214 › Core group 34 ›
 * No ministry 11"). Earlier steps are buttons that go back to them; the last is the current set.
 */
export function DrillPath({
	steps,
	onSelect,
	onReset,
	label = "Filter path",
	className,
}: {
	steps: { label: string; count: number }[];
	onSelect: (index: number) => void;
	onReset?: () => void;
	label?: string;
	className?: string;
}) {
	const last = steps.length - 1;
	const chip = "inline-flex h-10 items-center gap-2 rounded-[12px] px-3.5 font-medium whitespace-nowrap";
	return (
		<nav
			aria-label={label}
			className={cn(
				"relative flex items-center gap-2.5 overflow-x-auto rounded-[22px] border border-[var(--ef-card-edge)] bg-surface py-2.5 pr-3 pl-[22px] shadow-card max-app-sm:pl-3",
				className,
			)}
		>
			<ol className="flex items-center gap-2.5">
				{steps.map((s, i) => (
					<li key={i} className="flex items-center gap-2.5">
						{i > 0 ? <Icon icon={ArrowRight01Icon} size={16} className="size-[15px] text-text-3" /> : null}
						{i === last ? (
							<span
								aria-current="true"
								className={cn(chip, "bg-amber-100 text-amber-600 shadow-[inset_0_0_0_1px_var(--ef-amber-300)]")}
							>
								<span className="font-normal">{s.label}</span>
								<span className="tabular-nums">{formatCount(s.count)}</span>
							</span>
						) : (
							<button
								type="button"
								onClick={() => onSelect(i)}
								className={cn(
									chip,
									"cursor-pointer bg-surface-raised text-ink shadow-[inset_0_0_0_1px_var(--ef-line)] transition-colors hover:bg-surface-2",
								)}
							>
								<span className="font-normal text-text-2">{s.label}</span>
								<span className="tabular-nums">{formatCount(s.count)}</span>
							</button>
						)}
					</li>
				))}
			</ol>
			{onReset && steps.length > 1 ? (
				<Button variant="ghost" size="sm" onClick={onReset} className="ml-auto">
					Reset
				</Button>
			) : null}
		</nav>
	);
}
