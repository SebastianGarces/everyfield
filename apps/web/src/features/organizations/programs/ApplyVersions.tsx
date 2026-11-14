"use client";

import type { VersionReview } from "@everyfield/contracts/organizations";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@everyfield/ui/controls";
import { useEffect, useState, type FormEvent } from "react";
import { Problem } from "../board/Problem";
import { applyVersions, reviewVersions } from "./actions";
import { programProblem } from "./model";
import { ReviewParts } from "./VersionReview";

const lost = () => ({ status: "lost" as const });

/** "Casey Lee", "Casey Lee and Jordan Price", "Casey Lee, Jordan Price and Riley Shaw". */
function names(list: string[]) {
	return list.length < 2 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

/**
 * The director's review before applying the program's current version to the selected enrollments at once
 * (REQ-MUL-011, D-1328, D-1329): one section per person with what changes for them and their stage on the new version.
 * The director can take a person out of the review. Nothing is saved until they confirm, and then everyone listed
 * moves or nobody does: if anyone's review went out of date, the dialog names them and loads fresh reviews.
 */
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
	// The people still in the review, and each loaded review; a fresh load reads `load.ids` again.
	const [listed, setListed] = useState(enrollmentIds);
	const [load, setLoad] = useState({ ids: enrollmentIds, attempt: 0 });
	const [reviews, setReviews] = useState<VersionReview[] | null>(null);
	const [stages, setStages] = useState<Record<string, string>>({});
	const [saving, setSaving] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const shown = reviews?.filter((r) => listed.includes(r.enrollmentId)) ?? [];
	const number = reviews?.[0]?.toNumber ?? toNumber;

	useEffect(() => {
		let current = true;
		void reviewVersions(programId, load.ids)
			.catch(lost)
			.then((answer) => {
				if (!current) return;
				if (answer.status !== "ok") {
					setReviews(null);
					return setProblem(
						answer.status === "refused" && answer.refusal.code === "unavailable"
							? "We couldn’t load the review. Someone may have changed these enrollments. Close this, reload the page and select them again."
							: programProblem(answer),
					);
				}
				setReviews(answer.value);
				// Keep a stage the director already picked while it is still a stage of the version.
				setStages((picked) =>
					Object.fromEntries(
						answer.value.map((r) => {
							const kept = picked[r.enrollmentId];
							return [r.enrollmentId, kept && r.stages.some((s) => s.id === kept) ? kept : r.stageId];
						}),
					),
				);
			});
		return () => {
			current = false;
		};
	}, [programId, load]);

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!shown.length) return;
		setSaving(true);
		setProblem(null);
		const answer = await applyVersions({
			programId,
			versionId: shown[0]!.versionId,
			enrollments: shown.map((r) => ({
				enrollmentId: r.enrollmentId,
				stageId: stages[r.enrollmentId] ?? r.stageId,
				basis: r.basis,
			})),
		}).catch(lost);
		setSaving(false);
		if (answer.status === "ok") return onApplied();
		if (answer.status === "refused" && answer.refusal.code === "stale_review") {
			const changed = shown
				.filter((r) => answer.refusal.code === "stale_review" && answer.refusal.enrollmentIds?.includes(r.enrollmentId))
				.map((r) => r.name);
			setProblem(
				changed.length === shown.length && shown.length > 1
					? "A newer version was published, or everyone’s enrollment changed, since you opened this review. Nobody was moved. Check the updated reviews below, then confirm again."
					: `Something changed for ${names(changed)} since you opened this review, so nobody was moved. Check the updated review below, then confirm again.`,
			);
			setLoad({ ids: listed, attempt: load.attempt + 1 });
			return;
		}
		setProblem(programProblem(answer));
	}

	const people = shown.length === 1 ? shown[0]!.name : `${shown.length} people`;
	return (
		<form onSubmit={submit} noValidate className="contents">
			<DialogHeader
				title={`Apply Version ${number} to ${reviews ? people : `${listed.length} people`}`}
				description="Review what changes for each person. Nothing is saved until you confirm, and everyone listed moves together."
			/>
			<DialogBody className="flex flex-col gap-5">
				<Problem text={problem} />
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
									stageId={stages[r.enrollmentId] ?? r.stageId}
									onStageChange={(stageId) => setStages((s) => ({ ...s, [r.enrollmentId]: stageId }))}
								/>
							</section>
						))
					) : (
						<p className="text-sm text-text-3">Nobody is left in this review. Cancel and select people again.</p>
					)
				) : problem ? null : (
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
