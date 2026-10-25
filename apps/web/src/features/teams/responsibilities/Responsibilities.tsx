"use client";

import { Add01Icon, CheckListIcon, Delete02Icon, Edit02Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	Checkbox,
	ConfirmDialog,
	EmptyState,
	Field,
	IconButton,
	Spinner,
	StatePanel,
	Textarea,
	useToast,
} from "@everyfield/ui/controls";
import type * as c from "@everyfield/contracts/teams/responsibilities";
import { useEffect, useId, useOptimistic, useRef, useState, useTransition } from "react";
import type { z } from "zod";
import { RecordDialog, RowNotices, SaveNotice, useRowLanes, useSaveIntent } from "../../../components/save/parts.tsx";
import { reloadTeam } from "../actions.ts";
import { asRecordId, asRevision, dayText, problemText } from "../model.ts";
import {
	addResponsibility,
	completeResponsibility,
	deleteResponsibility,
	editResponsibility,
	listResponsibilities,
	offerResponsibilities,
	previewResponsibilities,
} from "./actions.ts";

// One ministry's responsibilities (REQ-TEAM-007). The playbook lines are an offer: a read shows them and writes
// nothing, and only an Owner or Admin accepts or declines. Lines left out or declined do not come back. A check
// records the church's day and does not move a phase. Each change draws at once, then settles from the write's answer.

type Page = z.infer<typeof c.responsibilityPage>;
type Item = Page["items"][number];
type OfferState = Page["offer"];
type Line = z.infer<typeof c.previewPage>["lines"][number];
type Row = Omit<Item, "completedOn"> & { completedOn: Item["completedOn"] | "pending"; pending?: boolean };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TEXT_MAX = 2000;
const short = (text: string) => (text.length > 80 ? `${text.slice(0, 79)}…` : text);

type RowChange =
	| { kind: "tick"; id: string; done: boolean }
	| { kind: "text"; id: string; text: string }
	| { kind: "remove"; id: string }
	| { kind: "add"; row: Row };

function applyRows(items: Row[], change: RowChange): Row[] {
	switch (change.kind) {
		case "tick":
			return items.map((row) =>
				row.id === change.id ? { ...row, completedOn: change.done ? (row.completedOn ?? "pending") : null } : row,
			);
		case "text":
			return items.map((row) => (row.id === change.id ? { ...row, text: change.text } : row));
		case "remove":
			return items.filter((row) => row.id !== change.id);
		case "add":
			return [...items, change.row];
	}
}

function byOrder(a: Row, b: Row) {
	return a.sortOrder - b.sortOrder || a.id.localeCompare(b.id);
}

/** The accepted lines, paired with the ids the write created. A mismatch draws nothing and the list is read again. */
function acceptedRows(
	lines: readonly Line[],
	createdIds: readonly string[],
	selected: ReadonlySet<string>,
): Row[] | null {
	if (lines.length !== createdIds.length) return null;
	return lines.flatMap((line, index) =>
		selected.has(line.key)
			? [
					{
						id: asRecordId(createdIds[index]!),
						revision: asRevision("1"),
						sourceLine: line.key,
						text: line.text,
						sortOrder: line.sortOrder,
						completedOn: null,
					},
				]
			: [],
	);
}

type TextForm = { mode: "add" | "edit"; text: string; id?: string; revision?: string; problem?: string };

export function ResponsibilitiesPanel({
	teamId,
	teamRevision,
	archived,
	canChange,
	canOffer,
	onTeamRevision,
}: {
	teamId: string;
	teamRevision: string;
	archived: boolean;
	canChange: boolean;
	canOffer: boolean;
	onTeamRevision: (revision: string) => void;
}) {
	const toast = useToast();
	const [, startTransition] = useTransition();
	const lane = useSaveIntent<TextForm>({ explain: problemText });
	const ticks = useRowLanes(problemText);
	const [seenTeam, setSeenTeam] = useState(teamId);
	const [seenRevision, setSeenRevision] = useState(teamRevision);
	const [revision, setRevision] = useState(teamRevision);
	const [page, setPage] = useState(1);
	const [reloadToken, setReloadToken] = useState(0);
	const [items, setItems] = useState<Row[] | null>(null);
	const [offer, setOffer] = useState<OfferState | undefined>(undefined);
	const [listPhase, setListPhase] = useState<"loading" | "ready" | "lost" | "refused">("loading");
	const [shown, project] = useOptimistic(items ?? [], applyRows);
	const rows = items === null ? null : shown;
	const [preview, setPreview] = useState<
		| { status: "loading" }
		| { status: "lost" }
		| { status: "ok"; lines: Line[]; templateVersion: string; reviewDigest: string }
	>({ status: "loading" });
	const [picked, setPicked] = useState<string[]>([]);
	const [pickError, setPickError] = useState(false);
	const [declineOpen, setDeclineOpen] = useState(false);
	const [drop, setDrop] = useState<Row | null>(null);
	const firstPick = useRef<HTMLButtonElement>(null);
	const pickErrorId = useId();
	if (seenTeam !== teamId) {
		setSeenTeam(teamId);
		setPage(1);
		setItems(null);
		setOffer(undefined);
		setListPhase("loading");
		setPreview({ status: "loading" });
		setPicked([]);
	}
	if (seenRevision !== teamRevision) {
		setSeenRevision(teamRevision);
		setRevision(teamRevision);
	}

	useEffect(() => {
		let live = true;
		listResponsibilities(teamId, page).then(
			(result) => {
				if (!live) return;
				if (result.status !== "ok") {
					setListPhase(result.status === "lost" ? "lost" : "refused");
					return;
				}
				if (result.value.items.length === 0 && page > 1) {
					setPage(page - 1);
					return;
				}
				setItems(result.value.items);
				setOffer(result.value.offer);
				setListPhase("ready");
			},
			() => live && setListPhase("lost"),
		);
		return () => {
			live = false;
		};
	}, [teamId, page, reloadToken]);

	useEffect(() => {
		if (!canOffer) return;
		let live = true;
		previewResponsibilities(teamId).then(
			(result) => {
				if (!live) return;
				if (result.status !== "ok") {
					setPreview({ status: "lost" });
					return;
				}
				setPreview({
					status: "ok",
					lines: result.value.lines,
					templateVersion: result.value.templateVersion,
					reviewDigest: result.value.reviewDigest,
				});
				setPicked((current) => current.filter((key) => result.value.lines.some((line) => line.key === key)));
			},
			() => live && setPreview({ status: "lost" }),
		);
		return () => {
			live = false;
		};
	}, [teamId, canOffer, reloadToken]);

	useEffect(() => {
		if (pickError) firstPick.current?.focus();
	}, [pickError]);

	const conflict = () => {
		setReloadToken((n) => n + 1);
		void reloadTeam(teamId).then((result) => {
			if (result.status === "ok" && result.value) onTeamRevision(result.value.team.revision);
		});
	};

	function rememberRevision(next: string) {
		setRevision(next);
		setSeenRevision(next);
		onTeamRevision(next);
	}

	function saveOffer(decision: "accept" | "decline") {
		if (preview.status !== "ok" || lane.wait) return;
		const selected = decision === "accept" ? picked : [];
		if (decision === "accept" && selected.length === 0) {
			setPickError(true);
			return;
		}
		setPickError(false);
		const lines = preview.lines;
		const templateVersion = preview.templateVersion;
		const reviewDigest = preview.reviewDigest;
		const chosen = new Set(selected);
		startTransition(async () => {
			await lane.save({
				what: decision === "accept" ? "The selected responsibilities" : "The playbook offer",
				done: decision === "accept" ? "added" : "declined",
				send: (key) =>
					offerResponsibilities(key, revision, {
						teamId,
						decision,
						selected,
						expectedVersion: templateVersion,
						reviewDigest,
					}),
				ok: (result) => {
					rememberRevision(result.revision);
					setOffer(result.decision === "accept" ? "accepted" : "declined");
					setPreview((current) => (current.status === "ok" ? { ...current, lines: [] } : current));
					setPicked([]);
					if (result.decision === "accept" && result.outcome === "changed") {
						const added = acceptedRows(lines, result.createdIds, chosen);
						if (added === null) setReloadToken((n) => n + 1);
						else if (page === 1)
							startTransition(() => setItems((current) => [...added, ...(current ?? [])].sort(byOrder).slice(0, 24)));
						else setPage(1);
					}
					toast({
						tone: "success",
						message:
							result.decision === "accept"
								? "The selected responsibilities are on this ministry."
								: "The playbook lines stay off this ministry.",
					});
				},
				refused: (code) => {
					if (code === "conflict" || code === "stale_review" || code === "stale_template_version") conflict();
				},
			});
		});
	}

	function saveText(form: TextForm) {
		const text = form.text.trim();
		if (lane.wait) return;
		if (form.mode === "add") {
			const pending = `pending-${crypto.randomUUID()}`;
			const row: Row = {
				id: asRecordId(pending),
				revision: asRevision("0"),
				sourceLine: "custom:pending",
				text,
				sortOrder: (items ?? []).reduce((max, item) => Math.max(max, item.sortOrder), 0) + 1,
				completedOn: null,
				pending: true,
			};
			startTransition(async () => {
				project({ kind: "add", row });
				await lane.save({
					what: short(text),
					done: "added",
					form,
					send: (key) => addResponsibility(key, revision, teamId, text),
					ok: (result) => {
						startTransition(() =>
							setItems((current) =>
								(current ?? []).concat({
									id: result.id,
									revision: result.revision,
									sourceLine: result.sourceLine,
									text: result.text,
									sortOrder: row.sortOrder,
									completedOn: null,
								}),
							),
						);
						toast({ tone: "success", message: "Responsibility added." });
					},
					refused: (code) => {
						if (code === "conflict") conflict();
					},
				});
			});
			return;
		}
		const id = form.id!;
		startTransition(async () => {
			project({ kind: "text", id, text });
			await lane.save({
				what: short(text),
				done: "saved",
				form,
				send: (key) => editResponsibility(key, form.revision!, id, text),
				ok: (result) => {
					startTransition(() =>
						setItems((current) =>
							(current ?? []).map((row) =>
								row.id === id ? { ...row, text: result.text, revision: result.revision } : row,
							),
						),
					);
				},
				refused: (code) => {
					if (code === "conflict") conflict();
				},
			});
		});
	}

	function remove(row: Row) {
		if (lane.wait || row.pending) return;
		startTransition(async () => {
			project({ kind: "remove", id: row.id });
			await lane.save({
				what: short(row.text),
				done: "deleted",
				send: (key) => deleteResponsibility(key, row.revision, row.id),
				ok: () => {
					startTransition(() => setItems((current) => (current ?? []).filter((item) => item.id !== row.id)));
					toast({ tone: "success", message: "Responsibility deleted." });
				},
				refused: (code) => {
					if (code === "conflict") conflict();
				},
			});
		});
	}

	function tick(row: Row, done: boolean) {
		if (!canChange || row.pending || lane.wait) return;
		startTransition(async () => {
			project({ kind: "tick", id: row.id, done });
			await ticks.save(row.id, {
				what: short(row.text),
				done: done ? "checked" : "cleared",
				send: (key) => completeResponsibility(key, row.revision, row.id, done),
				ok: (result) => {
					startTransition(() =>
						setItems((current) =>
							(current ?? []).map((item) =>
								item.id === row.id ? { ...item, completedOn: result.completedOn, revision: result.revision } : item,
							),
						),
					);
				},
				refused: (code) => {
					if (code === "conflict") conflict();
				},
			});
		});
	}

	const busy = lane.wait !== null;
	const lines = preview.status === "ok" && offer !== "declined" && offer !== undefined ? preview.lines : [];
	const showOffer = canOffer && lines.length > 0;
	const doneCount = (rows ?? []).filter((row) => row.completedOn !== null).length;
	const fullList = page === 1 && (rows?.length ?? 0) < 24;
	const description = [
		fullList && rows?.length ? `${doneCount} of ${rows.length} done` : null,
		"Checking one off does not move a phase.",
		offer === "declined" ? "Playbook lines were declined and stay off." : null,
	]
		.filter(Boolean)
		.join(" ");

	const addButton = canChange ? (
		<Button
			variant="ghost"
			size="sm"
			icon={Add01Icon}
			onClick={() => lane.open({ mode: "add", text: "" })}
			disabled={busy}
		>
			Responsibility
		</Button>
	) : null;

	return (
		<div className="flex flex-col gap-5">
			<SaveNotice {...lane.noticeProps} dialogOpen={lane.editing !== null} />
			<RowNotices lanes={ticks} />
			{showOffer ? (
				<Card as="section" aria-labelledby="offer-title">
					<CardHeader>
						<CardHeading>
							<CardTitle id="offer-title">
								{offer === "accepted" ? "New playbook lines" : "Playbook responsibilities"}
							</CardTitle>
							<CardDescription>
								{offer === "accepted"
									? "The playbook has lines this ministry has not reviewed. Choose the ones to add. Lines you leave out stay off."
									: "Choose the lines to keep. Lines you leave out stay off this ministry, including after a later playbook update."}
							</CardDescription>
						</CardHeading>
					</CardHeader>
					<fieldset aria-invalid={pickError || undefined} aria-describedby={pickError ? pickErrorId : undefined}>
						<legend className="sr-only">Playbook lines</legend>
						<ul className="flex flex-col">
							{lines.map((line, index) => (
								<li key={line.key}>
									<Checkbox
										ref={index === 0 ? firstPick : undefined}
										shape="round"
										label={<span className="wrap-anywhere">{line.text}</span>}
										checked={picked.includes(line.key)}
										disabled={busy}
										onCheckedChange={(next) => {
											setPickError(false);
											setPicked((current) =>
												next === true ? [...current, line.key] : current.filter((key) => key !== line.key),
											);
										}}
									/>
								</li>
							))}
						</ul>
						{pickError ? (
							<p id={pickErrorId} role="alert" className="text-sm text-magenta-600">
								Select at least one line.
							</p>
						) : null}
					</fieldset>
					<div className="mt-2 flex flex-wrap items-center gap-2.5">
						<Button variant="primary" onClick={() => saveOffer("accept")} disabled={busy}>
							Add selected
						</Button>
						{offer === null ? (
							<Button variant="secondary" onClick={() => setDeclineOpen(true)} disabled={busy}>
								Decline playbook lines
							</Button>
						) : null}
					</div>
				</Card>
			) : null}
			{canOffer && preview.status === "lost" ? (
				<StatePanel tone="error" title="Playbook lines did not load" headingLevel="h3">
					Nothing was changed. Open this tab again in a moment.
				</StatePanel>
			) : null}
			<Card as="section" aria-labelledby="responsibilities-title">
				<CardHeader>
					<CardHeading>
						<CardTitle id="responsibilities-title">Responsibilities</CardTitle>
						{rows?.length ? <CardDescription>{description}</CardDescription> : null}
					</CardHeading>
					{addButton}
				</CardHeader>
				{listPhase === "lost" || listPhase === "refused" ? (
					<StatePanel tone="error" title="Responsibilities did not load" headingLevel="h3">
						{listPhase === "lost"
							? "This is a loading problem. Nothing was changed. Open this tab again in a moment."
							: "You cannot see these responsibilities. Your seat may have changed."}
					</StatePanel>
				) : rows === null ? (
					<div className="flex justify-center py-8" role="status">
						<Spinner />
						<span className="sr-only">Loading responsibilities</span>
					</div>
				) : rows.length === 0 ? (
					<EmptyState icon={CheckListIcon} title="No responsibilities yet" headingLevel="h3" action={addButton}>
						{archived
							? "This ministry is archived. Its responsibilities stay as they were."
							: offer === "declined"
								? "The playbook offer was declined. Those lines stay off. You can add your own."
								: canChange
									? "Add a responsibility, or accept playbook lines when they are offered."
									: "When responsibilities are added, they appear here."}
					</EmptyState>
				) : (
					<ul className="flex flex-col">
						{rows.map((row) => (
							<ResponsibilityRow
								key={row.id}
								row={row}
								canChange={canChange}
								busy={busy || ticks.stateOf(row.id) !== undefined}
								onTick={tick}
								onEdit={(item) => lane.open({ mode: "edit", text: item.text, id: item.id, revision: item.revision })}
								onDelete={setDrop}
							/>
						))}
					</ul>
				)}
				{page > 1 || (rows?.length ?? 0) >= 24 ? (
					<div className="mt-4 flex flex-wrap items-center gap-2.5">
						<Button variant="secondary" size="sm" onClick={() => setPage(page - 1)} disabled={page === 1}>
							Previous
						</Button>
						<span className="text-sm text-text-3">Page {page}</span>
						<Button variant="secondary" size="sm" onClick={() => setPage(page + 1)} disabled={(rows?.length ?? 0) < 24}>
							Next
						</Button>
					</div>
				) : null}
			</Card>

			{lane.editing ? (
				<TextDialog
					form={lane.editing}
					problem={lane.problem}
					wait={lane.wait}
					onClose={lane.close}
					onSubmit={saveText}
				/>
			) : null}
			<ConfirmDialog
				open={declineOpen}
				onOpenChange={setDeclineOpen}
				tone="danger"
				title="Decline playbook lines?"
				consequences={[
					"These lines stay off this ministry.",
					"Later playbook updates are not offered.",
					"Responsibilities you add yourself stay.",
				]}
				confirmLabel="Decline playbook lines"
				onConfirm={() => {
					setDeclineOpen(false);
					saveOffer("decline");
				}}
			/>
			<ConfirmDialog
				open={drop !== null}
				onOpenChange={(next) => !next && setDrop(null)}
				tone="danger"
				title="Delete this responsibility?"
				consequences={[
					"It leaves this ministry.",
					"A playbook line deleted here does not come back, including after a later playbook update.",
				]}
				confirmLabel="Delete responsibility"
				onConfirm={() => {
					const row = drop;
					setDrop(null);
					if (row) remove(row);
				}}
			/>
		</div>
	);
}

function doneText(completedOn: string | null): string | undefined {
	if (!completedOn) return undefined;
	return DATE.test(completedOn) ? `Done on ${dayText(completedOn)}` : "Done";
}

function ResponsibilityRow({
	row,
	canChange,
	busy,
	onTick,
	onEdit,
	onDelete,
}: {
	row: Row;
	canChange: boolean;
	busy: boolean;
	onTick: (row: Row, done: boolean) => void;
	onEdit: (row: Row) => void;
	onDelete: (row: Row) => void;
}) {
	const done = row.completedOn !== null;
	return (
		<li className="flex items-start gap-2" aria-busy={row.pending || undefined}>
			<div className="min-w-0 flex-1">
				<Checkbox
					shape="round"
					label={<span className={done ? "wrap-anywhere line-through" : "wrap-anywhere"}>{row.text}</span>}
					description={doneText(row.completedOn)}
					checked={done}
					disabled={!canChange || busy || row.pending}
					onCheckedChange={(next) => {
						if (next === "indeterminate") return;
						onTick(row, next === true);
					}}
				/>
			</div>
			{canChange && !row.pending ? (
				<div className="flex flex-none gap-1 pt-3">
					<IconButton
						icon={Edit02Icon}
						label={`Edit ${row.text}`}
						size="sm"
						disabled={busy}
						onClick={() => onEdit(row)}
					/>
					<IconButton
						icon={Delete02Icon}
						label={`Delete ${row.text}`}
						size="sm"
						disabled={busy}
						onClick={() => onDelete(row)}
					/>
				</div>
			) : null}
		</li>
	);
}

function TextDialog({
	form,
	problem,
	wait,
	onClose,
	onSubmit,
}: {
	form: TextForm;
	problem?: string;
	wait: ReturnType<typeof useSaveIntent>["wait"];
	onClose: () => void;
	onSubmit: (form: TextForm) => void;
}) {
	const [text, setText] = useState(form.text);
	const [shown, setShown] = useState(form);
	const [touched, setTouched] = useState(false);
	if (form !== shown) {
		setShown(form);
		setText(form.text);
		setTouched(false);
	}
	const trimmed = text.trim();
	const error =
		trimmed === "" ? "Enter a responsibility." : trimmed.length > TEXT_MAX ? "Use 2000 characters or fewer." : null;
	return (
		<RecordDialog
			icon={form.mode === "add" ? Add01Icon : Edit02Icon}
			title={form.mode === "add" ? "Add a responsibility" : "Edit responsibility"}
			description={
				form.mode === "add" ? "It stays on this ministry until you delete it." : "The new wording replaces the old one."
			}
			action={form.mode === "add" ? "Add responsibility" : "Save changes"}
			problem={problem}
			wait={wait}
			onClose={onClose}
			onSubmit={() => {
				setTouched(true);
				if (error) return false;
				onSubmit({ ...form, text: trimmed });
				return true;
			}}
		>
			<Field label="Responsibility" error={touched ? error : null}>
				<Textarea value={text} rows={3} maxLength={TEXT_MAX} onChange={(event) => setText(event.target.value)} />
			</Field>
		</RecordDialog>
	);
}
