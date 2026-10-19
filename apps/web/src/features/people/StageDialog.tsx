"use client";

import { ArrowRight01Icon, UserCheck01Icon } from "@hugeicons/core-free-icons";
import type * as people from "@everyfield/contracts/people";
import {
	Button,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Field,
	Select,
	Skeleton,
	Textarea,
} from "@everyfield/ui/controls";
import { StageChip, StatusBadge } from "@everyfield/ui/display";
import { Icon } from "@everyfield/ui/foundations";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { z } from "zod";
import { changeStatus } from "./actions.ts";
import {
	leavesCommitted,
	runSave,
	skippedStages,
	STAGE_KEY,
	STAGE_LABEL,
	STAGES,
	type PersonStore,
	type StageValue,
} from "./model.ts";
import { FormProblem, fresh, problemOf, useStore, useWarnings } from "./parts.tsx";

type PlantPerson = z.infer<typeof people.plantPerson>;
type Warnings = z.infer<typeof people.statusWarningsResult>;
export type StageDraft = { stage: StageValue | null; reason: string };
/** Drafts of different forms share one store; each form reads its own slot and knows its own shape. */
export type PersonDraft = unknown;

const WARNING: Record<Warnings["warnings"][number], string> = {
	interview_not_recorded: "No interview is recorded for this person.",
	commitment_not_recorded: "No current commitment is recorded for this person.",
	open_duties: "This person has open follow-up work.",
};

/**
 * Change stage (REQ-PPL-006): one command from the profile and the pipeline. It shows recorded-evidence warnings and the
 * stages a move skips, asks for a reason, and when a person leaves core group, launch team or leader it lists every
 * open duty that will need an owner. Warnings guide; they never block (hardGate is false).
 */
export function StageDialog({
	open,
	onOpenChange,
	store,
	target,
	onDone,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	store: PersonStore<PlantPerson, PersonDraft>;
	/** A stage chosen before the dialog opened, such as a pipeline drop. */
	target?: StageValue;
	onDone?: (person: PlantPerson) => void;
}) {
	const router = useRouter();
	const state = useStore(store);
	const person = state.saved;
	const pending = state.pending === "stage";
	const draft = (state.drafts.stage as StageDraft | undefined) ?? { stage: target ?? null, reason: "" };
	const warnings = useWarnings(person.id, person.revision);
	const [touched, setTouched] = useState(false);

	const set = (patch: Partial<StageDraft>) =>
		store.dispatch({ type: "edit", slot: "stage", draft: { ...draft, ...patch } });
	const close = (next: boolean) => {
		if (pending) return;
		if (!next) {
			store.dispatch({ type: "discard", slot: "stage" });
			setTouched(false);
		}
		onOpenChange(next);
	};

	const chosen = draft.stage;
	const ready = warnings?.status === "ok" ? warnings.value : null;
	const handoffs =
		ready && chosen && leavesCommitted(person.stage, chosen)
			? ready.openDuties.map((d) => ({ kind: "needs_owner" as const, dutyId: d.id, expectedRevision: d.revision }))
			: [];
	const reasonMissing = draft.reason.trim() === "";
	const first = person.displayName.split(" ")[0] ?? person.displayName;

	async function submit() {
		setTouched(true);
		if (!chosen || reasonMissing || !ready || chosen === person.stage) return;
		const input = { personId: person.id, stage: chosen, reason: draft.reason.trim(), handoffs };
		const rev = person.revision;
		const result = await runSave(store, "stage", { input, rev }, (key) => changeStatus(key, rev, input), {
			fresh,
			toPerson: (p) => p,
		});
		if (result?.status === "ok") {
			setTouched(false);
			onOpenChange(false);
			onDone?.(result.value);
			router.refresh();
		} else if (result?.status === "refused" && result.code === "conflict") router.refresh();
	}

	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent aria-busy={pending || undefined}>
				<DialogHeader
					icon={UserCheck01Icon}
					tone="green"
					title={chosen ? `Move ${first} to ${STAGE_LABEL[chosen].toLowerCase()}` : `Change ${first}'s stage`}
					description={`Now ${STAGE_LABEL[person.stage].toLowerCase()}`}
				/>
				<DialogBody className="flex flex-col gap-5">
					<div className="rounded-[18px] bg-surface p-4">
						<div className="flex flex-wrap items-end gap-4">
							<div>
								<div className="text-sm text-text-3">Now</div>
								<StageChip stage={STAGE_KEY[person.stage]} className="mt-2">
									{STAGE_LABEL[person.stage]}
								</StageChip>
							</div>
							<Icon icon={ArrowRight01Icon} size={18} className="mb-1 text-text-3" />
							<Field
								label="New stage"
								className="min-w-[200px] flex-1"
								error={touched && !chosen ? "Choose a stage." : null}
							>
								<Select
									value={chosen ?? ""}
									onValueChange={(v) => set({ stage: v as StageValue })}
									disabled={pending}
									placeholder="Choose a stage"
									options={STAGES.filter((s) => s !== person.stage).map((s) => ({ value: s, label: STAGE_LABEL[s] }))}
								/>
							</Field>
						</div>
					</div>

					{!warnings ? (
						<div aria-busy="true" className="flex flex-col gap-2">
							<span className="sr-only" role="status">
								Checking recorded evidence
							</span>
							<Skeleton className="h-4 w-3/4" />
							<Skeleton className="h-4 w-1/2" />
						</div>
					) : warnings.status !== "ok" ? (
						<FormProblem code={problemOf(warnings)} />
					) : (
						<Guidance warnings={warnings.value} from={person.stage} to={chosen} handoffs={handoffs.length} />
					)}

					<Field
						label="Reason"
						hint="Saved with the stage history. Everyone who can see this person can read it."
						error={touched && reasonMissing ? "Say why the stage changes." : null}
					>
						<Textarea
							value={draft.reason}
							readOnly={pending}
							maxLength={5000}
							rows={3}
							onChange={(e) => set({ reason: e.target.value })}
						/>
					</Field>
					<FormProblem code={state.errors.stage} />
				</DialogBody>
				<DialogFooter>
					<Button variant="secondary" onClick={() => close(false)} disabled={pending}>
						Cancel
					</Button>
					<Button variant="primary" onClick={submit} loading={pending} disabled={!ready}>
						{chosen ? `Move to ${STAGE_LABEL[chosen].toLowerCase()}` : "Change stage"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function Guidance({
	warnings,
	from,
	to,
	handoffs,
}: {
	warnings: Warnings;
	from: StageValue;
	to: StageValue | null;
	handoffs: number;
}) {
	const skipped = to ? skippedStages(from, to) : [];
	const notes = warnings.warnings.filter((w) => w !== "open_duties").map((w) => WARNING[w]);
	if (!skipped.length && !notes.length && !handoffs) return null;
	return (
		<section aria-label="Before you move" className="flex flex-col gap-3">
			{skipped.length ? (
				<p className="flex flex-wrap items-center gap-2 text-sm text-text-2">
					<StatusBadge status="attention" size="sm">
						Skips {skipped.length === 1 ? "a stage" : `${skipped.length} stages`}
					</StatusBadge>
					{skipped.map((s) => STAGE_LABEL[s]).join(", ")}
				</p>
			) : null}
			{notes.length ? (
				<ul className="flex flex-col gap-1.5 text-sm text-text-2">
					{notes.map((n) => (
						<li key={n} className="flex gap-2.5">
							<span aria-hidden="true" className="mt-[7px] size-1.5 flex-none rounded-full bg-amber-500" />
							{n}
						</li>
					))}
				</ul>
			) : null}
			{handoffs ? (
				<div className="rounded-[14px] bg-amber-50 px-4 py-3 text-sm text-ink-2">
					<p className="font-medium text-ink">
						{handoffs === 1 ? "1 open duty needs an owner" : `${handoffs} open duties need an owner`}
					</p>
					<p className="mt-1">
						Leaving the committed stages takes this person off their open follow-up work. Each duty stays open and is
						marked Needs owner, so nothing is lost.
					</p>
				</div>
			) : null}
			<p className="text-xs text-text-3">These are reminders from the records. You can still move the person.</p>
		</section>
	);
}
