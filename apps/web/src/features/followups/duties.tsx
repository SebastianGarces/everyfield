"use client";

import { Add01Icon } from "@hugeicons/core-free-icons";
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
	MenuTrigger,
	SegmentedControl,
	Spinner,
} from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { When } from "../people/parts.tsx";
import { AssigneePicker, forgetAssignees } from "../tasks/AssigneePicker.tsx";
import { dueText, ownerText, ownerWarning } from "../tasks/model.ts";
import { assignFollowUp, createFollowUp } from "./actions.ts";
import { forgetOwners, prefetchOwners, warmOn } from "./fetch.ts";
import {
	needsOwner,
	OUTCOME_LABEL,
	originText,
	type Account,
	type DutyItem,
	type Outcome,
	type Owner,
} from "./model.ts";
import {
	DialogNotice,
	focusFirstProblem,
	NoticeInDialog,
	SaveButton,
	type SaveIntent,
} from "../../components/save/parts.tsx";

type TaskDetail = z.infer<typeof tc.taskDetail>;

/**
 * A follow-up the server just created or changed, as the assignment lists show it. An owner this screen already showed
 * keeps the view it had (a retained person who cannot own follow-ups still says so); a person a save just checked reads
 * as eligible.
 */
export function dutyFrom(task: TaskDetail, previous?: DutyItem): DutyItem {
	const shown = task.followUpOwners.length
		? task.followUpOwners
		: task.assignees.map((a) => ({ ...a, eligible: true, reason: null }));
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
		owners: shown.map((o) => previous?.owners.find((p) => p.accountId === o.accountId) ?? o),
		origin: previous?.origin ?? { kind: "added", by: null },
		lastOutcome: previous?.lastOutcome ?? null,
		contacted: previous?.contacted ?? null,
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

/** Each owner in the words every screen uses; Owner/Admin get Reassign for someone who cannot own follow-ups. */
function OwnerLines({
	duty,
	canReassign,
	showOwner,
	reassign,
}: {
	duty: DutyItem;
	canReassign: boolean;
	showOwner: boolean;
	reassign: (from: Owner, to: Account) => void;
}) {
	const [open, setOpen] = useState<string | null>(null);
	const owners = useOwners(open !== null);
	return (
		<ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label={`Owners of ${duty.title}`}>
			{duty.owners.map((o) => {
				const ineligible = !o.eligible;
				return (
					<li
						key={o.accountId}
						className="inline-flex flex-wrap items-center justify-end gap-x-2 max-app-sm:justify-start"
					>
						{ineligible ? (
							showOwner ? (
								<span className="text-sm text-text-2">{ownerText(o)}</span>
							) : null
						) : (
							<span className="text-sm text-text-2">{ownerText(o)}</span>
						)}
						{ineligible && canReassign ? (
							<Menu open={open === o.accountId} onOpenChange={(next) => setOpen(next ? o.accountId : null)}>
								<MenuTrigger asChild>
									<Button
										size="sm"
										variant="outline"
										aria-label={`Reassign ${o.displayName || "this person"} on ${duty.title}`}
										{...warmOn(prefetchOwners)}
									>
										Reassign
									</Button>
								</MenuTrigger>
								<MenuContent align="end" className="min-w-[220px]">
									<MenuLabel>Give {o.displayName || "this person"}&apos;s place to</MenuLabel>
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
										<MenuRadioGroup
											value=""
											onValueChange={(v) => {
												const to = owners.value.find((x) => x.accountId === v);
												setOpen(null);
												if (to) reassign(o, to);
											}}
										>
											{owners.value.filter((x) => !duty.owners.some((h) => h.accountId === x.accountId)).length ===
											0 ? (
												<p className="px-3 py-2 text-sm text-text-2">
													No one else can own follow-ups yet. Owners need a seat and a core group, launch team or leader
													stage.
												</p>
											) : (
												owners.value
													.filter((x) => !duty.owners.some((h) => h.accountId === x.accountId))
													.map((x) => (
														<MenuRadioItem key={x.accountId} value={x.accountId}>
															{x.displayName}
														</MenuRadioItem>
													))
											)}
										</MenuRadioGroup>
									)}
								</MenuContent>
							</Menu>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}

/**
 * Who owns a follow-up, and (Owner/Admin) a picker to give it to up to ten eligible owners or leave it as Needs owner
 * (REQ-TSK-012). Reassign replaces only the person it sits beside. The list loads on intent. The change shows at once
 * and rolls back when the server refuses it.
 */
export function AssignMenu({
	duty,
	lane,
	canAssign,
	showOwner = true,
	onChange,
	onSaved,
	onConflict,
}: {
	duty: DutyItem;
	lane: SaveIntent;
	canAssign: boolean;
	/** Name an owner who cannot own follow-ups beside Reassign; false where the screen already names them. */
	showOwner?: boolean;
	/** The follow-up as shown: at once when chosen, again from the server's answer, or back on a refusal. */
	onChange: (duty: DutyItem) => void;
	/** The server confirmed the change, from `before` to the saved follow-up. Totals update from this, never earlier. */
	onSaved?: (before: DutyItem, after: DutyItem) => void;
	onConflict: () => void;
}) {
	// The follow-up as it was when the picker opened: what a refusal restores and what "changed" compares with.
	const opened = useRef(duty);
	const needs = needsOwner(duty);
	/** The owner views for a chosen set: people already shown keep their view, new ones read as eligible. */
	const ownersFor = (ids: string[], names: Record<string, string>): Owner[] =>
		ids.map(
			(id) =>
				duty.owners.find((o) => o.accountId === id) ?? {
					accountId: id as never,
					displayName: names[id] ?? "",
					eligible: true,
					reason: null,
				},
		);
	async function save(before: DutyItem, owners: Owner[]) {
		if (lane.wait) return;
		onChange({ ...duty, owners });
		await lane.save({
			what: `The owners of ${duty.title}`,
			send: (key) =>
				assignFollowUp(key, before.revision, { taskId: duty.taskId, assigneeIds: owners.map((o) => o.accountId) }),
			ok: (value) => {
				const after = dutyFrom(value.task, before);
				onChange(after);
				onSaved?.(before, after);
			},
			refused: (code) => {
				onChange(before);
				if (code === "owner_ineligible" || code === "invalid_subject") {
					forgetOwners();
					forgetAssignees();
				}
				if (code === "conflict") onConflict();
			},
		});
	}
	const readOnly = !canAssign;
	return (
		<span className="inline-flex flex-col items-end gap-1.5 max-app-sm:items-start">
			{duty.owners.length ? (
				<OwnerLines
					duty={duty}
					canReassign={canAssign}
					showOwner={showOwner}
					reassign={(from, to) =>
						void save(duty, [
							...duty.owners.filter((o) => o.accountId !== from.accountId),
							{ accountId: to.accountId, displayName: to.displayName, eligible: true, reason: null },
						])
					}
				/>
			) : null}
			{needs ? (
				<StatusBadge status="attention" size="sm">
					Needs owner
				</StatusBadge>
			) : null}
			{readOnly ? null : (
				<AssigneePicker
					purpose="committed_follow_up"
					value={duty.owners.map((o) => o.accountId)}
					held={duty.owners.map((o) => ({
						accountId: o.accountId,
						displayName: o.displayName,
						warning: ownerWarning(o),
					}))}
					label={`Search people to own ${duty.title}`}
					placeholder={duty.owners.length ? "Change owners" : "Assign"}
					className="max-w-[240px] min-w-[180px]"
					onChange={(ids, names) => onChange({ ...duty, owners: ownersFor(ids, names) })}
					onOpenChange={(open) => {
						if (open) {
							opened.current = duty;
							return;
						}
						// Closing the list commits the pick session once: a save per toggle would queue behind the last one.
						const before = opened.current;
						const same = (a: readonly Owner[], b: readonly Owner[]) =>
							a
								.map((o) => o.accountId)
								.sort()
								.join() ===
							b
								.map((o) => o.accountId)
								.sort()
								.join();
						if (!same(before.owners, duty.owners)) void save(before, duty.owners);
					}}
				/>
			)}
		</span>
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
			<span>· {originText(duty.origin)}</span>
			{duty.contacted ? (
				<span>
					· Contacted <When at={duty.contacted.at} />
					{duty.contacted.by ? ` by ${duty.contacted.by}` : null}
				</span>
			) : null}
			{duty.lastOutcome ? <span>· Last: {OUTCOME_LABEL[duty.lastOutcome].toLowerCase()}</span> : null}
		</span>
	);
}

type AddDraft = { title: string; dated: "undated" | "date"; date: string; owners: string[] };

/**
 * An explicit follow-up with a Person (REQ-PPL-022, REQ-TSK-012): undated unless a date is chosen, with an eligible owner
 * or Needs owner. Nothing creates one in the background. The form keeps its answers while it saves and after a refusal.
 */
export function AddFollowUpDialog({
	person,
	lane,
	onClose,
	onCreated,
	returnFocus,
}: {
	person: { id: string; label: string };
	lane: SaveIntent;
	onClose: () => void;
	onCreated: (duty: DutyItem) => void;
	/** Focus back to the button that opened the dialog (useOpener). */
	returnFocus?: (e: Event) => void;
}) {
	const [draft, setDraft] = useState<AddDraft>({ title: "", dated: "undated", date: "", owners: [] });
	const [dateError, setDateError] = useState<string | null>(null);
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
			assigneeIds: draft.owners,
		};
		await lane.save({
			what: "The follow-up",
			send: (key) => createFollowUp(key, input),
			ok: (value) => {
				onCreated(dutyFrom(value.task));
				onClose();
			},
			refused: (code) => code === "owner_ineligible" && forgetOwners(),
		});
	}

	return (
		<NoticeInDialog {...lane.noticeProps}>
			<Dialog open onOpenChange={(next) => !next && onClose()}>
				<DialogContent size="sm" onCloseAutoFocus={returnFocus}>
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
							<DialogNotice />
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
								label="Owners"
								optional
								hint={
									owners?.status === "ok" && owners.value.length === 0
										? "No one can own follow-ups yet. It starts as Needs owner."
										: "Up to 10 people. Only people with a seat and a committed stage can own follow-ups."
								}
							>
								<AssigneePicker
									purpose="committed_follow_up"
									value={draft.owners}
									label="Search people to own this follow-up"
									placeholder="Needs owner"
									onChange={(ids) => set({ owners: ids })}
								/>
							</Field>
						</DialogBody>
						<DialogFooter>
							<Button variant="secondary" type="button" onClick={onClose}>
								Cancel
							</Button>
							<SaveButton wait={lane.wait} saving={lane.saving}>
								Add follow-up
							</SaveButton>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</NoticeInDialog>
	);
}
