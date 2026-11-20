import type * as c from "@everyfield/contracts/people";
import { fourCs, interviewCriteria } from "@everyfield/contracts/people";
import type { z } from "zod";
import { STAGES, type StageValue } from "../model.ts";

export type Assessment = z.infer<typeof c.assessment>;
export type Interview = z.infer<typeof c.interview>;
export type Commitment = z.infer<typeof c.commitment>;
export type CommitmentStatus = z.infer<typeof c.commitmentStatus>;
export type FirstAcquisition = z.infer<typeof c.commitmentsResult>["firstAcquisition"];
export type Assessments = z.infer<typeof c.assessmentsResult>;
export type Interviews = z.infer<typeof c.interviewsResult>;
export type Commitments = z.infer<typeof c.commitmentsResult>;
export type Lens = (typeof c.fourCs)[number];
export type CriterionKey = (typeof c.interviewCriteria)[number];
export type Rating = z.infer<typeof c.criterionRating>;
export type Result = z.infer<typeof c.interviewResult>;
export type Kind = z.infer<typeof c.commitmentKind>;

export type PersonRecords = {
	assessments: Assessments | null;
	interviews: Interviews | null;
	commitments: Commitments | null;
};

export const LENSES: readonly Lens[] = fourCs;
export const LENS_LABEL: Record<Lens, string> = {
	committed: "Committed",
	compelled: "Compelled",
	contagious: "Contagious",
	courageous: "Courageous",
};
export const CRITERIA: readonly CriterionKey[] = interviewCriteria;
export const CRITERION_LABEL: Record<CriterionKey, string> = {
	maturity: "Maturity",
	gifted: "Giftedness",
	chemistry: "Chemistry",
	rightReasons: "Right reasons",
	season: "Season of life",
};
export const RATINGS: readonly Rating[] = ["pass", "concern", "fail"];
export const RATING_LABEL: Record<Rating, string> = { pass: "Pass", concern: "Concern", fail: "Fail" };
export const RESULTS: readonly Result[] = ["qualified", "qualified_with_notes", "follow_up", "not_qualified"];
export const RESULT_LABEL: Record<Result, string> = {
	qualified: "Qualified",
	qualified_with_notes: "Qualified with notes",
	follow_up: "Follow up",
	not_qualified: "Not qualified",
};
export const RESULT_STATUS = {
	qualified: "positive",
	qualified_with_notes: "measured",
	follow_up: "attention",
	not_qualified: "risk",
} as const satisfies Record<Result, string>;
export const KIND_LABEL: Record<Kind, string> = { core_group: "Core group", launch_team: "Launch team" };

export function advancedStage(stage: StageValue, target: "interviewed" | "core_group"): StageValue {
	return STAGES.indexOf(stage) < STAGES.indexOf(target) ? target : stage;
}

export function withCard(first: FirstAcquisition, card: Pick<Commitment, "id" | "occurredOn">): FirstAcquisition {
	if (first.status === "unknown") return first;
	if (first.status === "known" && first.occurredOn <= card.occurredOn) return first;
	return { status: "known", occurredOn: card.occurredOn, evidenceId: card.id };
}

export function withRecord<R extends { id: string; occurredOn: string; recordedAt: string }>(
	items: readonly R[],
	record: R,
): R[] {
	const rest = items.filter((r) => r.id !== record.id);
	return [...rest, record].sort(
		(a, b) =>
			b.occurredOn.localeCompare(a.occurredOn) || b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id),
	);
}

export function withCorrections<R extends { id: string; occurredOn: string; recordedAt: string; revision: string }>(
	items: readonly R[],
	corrections: readonly R[],
): R[] {
	return corrections.reduce<R[]>(
		(shown, record) => {
			const held = shown.find((r) => r.id === record.id);
			return held && BigInt(record.revision) > BigInt(held.revision) ? withRecord(shown, record) : shown;
		},
		[...items],
	);
}

export const totalOf = (scores: readonly (number | null)[]) =>
	scores.every((s) => s !== null) ? scores.reduce<number>((t, s) => t + (s ?? 0), 0) : null;

export const firstName = (name: string) => name.split(" ")[0] || name;
