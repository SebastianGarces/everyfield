"use client";

import { dayText } from "@everyfield/contracts/common";
import type { ReadinessEntry, ReadinessKey, ReadinessRevision } from "@everyfield/contracts/intelligence";
import {
	Alert,
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	Combobox,
	ConfirmDialog,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Field,
	Input,
	Textarea,
	toast,
} from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { cn } from "@everyfield/ui/foundations";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { attestReadiness, correctReadiness } from "./readiness-actions.ts";
import {
	actionLabel,
	draftOf,
	entryOf,
	historyOf,
	inputOf,
	intentOf,
	KIND_LABEL,
	noteLine,
	problemsOf,
	READINESS,
	recorded,
	retracted,
	settleWrite,
	STATE_LABEL,
	withReadiness,
	type DraftProblems,
	type Failure,
	type ReadinessDraft,
	type ReadinessView,
	type ReadinessWriteResult,
} from "./readiness-model.ts";
import type { SignalOutcome } from "./signals-model.ts";

type Dialogs = { kind: "edit" | "retract"; key: ReadinessKey } | null;

export function ReadinessSection({
	initial,
	viewerName,
	timeZone,
}: {
	initial: ReadinessView;
	viewerName: string;
	timeZone: string;
}) {
	const router = useRouter();
	const [seen, setSeen] = useState(initial);
	const [view, setView] = useState(initial);
	const [dialog, setDialog] = useState<Dialogs>(null);
	const keys = useRef(new Map<string, string>());
	const inflight = useRef(false);
	if (initial !== seen) {
		setSeen(initial);
		setView(initial);
	}
	const keyFor = (payload: string) => {
		const known = keys.current.get(payload);
		if (known !== undefined) return known;
		const fresh = crypto.randomUUID();
		keys.current.set(payload, fresh);
		return fresh;
	};

	async function write(
		entry: ReadinessEntry,
		kind: ReadinessRevision["kind"],
		optimistic: ReadinessEntry,
		payload: unknown[],
		send: (requestKey: string) => Promise<SignalOutcome<ReadinessWriteResult>>,
	): Promise<Failure | "busy" | null> {
		if (inflight.current) return "busy";
		inflight.current = true;
		const id = JSON.stringify(payload);
		const failure = await settleWrite(entry, kind, optimistic, () => send(keyFor(id)), setView);
		inflight.current = false;
		if (failure) return failure;
		keys.current.delete(id);
		router.refresh();
		return null;
	}

	function save(entry: ReadinessEntry, draft: ReadinessDraft) {
		const what = intentOf(entry, draft);
		if (what === "none") return Promise.resolve(null);
		const input = inputOf(entry.key, draft);
		return write(
			entry,
			what === "attest" ? "answered" : "corrected",
			recorded(entry, draft, view.people, viewerName, new Date().toISOString()),
			[what, entry.revision, input],
			(key) =>
				what === "attest"
					? attestReadiness(key, entry.revision, input)
					: correctReadiness(key, entry.revision, { action: "correct", attestation: input }),
		);
	}
	function retract(entry: ReadinessEntry) {
		const input = { action: "retract", key: entry.key } as const;
		return write(
			entry,
			"retracted",
			retracted(entry, view.today, viewerName, new Date().toISOString()),
			["retract", entry.revision, input],
			(key) => correctReadiness(key, entry.revision, input),
		);
	}

	const open = dialog ? entryOf(view, dialog.key) : null;
	return (
		<Card className="mt-5">
			<CardHeader>
				<CardHeading>
					<CardTitle>What you attest</CardTitle>
					<CardDescription>
						Three dated statements only an Owner or Admin can make. Each one feeds an exit criterion above and keeps its
						history.
					</CardDescription>
				</CardHeading>
			</CardHeader>
			<ul className="flex flex-col">
				{view.attestations.map((entry) => (
					<ReadinessRow
						key={entry.key}
						entry={entry}
						history={historyOf(view, entry.key)}
						timeZone={timeZone}
						onEdit={() => setDialog({ kind: "edit", key: entry.key })}
						onRetract={() => setDialog({ kind: "retract", key: entry.key })}
					/>
				))}
			</ul>
			{open && dialog?.kind === "edit" ? (
				<ReadinessDialog
					key={open.key}
					entry={open}
					view={view}
					onClose={() => setDialog(null)}
					onSave={save}
					onReload={() => router.refresh()}
					onDone={(message) => {
						setDialog(null);
						toast({ message, tone: "success" });
					}}
				/>
			) : null}
			{open && dialog?.kind === "retract" ? (
				<ConfirmDialog
					open
					onOpenChange={(next) => (next ? null : setDialog(null))}
					tone="danger"
					title={`Retract the ${READINESS[open.key].title.toLowerCase()}?`}
					description="It stops counting toward its exit criterion. The old date and value stay in the history, and you can record it again."
					confirmLabel="Retract"
					onConfirm={async () => {
						const failure = await retract(open);
						if (failure === "busy") return;
						if (failure) return { refused: failure.text };
						toast({ message: `${READINESS[open.key].title} retracted.`, tone: "success" });
					}}
				/>
			) : null}
		</Card>
	);
}

const STATE_BADGE = {
	answered: { status: "positive", plain: false },
	retracted: { status: "unknown", plain: false },
	unanswered: { status: "unknown", plain: true },
} as const;

const instantText = (at: string, timeZone: string) =>
	new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone }).format(new Date(at));

function ReadinessRow({
	entry,
	history,
	timeZone,
	onEdit,
	onRetract,
}: {
	entry: ReadinessEntry;
	history: ReadinessRevision[];
	timeZone: string;
	onEdit: () => void;
	onRetract: () => void;
}) {
	const copy = READINESS[entry.key];
	const badge = STATE_BADGE[entry.state];
	const note = noteLine(entry);
	return (
		<li
			data-readiness={entry.key}
			className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.4fr)_auto] items-start gap-x-5 gap-y-2 border-t border-line py-4 first:border-t-0 first:pt-0 max-app-md:grid-cols-[minmax(0,1fr)_auto]"
		>
			<div className="min-w-0 max-app-md:col-span-2">
				<div className="flex flex-wrap items-center gap-2">
					<h3 className="font-semibold text-ink">{copy.title}</h3>
					<StatusBadge size="sm" status={badge.status} plain={badge.plain}>
						{STATE_LABEL[entry.state]}
					</StatusBadge>
				</div>
				<p className="mt-[3px] text-sm leading-[1.45] text-text-2">{copy.description}</p>
			</div>
			<div className="min-w-0 text-sm leading-[1.45] text-text-2 max-app-md:col-span-2">
				{entry.state === "answered" ? (
					<>
						<p className="font-medium break-words text-ink">{entry.named ?? "A person no longer listed"}</p>
						{note ? <p className="break-words">{note}</p> : null}
						<p className="text-text-3">
							{[
								entry.asOf ? `True as of ${dayText(entry.asOf)}` : null,
								entry.authorName ?? "A church admin",
							]
								.filter(Boolean)
								.join(" · ")}
						</p>
					</>
				) : entry.state === "retracted" ? (
					<p className="text-text-3">
						Retracted
						{entry.recordedAt ? ` ${instantText(entry.recordedAt, timeZone)}` : ""} by{" "}
						{entry.authorName ?? "a church admin"}. Its criterion reads Unknown until you record it again.
					</p>
				) : (
					<p className="text-text-3">Not recorded yet. Its criterion reads Unknown.</p>
				)}
			</div>
			<div className="flex flex-wrap justify-end gap-2 max-app-md:col-span-2 max-app-md:justify-start">
				{entry.state === "answered" ? (
					<Button variant="ghost" size="sm" onClick={onRetract} aria-label={`Retract: ${copy.title}`}>
						Retract
					</Button>
				) : null}
				<Button
					variant={entry.state === "answered" ? "secondary" : "primary"}
					size="sm"
					onClick={onEdit}
					aria-label={`${actionLabel(entry)}: ${copy.title}`}
				>
					{actionLabel(entry)}
				</Button>
			</div>
			{history.length ? (
				<details className="col-span-full">
					<summary className="w-max text-sm font-medium text-ink-2">History · {history.length}</summary>
					<HistoryList history={history} timeZone={timeZone} />
				</details>
			) : null}
		</li>
	);
}

function HistoryList({ history, timeZone }: { history: ReadinessRevision[]; timeZone: string }) {
	return (
		<ol className="mt-2 flex flex-col rounded-md bg-surface-2 px-3.5">
			{history.map((line, i) => {
				const note = noteLine(line);
				return (
					<li
						key={line.id}
						className="grid grid-cols-[10px_minmax(0,1fr)] items-start gap-3 border-t border-line py-2.5 first:border-t-0"
					>
						<span
							aria-hidden="true"
							className={cn(
								"mt-1.5 size-2.5 rounded-full",
								i === 0 ? "bg-ink" : "bg-transparent shadow-[inset_0_0_0_1.5px_var(--ef-line-2)]",
							)}
						/>
						<div className="min-w-0 text-sm">
							<p className="font-medium break-words text-ink">
								{KIND_LABEL[line.kind]} · {line.named ?? "A person no longer listed"}
							</p>
							{note ? <p className="break-words text-text-2">{note}</p> : null}
							<p className="text-xs text-text-3">
								True as of {dayText(line.asOf)} · {line.authorName ?? "A church admin"} · saved{" "}
								{instantText(line.recordedAt, timeZone)}
							</p>
						</div>
					</li>
				);
			})}
		</ol>
	);
}

function ReadinessDialog({
	entry,
	view,
	onClose,
	onSave,
	onReload,
	onDone,
}: {
	entry: ReadinessEntry;
	view: ReadinessView;
	onClose: () => void;
	onSave: (entry: ReadinessEntry, draft: ReadinessDraft) => Promise<Failure | "busy" | null>;
	onReload: () => void;
	onDone: (message: string) => void;
}) {
	const copy = READINESS[entry.key];
	const [draft, setDraft] = useState(() => draftOf(entry, view.today));
	const [failure, setFailure] = useState<Failure | null>(null);
	const [busy, setBusy] = useState(false);
	const [tried, setTried] = useState(false);
	const edit = (change: Partial<ReadinessDraft>) => setDraft((d) => ({ ...d, ...change }));
	const problems = problemsOf(entry.key, draft, view.today);
	const shown: DraftProblems = tried
		? problems
		: {
				named: draft.named.trim() ? problems.named : undefined,
				note: problems.note,
				asOf: draft.asOf ? problems.asOf : undefined,
			};
	const what = intentOf(entry, draft);
	const worship = entry.key === "worship_agreement";
	const nobody = worship && view.people.length === 0;
	const correcting = entry.state === "answered";

	async function submit() {
		setTried(true);
		if (busy || nobody || what === "none" || Object.keys(problems).length) return;
		setBusy(true);
		setFailure(null);
		const failed = await onSave(entry, draft);
		if (failed === "busy") return;
		setBusy(false);
		if (failed) setFailure(failed);
		else onDone(correcting ? `${copy.title} corrected.` : `${copy.title} recorded.`);
	}

	return (
		<Dialog open onOpenChange={(next) => (next || busy ? null : onClose())}>
			<DialogContent size="sm">
				<DialogHeader
					title={correcting ? `Correct the ${copy.title.toLowerCase()}` : `Record the ${copy.title.toLowerCase()}`}
					description={`${copy.description} Saved as your dated statement.`}
				/>
				<form
					className="contents"
					noValidate
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					<DialogBody className="flex flex-col gap-4">
						{failure ? (
							<Alert
								role="alert"
								tone="warning"
								actions={
									failure.stale ? (
										<Button type="button" variant="ghost" size="sm" onClick={onReload}>
											Load the latest
										</Button>
									) : undefined
								}
							>
								{failure.text}
							</Alert>
						) : null}
						{nobody ? (
							<Alert tone="neutral">
								Your church has no people yet, so there is no one to choose. Add the person on{" "}
								<Link href="/people" className="font-medium underline">
									People
								</Link>
								, then come back.
							</Alert>
						) : worship ? (
							<Field label={copy.named} hint={copy.namedHint} error={shown.named}>
								<Combobox
									value={draft.named ? [draft.named] : []}
									onValueChange={(next) => edit({ named: next[0] ?? "" })}
									options={view.people.map((p) => ({ value: p.id, label: p.displayName }))}
									placeholder="Choose a person"
									searchLabel="Search people"
									invalid={Boolean(shown.named)}
								/>
							</Field>
						) : (
							<Field label={copy.named} hint={copy.namedHint} error={shown.named}>
								<Input
									value={draft.named}
									onChange={(event) => edit({ named: event.target.value })}
									invalid={Boolean(shown.named)}
								/>
							</Field>
						)}
						<Field label={copy.note} hint={copy.noteHint} error={shown.note} optional>
							{worship ? (
								<Textarea
									value={draft.note}
									rows={2}
									onChange={(event) => edit({ note: event.target.value })}
									invalid={Boolean(shown.note)}
								/>
							) : (
								<Input
									value={draft.note}
									onChange={(event) => edit({ note: event.target.value })}
									invalid={Boolean(shown.note)}
								/>
							)}
						</Field>
						<Field label="True as of" error={shown.asOf}>
							<Input
								type="date"
								value={draft.asOf}
								max={view.today}
								onChange={(event) => edit({ asOf: event.target.value })}
								invalid={Boolean(shown.asOf)}
							/>
						</Field>
						{correcting && what === "none" ? (
							<p className="text-sm text-text-3">This is what it says now. Change a value or the date to correct it.</p>
						) : null}
					</DialogBody>
					<DialogFooter>
						<Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" variant="primary" loading={busy} disabled={nobody || what === "none"}>
							{correcting ? "Save correction" : "Save"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
