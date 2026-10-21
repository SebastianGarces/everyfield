"use client";

import { ArrowLeft01Icon, FileEditIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import type * as people from "@everyfield/contracts/people";
import {
	Button,
	CalloutLabel,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Field,
	Input,
	Radio,
	RadioGroup,
	Select,
	Skeleton,
	Textarea,
} from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { z } from "zod";
import type { Receipt } from "../boundary.ts";
import { runSave, type Outcome, type PersonStore } from "../model.ts";
import { fresh, LocalDay, useStore, When } from "../parts.tsx";
import type { PersonDraft } from "../StageDialog.tsx";
import { correctRecord, loadRecords } from "./actions.ts";
import { takeRecords } from "./intent.ts";
import {
	assessmentChanges,
	commitmentChanges,
	correctedFieldLabel,
	correctedValueText,
	CRITERIA,
	CRITERION_LABEL,
	interviewChanges,
	LENS_LABEL,
	LENSES,
	RATING_LABEL,
	RATINGS,
	RESULT_LABEL,
	RESULTS,
	totalOf,
	type AssessmentValues,
	type CommitmentValues,
	type InterviewValues,
	type Rating,
} from "./model.ts";
import { Problem } from "./parts.tsx";
import type { Records } from "./server.ts";

type PlantPerson = z.infer<typeof people.plantPerson>;
type Assessment = z.infer<typeof people.assessment>;
type Interview = z.infer<typeof people.interview>;
type Commitment = z.infer<typeof people.commitment>;
type Correction = z.infer<typeof people.recordCorrection>;
type RecordType = Correction["recordType"];
type Chosen =
	| { type: "assessment"; record: Assessment }
	| { type: "interview"; record: Interview }
	| { type: "commitment"; record: Commitment };

/** The record kind inside a sentence: "the Four Cs assessment". */
const TYPE_NAME: Record<RecordType, string> = {
	assessment: "Four Cs assessment",
	interview: "interview",
	commitment: "commitment card",
};
const KIND: Record<Commitment["kind"], string> = { core_group: "Core group card", launch_team: "Launch team card" };
const SCORES = ["1", "2", "3", "4", "5"].map((v) => ({ value: v, label: v }));

const assessmentValues = (r: Assessment): AssessmentValues => ({
	occurredOn: r.occurredOn,
	committed: r.committed,
	compelled: r.compelled,
	contagious: r.contagious,
	courageous: r.courageous,
});
const interviewValues = (r: Interview): InterviewValues => ({
	occurredOn: r.occurredOn,
	maturity: r.maturity,
	gifted: r.gifted,
	chemistry: r.chemistry,
	rightReasons: r.rightReasons,
	season: r.season,
	result: r.result,
	nextSteps: r.nextSteps,
});

/**
 * Correct a record (REQ-PPL-015, a flow the prototype does not draw). One dialog lists the person's Four Cs
 * assessments, interviews and commitment cards; choosing one opens its values to correct, with a required reason and
 * the corrections already made to it (old value, new value, who and why). Only changed fields are sent. The recorder,
 * the recorded time, the witness and the document never change, and the stage never moves. Each correction is one
 * intent with one request key: a retry after a lost answer replays, and a refusal after a lost answer reads the record
 * again before the dialog says whether the correction was saved.
 */
export function CorrectRecordDialog({
	person,
	store,
	accountId,
	onClose,
	onCorrected,
}: {
	person: PlantPerson;
	store: PersonStore<PlantPerson, PersonDraft>;
	accountId: string;
	onClose: () => void;
	/** A saved correction: Activity adds its entry. */
	onCorrected: (receipt: Receipt, recordType: RecordType, recordId: string) => void;
}) {
	const [records, setRecords] = useState<Outcome<Records> | null>(null);
	const [chosen, setChosen] = useState<{ type: RecordType; id: string } | null>(null);
	const [saved, setSaved] = useState<{ type: RecordType; id: string } | null>(null);
	const [reason, setReason] = useState("");
	const [pending, setPending] = useState(false);
	const seq = useRef(0);
	// Corrections whose answer was lost. Only a server answer may say what happened, never a failed read.
	const errors = useStore(store).errors;
	const uncertain = new Set(
		Object.entries(errors).flatMap(([k, v]) => (k.startsWith("correct:") && v === "lost" ? [k.slice(8)] : [])),
	);

	/** Reads the records. The first read is the one started on intent, when there is one (intent.ts). */
	async function load(first = false) {
		const n = ++seq.current;
		const r = first
			? await takeRecords(person.id)
			: await loadRecords(person.id).catch(() => ({ status: "lost" }) as const);
		if (n === seq.current) setRecords(r);
		return r;
	}
	useEffect(() => {
		void load(true);
	}, [person.id]); // eslint-disable-line react-hooks/exhaustive-deps

	const list = records?.status === "ok" ? records.value : null;
	const find = (data: Records, c: { type: RecordType; id: string }): Chosen | null => {
		const record =
			c.type === "assessment"
				? data.assessments.find((r) => r.id === c.id)
				: c.type === "interview"
					? data.interviews.find((r) => r.id === c.id)
					: data.commitments.find((r) => r.id === c.id);
		return record ? ({ type: c.type, record } as Chosen) : null;
	};
	const current = list && chosen ? find(list, chosen) : null;
	const back = () => {
		setChosen(null);
		setSaved(null);
		setReason("");
	};

	return (
		<Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
			<DialogContent size="md" aria-busy={pending || records === null || undefined}>
				<DialogHeader
					icon={FileEditIcon}
					tone="violet"
					title={current ? `Correct the ${TYPE_NAME[current.type]}` : "Correct a record"}
					description={
						current ? (
							<>
								{person.displayName} · <LocalDay day={current.record.occurredOn} />
							</>
						) : (
							`${person.displayName}’s Four Cs assessments, interviews and commitment cards`
						)
					}
				/>
				{records === null ? (
					<DialogBody className="flex flex-col gap-3 pb-6">
						<span className="sr-only" role="status">
							Loading records
						</span>
						<Skeleton className="h-14 w-full rounded-md" />
						<Skeleton className="h-14 w-full rounded-md" />
						<Skeleton className="h-14 w-full rounded-md" />
					</DialogBody>
				) : !list ? (
					<>
						<DialogBody>
							<Problem>
								{records.status === "lost"
									? uncertain.size
										? "The records did not load, so this page cannot tell whether your last correction was saved. Try again to see the current values."
										: "The records did not load. Try again in a moment."
									: "You cannot correct these records. Only Owners and Admins can; your seat may have changed."}
							</Problem>
						</DialogBody>
						<DialogFooter>
							<Button variant="secondary" onClick={onClose}>
								Close
							</Button>
							<Button
								variant="primary"
								onClick={() => {
									setRecords(null);
									void load();
								}}
							>
								Try again
							</Button>
						</DialogFooter>
					</>
				) : saved && current ? (
					<>
						<DialogBody>
							<SavedNote type={saved.type} />
							<History
								corrections={list.corrections.filter((c) => c.recordId === saved.id)}
								accountId={accountId}
								open
							/>
						</DialogBody>
						<DialogFooter>
							<Button variant="secondary" onClick={back}>
								Correct another record
							</Button>
							<Button variant="primary" onClick={onClose}>
								Done
							</Button>
						</DialogFooter>
					</>
				) : current ? (
					<CorrectionForm
						key={current.record.id}
						chosen={current}
						person={person}
						store={store}
						reason={reason}
						onReason={setReason}
						corrections={list.corrections.filter((c) => c.recordId === current.record.id)}
						accountId={accountId}
						onBack={back}
						onPending={setPending}
						reload={async () => {
							const r = await load();
							return r.status === "ok" ? find(r.value, { type: current.type, id: current.record.id }) : null;
						}}
						onSaved={(next, correction, receipt) => {
							setRecords({
								status: "ok",
								value: {
									...list,
									assessments: list.assessments.map((r) =>
										next.type === "assessment" && r.id === next.record.id ? next.record : r,
									),
									interviews: list.interviews.map((r) =>
										next.type === "interview" && r.id === next.record.id ? next.record : r,
									),
									commitments: list.commitments.map((r) =>
										next.type === "commitment" && r.id === next.record.id ? next.record : r,
									),
									corrections: correction ? [correction, ...list.corrections] : list.corrections,
								},
							});
							setSaved({ type: next.type, id: next.record.id });
							setReason("");
							if (receipt) onCorrected(receipt, next.type, next.record.id);
						}}
					/>
				) : (
					<>
						<DialogBody className="pb-2">
							<RecordList data={list} uncertain={uncertain} onChoose={(type, id) => setChosen({ type, id })} />
						</DialogBody>
						<DialogFooter>
							<Button variant="secondary" onClick={onClose}>
								Close
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

function SavedNote({ type }: { type: RecordType }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => ref.current?.focus(), []);
	return (
		<div ref={ref} tabIndex={-1} role="status" className="flex flex-col gap-2 outline-none">
			<CalloutLabel tone="green" icon={Tick02Icon}>
				Correction saved
			</CalloutLabel>
			<p className="text-sm">
				The {TYPE_NAME[type]} shows the corrected values. Its original recorder and date recorded stay, and the stage
				did not change. The history below keeps the old values and your reason.
			</p>
		</div>
	);
}

/** Every record the person has, grouped by kind. A voided card stays listed but cannot be corrected. */
function RecordList({
	data,
	uncertain,
	onChoose,
}: {
	data: Records;
	/** Records whose last correction got no answer: it may have been saved. */
	uncertain: ReadonlySet<string>;
	onChoose: (type: RecordType, id: string) => void;
}) {
	const count = (id: string) => data.corrections.filter((c) => c.recordId === id).length;
	const groups: {
		type: RecordType;
		title: string;
		rows: { id: string; day: string; text: string; voided?: boolean }[];
	}[] = [
		{
			type: "assessment",
			title: "Four Cs assessments",
			rows: data.assessments.map((r) => ({ id: r.id, day: r.occurredOn, text: `Total ${r.total} of 20` })),
		},
		{
			type: "interview",
			title: "Interviews",
			rows: data.interviews.map((r) => ({ id: r.id, day: r.occurredOn, text: RESULT_LABEL[r.result] })),
		},
		{
			type: "commitment",
			title: "Commitment cards",
			rows: data.commitments.map((r) => ({
				id: r.id,
				day: r.occurredOn,
				text: KIND[r.kind],
				voided: r.voidedAt !== null,
			})),
		},
	];
	if (groups.every((g) => g.rows.length === 0))
		return (
			<p className="py-6 text-center text-text-3">
				No Four Cs assessments, interviews or commitment cards are recorded yet, so there is nothing to correct.
			</p>
		);
	return (
		<div className="flex flex-col gap-5">
			<p className="text-sm">Choose the record to correct. Only its values change; who recorded it and when stay.</p>
			{groups
				.filter((g) => g.rows.length)
				.map((g) => (
					<section key={g.type} aria-labelledby={`records-${g.type}`}>
						<h3 id={`records-${g.type}`} className="mb-1 text-sm font-semibold text-ink">
							{g.title}
						</h3>
						<ul className="flex flex-col">
							{g.rows.map((r) => {
								const n = count(r.id);
								return (
									<li key={r.id} className="border-t border-line first:border-t-0">
										<button
											type="button"
											disabled={r.voided}
											onClick={() => onChoose(g.type, r.id)}
											data-focus-inset=""
											className="-mx-2 flex min-h-12 w-[calc(100%+16px)] items-center gap-3 rounded-md px-2 py-2.5 text-left transition-colors enabled:cursor-pointer enabled:hover:bg-hover disabled:cursor-not-allowed"
										>
											<span className="min-w-0 flex-1">
												<span className="block font-medium text-ink">
													<LocalDay day={r.day} />
												</span>
												<span className="block text-sm text-text-3">
													{r.text}
													{r.voided ? " · Voided, kept in the history" : null}
												</span>
												{uncertain.has(r.id) ? (
													<span className="mt-0.5 block text-sm text-amber-600">
														Your last correction got no answer and may be saved. Open it to check the values.
													</span>
												) : null}
											</span>
											{n ? (
												<StatusBadge status="unknown" size="sm">
													{n === 1 ? "Corrected once" : `Corrected ${n} times`}
												</StatusBadge>
											) : null}
											{r.voided ? null : <span className="text-sm font-medium text-ink-2">Correct</span>}
										</button>
									</li>
								);
							})}
						</ul>
					</section>
				))}
			{data.partial ? (
				<p className="text-xs text-text-3">This list shows the latest 100 records of each kind.</p>
			) : null}
		</div>
	);
}

type FormProps = {
	chosen: Chosen;
	person: PlantPerson;
	store: PersonStore<PlantPerson, PersonDraft>;
	reason: string;
	onReason: (reason: string) => void;
	corrections: Correction[];
	accountId: string;
	onBack: () => void;
	onPending: (pending: boolean) => void;
	/** The record read again, after a refusal; null when it could not be read. */
	reload: () => Promise<Chosen | null>;
	onSaved: (next: Chosen, correction: Correction | null, receipt: Receipt | null) => void;
};

function CorrectionForm(props: FormProps) {
	const { chosen } = props;
	if (chosen.type === "assessment") return <AssessmentForm {...props} chosen={chosen} />;
	if (chosen.type === "interview") return <InterviewForm {...props} chosen={chosen} />;
	return <CommitmentForm {...props} chosen={chosen} />;
}

/**
 * The save shared by the three forms. `changes` is what differs from the record; `apply` is the record with the
 * changes, as the server holds it after a saved correction.
 */
function useCorrection(
	props: FormProps,
	changes: Record<string, unknown>,
	apply: () => Chosen,
	reset: (fresh: Chosen) => void,
) {
	const { chosen, person, store, reason } = props;
	const [problem, setProblem] = useState<{ n: number; text: string; tone?: "info" } | null>(null);
	const say = (p: { text: string; tone?: "info" }) => setProblem((old) => ({ ...p, n: (old?.n ?? 0) + 1 }));
	const [touched, setTouched] = useState(false);
	const [pending, setPending] = useState(false);
	const lost = useRef(false);
	const slot = `correct:${chosen.record.id}`;
	const busy = (v: boolean) => {
		setPending(v);
		props.onPending(v);
	};

	async function save(event: React.FormEvent) {
		event.preventDefault();
		setTouched(true);
		if (!Object.keys(changes).length) return say({ text: "Change at least one value first. Nothing was sent." });
		if (!reason.trim()) return;
		const input = {
			recordType: chosen.type,
			personId: person.id,
			recordId: chosen.record.id,
			reason: reason.trim(),
			changes,
		};
		const rev = chosen.record.revision;
		// An earlier answer for this record was lost, in this form or before the dialog was reopened.
		if (store.get().errors[slot] === "lost") lost.current = true;
		busy(true);
		setProblem(null);
		const r = await runSave(store, slot, { input, rev }, (key) => correctRecord(key, rev, input), { fresh });
		if (r === null) {
			busy(false);
			return say({ text: "Another change to this person is still saving. Try again in a moment." });
		}
		if (r.status === "ok") {
			busy(false);
			if (r.value.result.outcome === "noop")
				return say({ tone: "info", text: "Nothing changed: the record already has these values." });
			const draft = apply();
			const next = { ...draft, record: { ...draft.record, revision: r.value.result.revision } } as Chosen;
			const correction: Correction = {
				id: r.value.receipt.id,
				recordType: chosen.type,
				recordId: chosen.record.id,
				correctedAt: r.value.receipt.at,
				actor: { kind: "current_account", accountId: props.accountId } as Correction["actor"],
				reason: input.reason,
				changes: Object.keys(changes).map((field) => ({
					field,
					old: (chosen.record as Record<string, unknown>)[field] ?? null,
					new: changes[field] ?? null,
				})),
			};
			return props.onSaved(next, correction, r.value.receipt);
		}
		if (r.status === "lost") {
			lost.current = true;
			busy(false);
			return say({
				text: "We did not hear back from the server. Your changes are kept. Try again; it will not save twice.",
			});
		}
		if (r.code === "conflict") {
			// The record changed since the form opened, perhaps by this correction's own earlier attempt.
			const fresh = await props.reload();
			busy(false);
			const draft = apply();
			if (
				fresh &&
				lost.current &&
				JSON.stringify(fresh.record) === JSON.stringify({ ...draft.record, revision: fresh.record.revision })
			)
				return props.onSaved(fresh, null, null);
			if (fresh) reset(fresh);
			return say({
				text: fresh
					? "This record changed since you opened it. The form now shows its current values; your reason is kept. Check them, then save again."
					: "This record changed or moved to another person since you opened it. Close this and open the person again.",
			});
		}
		busy(false);
		say({
			text:
				r.code === "invalid_input"
					? "Some values are not valid. A date cannot be later than today in your church's time zone."
					: r.code === "invalid_subject"
						? "This card was voided, so it cannot be corrected. It stays in the history."
						: "You cannot correct this record. Only Owners and Admins can; your seat may have changed.",
		});
	}
	return { save, problem, touched, pending };
}

function Frame({
	props,
	state,
	children,
}: {
	props: FormProps;
	state: ReturnType<typeof useCorrection>;
	children: ReactNode;
}) {
	const { reason, onReason, corrections, accountId, onBack } = props;
	return (
		<form onSubmit={state.save} className="flex min-h-0 flex-1 flex-col" noValidate>
			<DialogBody className="flex flex-col gap-5">
				<div>
					<Button
						variant="ghost"
						size="sm"
						icon={ArrowLeft01Icon}
						className="-ml-3"
						disabled={state.pending}
						onClick={onBack}
					>
						All records
					</Button>
				</div>
				{children}
				<Field
					label="Reason for the correction"
					hint="Your reason is saved in this person's history."
					error={state.touched && !reason.trim() ? "Give a reason." : null}
				>
					<Textarea
						rows={2}
						maxLength={2000}
						value={reason}
						readOnly={state.pending}
						onChange={(e) => onReason(e.target.value)}
					/>
				</Field>
				{state.problem ? (
					state.problem.tone === "info" ? (
						<p key={state.problem.n} role="status" className="rounded-md bg-surface px-3.5 py-2.5 text-sm text-ink-2">
							{state.problem.text}
						</p>
					) : (
						<Problem key={state.problem.n}>{state.problem.text}</Problem>
					)
				) : null}
				<History corrections={corrections} accountId={accountId} />
			</DialogBody>
			<DialogFooter>
				<Button variant="secondary" disabled={state.pending} onClick={onBack}>
					Back
				</Button>
				<Button variant="primary" type="submit" loading={state.pending}>
					Save correction
				</Button>
			</DialogFooter>
		</form>
	);
}

function DateField({ value, onChange, readOnly }: { value: string; onChange: (v: string) => void; readOnly: boolean }) {
	return (
		<Field label="Date it happened" className="max-w-[220px]">
			<Input type="date" value={value} readOnly={readOnly} required onChange={(e) => onChange(e.target.value)} />
		</Field>
	);
}
const notesOf = (s: string | null) => s ?? "";
const noteValue = (s: string) => (s === "" ? null : s);

function AssessmentForm(props: FormProps & { chosen: Extract<Chosen, { type: "assessment" }> }) {
	const base = assessmentValues(props.chosen.record);
	const [draft, setDraft] = useState(base);
	const changes = assessmentChanges(base, draft);
	const state = useCorrection(
		props,
		changes,
		() => ({ type: "assessment", record: { ...props.chosen.record, ...draft, total: totalOf(draft) } as Assessment }),
		(c) => c.type === "assessment" && setDraft(assessmentValues(c.record)),
	);
	return (
		<Frame props={props} state={state}>
			<DateField
				value={draft.occurredOn}
				readOnly={state.pending}
				onChange={(occurredOn) => setDraft({ ...draft, occurredOn })}
			/>
			<fieldset className="flex flex-col gap-4">
				<legend className="mb-2 text-sm font-semibold text-ink">Scores, 1 to 5</legend>
				{LENSES.map((l) => (
					<div key={l} className="grid grid-cols-[120px_minmax(0,1fr)] items-start gap-3 max-app-sm:grid-cols-1">
						<Field label={LENS_LABEL[l]}>
							<Select
								value={String(draft[l].score)}
								disabled={state.pending}
								options={SCORES}
								onValueChange={(v) => setDraft({ ...draft, [l]: { ...draft[l], score: Number(v) } })}
							/>
						</Field>
						<Field label={`${LENS_LABEL[l]} notes`} optional>
							<Textarea
								rows={1}
								maxLength={5000}
								value={notesOf(draft[l].notes)}
								readOnly={state.pending}
								onChange={(e) => setDraft({ ...draft, [l]: { ...draft[l], notes: noteValue(e.target.value) } })}
							/>
						</Field>
					</div>
				))}
			</fieldset>
			<p className="text-sm text-ink-2" aria-live="polite">
				Total <b className="num text-ink">{totalOf(draft)}</b> of 20
				{totalOf(draft) !== props.chosen.record.total ? ` (was ${props.chosen.record.total})` : null}
			</p>
		</Frame>
	);
}

function InterviewForm(props: FormProps & { chosen: Extract<Chosen, { type: "interview" }> }) {
	const base = interviewValues(props.chosen.record);
	const [draft, setDraft] = useState(base);
	const changes = interviewChanges(base, draft);
	const state = useCorrection(
		props,
		changes,
		() => ({ type: "interview", record: { ...props.chosen.record, ...draft } as Interview }),
		(c) => c.type === "interview" && setDraft(interviewValues(c.record)),
	);
	return (
		<Frame props={props} state={state}>
			<DateField
				value={draft.occurredOn}
				readOnly={state.pending}
				onChange={(occurredOn) => setDraft({ ...draft, occurredOn })}
			/>
			{CRITERIA.map((k) => (
				<fieldset key={k} className="flex flex-col gap-1">
					<legend className="text-sm font-semibold text-ink">{CRITERION_LABEL[k]}</legend>
					<RadioGroup
						orientation="horizontal"
						aria-label={CRITERION_LABEL[k]}
						value={draft[k].rating}
						disabled={state.pending}
						onValueChange={(v) => setDraft({ ...draft, [k]: { ...draft[k], rating: v as Rating } })}
						className="flex-wrap"
					>
						{RATINGS.map((r) => (
							<Radio key={r} value={r} label={RATING_LABEL[r]} />
						))}
					</RadioGroup>
					<Field label={`${CRITERION_LABEL[k]} notes`} optional>
						<Textarea
							rows={1}
							maxLength={5000}
							value={notesOf(draft[k].notes)}
							readOnly={state.pending}
							onChange={(e) => setDraft({ ...draft, [k]: { ...draft[k], notes: noteValue(e.target.value) } })}
						/>
					</Field>
				</fieldset>
			))}
			<Field label="Result" className="max-w-[280px]">
				<Select
					value={draft.result}
					disabled={state.pending}
					options={RESULTS.map((r) => ({ value: r, label: RESULT_LABEL[r] }))}
					onValueChange={(v) => setDraft({ ...draft, result: v as InterviewValues["result"] })}
				/>
			</Field>
			<p className="-mt-3 text-xs text-text-3">Correcting the result never changes the stage.</p>
			<Field label="Next steps" optional>
				<Textarea
					rows={2}
					maxLength={5000}
					value={notesOf(draft.nextSteps)}
					readOnly={state.pending}
					onChange={(e) => setDraft({ ...draft, nextSteps: noteValue(e.target.value) })}
				/>
			</Field>
		</Frame>
	);
}

function CommitmentForm(props: FormProps & { chosen: Extract<Chosen, { type: "commitment" }> }) {
	const record = props.chosen.record;
	const base: CommitmentValues = { notes: record.notes };
	const [draft, setDraft] = useState(base);
	const changes = commitmentChanges(base, draft);
	const state = useCorrection(
		props,
		changes,
		() => ({ type: "commitment", record: { ...record, ...draft } }),
		(c) => c.type === "commitment" && setDraft({ notes: c.record.notes }),
	);
	return (
		<Frame props={props} state={state}>
			<p className="text-sm">
				{KIND[record.kind]}, signed <LocalDay day={record.occurredOn} />. Here you correct its notes. The card&rsquo;s
				date and kind are corrected on the card itself, and its witness and document never change.
			</p>
			<Field label="Notes" optional>
				<Textarea
					rows={3}
					maxLength={5000}
					value={notesOf(draft.notes)}
					readOnly={state.pending}
					onChange={(e) => setDraft({ notes: noteValue(e.target.value) })}
				/>
			</Field>
		</Frame>
	);
}

/** The corrections already made to one record: old value, new value, who and why, latest first. */
function History({ corrections, accountId, open }: { corrections: Correction[]; accountId: string; open?: boolean }) {
	if (!corrections.length) return null;
	return (
		<details open={open} className="group rounded-md bg-surface px-4 py-3">
			<summary className="cursor-pointer text-sm font-semibold text-ink">
				Corrections to this record ({corrections.length})
			</summary>
			<ol className="mt-2 flex flex-col">
				{corrections.map((c) => (
					<li key={c.id} className="border-t border-line py-3 text-sm first:border-t-0">
						<p className="text-text-3">
							{c.actor.kind === "current_account" && c.actor.accountId === accountId
								? "You"
								: c.actor.kind === "current_account"
									? "A team member"
									: "A former team member"}{" "}
							· <When at={c.correctedAt} withTime />
						</p>
						<ul className="mt-1 flex flex-col gap-0.5">
							{c.changes.map((x) => (
								<li key={x.field} className="text-ink-2 [overflow-wrap:anywhere]">
									<span className="font-medium text-ink">{correctedFieldLabel(x.field)}:</span>{" "}
									<span className="line-through decoration-text-3">{correctedValueText(x.old)}</span>
									<span aria-hidden="true"> → </span>
									<span className="sr-only"> changed to </span>
									{correctedValueText(x.new)}
								</li>
							))}
						</ul>
						{c.reason ? <p className="mt-1 text-ink-2">Reason: {c.reason}</p> : null}
					</li>
				))}
			</ol>
		</details>
	);
}
