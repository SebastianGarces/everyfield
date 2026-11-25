"use client";

import { dayText } from "@everyfield/contracts/common";
import {
	ENROLLMENT_END_NOTES,
	ENROLLMENT_STATUS,
	enrollmentOutcome,
	type EnrollmentDetail,
	type EnrollmentOutcome,
} from "@everyfield/contracts/organizations";
import {
	Button,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	InlineAlert,
	Radio,
	RadioGroup,
} from "@everyfield/ui/controls";
import { useState, useTransition, type FormEvent } from "react";
import { endEnrollment } from "./actions";
import { endProblem, formatMeeting } from "./model";
import { Detail } from "./ProgramScreen";

const lost = () => ({ status: "lost" as const });
const MEANING: Record<EnrollmentOutcome, string> = {
	completed: "They finished the program.",
	withdrawn: "They left before finishing.",
};

type Props = {
	enrollment: EnrollmentDetail;
	onClose: () => void;
	onEnded: (outcome: EnrollmentOutcome) => Promise<void>;
	reread: () => Promise<EnrollmentDetail | null>;
};

export function EndEnrollmentDialog({ open, ...props }: Props & { open: boolean }) {
	const [saving, startSaving] = useTransition();
	return (
		<Dialog open={open} onOpenChange={(next) => (next || saving ? null : props.onClose())}>
			<DialogContent size="sm" aria-busy={saving || undefined}>
				{open ? <EndForm {...props} saving={saving} startSaving={startSaving} /> : null}
			</DialogContent>
		</Dialog>
	);
}

function EndForm({
	enrollment,
	onClose,
	onEnded,
	reread,
	saving,
	startSaving,
}: Props & { saving: boolean; startSaving: (work: () => Promise<void>) => void }) {
	const [pick, setPick] = useState<EnrollmentOutcome | null>(null);
	const [problem, setProblem] = useState<{ text: string; current: boolean } | null>(null);
	const { person, program } = enrollment;
	const canEnd = enrollment.status === "active" && enrollment.viewer.director;

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (saving || !canEnd) return;
		if (!pick) return setProblem({ text: "Choose Completed or Withdrawn.", current: false });
		startSaving(async () => {
			setProblem(null);
			const answer = await endEnrollment({
				enrollmentId: enrollment.id,
				expectedRevision: enrollment.revision,
				outcome: pick,
			}).catch(lost);
			if (answer.status === "ok") return onEnded(pick);
			const now = await reread();
			setProblem({ text: endProblem(answer, now), current: now !== null });
		});
	};

	return (
		<form onSubmit={submit} noValidate className="contents">
			<DialogHeader
				title={`End ${person.name}’s enrollment`}
				description={`${program.name}, Version ${enrollment.versionNumber}`}
			/>
			<DialogBody className="flex flex-col gap-4">
				<RadioGroup
					aria-label="How it ended"
					value={pick ?? ""}
					disabled={saving || !canEnd}
					onValueChange={(v) => {
						setPick(enrollmentOutcome.parse(v));
						setProblem(null);
					}}
				>
					{enrollmentOutcome.options.map((o) => (
						<Radio key={o} value={o} label={ENROLLMENT_STATUS[o]} description={MEANING[o]} />
					))}
				</RadioGroup>
				<ul className="flex list-disc flex-col gap-1 rounded-md bg-surface-2 py-3 pr-3 pl-7 text-sm text-ink-2">
					{ENROLLMENT_END_NOTES.map((note) => (
						<li key={note}>{note}</li>
					))}
				</ul>
				<InlineAlert live="polite">{problem?.text}</InlineAlert>
				{problem?.current ? (
					<section aria-label="The enrollment now">
						<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
							<Detail term="Status now">{ENROLLMENT_STATUS[enrollment.status]}</Detail>
							<Detail term="Plan">{`Version ${enrollment.versionNumber}`}</Detail>
							<Detail term="Program stage">{enrollment.stage.label}</Detail>
							<Detail term="Cohort">{enrollment.cohort}</Detail>
							<Detail term="Expected end">{dayText(enrollment.expectedEndOn)}</Detail>
							<Detail term="Next meeting">
								{enrollment.nextMeeting ? formatMeeting(enrollment.nextMeeting.at, dayText) : "Not set"}
							</Detail>
						</dl>
					</section>
				) : null}
			</DialogBody>
			<DialogFooter>
				<Button variant="ghost" onClick={onClose} disabled={saving}>
					{canEnd ? "Cancel" : "Close"}
				</Button>
				{canEnd ? (
					<Button type="submit" variant="primary" loading={saving}>
						End enrollment
					</Button>
				) : null}
			</DialogFooter>
		</form>
	);
}
