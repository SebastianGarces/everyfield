"use client";

import { Add01Icon, Analytics01Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	Field,
	IconButton,
	Input,
	Textarea,
	useToast,
} from "@everyfield/ui/controls";
import { startTransition, useOptimistic, useState, useTransition } from "react";
import type { Wait } from "../../../components/save/model.ts";
import { NoticeInDialog, RecordDialog, SaveNotice, useSaveIntent } from "../../../components/save/parts.tsx";
import { throughStore } from "../model.ts";
import { LocalDay, useStore } from "../parts.tsx";
import { loadAssessments, recordAssessment } from "./actions.ts";
import {
	firstName,
	LENS_LABEL,
	LENSES,
	today,
	totalOf,
	withRecord,
	type Assessment,
	type Assessments,
	type Lens,
} from "./model.ts";
import { ChoiceField, recorder, recordProblem, ShowEarlier, useHistory } from "./parts.tsx";
import type { PlantPerson, RecordProps } from "./RecordsSection.tsx";

type Draft = { occurredOn: string } & Record<Lens, { score: string; notes: string }>;
type Editing = { draft: Draft; problem?: string };
const SCORES = ["1", "2", "3", "4", "5"].map((v) => ({ value: v, label: v }));
const blank = (): Draft => ({
	occurredOn: today(),
	committed: { score: "", notes: "" },
	compelled: { score: "", notes: "" },
	contagious: { score: "", notes: "" },
	courageous: { score: "", notes: "" },
});

/**
 * The 4 C's (REQ-PPL-012): the latest human assessment, four scores from 1 to 5 and their total, with earlier ones
 * below. Recording one never changes the stage. A new assessment shows at once while it saves; a refusal takes it away
 * and opens the form again with the answers kept and the reason.
 */
export function AssessmentCard({
	personId,
	personName,
	store,
	initial,
	canEdit,
	accountId,
	onSaved,
	corrected,
}: RecordProps<Assessments>) {
	const toast = useToast();
	const history = useHistory(
		initial,
		(page) => loadAssessments(personId, page),
		corrected?.flatMap((c) => (c.type === "assessment" ? [c.record] : [])),
	);
	const [shown, expect] = useOptimistic(history.items, withRecord<Assessment>);
	const [, start] = useTransition();
	// Another change to this person is saving: the card waits, and Check again waits for it (C65, C68).
	useStore(store);
	const form = useSaveIntent<Editing>({ explain: recordProblem, busy: () => store.get().pending !== null });
	const wait = form.wait;
	const [open, setOpen] = useState(false);
	const first = firstName(personName);
	const latest = shown[0] ?? null;
	const earlier = shown.slice(1);

	function submit(draft: Draft) {
		const lens = (l: Lens) => ({ score: Number(draft[l].score), notes: draft[l].notes.trim() || null });
		const input = {
			personId,
			occurredOn: draft.occurredOn,
			committed: lens("committed"),
			compelled: lens("compelled"),
			contagious: lens("contagious"),
			courageous: lens("courageous"),
		};
		start(async () => {
			const now = new Date().toISOString();
			expect({
				...input,
				id: `new:${now}`,
				recordedAt: now,
				actor: { kind: "current_account", accountId },
				revision: "0",
				total: LENSES.reduce((t, l) => t + input[l].score, 0),
			} as Assessment);
			await form.save({
				what: "Your 4 C's assessment",
				form: { draft },
				send: (key) => recordAssessment(key, input),
				through: throughStore(
					store,
					"assessment",
					(v: { person: { stage: PlantPerson["stage"]; revision: string } }) =>
						({ ...store.get().saved, stage: v.person.stage, revision: v.person.revision }) as PlantPerson,
				),
				ok: (value) => {
					startTransition(() => history.add(value.assessment));
					onSaved(value.receipt, { kind: "activity", action: "assessment_recorded", recordId: value.assessment.id });
					toast({ tone: "success", message: `4 C's saved for ${first}.` });
				},
			});
		});
	}

	return (
		<Card className="min-w-0">
			<CardHeader className="mb-4">
				<CardHeading>
					<CardTitle size="sm">The 4 C&rsquo;s</CardTitle>
					<CardDescription className="text-sm">
						{latest ? (
							<>
								<LocalDay day={latest.occurredOn} /> · {pendingOr(latest, `by ${recorder(latest.actor, accountId)}`)}
							</>
						) : initial === null ? (
							"Did not load"
						) : (
							"Not recorded yet"
						)}
					</CardDescription>
				</CardHeading>
				{canEdit && initial !== null && latest ? (
					<IconButton
						icon={Add01Icon}
						label={`Record a 4 C's assessment for ${first}`}
						size="sm"
						onClick={() => form.open({ draft: blank() })}
					/>
				) : null}
			</CardHeader>
			<SaveNotice {...form.noticeProps} dialogOpen={form.editing !== null} />

			{initial === null ? (
				<p className="text-sm text-text-3">The 4 C&rsquo;s did not load. Reload the page to see them.</p>
			) : !latest ? (
				<div className="flex flex-col items-start gap-3">
					<p className="text-sm text-text-2">
						{canEdit
							? `Score how committed, compelled, contagious and courageous ${first} is, each from 1 to 5.`
							: `No 4 C's are recorded for ${first}.`}
					</p>
					{canEdit ? (
						<Button size="sm" variant="secondary" icon={Add01Icon} onClick={() => form.open({ draft: blank() })}>
							Record the 4 C&rsquo;s
						</Button>
					) : null}
				</div>
			) : (
				<>
					<Scores assessment={latest} />
					{earlier.length > 0 || history.next !== null ? (
						<div className="mt-4 border-t border-line pt-3">
							<button
								type="button"
								aria-expanded={open}
								onClick={() => setOpen(!open)}
								className="cursor-pointer rounded-xs text-sm font-medium text-ink-2 underline-offset-[3px] hover:underline"
							>
								{open
									? "Hide earlier assessments"
									: `Earlier assessments (${Math.max(history.total - 1, earlier.length)})`}
							</button>
							{open ? (
								<>
									<ul className="mt-2 flex flex-col">
										{earlier.map((a) => (
											<li
												key={a.id}
												className="flex items-baseline justify-between gap-3 border-t border-line py-2 first:border-t-0"
											>
												<span className="text-sm text-ink-2">
													<LocalDay day={a.occurredOn} />
													<span className="text-text-3"> · by {recorder(a.actor, accountId)}</span>
												</span>
												<span className="text-sm text-text-2 tabular-nums">
													{LENSES.map((l) => a[l].score).join(" · ")}
													<span className="ml-2 font-medium text-ink">Total {a.total}</span>
												</span>
											</li>
										))}
									</ul>
									{history.next !== null ? (
										<ShowEarlier
											loading={history.loading}
											failed={history.failed}
											onClick={() => void history.more()}
										/>
									) : null}
								</>
							) : null}
						</div>
					) : null}
				</>
			)}
			<p className="mt-4 text-xs text-text-3">Human judgment. Evry and Plant Intelligence never set these.</p>
			<NoticeInDialog {...form.noticeProps}>
				{form.editing ? (
					<AssessmentDialog
						editing={form.editing}
						personName={first}
						wait={wait}
						onClose={form.close}
						onSubmit={submit}
					/>
				) : null}
			</NoticeInDialog>
		</Card>
	);
}

const pendingOr = (r: { id: string }, text: string) => (r.id.startsWith("new:") ? "Saving…" : text);

function Scores({ assessment: a }: { assessment: Assessment }) {
	const pending = a.id.startsWith("new:");
	return (
		<div className="flex flex-col gap-3.5" aria-busy={pending || undefined}>
			<dl className="flex flex-col gap-3.5">
				{LENSES.map((l) => (
					<div key={l} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3">
						<dt className="font-medium text-ink">{LENS_LABEL[l]}</dt>
						<dd className="text-sm text-text-2 tabular-nums">
							<span className="font-semibold text-ink">{a[l].score}</span> of 5
						</dd>
						<dd className="col-span-2">
							<div aria-hidden="true" className="mt-2 h-1.5 overflow-hidden rounded-pill bg-surface-2">
								<span className="block h-full rounded-pill bg-green-500" style={{ width: `${a[l].score * 20}%` }} />
							</div>
							{a[l].notes ? (
								<p className="mt-1.5 line-clamp-3 text-sm whitespace-pre-wrap text-text-2 [overflow-wrap:anywhere]">
									{a[l].notes}
								</p>
							) : null}
						</dd>
					</div>
				))}
			</dl>
			<p className="flex items-baseline justify-between gap-3 border-t border-line pt-3">
				<span className="font-medium text-ink">Total</span>
				<span className="text-sm text-text-2 tabular-nums">
					<span className="font-semibold text-ink">{a.total}</span> of 20
				</span>
			</p>
		</div>
	);
}

function AssessmentDialog({
	wait,
	editing,
	personName,
	onClose,
	onSubmit,
}: {
	/** The card's last save is in flight or unknown (C68): saving waits, and the form keeps its answers. */
	wait: Wait;
	editing: Editing;
	personName: string;
	onClose: () => void;
	onSubmit: (draft: Draft) => void;
}) {
	const [draft, setDraft] = useState(editing.draft);
	const [touched, setTouched] = useState(false);
	const setLens = (l: Lens, patch: Partial<Draft[Lens]>) => setDraft((d) => ({ ...d, [l]: { ...d[l], ...patch } }));
	const total = totalOf(LENSES.map((l) => (draft[l].score ? Number(draft[l].score) : null)));
	const complete = draft.occurredOn !== "" && LENSES.every((l) => draft[l].score !== "");
	const futureDate = editing.problem === "future_date";
	return (
		<RecordDialog
			wait={wait}
			icon={Analytics01Icon}
			tone="green"
			title={`Record the 4 C's for ${personName}`}
			description="Your own judgment, from 1 (not yet) to 5 (clearly). Recording this never changes the stage."
			action="Save assessment"
			problem={editing.problem && recordProblem(editing.problem)}
			onClose={onClose}
			onSubmit={() => {
				setTouched(true);
				if (complete) onSubmit(draft);
				return complete;
			}}
		>
			<Field
				label="Assessed on"
				className="max-w-[240px] max-app-sm:max-w-none"
				error={
					touched && draft.occurredOn === ""
						? "Choose the date of the assessment."
						: futureDate
							? "Choose today or an earlier date."
							: null
				}
			>
				<Input
					type="date"
					value={draft.occurredOn}
					max={today()}
					onChange={(e) => setDraft((d) => ({ ...d, occurredOn: e.target.value }))}
				/>
			</Field>
			{LENSES.map((l) => (
				<div key={l} className="flex flex-col gap-2.5 border-t border-line pt-4">
					<ChoiceField
						label={LENS_LABEL[l]}
						value={draft[l].score}
						options={SCORES}
						onChange={(score) => setLens(l, { score })}
						error={touched && draft[l].score === "" ? `Choose a score for ${LENS_LABEL[l].toLowerCase()}.` : null}
					/>
					<Field label={`${LENS_LABEL[l]} notes`} optional>
						<Textarea
							rows={2}
							maxLength={5000}
							value={draft[l].notes}
							onChange={(e) => setLens(l, { notes: e.target.value })}
						/>
					</Field>
				</div>
			))}
			<p className="flex items-baseline justify-between border-t border-line pt-4 text-md" aria-live="polite">
				<span className="font-medium text-ink">Total</span>
				<span className="tabular-nums text-text-2">
					{total === null ? (
						"Score all four to see the total"
					) : (
						<>
							<span className="font-semibold text-ink">{total}</span> of 20
						</>
					)}
				</span>
			</p>
		</RecordDialog>
	);
}
