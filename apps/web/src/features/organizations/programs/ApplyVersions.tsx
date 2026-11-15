"use client";

import type { VersionReview } from "@everyfield/contracts/organizations";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@everyfield/ui/controls";
import { useState, useTransition, type FormEvent } from "react";
import { createRead, useRead } from "../../../components/read.tsx";
import { Problem } from "../board/Problem";
import { applyVersions, reviewVersions } from "./actions";
import { programProblem } from "./model";
import { ReviewParts } from "./VersionReview";

const lost = () => ({ status: "lost" as const });

export const versionReviews = createRead(
	(programId: string, enrollmentIds: string[]) => reviewVersions(programId, enrollmentIds).catch(lost),
	{ failed: lost },
);

function names(list: string[]) {
	return list.length < 2 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

export function ApplyVersionsDialog({
	open,
	programId,
	toNumber,
	enrollmentIds,
	onClose,
	onApplied,
}: {
	open: boolean;
	programId: string;
	toNumber: number;
	enrollmentIds: string[];
	onClose: () => void;
	onApplied: () => Promise<void>;
}) {
	return (
		<Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
			<DialogContent size="lg">
				{open ? (
					<ApplyVersionsReview
						programId={programId}
						toNumber={toNumber}
						enrollmentIds={enrollmentIds}
						onClose={onClose}
						onApplied={onApplied}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

function ApplyVersionsReview({
	programId,
	toNumber,
	enrollmentIds,
	onClose,
	onApplied,
}: {
	programId: string;
	toNumber: number;
	enrollmentIds: string[];
	onClose: () => void;
	onApplied: () => Promise<void>;
}) {
	const [listed, setListed] = useState(enrollmentIds);
	const [asked, setAsked] = useState(enrollmentIds);
	const [picked, setPicked] = useState<Record<string, string>>({});
	const [problem, setProblem] = useState<string | null>(null);
	const [saving, startSaving] = useTransition();
	const answer = useRead(versionReviews, programId, asked).value;
	const reviews = answer?.status === "ok" ? answer.value : null;
	const loadProblem =
		!answer || answer.status === "ok"
			? null
			: answer.status === "refused" && answer.refusal.code === "unavailable"
				? "We couldn’t load the review. Someone may have changed these enrollments. Close this, reload the page and select them again."
				: programProblem(answer);
	const shown = reviews?.filter((r) => listed.includes(r.enrollmentId)) ?? [];
	const number = reviews?.[0]?.toNumber ?? toNumber;
	const stageOf = (r: VersionReview) => {
		const kept = picked[r.enrollmentId];
		return kept && r.stages.some((s) => s.id === kept) ? kept : r.stageId;
	};

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!shown.length) return;
		startSaving(async () => {
			setProblem(null);
			const answer = await applyVersions({
				programId,
				versionId: shown[0]!.versionId,
				enrollments: shown.map((r) => ({ enrollmentId: r.enrollmentId, stageId: stageOf(r), basis: r.basis })),
			}).catch(lost);
			if (answer.status === "ok") return onApplied();
			if (answer.status === "refused" && answer.refusal.code === "stale_review") {
				const changed = shown
					.filter(
						(r) => answer.refusal.code === "stale_review" && answer.refusal.enrollmentIds?.includes(r.enrollmentId),
					)
					.map((r) => r.name);
				setProblem(
					changed.length === shown.length && shown.length > 1
						? "A newer version was published, or everyone’s enrollment changed, since you opened this review. Nobody was moved. Check the updated reviews below, then confirm again."
						: `Something changed for ${names(changed)} since you opened this review, so nobody was moved. Check the updated review below, then confirm again.`,
				);
				versionReviews.seed({ status: "ok", value: shown }, programId, listed);
				void versionReviews.refresh(programId, listed);
				setAsked(listed);
				return;
			}
			setProblem(programProblem(answer));
		});
	};

	const people = shown.length === 1 ? shown[0]!.name : `${shown.length} people`;
	return (
		<form onSubmit={submit} noValidate className="contents">
			<DialogHeader
				title={`Apply Version ${number} to ${reviews ? people : `${listed.length} people`}`}
				description="Review what changes for each person. Nothing is saved until you confirm, and everyone listed moves together."
			/>
			<DialogBody className="flex flex-col gap-5">
				<Problem text={loadProblem ?? problem} />
				{reviews ? (
					shown.length ? (
						shown.map((r) => (
							<section
								key={r.enrollmentId}
								aria-label={r.name}
								className="flex flex-col gap-4 border-t border-line pt-5 first-of-type:border-t-0 first-of-type:pt-0"
							>
								<div className="flex items-start justify-between gap-3">
									<div className="min-w-0">
										<h3 className="font-title text-title-sm [overflow-wrap:anywhere] text-ink">{r.name}</h3>
										<p className="text-sm text-text-2">
											Version {r.fromNumber} to Version {r.toNumber}
										</p>
									</div>
									<Button
										variant="ghost"
										size="sm"
										className="flex-none"
										aria-label={`Remove ${r.name} from this review`}
										disabled={saving}
										onClick={() => setListed((ids) => ids.filter((id) => id !== r.enrollmentId))}
									>
										Remove
									</Button>
								</div>
								<ReviewParts
									review={r}
									heading="h4"
									stageId={stageOf(r)}
									onStageChange={(stageId) => setPicked((s) => ({ ...s, [r.enrollmentId]: stageId }))}
								/>
							</section>
						))
					) : (
						<p className="text-sm text-text-3">Nobody is left in this review. Cancel and select people again.</p>
					)
				) : loadProblem || problem ? null : (
					<p className="text-sm text-text-3">Loading the review…</p>
				)}
			</DialogBody>
			<DialogFooter>
				<Button variant="ghost" onClick={onClose} disabled={saving}>
					Cancel
				</Button>
				<Button type="submit" variant="primary" loading={saving} disabled={!shown.length}>
					{shown.length ? `Apply Version ${number} to ${people}` : `Apply Version ${number}`}
				</Button>
			</DialogFooter>
		</form>
	);
}
