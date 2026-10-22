"use client";

import {
	Add01Icon,
	Delete02Icon,
	Edit02Icon,
	File02Icon,
	MoreHorizontalIcon,
	SignatureIcon,
	UserCheck01Icon,
	UserRemove01Icon,
} from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	IconButton,
	IntentLink,
	Menu,
	MenuContent,
	MenuItem,
	MenuSeparator,
	MenuTrigger,
	useToast,
} from "@everyfield/ui/controls";
import { KeyValue, KeyValueList, StatusBadge } from "@everyfield/ui/display";
import { cn, Icon } from "@everyfield/ui/foundations";
import { startTransition, useOptimistic, useRef, useState, useTransition } from "react";
import { newerRevision, runSave, STAGE_LABEL, type KeyedPayload, type Outcome } from "../model.ts";
import { fresh, isConflict, LocalDay, useStore } from "../parts.tsx";
import {
	changeCommitment,
	correctCommitment,
	loadCommitments,
	recordCommitment,
	type CommitmentSaved,
} from "./actions.ts";
import {
	blankCommitment,
	CorrectionDialog,
	fileKind,
	fileSize,
	LifecycleDialog,
	RecordCommitmentDialog,
	type CommitmentDraft,
	type CorrectionDraft,
	type LifecycleDraft,
} from "./CommitmentDialogs.tsx";
import {
	advancedStage,
	firstName,
	KIND_LABEL,
	today,
	withCard,
	withRecord,
	type Commitment,
	type Commitments,
	type CommitmentStatus,
	type FirstAcquisition,
	sendTwice,
	stillUnknown,
	waitOf,
} from "./model.ts";
import { codeOf, recorder, SaveNotice, ShowEarlier, useHistory, useRecordForm } from "./parts.tsx";
import type { PlantPerson, RecordProps } from "./RecordsSection.tsx";
import { newUpload, reusable, saveWithDocument, type DocumentUpload } from "./upload.ts";

type Editing =
	| { form: "record"; draft: CommitmentDraft; problem?: string }
	| { form: "withdraw" | "reactivate"; draft: LifecycleDraft; problem?: string }
	| { form: "correct"; card: Commitment; draft: CorrectionDraft; problem?: string };
/** What the card shows while a save runs: a new card, a state change or a corrected card. */
type Expected = { card: Commitment } | { current: CommitmentStatus };

const STATE_BADGE = {
	active: { status: "positive", label: "Committed" },
	withdrawn: { status: "attention", label: "Withdrawn" },
	unknown: { status: "unknown", label: "Not recorded" },
} as const;

/**
 * The commitment (REQ-PPL-014, 020, 026): the current state, the first commitment date and every signed card with its
 * witness and private document. Recording a card moves an earlier stage to Core group in the same save. A withdrawal or
 * reactivation changes only the current state; a correction or void keeps the old values in the history. Each change
 * shows at once while it saves; a refusal takes it back and opens the form again with the values and the reason.
 */
export function CommitmentCard({
	personId,
	personName,
	stage,
	store,
	expectPerson,
	initial,
	canEdit,
	accountId,
	onSaved,
	onConflict,
	documentsEnabled,
	corrected,
}: RecordProps<Commitments> & { documentsEnabled: boolean }) {
	const toast = useToast();
	const history = useHistory(
		initial,
		(page) => loadCommitments(personId, page),
		corrected?.flatMap((c) => (c.type === "commitment" ? [c.record] : [])),
	);
	const [current, setCurrent] = useState<CommitmentStatus | null>(initial?.current ?? null);
	/** Takes a commitment state from an answer only when it is newer: a late or replayed answer never undoes a later one. */
	const setLatest = (next: CommitmentStatus) =>
		setCurrent((now) => (now && newerRevision(now.personRevision, next.personRevision) ? now : next));
	const [firstOn, setFirstOn] = useState<FirstAcquisition>(initial?.firstAcquisition ?? { status: "unknown" });
	const [names, setNames] = useState<Record<string, string>>(initial?.witnessNames ?? {});
	const [view, expect] = useOptimistic({ items: history.items, current }, (v, e: Expected) =>
		"card" in e ? { ...v, items: withRecord(v.items, e.card) } : { ...v, current: e.current },
	);
	const [, start] = useTransition();
	const dialog = useRecordForm<Editing>();
	/** How much of the pending card's document the bucket has received, 0 to 1, or null when no bytes are moving. */
	const [progress, setProgress] = useState<number | null>(null);
	/** Uploads a refused save left pending, by file: a corrected form with the same file does not send it again. */
	const uploads = useRef(new WeakMap<File, DocumentUpload>());
	/** Another change to this person is saving; Check again waits for it, so it never reads as refused. */
	const saving = useStore(store).pending !== null;
	const wait = waitOf(saving, dialog.notice);
	const editing = dialog.editing;
	const first = firstName(personName);
	const moves = advancedStage(stage, "core_group") !== stage;
	const state = view.current?.state ?? "unknown";
	/** A save that did not save: its form opens again with the reason, or the card says why (model.ts formRefused). */
	const refused = (token: number, e: Editing, r: Outcome<unknown> | null, id: string, what: string) => {
		const code = r?.status === "refused" && r.code === "invalid_input" ? invalidInput(e) : codeOf(r);
		startTransition(() => dialog.refused(token, { ...e, problem: code } as Editing, id, what));
		if (isConflict(r)) onConflict();
	};
	/**
	 * The save answers invalid_input for a date after the church's today and for a file it cannot read. A card signed
	 * before yesterday cannot be in the future anywhere, so with a file that answer means the file.
	 */
	const invalidInput = (e: Editing) =>
		e.form !== "record" || !e.draft.file
			? "future_date"
			: e.draft.occurredOn < today(new Date(Date.now() - 86_400_000))
				? "upload_unreadable"
				: "date_or_file";
	/** The person as the write left them: its revision and, for a card, the stage it advanced to. */
	const personAfter = (revision: string, stageNow = store.get().saved.stage): PlantPerson =>
		({ ...store.get().saved, stage: stageNow, revision }) as PlantPerson;

	function record(draft: CommitmentDraft) {
		const { token, key } = dialog.send();
		start(async () => {
			const now = new Date().toISOString();
			const witness =
				draft.witness.kind === "person"
					? { personId: draft.witness.id }
					: draft.witness.kind === "external"
						? { external: draft.witness.text.trim() }
						: null;
			expect({
				card: {
					id: `new:${now}`,
					personId,
					occurredOn: draft.occurredOn,
					recordedAt: now,
					actor: { kind: "current_account", accountId },
					revision: "0",
					kind: draft.kind,
					witness:
						draft.witness.kind === "person"
							? { kind: "person", personId: draft.witness.id }
							: draft.witness.kind === "external"
								? { kind: "external", text: draft.witness.text.trim() }
								: null,
					notes: draft.notes.trim() || null,
					document: draft.file
						? { status: "attached", mediaType: draft.file.type as "application/pdf", byteCount: draft.file.size }
						: { status: "none" },
					voidedAt: null,
				} as Commitment,
			});
			expectPerson({ stage: advancedStage(stage, "core_group") });
			const base = {
				personId,
				kind: draft.kind,
				occurredOn: draft.occurredOn,
				witness,
				notes: draft.notes.trim() || null,
			};
			const file = draft.file;
			const known = file ? uploads.current.get(file) : undefined;
			await commitCard(base, file ? (reusable(known) ? known : newUpload(file)) : null, key, token, draft);
		});
	}

	/**
	 * One card save of one intent: its first send, or Check again with the same request and key (token -1). The document
	 * moves inside the save, so the card counts as saving from the first byte (C68). Check again keeps the intent's
	 * upload, so it never signs or sends the file again before the save has checked it (upload.ts). A refused save keeps
	 * the upload pending for a corrected form with the same file; a saved card takes it.
	 */
	async function commitCard(
		base: { personId: string } & Record<string, unknown>,
		upload: DocumentUpload | null,
		key: KeyedPayload,
		token: number,
		draft: CommitmentDraft,
	) {
		const send = (k: string): Promise<Outcome<CommitmentSaved>> =>
			upload
				? saveWithDocument(k, base, upload, setProgress)
				: sendTwice(() => recordCommitment(k, { ...base, documentUploadId: null }));
		const r = await runSave(store, "commitment", base, send, {
			fresh,
			key,
			toPerson: (v: CommitmentSaved) => personAfter(v.person.revision, v.person.stage),
		});
		const what = "Your commitment card";
		if (stillUnknown(r, token))
			return dialog.unknown(key.key, what, () => start(() => commitCard(base, upload, key, -1, draft)));
		if (upload) {
			if (r?.status === "ok") uploads.current.delete(upload.file);
			else uploads.current.set(upload.file, upload);
		}
		if (r?.status !== "ok") return refused(token, { form: "record", draft }, r, key.key, what);
		dialog.settled(key.key);
		const { commitment, current: now, person } = r.value;
		startTransition(() => {
			history.add(commitment);
			setLatest(now);
			setFirstOn((f) => withCard(f, commitment));
			if (draft.witness.kind === "person") {
				const w = draft.witness;
				setNames((n) => ({ ...n, [w.id]: w.name }));
			}
		});
		onSaved(r.value.receipt, {
			kind: "activity",
			action: "commitment_recorded",
			recordId: commitment.id,
			...(person.stageChange ? { stage: person.stageChange } : {}),
		});
		toast({
			tone: "success",
			message: person.stageChange
				? `Commitment saved. ${first} is now ${STAGE_LABEL[person.stageChange.to].toLowerCase()}.`
				: `Commitment saved for ${first}.`,
		});
	}

	function lifecycle(change: "withdraw" | "reactivate", draft: LifecycleDraft) {
		if (!current) return;
		const { token, key } = dialog.send();
		start(async () => {
			expect({
				current: {
					...current,
					state: change === "withdraw" ? "withdrawn" : "active",
					effectiveOn: draft.effectiveOn as CommitmentStatus["effectiveOn"],
				},
			});
			const revision = store.get().saved.revision;
			const input = { personId, effectiveOn: draft.effectiveOn, reason: draft.reason || null };
			await commitLifecycle(change, input, revision, key, token, draft);
		});
	}

	/** One withdrawal or reactivation: its first send, or Check again with the same request and key (token -1). */
	async function commitLifecycle(
		change: "withdraw" | "reactivate",
		input: { personId: string; effectiveOn: string; reason: string | null },
		revision: string,
		key: KeyedPayload,
		token: number,
		draft: LifecycleDraft,
	) {
		const r = await runSave(
			store,
			change,
			{ input, revision },
			(k) => sendTwice(() => changeCommitment(change, k, revision, input)),
			{ fresh, key, toPerson: (v) => personAfter(v.current.personRevision) },
		);
		const what = change === "withdraw" ? "Your withdrawal" : "Your reactivation";
		if (stillUnknown(r, token))
			return dialog.unknown(key.key, what, () => start(() => commitLifecycle(change, input, revision, key, -1, draft)));
		if (r?.status !== "ok") return refused(token, { form: change, draft }, r, key.key, what);
		dialog.settled(key.key);
		startTransition(() => setLatest(r.value.current));
		onSaved(r.value.receipt, {
			kind: "activity",
			action: change === "withdraw" ? "commitment_withdrawn" : "commitment_reactivated",
		});
		toast({
			tone: "success",
			// A checked-again save may land after a later change moved the state on, so it names the change only.
			message:
				token === -1
					? `${what} is saved.`
					: change === "withdraw"
						? `${first}'s commitment is withdrawn.`
						: `${first}'s commitment is active again.`,
		});
	}

	function correct(card: Commitment, draft: CorrectionDraft) {
		const { token, key } = dialog.send();
		start(async () => {
			const voiding = draft.action === "void";
			expect({
				card: (voiding
					? { ...card, voidedAt: new Date().toISOString() }
					: { ...card, occurredOn: draft.occurredOn, kind: draft.kind }) as Commitment,
			});
			const correction = voiding
				? { action: "void" as const }
				: {
						action: "correct" as const,
						...(draft.occurredOn !== card.occurredOn ? { occurredOn: draft.occurredOn } : {}),
						...(draft.kind !== card.kind ? { kind: draft.kind } : {}),
					};
			await commitCorrection(card, { commitmentId: card.id, correction, reason: draft.reason }, key, token, draft);
		});
	}

	/** One correction or void: its first send, or Check again with the same request and key (token -1). */
	async function commitCorrection(
		card: Commitment,
		input: { commitmentId: string; correction: unknown; reason: string },
		key: KeyedPayload,
		token: number,
		draft: CorrectionDraft,
	) {
		const r = await runSave(
			store,
			`correct:${card.id}`,
			{ input, revision: card.revision },
			(k) => sendTwice(() => correctCommitment(k, card.revision, personId, input)),
			{ fresh, key, toPerson: (v) => personAfter(v.commitments.current.personRevision) },
		);
		const what = draft.action === "void" ? "Your void of the card" : "Your card correction";
		if (stillUnknown(r, token))
			return dialog.unknown(key.key, what, () => start(() => commitCorrection(card, input, key, -1, draft)));
		if (r?.status !== "ok") return refused(token, { form: "correct", card, draft }, r, key.key, what);
		dialog.settled(key.key);
		const page = r.value.commitments;
		startTransition(() => {
			history.setPage({ items: page.items, next: page.next, total: page.total });
			setLatest(page.current);
			setFirstOn(page.firstAcquisition);
			setNames(page.witnessNames);
		});
		onSaved(r.value.receipt, { kind: "activity", action: "commitment_corrected", recordId: card.id });
		toast({ tone: "success", message: draft.action === "void" ? "The card is voided." : "The card is corrected." });
	}

	const badge = STATE_BADGE[state];
	return (
		<Card className="min-w-0">
			<CardHeader className="mb-3">
				<CardHeading>
					<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
						<CardTitle size="sm">Commitment</CardTitle>
						{initial !== null && view.items.length > 0 ? (
							<StatusBadge status={badge.status} size="sm">
								{badge.label}
							</StatusBadge>
						) : null}
					</div>
					<CardDescription className="text-sm">
						{initial === null ? (
							"Did not load"
						) : state === "unknown" ? (
							view.items.length > 0 ? (
								"No valid card on file"
							) : (
								"No signed card yet"
							)
						) : view.current?.effectiveOn ? (
							<>
								{state === "active" ? "Committed since" : "Withdrawn on"} <LocalDay day={view.current.effectiveOn} />
							</>
						) : (
							badge.label
						)}
					</CardDescription>
				</CardHeading>
				{canEdit && initial !== null ? (
					<div className="flex items-center gap-1.5">
						{view.items.length > 0 ? (
							<IconButton
								icon={Add01Icon}
								label={`Record a commitment card for ${first}`}
								size="sm"
								onClick={() => dialog.open({ form: "record", draft: blankCommitment() })}
							/>
						) : null}
						{current && current.state !== "unknown" ? (
							<Menu>
								<MenuTrigger asChild>
									<IconButton icon={MoreHorizontalIcon} label="Commitment actions" size="sm" />
								</MenuTrigger>
								<MenuContent align="end">
									{current.state === "active" ? (
										<MenuItem
											icon={UserRemove01Icon}
											danger
											onSelect={() => dialog.open({ form: "withdraw", draft: { effectiveOn: today(), reason: "" } })}
										>
											Withdraw commitment
										</MenuItem>
									) : (
										<MenuItem
											icon={UserCheck01Icon}
											onSelect={() => dialog.open({ form: "reactivate", draft: { effectiveOn: today(), reason: "" } })}
										>
											Reactivate commitment
										</MenuItem>
									)}
								</MenuContent>
							</Menu>
						) : null}
					</div>
				) : null}
			</CardHeader>
			<SaveNotice notice={dialog.notice} busy={saving} onDismiss={dialog.dismiss} />

			{initial === null ? (
				<p className="text-sm text-text-3">Commitments did not load. Reload the page to see them.</p>
			) : (
				<>
					{view.items.length > 0 ? (
						<KeyValueList>
							<KeyValue
								size="sm"
								k="First commitment"
								value={
									firstOn.status === "known" ? (
										<LocalDay day={firstOn.occurredOn} />
									) : firstOn.status === "none" ? null : (
										"Unknown"
									)
								}
							/>
						</KeyValueList>
					) : null}
					{view.items.length === 0 ? (
						<div className="flex flex-col items-start gap-3">
							<p className="text-sm text-text-2">
								{canEdit
									? `Record the commitment card ${first} signed.${moves ? ` Saving it moves ${first} to Core group.` : ""}`
									: `No commitment card is recorded for ${first}.`}
							</p>
							{canEdit ? (
								<Button
									size="sm"
									variant="secondary"
									icon={SignatureIcon}
									onClick={() => dialog.open({ form: "record", draft: blankCommitment() })}
								>
									Record commitment
								</Button>
							) : null}
						</div>
					) : (
						<>
							<h3 className="mt-4 mb-1 font-sans text-xs font-medium tracking-normal text-text-3">Signed cards</h3>
							<ul className="flex flex-col">
								{view.items.map((card) => (
									<CardRow
										key={card.id}
										card={card}
										personId={personId}
										witnessName={card.witness?.kind === "person" ? names[card.witness.personId] : undefined}
										by={recorder(card.actor, accountId)}
										canEdit={canEdit}
										progress={progress}
										onCorrect={(action) =>
											dialog.open({
												form: "correct",
												card,
												draft: { action, occurredOn: card.occurredOn, kind: card.kind, reason: "" },
											})
										}
									/>
								))}
							</ul>
							{history.next !== null ? (
								<ShowEarlier loading={history.loading} failed={history.failed} onClick={() => void history.more()} />
							) : null}
						</>
					)}
				</>
			)}
			<p className="mt-4 text-xs text-text-3">A stage alone never counts as a commitment. Only a signed card does.</p>

			{editing?.form === "record" ? (
				<RecordCommitmentDialog
					wait={wait}
					draft={editing.draft}
					problem={editing.problem}
					personId={personId}
					personName={first}
					moves={moves}
					documentsEnabled={documentsEnabled}
					onClose={dialog.close}
					onSubmit={record}
				/>
			) : editing?.form === "withdraw" || editing?.form === "reactivate" ? (
				<LifecycleDialog
					wait={wait}
					change={editing.form}
					draft={editing.draft}
					problem={editing.problem}
					personName={first}
					since={current?.effectiveOn ?? null}
					onClose={dialog.close}
					onSubmit={(d) => lifecycle(editing.form as "withdraw" | "reactivate", d)}
				/>
			) : editing?.form === "correct" ? (
				<CorrectionDialog
					wait={wait}
					card={editing.card}
					draft={editing.draft}
					problem={editing.problem}
					onClose={dialog.close}
					onSubmit={(d) => correct(editing.card, d)}
				/>
			) : null}
		</Card>
	);
}

function CardRow({
	card,
	personId,
	witnessName,
	by,
	canEdit,
	progress,
	onCorrect,
}: {
	card: Commitment;
	personId: string;
	witnessName: string | undefined;
	by: string;
	canEdit: boolean;
	/** The pending card's upload, 0 to 1, while its bytes move; null before and after. */
	progress: number | null;
	onCorrect: (action: "correct" | "void") => void;
}) {
	const pending = card.id.startsWith("new:");
	const voided = card.voidedAt !== null;
	return (
		<li
			className={cn("flex items-start gap-3 border-t border-line py-3 first:border-t-0", pending && "opacity-70")}
			aria-busy={pending || undefined}
		>
			<span
				aria-hidden="true"
				className={cn(
					"mt-0.5 grid size-8 flex-none place-items-center rounded-md",
					voided ? "bg-surface-2 text-text-3" : "bg-green-100 text-green-700",
				)}
			>
				<Icon icon={SignatureIcon} size={16} />
			</span>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
					<span className={cn("font-medium text-ink", voided && "text-text-2 line-through")}>
						{KIND_LABEL[card.kind]} card
					</span>
					<span className="text-sm text-text-2">
						signed <LocalDay day={card.occurredOn} />
					</span>
					{voided ? (
						<StatusBadge status="unknown" size="sm">
							Voided
						</StatusBadge>
					) : null}
				</div>
				<p className="mt-0.5 text-sm text-text-3 [overflow-wrap:anywhere]">
					{card.witness?.kind === "person" ? (
						<>
							Witness:{" "}
							<IntentLink
								href={`/people/${card.witness.personId}`}
								className="text-ink-2 underline underline-offset-2 hover:text-ink"
							>
								{witnessName ?? "a person in your church"}
							</IntentLink>
							{" · "}
						</>
					) : card.witness?.kind === "external" ? (
						<>Witness: {card.witness.text} · </>
					) : null}
					{pending ? "Saving…" : `Recorded by ${by}`}
				</p>
				{card.notes ? (
					<p className="mt-1 line-clamp-3 text-sm whitespace-pre-wrap text-text-2 [overflow-wrap:anywhere]">
						{card.notes}
					</p>
				) : null}
				{card.document.status === "attached" && !pending ? (
					<a
						href={`/people/${personId}/commitments/${card.id}/document`}
						rel="noreferrer"
						className="mt-2 inline-flex min-h-6 flex-wrap items-center gap-x-1.5 rounded-xs text-sm font-medium text-ink underline underline-offset-[3px]"
					>
						<Icon icon={File02Icon} size={16} />
						<span className="whitespace-nowrap">Download signed card</span>
						<span className="font-normal whitespace-nowrap text-text-3">
							({fileKind(card.document.mediaType)}, {fileSize(card.document.byteCount)})
						</span>
					</a>
				) : card.document.status === "attached" ? (
					<div className="mt-2 flex flex-col gap-1.5 text-sm text-text-3">
						{progress === null ? (
							<span>Saving the signed card…</span>
						) : (
							<>
								<span className="tabular-nums">Uploading the signed card… {Math.round(progress * 100)}%</span>
								<progress
									value={progress}
									max={1}
									aria-label="Uploading the signed card"
									className="h-1.5 w-full max-w-48 appearance-none overflow-hidden rounded-full bg-line [&::-moz-progress-bar]:bg-ink [&::-webkit-progress-bar]:bg-line [&::-webkit-progress-value]:bg-ink"
								/>
							</>
						)}
					</div>
				) : null}
			</div>
			{canEdit && !pending && !voided ? (
				<Menu>
					<MenuTrigger asChild>
						<IconButton
							icon={MoreHorizontalIcon}
							label={`Actions for the ${KIND_LABEL[card.kind].toLowerCase()} card`}
							size="sm"
						/>
					</MenuTrigger>
					<MenuContent align="end">
						<MenuItem icon={Edit02Icon} onSelect={() => onCorrect("correct")}>
							Correct date or card
						</MenuItem>
						<MenuSeparator />
						<MenuItem icon={Delete02Icon} danger onSelect={() => onCorrect("void")}>
							Void card
						</MenuItem>
					</MenuContent>
				</Menu>
			) : null}
		</li>
	);
}
