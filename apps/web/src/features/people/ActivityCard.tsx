"use client";

import {
	ArrowTurnBackwardIcon,
	Delete02Icon,
	Edit02Icon,
	GitMergeIcon,
	Home01Icon,
	Note01Icon,
	Route01Icon,
	TaskDone01Icon,
	UserEdit01Icon,
} from "@hugeicons/core-free-icons";
import type * as people from "@everyfield/contracts/people";
import {
	Button,
	Card,
	CardHeader,
	CardHeading,
	CardTitle,
	CardDescription,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Field,
	StatePanel,
	Textarea,
} from "@everyfield/ui/controls";
import { TINT, type Tone } from "@everyfield/ui/display";
import { cn, Icon, type IconSvgElement } from "@everyfield/ui/foundations";
import { useState } from "react";
import type { z } from "zod";
import { addNote, deleteNote, editNote, loadActivities } from "./actions.ts";
import { CHANNEL_LABEL } from "../followups/model.ts";
import { unmergeIntent } from "./corrections/intent.ts";
import { householdChange } from "./fields/model.ts";
import { runSave, STAGE_LABEL, type PersonStore } from "./model.ts";
import type { Outcome } from "../../components/save/model.ts";
import { FormProblem, fresh, isConflict, problemOf, useStore, When } from "./parts.tsx";
import type { PersonDraft } from "./StageDialog.tsx";

type PlantPerson = z.infer<typeof people.plantPerson>;
export type Activities = z.infer<typeof people.activitiesResult>;
export type Item = Activities["items"][number];
type Base = "id" | "occurredAt" | "recordedAt" | "actor";
/** An Activity entry without the parts every entry has: what a saved change adds, before its receipt is known. */
export type EntryFields = Item extends infer I ? (I extends Item ? Omit<I, Base> : never) : never;
type Store = PersonStore<PlantPerson, PersonDraft>;
type NoteEdit = { body: string; reason: string };

const ACTION: Record<Extract<Item, { kind: "activity" }>["action"], string> = {
	created: "Added to People",
	updated: "Details changed",
	retired: "Retired",
	restored: "Restored",
	classification_recorded: "Adult or child recorded",
	classification_corrected: "Adult or child corrected",
	assessment_recorded: "4 C's assessment recorded",
	interview_recorded: "Interview recorded",
	commitment_recorded: "Commitment recorded",
	commitment_withdrawn: "Commitment withdrawn",
	commitment_reactivated: "Commitment reactivated",
	commitment_corrected: "Commitment corrected",
	assessment_corrected: "4 C's assessment corrected",
	interview_corrected: "Interview corrected",
	person_merged: "A duplicate was merged into this person",
	person_unmerged: "A merge was undone",
};
const FOLLOW_UP: Record<Extract<Item, { kind: "follow_up" }>["outcome"], string> = {
	contacted: "Follow-up: contacted",
	attempted_no_contact: "Follow-up: tried, no contact",
	administrative_completion: "Follow-up closed by an administrator",
	no_longer_needed: "Follow-up no longer needed",
};

/**
 * Activity (REQ-PPL-008): ordinary notes, stage changes, record activity and follow-up history, oldest first, in the
 * server's time-and-ID order. Only a note's author edits or deletes it, with a reason that goes to the history. A
 * deleted note keeps a marker of who removed it and when; its words are gone. A saved note shows from its answer.
 */
export function ActivityCard({
	store,
	activities,
	onActivities: setActivities,
	onEntry,
	onConflict,
	accountId,
	canWrite,
	onUnmerge,
}: {
	store: Store;
	activities: Outcome<Activities>;
	onActivities: (activities: Outcome<Activities>) => void;
	/** A saved note change: a new entry, or a known entry as it is now. */
	onEntry: (item: Item) => void;
	/** A note change was refused because this page is out of date: read the person again. */
	onConflict: () => void;
	/** The viewer's account, to tell their own notes from others'. */
	accountId: string;
	canWrite: boolean;
	/** Opens the Unmerge preview for a merge in this history (WP-015). Owners and Admins only. */
	onUnmerge?: (mergeId: string) => void;
}) {
	const state = useStore(store);
	const person = state.saved;
	const live = person.lifecycle.state === "live";
	const [more, setMore] = useState<{ loading: boolean; problem?: string }>({ loading: false });
	const [removing, setRemoving] = useState<Extract<Item, { kind: "note" }> | null>(null);
	const first = person.displayName.split(" ")[0] ?? person.displayName;
	const composer = (state.drafts.note as { body: string } | undefined)?.body ?? "";
	const writing = canWrite && live;
	// A merge that a later loaded entry undid offers no Unmerge; the dialog still guards one undone on an unloaded page.
	const undone = new Set(
		activities.status === "ok"
			? activities.value.items.flatMap((i) =>
					i.kind === "activity" && i.action === "person_unmerged" && i.recordId ? [i.recordId] : [],
				)
			: [],
	);

	async function reload() {
		const fresh = await loadActivities(person.id).catch(() => ({ status: "lost" }) as const);
		if (fresh.status === "ok") setActivities(fresh);
	}
	async function loadMore() {
		if (activities.status !== "ok" || !activities.value.next) return;
		setMore({ loading: true });
		const r = await loadActivities(person.id, activities.value.next).catch(() => ({ status: "lost" }) as const);
		if (r.status === "ok")
			setActivities({ status: "ok", value: { ...r.value, items: [...activities.value.items, ...r.value.items] } });
		setMore({ loading: false, problem: problemOf(r) });
	}

	async function saveNote(event: React.FormEvent) {
		event.preventDefault();
		const body = composer.trim();
		if (!body) return;
		const input = { personId: person.id, body };
		const rev = person.revision;
		const r = await runSave(store, "note", { input, rev }, (key) => addNote(key, rev, input), {
			fresh,
			toPerson: (v) => v.person,
		});
		if (r?.status === "ok") {
			const { note, receipt } = r.value;
			onEntry({
				id: note.id,
				occurredAt: receipt.at,
				recordedAt: receipt.at,
				actor: { kind: "current_account", accountId } as Item["actor"],
				kind: "note",
				revision: note.revision,
				body,
				editedAt: null,
			});
		} else if (isConflict(r)) onConflict();
	}

	return (
		<Card>
			<CardHeader>
				<CardHeading>
					<CardTitle>Activity</CardTitle>
					<CardDescription>Oldest first</CardDescription>
				</CardHeading>
			</CardHeader>
			{writing ? (
				<form onSubmit={saveNote} className="mb-4 flex flex-col gap-2.5 rounded-card bg-surface p-4">
					<Field label={`Add a note about ${first}`}>
						<Textarea
							rows={2}
							maxLength={5000}
							value={composer}
							readOnly={state.pending === "note"}
							onChange={(e) => store.dispatch({ type: "edit", slot: "note", draft: { body: e.target.value } })}
						/>
					</Field>
					<FormProblem code={state.errors.note} />
					<div className="flex items-center justify-between gap-3">
						<span className="text-xs text-text-3">Everyone who can see this person can read notes.</span>
						<Button
							variant="primary"
							size="sm"
							type="submit"
							loading={state.pending === "note"}
							disabled={composer.trim() === ""}
						>
							Save note
						</Button>
					</div>
				</form>
			) : null}
			{activities.status !== "ok" ? (
				<StatePanel
					tone="error"
					title="Activity did not load"
					headingLevel="h3"
					actions={
						<Button variant="secondary" size="sm" onClick={reload}>
							Try again
						</Button>
					}
				>
					Nothing was changed. Try again in a moment.
				</StatePanel>
			) : activities.value.items.length === 0 ? (
				<p className="py-6 text-center text-text-3">No activity yet.</p>
			) : (
				<ol className="flex flex-col" aria-label="Activity, oldest first">
					{activities.value.items.map((item) => (
						<Row
							key={item.id}
							item={item}
							store={store}
							mine={item.actor.kind === "current_account" && item.actor.accountId === accountId}
							writing={writing}
							onRemove={setRemoving}
							onEntry={onEntry}
							onConflict={onConflict}
							onUnmerge={
								live && !(item.kind === "activity" && item.recordId && undone.has(item.recordId))
									? onUnmerge
									: undefined
							}
						/>
					))}
				</ol>
			)}
			{activities.status === "ok" && activities.value.next ? (
				<Button variant="ghost" size="sm" className="mt-3 self-center" onClick={loadMore} loading={more.loading}>
					Show later activity
				</Button>
			) : null}
			<FormProblem code={more.problem} />
			<DeleteNoteDialog
				note={removing}
				store={store}
				onClose={() => setRemoving(null)}
				onDeleted={(entry) => {
					setRemoving(null);
					onEntry(entry);
				}}
				onConflict={onConflict}
			/>
		</Card>
	);
}

function who(actor: Item["actor"], mine: boolean) {
	if (mine) return "You";
	return actor.kind === "current_account" ? "A team member" : "A former team member";
}

function Row({
	item,
	store,
	mine,
	writing,
	onRemove,
	onEntry,
	onConflict,
	onUnmerge,
}: {
	item: Item;
	store: Store;
	mine: boolean;
	writing: boolean;
	onRemove: (note: Extract<Item, { kind: "note" }>) => void;
	onEntry: (item: Item) => void;
	onConflict: () => void;
	onUnmerge?: (mergeId: string) => void;
}) {
	const state = useStore(store);
	const slot = `note:${item.id}`;
	const edit = state.drafts[slot] as NoteEdit | undefined;
	const by = who(item.actor, mine);
	const [touched, setTouched] = useState(false);

	if (item.kind === "note" && edit) {
		const pending = state.pending === slot;
		const set = (patch: Partial<NoteEdit>) => store.dispatch({ type: "edit", slot, draft: { ...edit, ...patch } });
		async function save(event: React.FormEvent) {
			event.preventDefault();
			setTouched(true);
			if (item.kind !== "note" || !edit || !edit.body.trim() || !edit.reason.trim()) return;
			const input = {
				personId: store.get().saved.id,
				noteId: item.id,
				body: edit.body.trim(),
				reason: edit.reason.trim(),
			};
			const rev = item.revision;
			const r = await runSave(store, slot, { input, rev }, (key) => editNote(key, rev, input), {
				fresh,
				toPerson: (v) => v.person,
			});
			if (r?.status === "ok") {
				setTouched(false);
				onEntry({ ...item, body: input.body, editedAt: r.value.receipt.at, revision: r.value.note.revision });
			} else if (isConflict(r)) onConflict();
		}
		return (
			<li className="border-t border-line py-4 first:border-t-0">
				<form onSubmit={save} className="flex flex-col gap-3" aria-label="Edit note">
					<Field label="Note" error={touched && !edit.body.trim() ? "A note cannot be empty." : null}>
						<Textarea
							rows={3}
							maxLength={5000}
							value={edit.body}
							readOnly={pending}
							onChange={(e) => set({ body: e.target.value })}
						/>
					</Field>
					<Field
						label="Why you changed it"
						hint="Saved with the earlier version in the history."
						error={touched && !edit.reason.trim() ? "Give a reason." : null}
					>
						<Textarea
							rows={1}
							maxLength={5000}
							value={edit.reason}
							readOnly={pending}
							onChange={(e) => set({ reason: e.target.value })}
						/>
					</Field>
					<FormProblem code={state.errors[slot]} />
					<div className="flex justify-end gap-2">
						<Button
							variant="secondary"
							size="sm"
							disabled={pending}
							onClick={() => {
								setTouched(false);
								store.dispatch({ type: "discard", slot });
							}}
						>
							Cancel
						</Button>
						<Button variant="primary" size="sm" type="submit" loading={pending}>
							Save note
						</Button>
					</div>
				</form>
			</li>
		);
	}

	const view = describe(item, by);
	return (
		<li className="flex items-start gap-3.5 border-t border-line py-4 first:border-t-0">
			<span
				aria-hidden="true"
				className={cn("grid size-10 flex-none place-items-center rounded-pill", TINT[view.tone])}
			>
				<Icon icon={view.icon} size={18} />
			</span>
			<div className="min-w-0 flex-1">
				<p className="text-[15px] font-medium text-ink">{view.title}</p>
				{item.kind === "note" ? (
					<p className="mt-1 whitespace-pre-wrap text-md text-ink-2 [overflow-wrap:anywhere]">{item.body}</p>
				) : null}
				{item.kind === "follow_up" && item.channel ? (
					<p className="mt-1 text-md text-ink-2">{CHANNEL_LABEL[item.channel]}</p>
				) : null}
				{item.kind === "follow_up" && item.notes ? (
					<p className="mt-1 whitespace-pre-wrap text-md text-ink-2 [overflow-wrap:anywhere]">{item.notes}</p>
				) : null}
				<p className="mt-1 text-sm text-text-3">
					{by} · <When at={item.occurredAt} withTime />
					{item.kind === "note" && item.editedAt ? (
						<>
							{" "}
							· Edited <When at={item.editedAt} withTime />
						</>
					) : null}
				</p>
				{onUnmerge && item.kind === "activity" && item.action === "person_merged" && item.recordId ? (
					<div className="mt-2 -ml-3">
						<Button
							variant="ghost"
							size="sm"
							icon={ArrowTurnBackwardIcon}
							disabled={state.pending !== null}
							onClick={() => onUnmerge(item.recordId!)}
							{...unmergeIntent(item.recordId)}
						>
							Review Unmerge
						</Button>
					</div>
				) : null}
				{item.kind === "note" && mine && writing ? (
					<div className="mt-2 -ml-3 flex gap-1">
						<Button
							variant="ghost"
							size="sm"
							icon={Edit02Icon}
							disabled={state.pending !== null}
							onClick={() => store.dispatch({ type: "edit", slot, draft: { body: item.body, reason: "" } })}
						>
							Edit
						</Button>
						<Button
							variant="ghost"
							size="sm"
							icon={Delete02Icon}
							disabled={state.pending !== null}
							onClick={() => onRemove(item)}
						>
							Delete
						</Button>
					</div>
				) : null}
			</div>
		</li>
	);
}

function describe(item: Item, by: string): { title: string; icon: IconSvgElement; tone: Tone } {
	switch (item.kind) {
		case "note":
			return { title: "Note", icon: Note01Icon, tone: "violet" };
		case "note_removed":
			return { title: `Note deleted by ${by === "You" ? "you" : by.toLowerCase()}`, icon: Delete02Icon, tone: "ink" };
		case "stage_changed":
			return {
				title: `Stage changed from ${STAGE_LABEL[item.from].toLowerCase()} to ${STAGE_LABEL[item.to].toLowerCase()}`,
				icon: Route01Icon,
				tone: "green",
			};
		case "activity":
			// A household join, leave or role change names the household as it was then (REQ-PPL-009).
			if (item.household) return { title: householdChange(item.household), icon: Home01Icon, tone: "teal" };
			if (item.action === "person_merged" || item.action === "person_unmerged")
				return { title: ACTION[item.action], icon: GitMergeIcon, tone: "violet" };
			return {
				// A record that advanced the stage says so in the same entry (REQ-PPL-020).
				title: item.stage
					? `${ACTION[item.action]}. Stage moved from ${STAGE_LABEL[item.stage.from].toLowerCase()} to ${STAGE_LABEL[item.stage.to].toLowerCase()}`
					: ACTION[item.action],
				icon: UserEdit01Icon,
				tone: "blue",
			};
		case "follow_up":
			return { title: FOLLOW_UP[item.outcome], icon: TaskDone01Icon, tone: "amber" };
	}
}

function DeleteNoteDialog({
	note,
	store,
	onClose,
	onDeleted,
	onConflict,
}: {
	note: Extract<Item, { kind: "note" }> | null;
	store: Store;
	onClose: () => void;
	/** The note's entry as it is now: a marker that it was deleted. */
	onDeleted: (entry: Item) => void;
	onConflict: () => void;
}) {
	const state = useStore(store);
	const slot = note ? `delete:${note.id}` : "delete";
	const pending = state.pending === slot;
	const reason = (state.drafts[slot] as { body: string } | undefined)?.body ?? "";
	const [touched, setTouched] = useState(false);
	const close = () => {
		if (pending) return;
		store.dispatch({ type: "discard", slot });
		setTouched(false);
		onClose();
	};
	async function remove() {
		setTouched(true);
		if (!note || !reason.trim()) return;
		const input = { personId: state.saved.id, noteId: note.id, reason: reason.trim() };
		const rev = note.revision;
		const r = await runSave(store, slot, { input, rev }, (key) => deleteNote(key, rev, input), {
			fresh,
			toPerson: (v) => v.person,
		});
		if (r?.status === "ok") {
			setTouched(false);
			const { id, occurredAt, recordedAt, actor } = note;
			onDeleted({ id, occurredAt, recordedAt, actor, kind: "note_removed", revision: r.value.note.revision });
		} else if (isConflict(r)) onConflict();
	}
	return (
		<Dialog open={note !== null} onOpenChange={(open) => !open && close()}>
			<DialogContent size="sm" aria-busy={pending || undefined}>
				<DialogHeader icon={Delete02Icon} tone="magenta" title="Delete this note?" />
				<DialogBody className="flex flex-col gap-4">
					<p>The words are removed. The activity keeps a marker that you deleted a note and when.</p>
					{note ? (
						<blockquote className="line-clamp-3 rounded-md bg-surface px-4 py-3 text-ink-2">{note.body}</blockquote>
					) : null}
					<Field label="Reason" error={touched && !reason.trim() ? "Give a reason." : null}>
						<Textarea
							rows={2}
							maxLength={5000}
							value={reason}
							readOnly={pending}
							onChange={(e) => store.dispatch({ type: "edit", slot, draft: { body: e.target.value } })}
						/>
					</Field>
					<FormProblem code={state.errors[slot]} />
				</DialogBody>
				<DialogFooter>
					<Button variant="secondary" onClick={close} disabled={pending}>
						Cancel
					</Button>
					<Button variant="danger" onClick={remove} loading={pending}>
						Delete note
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
