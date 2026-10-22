"use client";

import { Add01Icon, UserAdd01Icon } from "@hugeicons/core-free-icons";
import { personId } from "@everyfield/contracts/common";
import type * as tc from "@everyfield/contracts/tasks";
import {
	Button,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Field,
	Input,
	Menu,
	MenuContent,
	MenuLabel,
	MenuRadioGroup,
	MenuRadioItem,
	MenuSeparator,
	MenuTrigger,
	SegmentedControl,
	Select,
	Spinner,
} from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { useEffect, useState } from "react";
import type { z } from "zod";
import { dueText } from "../tasks/model.ts";
import { assignFollowUp, createFollowUp } from "./actions.ts";
import { forgetOwners, prefetchOwners, warmOn } from "./fetch.ts";
import { focusFirstProblem } from "./fields.tsx";
import { OUTCOME_LABEL, type Account, type DutyItem, type Outcome } from "./model.ts";
import { LaneNotice, SaveButton, type LaneControl } from "./save.tsx";

type TaskDetail = z.infer<typeof tc.taskDetail>;
const NEEDS_OWNER = "needs_owner";

/** A follow-up the server just created or changed, as the assignment lists show it. */
export function dutyFrom(task: TaskDetail, previous?: DutyItem): DutyItem {
	return {
		taskId: task.id,
		revision: task.revision,
		title: task.title,
		status: task.status,
		due: task.due,
		overdue: task.overdue,
		obligationId: task.managed?.obligationId ?? null,
		person: task.relation
			? { id: personId.parse(task.relation.id), label: task.relation.label }
			: (previous?.person ?? { id: personId.parse(task.id), label: "" }),
		owner: task.assignee,
		lastOutcome: previous?.lastOutcome ?? null,
	};
}

/** The eligible owners, read on the first sign of intent and again when the menu or form opens (C76). */
function useOwners(active: boolean) {
	const [owners, setOwners] = useState<Outcome<Account[]> | null>(null);
	useEffect(() => {
		if (!active) return;
		let live = true;
		void prefetchOwners().then((r) => live && setOwners(r));
		return () => {
			live = false;
		};
	}, [active]);
	return owners;
}

/**
 * Who owns a follow-up, and (Owner/Admin) a menu to give it to an eligible owner or leave it as Needs owner
 * (REQ-TSK-012). The list loads on intent. The change shows at once and rolls back when the server refuses it.
 */
export function AssignMenu({
	duty,
	lane,
	canAssign,
	onChange,
	onSaved,
	onConflict,
}: {
	duty: DutyItem;
	lane: LaneControl;
	canAssign: boolean;
	/** The follow-up as shown: at once when chosen, again from the server's answer, or back on a refusal. */
	onChange: (duty: DutyItem) => void;
	/** The server confirmed the change, from `before` to the saved follow-up. Totals update from this, never earlier. */
	onSaved?: (before: DutyItem, after: DutyItem) => void;
	onConflict: () => void;
}) {
	const [open, setOpen] = useState(false);
	const owners = useOwners(open);
	const label = duty.owner ? duty.owner.displayName : "Needs owner";
	if (!canAssign)
		return duty.owner ? (
			<span className="text-sm text-text-2">{label}</span>
		) : (
			<StatusBadge status="attention" size="sm">
				Needs owner
			</StatusBadge>
		);
	async function assign(value: string) {
		const assigneeId = value === NEEDS_OWNER ? null : value;
		if (assigneeId === (duty.owner?.accountId ?? null)) return;
		const before = duty;
		const chosen = owners?.status === "ok" ? owners.value.find((o) => o.accountId === assigneeId) : undefined;
		onChange({ ...duty, owner: chosen ?? null });
		const started = await lane.save(
			`The owner of ${duty.title}`,
			(key) => assignFollowUp(key, duty.revision, { taskId: duty.taskId, assigneeId }),
			(r) => {
				if (r.status === "ok") {
					const after = dutyFrom(r.value.task, before);
					onChange(after);
					return onSaved?.(before, after);
				}
				onChange(before);
				if (r.code === "owner_ineligible") forgetOwners();
				if (r.code === "conflict") onConflict();
			},
		);
		if (!started) onChange(before);
	}
	return (
		<Menu open={open} onOpenChange={setOpen}>
			<MenuTrigger asChild>
				<Button
					size="sm"
					variant={duty.owner ? "ghost" : "outline"}
					icon={duty.owner ? undefined : UserAdd01Icon}
					disabled={lane.wait !== null}
					aria-label={duty.owner ? `${label}, owner of ${duty.title}. Change owner` : `Assign ${duty.title}`}
					{...warmOn(prefetchOwners)}
					className="max-w-[200px] truncate"
				>
					{duty.owner ? label : "Assign"}
				</Button>
			</MenuTrigger>
			<MenuContent align="end" className="min-w-[220px]">
				<MenuLabel>Give this follow-up to</MenuLabel>
				{owners === null ? (
					<div className="flex items-center gap-2 px-3 py-2 text-sm text-text-2" role="status">
						<Spinner size={16} />
						Loading owners
					</div>
				) : owners.status !== "ok" ? (
					<p className="px-3 py-2 text-sm text-text-2" role="status">
						The owners did not load. Close this menu and try again.
					</p>
				) : (
					<MenuRadioGroup value={duty.owner?.accountId ?? NEEDS_OWNER} onValueChange={(v) => void assign(v)}>
						{owners.value.length === 0 ? (
							<p className="px-3 py-2 text-sm text-text-2">
								No one can own follow-ups yet. Owners need a seat and a core group, launch team or leader stage.
							</p>
						) : (
							owners.value.map((o) => (
								<MenuRadioItem key={o.accountId} value={o.accountId}>
									{o.displayName}
								</MenuRadioItem>
							))
						)}
						<MenuSeparator />
						<MenuRadioItem value={NEEDS_OWNER}>Leave as Needs owner</MenuRadioItem>
					</MenuRadioGroup>
				)}
			</MenuContent>
		</Menu>
	);
}

/** A follow-up row's facts: due date (none is never invented), overdue, and the last outcome on it. */
export function DutyFacts({ duty }: { duty: DutyItem }) {
	const due = dueText(duty.due);
	return (
		<span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-2">
			{due ? (
				duty.overdue ? (
					<StatusBadge status="risk" size="sm">
						Overdue · {due}
					</StatusBadge>
				) : (
					<span>Due {due}</span>
				)
			) : (
				<span>No due date</span>
			)}
			{duty.obligationId ? <span>· After a Vision meeting</span> : null}
			{duty.lastOutcome ? <span>· Last: {OUTCOME_LABEL[duty.lastOutcome].toLowerCase()}</span> : null}
		</span>
	);
}

type AddDraft = { title: string; dated: "undated" | "date"; date: string; owner: string };

/**
 * An explicit follow-up with a Person (REQ-PPL-022, REQ-TSK-012): undated unless a date is chosen, with an eligible owner
 * or Needs owner. Nothing creates one in the background. The form keeps its answers while it saves and after a refusal.
 */
export function AddFollowUpDialog({
	person,
	lane,
	onClose,
	onCreated,
}: {
	person: { id: string; label: string };
	lane: LaneControl;
	onClose: () => void;
	onCreated: (duty: DutyItem) => void;
}) {
	const [draft, setDraft] = useState<AddDraft>({ title: "", dated: "undated", date: "", owner: NEEDS_OWNER });
	const [dateError, setDateError] = useState<string | null>(null);
	const [sent, setSent] = useState(false);
	const owners = useOwners(true);
	const set = (patch: Partial<AddDraft>) => setDraft((d) => ({ ...d, ...patch }));

	async function submit(form: HTMLFormElement) {
		if (draft.dated === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) {
			setDateError("Choose a due date, or choose No date.");
			return focusFirstProblem(form);
		}
		setDateError(null);
		const input = {
			personId: person.id,
			...(draft.title.trim() ? { title: draft.title.trim() } : {}),
			due: draft.dated === "date" ? { kind: "local_date", date: draft.date } : { kind: "undated" },
			assigneeId: draft.owner === NEEDS_OWNER ? null : draft.owner,
		};
		setSent(true);
		await lane.save(
			"The follow-up",
			(key) => createFollowUp(key, input),
			(r) => {
				setSent(false);
				if (r.status === "ok") {
					onCreated(dutyFrom(r.value.task));
					onClose();
				} else if (r.code === "owner_ineligible") forgetOwners();
			},
		);
		setSent(false);
	}

	return (
		<Dialog open onOpenChange={(next) => !next && onClose()}>
			<DialogContent size="sm">
				<form
					noValidate
					className="contents"
					onSubmit={(e) => {
						e.preventDefault();
						if (!lane.wait) void submit(e.currentTarget);
					}}
				>
					<DialogHeader
						icon={Add01Icon}
						tone="green"
						title="Add a follow-up"
						description={`A follow-up with ${person.label}. It has no date unless you choose one.`}
					/>
					<DialogBody className="flex flex-col gap-5 pb-1">
						<LaneNotice control={lane} />
						<Field label="Title" optional hint={`Leave blank for “Follow up with ${person.label}”.`}>
							<Input value={draft.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} />
						</Field>
						<div className="flex flex-col gap-2">
							<SegmentedControl
								label="Due date"
								value={draft.dated}
								onValueChange={(dated) => set({ dated })}
								options={[
									{ value: "undated", label: "No date" },
									{ value: "date", label: "Choose a date" },
								]}
								className="w-full *:flex-1 *:justify-center"
							/>
							{draft.dated === "date" ? (
								<Field label="Due on" error={dateError}>
									<Input type="date" value={draft.date} onChange={(e) => set({ date: e.target.value })} />
								</Field>
							) : null}
						</div>
						<Field
							label="Owner"
							hint={
								owners?.status === "ok" && owners.value.length === 0
									? "No one can own follow-ups yet. It starts as Needs owner."
									: "Only people with a seat and a committed stage can own follow-ups."
							}
						>
							<Select
								value={draft.owner}
								onValueChange={(owner) => set({ owner })}
								options={[
									{ value: NEEDS_OWNER, label: "Needs owner" },
									...(owners?.status === "ok"
										? owners.value.map((o) => ({ value: o.accountId, label: o.displayName }))
										: []),
								]}
							/>
						</Field>
					</DialogBody>
					<DialogFooter>
						<Button variant="secondary" type="button" onClick={onClose}>
							Cancel
						</Button>
						<SaveButton wait={lane.wait} saving={sent}>
							Add follow-up
						</SaveButton>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
