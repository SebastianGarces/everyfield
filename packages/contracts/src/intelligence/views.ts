import { z } from "zod";
import { recordId } from "../common/values.ts";
import { instant, localDate } from "../common/time.ts";
import { criterionKey, phaseNumber } from "../phases/index.ts";
import type { SignalKey } from "./signals.ts";

const factValue = z.union([z.number(), z.string(), z.boolean(), z.array(z.number()), z.null()]);
export const evidenceFact = z.strictObject({ key: z.string(), label: z.string(), value: factValue });
export type EvidenceFact = z.infer<typeof evidenceFact>;

export const LENSES = [
	{
		key: "vision",
		label: "Vision Casting",
		facts: ["vision"],
		attestations: [],
		headline: ["vision.daysSince", "vision.lastHeldOn"],
	},
	{
		key: "ownership",
		label: "Shared Ownership",
		facts: ["followUps"],
		attestations: [],
		headline: ["followUps.onTime", "followUps.measured"],
	},
	{
		key: "critical_mass",
		label: "Critical Mass",
		facts: ["committedAdults", "growth"],
		attestations: [],
		headline: ["committedAdults.atLeast", "growth.daysSince", "growth.current"],
	},
	{
		key: "cohesion",
		label: "Core Group Cohesion",
		facts: ["cohesion"],
		attestations: [],
		headline: ["cohesion.disengaged", "cohesion.committed"],
	},
	{
		key: "prayer",
		label: "Prayer",
		facts: [],
		attestations: ["prayer_rhythm_established", "prayer_in_gatherings"],
		headline: [],
	},
	{
		key: "generosity",
		label: "Generosity & Financial Readiness",
		facts: [],
		attestations: ["core_group_giving", "financial_base_established"],
		headline: [],
	},
	{
		key: "leadership",
		label: "Emerging Leadership",
		facts: ["coverage"],
		attestations: ["prayer_leader_assigned"],
		headline: ["coverage.filled", "coverage.people", "coverage.prayerLeader"],
	},
	{
		key: "training",
		label: "Comprehensive Training",
		facts: ["training"],
		attestations: [],
		headline: ["training.complete", "training.total"],
	},
] as const satisfies readonly {
	key: string;
	label: string;
	facts: readonly string[];
	attestations: readonly SignalKey[];
	headline: readonly string[];
}[];
export const lensKey = z.enum(LENSES.map((l) => l.key) as [LensKey, ...LensKey[]]);
export type LensKey = (typeof LENSES)[number]["key"];

export function lensOfKey(key: string): LensKey | null {
	const [group, signal] = key.split(".");
	for (const l of LENSES) {
		const keys: readonly string[] = group === "attestations" ? l.attestations : l.facts;
		if (keys.includes((group === "attestations" ? signal : group) ?? "")) return l.key;
	}
	return null;
}

export const lensTile = z.strictObject({
	key: lensKey,
	label: z.string(),
	quality: z.enum(["measured", "attested", "unknown"]),
	standing: z.enum(["attention", "watch", "noted", "strength", "not_raised", "insufficient"]),
	evidence: z.array(evidenceFact).max(3),
	attestations: z.array(
		z.strictObject({
			key: z.string(),
			label: z.string(),
			answered: z.boolean(),
			asOf: localDate.nullable(),
			needsRenewing: z.boolean(),
		}),
	),
	points: z.array(z.int().min(0)),
});
export type LensTile = z.infer<typeof lensTile>;

export const CRITERION_EVIDENCE: Partial<Record<z.infer<typeof criterionKey>, readonly string[]>> = {
	values_documented: ["attestations.values_documented", "attestations.values_documented.asOf"],
	committed_adults: ["committedAdults.atLeast", "committedAdults.count", "committedAdults.needsClassifying"],
	growth_trajectory: ["growth.daysSince", "growth.lastAcquiredOn"],
	financial_base: ["attestations.financial_base_established", "attestations.financial_base_established.asOf"],
	all_team_leaders: ["coverage.filled", "coverage.slots", "coverage.people"],
	launch_date_set: ["launch.targetOn"],
	training_complete: ["training.complete", "training.total"],
	systems_tested: ["attestations.systems_tested", "attestations.systems_tested.asOf"],
	launch_window: ["launch.daysToLaunch"],
	first_service_complete: ["firstService.milestone", "firstService.heldOn"],
};

export const assessedCriterion = z.strictObject({
	key: criterionKey,
	label: z.string(),
	status: z.enum(["met", "not_met", "unknown", "not_tracked"]),
	evidence: z.array(evidenceFact),
});
export type AssessedCriterion = z.infer<typeof assessedCriterion>;

export const concern = z.strictObject({
	id: z.string().regex(/^[0-9a-f-]{36}:\d+$/),
	ordinal: z.int().min(0),
	severity: z.enum(["medium", "high"]),
	lens: lensKey.nullable(),
	evidence: z.array(evidenceFact),
});
export type Concern = z.infer<typeof concern>;
export const concernId = (runId: string, ordinal: number) => `${runId}:${ordinal}`;

export const FEEDBACK_COMMENT_MAX = 1000;
export const feedbackRating = z.enum(["useful", "not_useful"]);
export type FeedbackRating = z.infer<typeof feedbackRating>;
export const ownFeedback = z.strictObject({
	ordinal: z.int().min(0),
	rating: feedbackRating,
	comment: z.string().nullable(),
	recordedAt: instant,
});
export type OwnFeedback = z.infer<typeof ownFeedback>;
export const submitFeedbackRequest = z.strictObject({
	runId: recordId,
	ordinal: z.int().min(0).max(5),
	rating: feedbackRating,
	comment: z.string().max(FEEDBACK_COMMENT_MAX),
});
export const feedbackReceipt = z.strictObject({ outcome: z.enum(["saved", "unchanged"]), feedback: ownFeedback });
export type FeedbackReceipt = z.infer<typeof feedbackReceipt>;

export const markSeenRequest = z.strictObject({ runId: recordId });
export const seenReceipt = z.strictObject({ outcome: z.enum(["recorded", "already_seen"]) });
export type SeenReceipt = z.infer<typeof seenReceipt>;

export const TREND_FACTS = [
	{ key: "committedAdults.known", label: "Committed adults known" },
	{ key: "growth.current", label: "New adults in the last 28 days" },
	{ key: "vision.daysSince", label: "Days since the last Vision meeting" },
	{ key: "followUps.onTime", label: "Follow-ups done within 48 hours" },
	{ key: "coverage.filled", label: "Ministry responsibilities filled (of 8)" },
	{ key: "training.complete", label: "Required training completed" },
] as const;
export const trendValue = z.discriminatedUnion("state", [
	z.strictObject({ state: z.literal("measured"), value: z.number() }),
	z.strictObject({ state: z.literal("unknown") }),
	z.strictObject({ state: z.literal("not_measured") }),
]);
export type TrendValue = z.infer<typeof trendValue>;
export const TREND_RUNS = 12;
export const trendRun = z.strictObject({
	runId: recordId,
	asOf: instant,
	measuredOn: localDate,
	phase: phaseNumber,
	values: z.array(trendValue).length(TREND_FACTS.length),
});
export const assessmentHistory = z.strictObject({ runs: z.array(trendRun).max(TREND_RUNS) });
export type AssessmentHistory = z.infer<typeof assessmentHistory>;
export const readAssessmentHistoryRequest = z.strictObject({});
