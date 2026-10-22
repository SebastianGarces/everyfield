"use client";

import { Checkbox, Field, Input, Radio, RadioGroup, SegmentedControl, Select, Textarea } from "@everyfield/ui/controls";
import { cn } from "@everyfield/ui/foundations";
import { useId } from "react";
import {
	CHANNEL_LABEL,
	CHANNELS,
	localInputOf,
	NOTES_MAX,
	OUTCOME_HINT,
	OUTCOME_LABEL,
	OUTCOMES,
	pickOutcome,
	type Draft,
	type DraftErrors,
	type OutcomeValue,
} from "./model.ts";

/**
 * After a submit with problems, moves focus to the first control marked invalid once React has drawn the errors. A
 * radio group's first option takes focus for the group.
 */
export function focusFirstProblem(form: HTMLFormElement) {
	requestAnimationFrame(() => {
		const bad = form.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid="true"]');
		const target = bad?.matches("input, textarea, button, select")
			? bad
			: bad?.querySelector<HTMLElement>('input, textarea, button, [tabindex]:not([tabindex="-1"])');
		target?.focus();
	});
}

/**
 * The outcome form (REQ-MTG-022): what happened, when, how, a note and, on a follow-up, whether it is done. Contacted
 * needs the person to say when it happened. `completable` is false for a contact with no task and for a correction.
 * `outcomes` limits the choices (a standalone contact cannot be "No longer needed").
 */
export function OutcomeFields({
	draft,
	onDraft,
	errors,
	completable,
	outcomes = OUTCOMES,
	personName,
}: {
	draft: Draft;
	onDraft: (d: Draft) => void;
	errors: DraftErrors;
	completable: boolean;
	outcomes?: readonly OutcomeValue[];
	personName: string;
}) {
	const groupLabel = useId();
	const groupError = useId();
	const set = (patch: Partial<Draft>) => onDraft({ ...draft, ...patch });
	const contacted = draft.outcome === "contacted";
	const reached = contacted || draft.outcome === "attempted_no_contact";
	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-col gap-1.5">
				<span id={groupLabel} className="text-sm font-medium text-ink-2">
					What happened?
				</span>
				<RadioGroup
					aria-labelledby={groupLabel}
					aria-describedby={errors.outcome ? groupError : undefined}
					aria-required="true"
					data-invalid={errors.outcome ? "true" : undefined}
					value={draft.outcome}
					onValueChange={(v) => onDraft(pickOutcome(draft, v as OutcomeValue))}
					className="gap-2"
				>
					{outcomes.map((o) => (
						<Radio
							key={o}
							value={o}
							label={OUTCOME_LABEL[o]}
							description={OUTCOME_HINT[o]}
							className={cn(
								"rounded-card px-3.5 shadow-[inset_0_0_0_1px_var(--ef-line-2)] transition-[box-shadow] duration-150 has-[[data-state=checked]]:shadow-[inset_0_0_0_2px_var(--ef-ink)]",
								errors.outcome && "shadow-[inset_0_0_0_1.5px_var(--ef-magenta-500)]",
							)}
						/>
					))}
				</RadioGroup>
				<div aria-live="polite" className="empty:hidden">
					{errors.outcome ? (
						<p id={groupError} className="text-xs font-medium text-magenta-600">
							{errors.outcome}
						</p>
					) : null}
				</div>
			</div>

			{draft.outcome && draft.outcome !== "no_longer_needed" ? (
				<WhenField draft={draft} onDraft={onDraft} errors={errors} required={contacted} />
			) : null}

			{reached ? (
				<Field label="How" optional>
					<Select
						value={draft.channel || undefined}
						onValueChange={(v) => set({ channel: v as Draft["channel"] })}
						placeholder="Choose how"
						options={CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))}
					/>
				</Field>
			) : null}

			{draft.outcome ? (
				<Field
					label="Note"
					optional
					hint={`Facts about this follow-up only, such as a good time to call back. ${draft.notes.length.toLocaleString("en-US")} of ${NOTES_MAX.toLocaleString("en-US")} characters.`}
					error={errors.notes}
				>
					<Textarea
						value={draft.notes}
						onChange={(e) => set({ notes: e.target.value })}
						rows={3}
						className="min-h-20"
					/>
				</Field>
			) : null}

			{completable && draft.outcome && draft.outcome !== "no_longer_needed" ? (
				<Checkbox
					checked={draft.complete}
					onCheckedChange={(v) => set({ complete: v === true })}
					label="Mark the follow-up done"
					description={
						draft.outcome === "attempted_no_contact"
							? `Leave it open to try ${personName} again.`
							: "Done and contact are separate. Only Contacted counts as contact."
					}
				/>
			) : null}
		</div>
	);
}

function WhenField({
	draft,
	onDraft,
	errors,
	required,
}: {
	draft: Draft;
	onDraft: (d: Draft) => void;
	errors: DraftErrors;
	required: boolean;
}) {
	const label = useId();
	const error = useId();
	return (
		<div className="flex flex-col gap-1.5">
			<span id={label} className="text-sm font-medium text-ink-2">
				{required ? "When did you talk?" : "When did it happen?"}
				{required ? null : <span className="font-normal text-text-3"> · Optional, now if left blank</span>}
			</span>
			<div data-invalid={errors.when ? "true" : undefined} className="min-w-0">
				<SegmentedControl
					label={
						errors.when
							? `${required ? "When did you talk?" : "When did it happen?"} ${errors.when}`
							: required
								? "When did you talk?"
								: "When did it happen?"
					}
					value={draft.when as "now" | "earlier"}
					onValueChange={(when) =>
						onDraft({ ...draft, when, at: when === "earlier" && !draft.at ? localInputOf(new Date()) : draft.at })
					}
					options={[
						{ value: "now", label: "Just now" },
						{ value: "earlier", label: "Earlier" },
					]}
					className={cn(
						"w-full *:flex-1 *:justify-center",
						errors.when && "shadow-[inset_0_0_0_1.5px_var(--ef-magenta-500)]",
					)}
				/>
			</div>
			<div aria-live="polite" className="empty:hidden">
				{errors.when ? (
					<p id={error} className="text-xs font-medium text-magenta-600">
						{errors.when}
					</p>
				) : null}
			</div>
			{draft.when === "earlier" ? (
				<Field label="Date and time" error={errors.at} className="mt-2">
					<Input
						type="datetime-local"
						value={draft.at}
						max={localInputOf(new Date())}
						onChange={(e) => onDraft({ ...draft, at: e.target.value })}
					/>
				</Field>
			) : null}
		</div>
	);
}
