"use client";

import { Add01Icon, Alert02Icon, Cancel01Icon, Tick02Icon, UserCheck01Icon } from "@hugeicons/core-free-icons";
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
	Radio,
	RadioGroup,
	Textarea,
	useToast,
} from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { cn, Icon } from "@everyfield/ui/foundations";
import { startTransition, useId, useOptimistic, useState, useTransition } from "react";
import type { Wait } from "../../../components/save/model.ts";
import { NoticeInDialog, RecordDialog, SaveNotice, useSaveIntent } from "../../../components/save/parts.tsx";
import { STAGE_LABEL, throughStore } from "../model.ts";
import { LocalDay, useStore } from "../parts.tsx";
import { loadInterviews, recordInterview } from "./actions.ts";
import {
	advancedStage,
	CRITERIA,
	CRITERION_LABEL,
	firstName,
	RATING_LABEL,
	RATINGS,
	RESULT_LABEL,
	RESULT_STATUS,
	RESULTS,
	today,
	withRecord,
	type CriterionKey,
	type Interview,
	type Interviews,
	type Rating,
	type Result,
} from "./model.ts";
import { ChoiceField, recorder, recordProblem, ShowEarlier, useHistory } from "./parts.tsx";
import type { PlantPerson, RecordProps } from "./RecordsSection.tsx";

type Draft = {
	occurredOn: string;
	result: Result | "";
	nextSteps: string;
} & Record<CriterionKey, { rating: Rating | ""; notes: string }>;
type Editing = { draft: Draft; problem?: string };
const RATING_OPTIONS = RATINGS.map((r) => ({ value: r, label: RATING_LABEL[r] }));
const blank = (): Draft => ({
	occurredOn: today(),
	result: "",
	nextSteps: "",
	maturity: { rating: "", notes: "" },
	gifted: { rating: "", notes: "" },
	chemistry: { rating: "", notes: "" },
	rightReasons: { rating: "", notes: "" },
	season: { rating: "", notes: "" },
});
const RATING_ICON = { pass: Tick02Icon, concern: Alert02Icon, fail: Cancel01Icon } as const;
const RATING_TONE = {
	pass: "bg-green-100 text-green-700",
	concern: "bg-amber-100 text-amber-600",
	fail: "bg-magenta-100 text-magenta-600",
} as const;

/**
 * The interview (REQ-PPL-013, 020): the latest one's five criteria, result and next steps, with earlier ones below.
 * Any result means the interview happened, so saving one moves an earlier stage to Interviewed in the same save; a
 * later stage stays. The new interview and the stage show at once while it saves; a refusal takes both back and opens
 * the form again with the answers and the reason.
 */
export function InterviewCard({
	personId,
	personName,
	stage,
	store,
	expectPerson,
	initial,
	canEdit,
	accountId,
	onSaved,
	corrected,
}: RecordProps<Interviews>) {
	const toast = useToast();
	const history = useHistory(
		initial,
		(page) => loadInterviews(personId, page),
		corrected?.flatMap((c) => (c.type === "interview" ? [c.record] : [])),
	);
	const [shown, expect] = useOptimistic(history.items, withRecord<Interview>);
	const [, start] = useTransition();
	// Another change to this person is saving: the card waits, and Check again waits for it (C65, C68).
	useStore(store);
	const form = useSaveIntent<Editing>({ explain: recordProblem, busy: () => store.get().pending !== null });
	const wait = form.wait;
	const [open, setOpen] = useState(false);
	const first = firstName(personName);
	const latest = shown[0] ?? null;
	const earlier = shown.slice(1);
	const moves = advancedStage(stage, "interviewed") !== stage;

	function submit(draft: Draft) {
		const criterion = (k: CriterionKey) => ({
			rating: draft[k].rating as Rating,
			notes: draft[k].notes.trim() || null,
		});
		const input = {
			personId,
			occurredOn: draft.occurredOn,
			maturity: criterion("maturity"),
			gifted: criterion("gifted"),
			chemistry: criterion("chemistry"),
			rightReasons: criterion("rightReasons"),
			season: criterion("season"),
			result: draft.result as Result,
			nextSteps: draft.nextSteps.trim() || null,
		};
		start(async () => {
			const now = new Date().toISOString();
			expect({
				...input,
				id: `new:${now}`,
				recordedAt: now,
				actor: { kind: "current_account", accountId },
				revision: "0",
			} as Interview);
			expectPerson({ stage: advancedStage(stage, "interviewed") });
			await form.save({
				what: "Your interview",
				form: { draft },
				send: (key) => recordInterview(key, input),
				through: throughStore(
					store,
					"interview",
					(v: { person: { stage: PlantPerson["stage"]; revision: string } }) =>
						({ ...store.get().saved, stage: v.person.stage, revision: v.person.revision }) as PlantPerson,
				),
				code: (code) => (code === "invalid_input" ? "future_date" : code),
				ok: (value) => {
					const moved = value.person.stageChange;
					startTransition(() => history.add(value.interview));
					onSaved(value.receipt, {
						kind: "activity",
						action: "interview_recorded",
						recordId: value.interview.id,
						...(moved ? { stage: moved } : {}),
					});
					toast({
						tone: "success",
						message: moved
							? `Interview saved. ${first} is now ${STAGE_LABEL[moved.to].toLowerCase()}.`
							: `Interview saved for ${first}.`,
					});
				},
			});
		});
	}

	return (
		<Card className="min-w-0">
			<CardHeader className="mb-3">
				<CardHeading>
					<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
						<CardTitle size="sm">Interview</CardTitle>
						{latest ? (
							<StatusBadge status={RESULT_STATUS[latest.result]} size="sm">
								{RESULT_LABEL[latest.result]}
							</StatusBadge>
						) : null}
					</div>
					<CardDescription className="text-sm">
						{latest ? (
							<>
								<LocalDay day={latest.occurredOn} /> ·{" "}
								{latest.id.startsWith("new:") ? "Saving…" : `by ${recorder(latest.actor, accountId)}`}
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
						label={`Record an interview with ${first}`}
						size="sm"
						onClick={() => form.open({ draft: blank() })}
					/>
				) : null}
			</CardHeader>
			<SaveNotice {...form.noticeProps} dialogOpen={form.editing !== null} />

			{initial === null ? (
				<p className="text-sm text-text-3">Interviews did not load. Reload the page to see them.</p>
			) : !latest ? (
				<div className="flex flex-col items-start gap-3">
					<p className="text-sm text-text-2">
						{canEdit
							? `Rate maturity, giftedness, chemistry, right reasons and season of life, then give a result.${moves ? ` Saving it moves ${first} to Interviewed.` : ""}`
							: `No interview is recorded for ${first}.`}
					</p>
					{canEdit ? (
						<Button size="sm" variant="secondary" icon={Add01Icon} onClick={() => form.open({ draft: blank() })}>
							Record an interview
						</Button>
					) : null}
				</div>
			) : (
				<>
					<Criteria interview={latest} />
					{latest.nextSteps ? (
						<div className="mt-3 border-t border-line pt-3">
							<p className="text-xs font-medium text-text-3">Next steps</p>
							<p className="mt-1 text-sm whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">{latest.nextSteps}</p>
						</div>
					) : null}
					{earlier.length > 0 || history.next !== null ? (
						<div className="mt-3 border-t border-line pt-3">
							<button
								type="button"
								aria-expanded={open}
								onClick={() => setOpen(!open)}
								className="cursor-pointer rounded-xs text-sm font-medium text-ink-2 underline-offset-[3px] hover:underline"
							>
								{open
									? "Hide earlier interviews"
									: `Earlier interviews (${Math.max(history.total - 1, earlier.length)})`}
							</button>
							{open ? (
								<>
									<ul className="mt-2 flex flex-col">
										{earlier.map((i) => (
											<li
												key={i.id}
												className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-line py-2 first:border-t-0"
											>
												<span className="text-sm text-ink-2">
													<LocalDay day={i.occurredOn} />
													<span className="text-text-3"> · by {recorder(i.actor, accountId)}</span>
												</span>
												<StatusBadge status={RESULT_STATUS[i.result]} size="sm">
													{RESULT_LABEL[i.result]}
												</StatusBadge>
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
			<p className="mt-4 text-xs text-text-3">Next steps are notes. They do not create tasks.</p>
			<NoticeInDialog {...form.noticeProps}>
				{form.editing ? (
					<InterviewDialog
						wait={wait}
						editing={form.editing}
						personName={first}
						moves={moves}
						onClose={form.close}
						onSubmit={submit}
					/>
				) : null}
			</NoticeInDialog>
		</Card>
	);
}

function Criteria({ interview: i }: { interview: Interview }) {
	const pending = i.id.startsWith("new:");
	return (
		<ul className="flex flex-col" aria-busy={pending || undefined}>
			{CRITERIA.map((k) => {
				const { rating, notes } = i[k];
				return (
					<li key={k} className="flex items-start gap-3 border-t border-line py-2.5 first:border-t-0 first:pt-0">
						<span
							aria-hidden="true"
							className={cn("mt-px grid size-[22px] flex-none place-items-center rounded-full", RATING_TONE[rating])}
						>
							<Icon icon={RATING_ICON[rating]} size={16} />
						</span>
						<div className="min-w-0 flex-1">
							<div className="flex items-baseline justify-between gap-3">
								<span className="text-ink">{CRITERION_LABEL[k]}</span>
								<span className="text-sm text-text-2">{RATING_LABEL[rating]}</span>
							</div>
							{notes ? (
								<p className="mt-0.5 line-clamp-2 text-sm text-text-3 [overflow-wrap:anywhere]">{notes}</p>
							) : null}
						</div>
					</li>
				);
			})}
		</ul>
	);
}

function InterviewDialog({
	wait,
	editing,
	personName,
	moves,
	onClose,
	onSubmit,
}: {
	/** The card's last save is in flight or unknown (C68): saving waits, and the form keeps its answers. */
	wait: Wait;
	editing: Editing;
	personName: string;
	moves: boolean;
	onClose: () => void;
	onSubmit: (draft: Draft) => void;
}) {
	const [draft, setDraft] = useState(editing.draft);
	const [touched, setTouched] = useState(false);
	const resultId = useId();
	const setCriterion = (k: CriterionKey, patch: Partial<Draft[CriterionKey]>) =>
		setDraft((d) => ({ ...d, [k]: { ...d[k], ...patch } }));
	const complete = draft.occurredOn !== "" && draft.result !== "" && CRITERIA.every((k) => draft[k].rating !== "");
	const futureDate = editing.problem === "future_date";
	return (
		<RecordDialog
			wait={wait}
			icon={UserCheck01Icon}
			tone="violet"
			title={`Record an interview with ${personName}`}
			description={
				moves
					? `Rate each criterion and give a result. Saving moves ${personName} to Interviewed.`
					: "Rate each criterion and give a result. The stage stays as it is."
			}
			action="Save interview"
			problem={editing.problem && recordProblem(editing.problem)}
			onClose={onClose}
			onSubmit={() => {
				setTouched(true);
				if (complete) onSubmit(draft);
				return complete;
			}}
		>
			<Field
				label="Interviewed on"
				className="max-w-[240px] max-app-sm:max-w-none"
				error={
					touched && draft.occurredOn === ""
						? "Choose the date of the interview."
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
			{CRITERIA.map((k) => (
				<div key={k} className="flex flex-col gap-2.5 border-t border-line pt-4">
					<ChoiceField
						label={CRITERION_LABEL[k]}
						value={draft[k].rating}
						options={RATING_OPTIONS}
						onChange={(rating) => setCriterion(k, { rating })}
						error={touched && draft[k].rating === "" ? `Rate ${CRITERION_LABEL[k].toLowerCase()}.` : null}
					/>
					<Field label={`${CRITERION_LABEL[k]} notes`} optional>
						<Textarea
							rows={2}
							maxLength={5000}
							value={draft[k].notes}
							onChange={(e) => setCriterion(k, { notes: e.target.value })}
						/>
					</Field>
				</div>
			))}
			<div className="flex flex-col gap-1.5 border-t border-line pt-4">
				<span id={resultId} className="text-sm font-medium text-ink-2">
					Result
				</span>
				<RadioGroup
					aria-labelledby={resultId}
					aria-invalid={(touched && draft.result === "") || undefined}
					aria-describedby={touched && draft.result === "" ? `${resultId}-error` : undefined}
					value={draft.result}
					onValueChange={(result) => setDraft((d) => ({ ...d, result: result as Result }))}
					className="grid grid-cols-2 gap-x-4 max-app-sm:grid-cols-1"
				>
					{RESULTS.map((r) => (
						<Radio key={r} value={r} label={RESULT_LABEL[r]} className="py-2" />
					))}
				</RadioGroup>
				<div aria-live="polite" className="empty:hidden">
					{touched && draft.result === "" ? (
						<p id={`${resultId}-error`} className="text-xs font-medium text-magenta-600">
							Choose a result.
						</p>
					) : null}
				</div>
			</div>
			<Field label="Next steps" optional hint="Saved as a note. To plan a task, add it in Tasks.">
				<Textarea
					rows={2}
					maxLength={5000}
					value={draft.nextSteps}
					onChange={(e) => setDraft((d) => ({ ...d, nextSteps: e.target.value }))}
				/>
			</Field>
		</RecordDialog>
	);
}
