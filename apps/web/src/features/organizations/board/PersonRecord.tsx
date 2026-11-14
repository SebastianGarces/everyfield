"use client";

import type { PipelineBoard, PipelinePersonRecord } from "@everyfield/contracts/organizations";
import { ArrowRight02Icon, Edit02Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardBody,
	CardHeader,
	CardTitle,
	ConfirmDialog,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Field,
	Input,
	PageHeader,
	Select,
	Textarea,
} from "@everyfield/ui/controls";
import { useState, type FormEvent, type ReactNode } from "react";
import {
	addNote,
	editNote,
	movePerson,
	readPerson,
	recordAssessment,
	removeNote,
	restorePerson,
	retirePerson,
} from "./actions";
import { ConversationsCard } from "./Conversations";
import { formatDay, PIPELINE_PATH, refusalText } from "./model";
import { PersonDialog } from "./PersonDialog";
import { Problem } from "./Problem";

type Record = PipelinePersonRecord;
type Answer = Awaited<ReturnType<typeof movePerson>>;
type Failure = Exclude<Answer, { status: "ok" }>;

/**
 * One pipeline person (REQ-MUL-001, -008, -009). Owners and Admins edit, move with a reason, record an outside
 * assessment, retire and restore; the person's responsible staff read the record and write notes. A change reads the
 * record again, so history shows the server's own entry.
 */
export function PersonRecord({
	initial,
	stages,
	staff,
}: {
	initial: Record;
	stages: PipelineBoard["stages"];
	staff: PipelineBoard["staff"];
}) {
	const [record, setRecord] = useState(initial);
	const [dialog, setDialog] = useState<"edit" | "move" | "assessment" | "retire" | "restore" | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const admin = record.audience === "administrator";

	async function reread() {
		const answer = await readPerson(record.personId).catch(() => null);
		if (answer?.status === "ok") setRecord(answer.value);
	}
	/** Runs a change; on success closes its dialog and reads the record again. A failure is returned for the form. */
	async function change(run: () => Promise<Answer | Failure>): Promise<string | null> {
		const answer = await run().catch((): Failure => ({ status: "lost" }));
		if (answer.status !== "ok") return refusalText(answer);
		setDialog(null);
		await reread();
		return null;
	}

	return (
		<div className="flex flex-col gap-5">
			<PageHeader
				breadcrumb={[{ label: "Pipeline", href: PIPELINE_PATH }, { label: record.name }]}
				title={record.name}
				subtitle={record.retired ? `Retired · was at ${record.stage.label}` : record.stage.label}
				actions={
					admin ? (
						record.retired ? (
							<Button variant="primary" onClick={() => setDialog("restore")}>
								Restore
							</Button>
						) : (
							<>
								<Button variant="secondary" icon={Edit02Icon} onClick={() => setDialog("edit")}>
									Edit
								</Button>
								<Button variant="primary" icon={ArrowRight02Icon} onClick={() => setDialog("move")}>
									Move stage
								</Button>
							</>
						)
					) : null
				}
			/>
			<Problem text={notice} />
			<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-5 max-app-md:grid-cols-1">
				<div className="flex flex-col gap-5">
					<Card>
						<CardHeader>
							<CardTitle>Details</CardTitle>
						</CardHeader>
						<CardBody>
							<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm">
								<Detail term="Stage">{record.stage.label}</Detail>
								<Detail term="Email">{record.email ?? "None"}</Detail>
								<Detail term="Responsible staff">{record.responsible?.name ?? "No one"}</Detail>
							</dl>
							<p className="mt-4 text-sm text-ink">
								{record.assessment
									? `Outside assessment: ${formatDay(record.assessment.on)}, ${record.assessment.by}`
									: "No outside assessment recorded"}
							</p>
							{admin && !record.retired ? (
								<div className="mt-4 flex flex-wrap gap-2">
									<Button variant="secondary" size="sm" onClick={() => setDialog("assessment")}>
										Record outside assessment
									</Button>
									<Button variant="ghost" size="sm" onClick={() => setDialog("retire")}>
										Retire
									</Button>
								</div>
							) : null}
						</CardBody>
					</Card>
					<History record={record} />
				</div>
				<div className="flex flex-col gap-5">
					<ConversationsCard record={record} onChanged={reread} />
					<Notes record={record} onChanged={reread} />
				</div>
			</div>

			{admin ? (
				<>
					<PersonDialog
						open={dialog === "edit"}
						onOpenChange={(open) => setDialog(open ? "edit" : null)}
						staff={staff}
						stages={stages}
						editing={{
							personId: record.personId,
							revision: record.revision,
							name: record.name,
							email: record.email,
							responsibleSeatId: record.responsible?.seatId ?? null,
							stageId: record.stage.id,
						}}
						onSaved={() => {
							setDialog(null);
							void reread();
						}}
					/>
					<MoveDialog
						open={dialog === "move"}
						onOpenChange={(open) => setDialog(open ? "move" : null)}
						record={record}
						stages={stages}
						onSubmit={(stageId, reason) =>
							change(() =>
								movePerson({ personId: record.personId, expectedRevision: record.revision, stageId, reason }),
							)
						}
					/>
					<AssessmentDialog
						open={dialog === "assessment"}
						onOpenChange={(open) => setDialog(open ? "assessment" : null)}
						asOf={record.asOf}
						onSubmit={(assessedOn, assessor) =>
							change(() =>
								recordAssessment({
									personId: record.personId,
									expectedRevision: record.revision,
									assessedOn,
									assessor,
								}),
							)
						}
					/>
					<ConfirmDialog
						open={dialog === "retire" || dialog === "restore"}
						onOpenChange={(open) => (open ? null : setDialog(null))}
						title={dialog === "restore" ? `Restore ${record.name}?` : `Retire ${record.name}?`}
						description={
							dialog === "restore"
								? `${record.name} goes back to ${record.stage.label} on the board.`
								: `${record.name} leaves the board, the stage counts and the staff pickers. Their history stays, and you can restore them from Retired.`
						}
						confirmLabel={dialog === "restore" ? "Restore" : "Retire"}
						onConfirm={async () => {
							const run = dialog === "restore" ? restorePerson : retirePerson;
							const problem = await change(() => run({ personId: record.personId, expectedRevision: record.revision }));
							setNotice(problem);
						}}
					/>
				</>
			) : null}
		</div>
	);
}

function Detail({ term, children }: { term: string; children: ReactNode }) {
	return (
		<>
			<dt className="text-text-2">{term}</dt>
			<dd className="min-w-0 text-ink [overflow-wrap:anywhere]">{children}</dd>
		</>
	);
}

/** Every move with who made it, the day and the reason, under the stage names of that day. */
function History({ record }: { record: Record }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>History</CardTitle>
			</CardHeader>
			<CardBody>
				<ol className="flex flex-col gap-3.5">
					{record.history.map((h) => (
						<li key={h.id} className="flex flex-col gap-0.5 text-sm">
							<span className="font-medium text-ink">
								{h.kind === "placed"
									? `Added to ${h.to}`
									: h.kind === "moved"
										? `Moved from ${h.from} to ${h.to}`
										: h.kind === "assessment"
											? "Outside assessment recorded"
											: h.kind === "retired"
												? "Retired"
												: h.kind === "restored"
													? "Restored"
													: "Details edited"}
							</span>
							<span className="text-text-2">{[h.actor ?? "Former staff", formatDay(h.on)].join(" · ")}</span>
							{h.kind === "moved" ? <span className="text-ink-2">Reason: {h.reason}</span> : null}
						</li>
					))}
				</ol>
			</CardBody>
		</Card>
	);
}

function MoveDialog({
	open,
	onOpenChange,
	...form
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	record: Record;
	stages: PipelineBoard["stages"];
	onSubmit: (stageId: string, reason: string) => Promise<string | null>;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent size="sm">{open ? <MoveForm {...form} /> : null}</DialogContent>
		</Dialog>
	);
}

/** Any stage but the current one, and a reason, which is required. Not continuing is a stage like any other. */
function MoveForm({
	record,
	stages,
	onSubmit,
}: {
	record: Record;
	stages: PipelineBoard["stages"];
	onSubmit: (stageId: string, reason: string) => Promise<string | null>;
}) {
	const choices = stages.filter((s) => s.id !== record.stage.id);
	const [stageId, setStageId] = useState(choices[0]?.id ?? "");
	const [reason, setReason] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!reason.trim()) {
			setError("Give a reason for this move.");
			return;
		}
		setError(null);
		setSaving(true);
		const failed = await onSubmit(stageId, reason.trim());
		setSaving(false);
		setProblem(failed);
		if (!failed) setReason("");
	}
	return (
		<form onSubmit={submit} noValidate className="contents">
			<DialogHeader title={`Move ${record.name}`} description={`Now at ${record.stage.label}.`} />
			<DialogBody className="flex flex-col gap-4">
				<Field label="Move to">
					<Select
						value={stageId}
						onValueChange={setStageId}
						options={choices.map((s) => ({ value: s.id, label: s.label }))}
					/>
				</Field>
				<Field label="Reason" error={error ?? undefined} hint="Staff with access to this record see it in the history.">
					<Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} />
				</Field>
				<Problem text={problem} />
			</DialogBody>
			<DialogFooter>
				<Button type="submit" variant="primary" loading={saving}>
					Move
				</Button>
			</DialogFooter>
		</form>
	);
}

/** Only that an outside assessment happened, when and who ran it. There is no field for its result. */
function AssessmentDialog({
	open,
	onOpenChange,
	asOf,
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	asOf: string;
	onSubmit: (on: string, by: string) => Promise<string | null>;
}) {
	const [on, setOn] = useState("");
	const [by, setBy] = useState("");
	const [errors, setErrors] = useState<{ on?: string; by?: string }>({});
	const [problem, setProblem] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	async function submit(event: FormEvent) {
		event.preventDefault();
		const next = {
			on: !on ? "Enter the date." : on > asOf ? "The date can’t be after today." : undefined,
			by: by.trim() ? undefined : "Enter who ran it.",
		};
		setErrors(next);
		if (next.on || next.by) return;
		setSaving(true);
		setProblem(await onSubmit(on, by.trim()));
		setSaving(false);
	}
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent size="sm">
				<form onSubmit={submit} noValidate className="contents">
					<DialogHeader
						title="Record an outside assessment"
						description="Record that it happened, when, and who ran it. Everyfield doesn’t keep results, scores or ratings."
					/>
					<DialogBody className="flex flex-col gap-4">
						<Field label="Date" error={errors.on}>
							<Input type="date" value={on} max={asOf} onChange={(e) => setOn(e.target.value)} />
						</Field>
						<Field label="Who ran it" error={errors.by} hint="For example, Send Network assessment retreat.">
							<Input value={by} onChange={(e) => setBy(e.target.value)} maxLength={200} />
						</Field>
						<Problem text={problem} />
					</DialogBody>
					<DialogFooter>
						<Button type="submit" variant="primary" loading={saving}>
							Save
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Private staff notes (REQ-MUL-009): read by Owners, Admins and the person's responsible staff. Only the author edits
 * or removes their note; a removed note shows who removed it and when, with no text.
 */
function Notes({ record, onChanged }: { record: Record; onChanged: () => Promise<void> }) {
	const canWrite = !record.retired;
	const [draft, setDraft] = useState("");
	const [noteId, setNoteId] = useState(() => crypto.randomUUID());
	const [problem, setProblem] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	async function add(event: FormEvent) {
		event.preventDefault();
		if (!draft.trim()) return;
		setSaving(true);
		const answer = await addNote({ personId: record.personId, noteId, body: draft.trim() }).catch((): Failure => ({
			status: "lost",
		}));
		setSaving(false);
		if (answer.status !== "ok") {
			setProblem(refusalText(answer));
			return;
		}
		setProblem(null);
		setDraft("");
		setNoteId(crypto.randomUUID());
		await onChanged();
	}
	return (
		<Card>
			<CardHeader>
				<CardTitle>Notes</CardTitle>
			</CardHeader>
			<CardBody className="flex flex-col gap-4">
				<p className="text-sm text-text-2">
					Only Owners, Admins and {record.name}’s responsible staff can read these notes. They never go to Evry.
				</p>
				{canWrite ? (
					<form onSubmit={add} className="flex flex-col gap-2">
						<Field label="Add a note">
							<Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} maxLength={5000} />
						</Field>
						<Problem text={problem} />
						<Button
							type="submit"
							variant="secondary"
							size="sm"
							loading={saving}
							disabled={!draft.trim()}
							className="self-end"
						>
							Add note
						</Button>
					</form>
				) : null}
				{record.notes.length ? (
					<ul className="flex flex-col gap-3">
						{record.notes.map((n) => (
							<li key={n.id}>
								{n.state === "removed" ? (
									<p className="rounded-md bg-surface-2 px-3 py-2.5 text-sm text-text-2">
										Note removed by {n.author ?? "former staff"}, {formatDay(n.removedOn)}
									</p>
								) : (
									<NoteItem note={n} editable={canWrite && n.mine} onChanged={onChanged} />
								)}
							</li>
						))}
					</ul>
				) : (
					<p className="text-sm text-text-3">No notes yet.</p>
				)}
			</CardBody>
		</Card>
	);
}

function NoteItem({
	note,
	editable,
	onChanged,
}: {
	note: Extract<Record["notes"][number], { state: "current" }>;
	/** The author's own note on a live person: only then can it change (REQ-MUL-009). */
	editable: boolean;
	onChanged: () => Promise<void>;
}) {
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState(note.body);
	const [removing, setRemoving] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	async function save(event: FormEvent) {
		event.preventDefault();
		if (!text.trim()) return;
		setSaving(true);
		const answer = await editNote({ noteId: note.id, expectedRevision: note.revision, body: text.trim() }).catch(
			(): Failure => ({ status: "lost" }),
		);
		setSaving(false);
		if (answer.status !== "ok") return setProblem(refusalText(answer));
		setEditing(false);
		await onChanged();
	}
	const meta = `${note.author ?? "Former staff"} · ${formatDay(note.writtenOn)}${note.editedOn ? ` · edited ${formatDay(note.editedOn)}` : ""}`;
	return (
		<article className="flex flex-col gap-1.5 rounded-md bg-surface-2 px-3 py-2.5">
			{editing ? (
				<form onSubmit={save} className="flex flex-col gap-2">
					<Textarea
						aria-label="Edit note"
						value={text}
						onChange={(e) => setText(e.target.value)}
						rows={3}
						maxLength={5000}
					/>
					<div className="flex justify-end gap-2">
						<Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
							Cancel
						</Button>
						<Button type="submit" variant="secondary" size="sm" loading={saving} disabled={!text.trim()}>
							Save note
						</Button>
					</div>
				</form>
			) : (
				<p className="text-sm whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">{note.body}</p>
			)}
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span className="text-xs text-text-3">{meta}</span>
				{editable && !editing ? (
					<span className="ml-auto flex gap-1">
						<Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
							Edit
						</Button>
						<Button variant="ghost" size="sm" onClick={() => setRemoving(true)}>
							Remove
						</Button>
					</span>
				) : null}
			</div>
			{problem ? <p className="text-sm text-magenta-600">{problem}</p> : null}
			<ConfirmDialog
				open={removing}
				onOpenChange={setRemoving}
				title="Remove this note?"
				description="The text is deleted. Others who can read notes will see that you removed a note, and when."
				confirmLabel="Remove note"
				onConfirm={async () => {
					const answer = await removeNote({ noteId: note.id, expectedRevision: note.revision }).catch((): Failure => ({
						status: "lost",
					}));
					if (answer.status !== "ok") setProblem(refusalText(answer));
					else await onChanged();
				}}
			/>
		</article>
	);
}
