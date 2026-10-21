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
import { startTransition, useOptimistic, useState, useTransition } from "react";
import { runSave, STAGE_LABEL, type Outcome } from "../model.ts";
import { fresh, isConflict, LocalDay } from "../parts.tsx";
import {
	changeCommitment,
	correctCommitment,
	loadCommitments,
	recordCommitment,
	uploadDocument,
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
} from "./model.ts";
import { codeOf, recorder, sendTwice, ShowEarlier, useHistory } from "./parts.tsx";
import type { PlantPerson, RecordProps } from "./RecordsSection.tsx";

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
}: RecordProps<Commitments> & { documentsEnabled: boolean }) {
	const toast = useToast();
	const history = useHistory(initial, (page) => loadCommitments(personId, page));
	const [current, setCurrent] = useState<CommitmentStatus | null>(initial?.current ?? null);
	const [firstOn, setFirstOn] = useState<FirstAcquisition>(initial?.firstAcquisition ?? { status: "unknown" });
	const [names, setNames] = useState<Record<string, string>>(initial?.witnessNames ?? {});
	const [view, expect] = useOptimistic({ items: history.items, current }, (v, e: Expected) =>
		"card" in e ? { ...v, items: withRecord(v.items, e.card) } : { ...v, current: e.current },
	);
	const [, start] = useTransition();
	const [editing, setEditing] = useState<Editing | null>(null);
	const first = firstName(personName);
	const moves = advancedStage(stage, "core_group") !== stage;
	const state = view.current?.state ?? "unknown";
	const reopen = (e: Editing, r: Outcome<unknown> | null) => {
		const code = r?.status === "refused" && r.code === "invalid_input" ? "future_date" : codeOf(r);
		startTransition(() => setEditing({ ...e, problem: code } as Editing));
		if (isConflict(r)) onConflict();
	};
	/** The person as the write left them: its revision and, for a card, the stage it advanced to. */
	const personAfter = (revision: string, stageNow = store.get().saved.stage): PlantPerson =>
		({ ...store.get().saved, stage: stageNow, revision }) as PlantPerson;

	function record(draft: CommitmentDraft) {
		setEditing(null);
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
			// The document is stored first, once per chosen file; a retried save sends the same upload.
			let upload = draft.file && draft.upload?.file === draft.file ? draft.upload : null;
			if (draft.file && !upload) {
				const form = new FormData();
				form.set("personId", personId);
				form.set("file", draft.file);
				const stored = await uploadDocument(form).catch((): Outcome<{ uploadId: string }> => ({ status: "lost" }));
				if (stored.status !== "ok") {
					const code =
						stored.status === "lost"
							? "upload_lost"
							: stored.code === "storage_unavailable"
								? "storage_unavailable"
								: "upload_failed";
					return startTransition(() => setEditing({ form: "record", draft, problem: code }));
				}
				upload = { file: draft.file, uploadId: stored.value.uploadId };
			}
			const kept = { ...draft, upload };
			const input = {
				personId,
				kind: draft.kind,
				occurredOn: draft.occurredOn,
				witness,
				notes: draft.notes.trim() || null,
				documentUploadId: upload?.uploadId ?? null,
			};
			const r = await runSave(store, "commitment", input, (key) => sendTwice(() => recordCommitment(key, input)), {
				fresh,
				toPerson: (v: CommitmentSaved) => personAfter(v.person.revision, v.person.stage),
			});
			if (r?.status !== "ok") {
				// A refused save never attached the upload; a new try stores the file again in case it expired.
				return reopen({ form: "record", draft: r?.status === "lost" ? kept : { ...kept, upload: null } }, r);
			}
			const { commitment, current: now2, person } = r.value;
			startTransition(() => {
				history.add(commitment);
				setCurrent(now2);
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
		});
	}

	function lifecycle(change: "withdraw" | "reactivate", draft: LifecycleDraft) {
		if (!current) return;
		setEditing(null);
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
			const r = await runSave(
				store,
				change,
				{ input, revision },
				(key) => sendTwice(() => changeCommitment(change, key, revision, input)),
				{ fresh, toPerson: (v) => personAfter(v.current.personRevision) },
			);
			if (r?.status !== "ok") return reopen({ form: change, draft }, r);
			startTransition(() => setCurrent(r.value.current));
			onSaved(r.value.receipt, {
				kind: "activity",
				action: change === "withdraw" ? "commitment_withdrawn" : "commitment_reactivated",
			});
			toast({
				tone: "success",
				message:
					change === "withdraw" ? `${first}'s commitment is withdrawn.` : `${first}'s commitment is active again.`,
			});
		});
	}

	function correct(card: Commitment, draft: CorrectionDraft) {
		setEditing(null);
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
			const input = { commitmentId: card.id, correction, reason: draft.reason };
			const r = await runSave(
				store,
				`correct:${card.id}`,
				{ input, revision: card.revision },
				(key) => sendTwice(() => correctCommitment(key, card.revision, personId, input)),
				{ fresh, toPerson: (v) => personAfter(v.commitments.current.personRevision) },
			);
			if (r?.status !== "ok") return reopen({ form: "correct", card, draft }, r);
			const page = r.value.commitments;
			startTransition(() => {
				history.setPage({ items: page.items, next: page.next, total: page.total });
				setCurrent(page.current);
				setFirstOn(page.firstAcquisition);
				setNames(page.witnessNames);
			});
			onSaved(r.value.receipt, { kind: "activity", action: "commitment_corrected", recordId: card.id });
			toast({ tone: "success", message: voiding ? "The card is voided." : "The card is corrected." });
		});
	}

	const badge = STATE_BADGE[state];
	return (
		<Card className="min-w-0">
			<CardHeader className="mb-3">
				<CardHeading>
					<CardTitle size="sm">Commitment</CardTitle>
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
				{initial !== null && view.items.length > 0 ? (
					<StatusBadge status={badge.status} size="sm" className="mt-0.5">
						{badge.label}
					</StatusBadge>
				) : null}
				{canEdit && initial !== null ? (
					<div className="flex items-center gap-1.5">
						{history.items.length > 0 ? (
							<IconButton
								icon={Add01Icon}
								label={`Record a commitment card for ${first}`}
								size="sm"
								onClick={() => setEditing({ form: "record", draft: blankCommitment() })}
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
											onSelect={() => setEditing({ form: "withdraw", draft: { effectiveOn: today(), reason: "" } })}
										>
											Withdraw commitment
										</MenuItem>
									) : (
										<MenuItem
											icon={UserCheck01Icon}
											onSelect={() => setEditing({ form: "reactivate", draft: { effectiveOn: today(), reason: "" } })}
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
								Record the commitment card {first} signed.
								{moves ? ` Saving it moves ${first} to Core group.` : ""}
							</p>
							{canEdit ? (
								<Button
									size="sm"
									variant="secondary"
									icon={SignatureIcon}
									onClick={() => setEditing({ form: "record", draft: blankCommitment() })}
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
										onCorrect={(action) =>
											setEditing({
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
					draft={editing.draft}
					problem={editing.problem}
					personId={personId}
					personName={first}
					moves={moves}
					documentsEnabled={documentsEnabled}
					onClose={() => setEditing(null)}
					onSubmit={record}
				/>
			) : editing?.form === "withdraw" || editing?.form === "reactivate" ? (
				<LifecycleDialog
					change={editing.form}
					draft={editing.draft}
					problem={editing.problem}
					personName={first}
					since={current?.effectiveOn ?? null}
					onClose={() => setEditing(null)}
					onSubmit={(d) => lifecycle(editing.form as "withdraw" | "reactivate", d)}
				/>
			) : editing?.form === "correct" ? (
				<CorrectionDialog
					card={editing.card}
					draft={editing.draft}
					problem={editing.problem}
					onClose={() => setEditing(null)}
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
	onCorrect,
}: {
	card: Commitment;
	personId: string;
	witnessName: string | undefined;
	by: string;
	canEdit: boolean;
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
						target="_blank"
						rel="noopener noreferrer"
						className="mt-2 inline-flex min-h-6 items-center gap-1.5 rounded-xs text-sm font-medium text-ink underline underline-offset-[3px]"
					>
						<Icon icon={File02Icon} size={16} />
						Open signed card
						<span className="font-normal text-text-3">
							({fileKind(card.document.mediaType)}, {fileSize(card.document.byteCount)})
						</span>
						<span className="sr-only">, opens in a new tab</span>
					</a>
				) : card.document.status === "attached" ? (
					<p className="mt-2 text-sm text-text-3">Uploading the signed card…</p>
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
