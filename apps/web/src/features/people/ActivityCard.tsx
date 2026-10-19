"use client";

import {
	Delete02Icon,
	Edit02Icon,
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
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { z } from "zod";
import { addNote, deleteNote, editNote, loadActivities } from "./actions.ts";
import { runSave, STAGE_LABEL, type Outcome, type PersonStore } from "./model.ts";
import { FormProblem, fresh, problemOf, useStore, When } from "./parts.tsx";
import type { PersonDraft } from "./StageDialog.tsx";

type PlantPerson = z.infer<typeof people.plantPerson>;
type Activities = z.infer<typeof people.activitiesResult>;
type Item = Activities["items"][number];
type Store = PersonStore<PlantPerson, PersonDraft>;
type NoteEdit = { body: string; reason: string };

const ACTION: Record<Extract<Item, { kind: "activity" }>["action"], string> = {
	created: "Added to People",
	updated: "Details changed",
	retired: "Retired",
	restored: "Restored",
	classification_recorded: "Adult or child recorded",
	classification_corrected: "Adult or child corrected",
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
 * deleted note keeps a marker of who removed it and when; its words are gone.
 */
export function ActivityCard({
	store,
	initial,
	accountId,
	canWrite,
}: {
	store: Store;
	initial: Outcome<Activities>;
	/** The viewer's account, to tell their own notes from others'. */
	accountId: string;
	canWrite: boolean;
}) {
	const state = useStore(store);
	const person = state.saved;
	const live = person.lifecycle.state === "live";
	const router = useRouter();
	// The server's first page is the source of truth; a refresh after any change replaces it. Pages loaded with
	// "Show later activity" or "Try again" belong to the server copy they were loaded on.
	const [loaded, setLoaded] = useState({ from: initial, value: initial });
	const activities = loaded.from === initial ? loaded.value : initial;
	const setActivities = (value: Outcome<Activities>) => setLoaded({ from: initial, value });
	const [more, setMore] = useState<{ loading: boolean; problem?: string }>({ loading: false });
	const [removing, setRemoving] = useState<Extract<Item, { kind: "note" }> | null>(null);
	const first = person.displayName.split(" ")[0] ?? person.displayName;
	const composer = (state.drafts.note as { body: string } | undefined)?.body ?? "";
	const writing = canWrite && live;

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
			toPerson: (p) => p,
		});
		if (r?.status === "ok") router.refresh();
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
				<form onSubmit={saveNote} className="mb-4 flex flex-col gap-2.5 rounded-[18px] bg-surface p-4">
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
							onSaved={async () => router.refresh()}
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
				onDeleted={async () => {
					setRemoving(null);
					router.refresh();
				}}
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
	onSaved,
}: {
	item: Item;
	store: Store;
	mine: boolean;
	writing: boolean;
	onRemove: (note: Extract<Item, { kind: "note" }>) => void;
	onSaved: () => Promise<void>;
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
				toPerson: (p) => p,
			});
			if (r?.status === "ok") {
				setTouched(false);
				await onSaved();
			}
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
				className={cn("grid size-10 flex-none place-items-center rounded-full", TINT[view.tone])}
			>
				<Icon icon={view.icon} size={18} />
			</span>
			<div className="min-w-0 flex-1">
				<p className="text-[15px] font-medium text-ink">{view.title}</p>
				{item.kind === "note" ? (
					<p className="mt-1 whitespace-pre-wrap text-md text-ink-2 [overflow-wrap:anywhere]">{item.body}</p>
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
			return { title: ACTION[item.action], icon: UserEdit01Icon, tone: "blue" };
		case "follow_up":
			return { title: FOLLOW_UP[item.outcome], icon: TaskDone01Icon, tone: "amber" };
	}
}

function DeleteNoteDialog({
	note,
	store,
	onClose,
	onDeleted,
}: {
	note: Extract<Item, { kind: "note" }> | null;
	store: Store;
	onClose: () => void;
	onDeleted: () => Promise<void>;
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
			toPerson: (p) => p,
		});
		if (r?.status === "ok") {
			setTouched(false);
			await onDeleted();
		}
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
