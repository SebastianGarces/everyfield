import { z } from "zod";
import { recordId } from "../common/values.ts";
import { instant, localDate } from "../common/time.ts";
import { criterionKey, phaseNumber } from "../phases/index.ts";
import type { SignalKey } from "./signals.ts";

// What the Plant Intelligence screen, Overview and an organization's oversight read from a published assessment
// (WP-044, PI-024 to PI-033). Everything here is derived from the run's own stored snapshot and result when it is read:
// the eight lens tiles, the assessed phase's exit criteria with their evidence, the concerns an organization may see,
// and dated trends. Nothing here calls a model, and nothing changes the run.

/** One citable fact value, as a citation, tile or concern shows it. */
const factValue = z.union([z.number(), z.string(), z.boolean(), z.array(z.number()), z.null()]);
export const evidenceFact = z.strictObject({ key: z.string(), label: z.string(), value: factValue });
export type EvidenceFact = z.infer<typeof evidenceFact>;

/**
 * The eight Critical Success Factor lenses (rubric v1 §4), in rubric order. `facts` are the fact groups that measure a
 * lens, `attestations` the planter's answers that can stand for it when nothing is measured (rubric v1 §5b). A fact
 * key's group is its text before the first dot; an attestation key is `attestations.<signal>`.
 */
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
	/** The facts a tile shows, at most three. */
	headline: readonly string[];
}[];
export const lensKey = z.enum(LENSES.map((l) => l.key) as [LensKey, ...LensKey[]]);
export type LensKey = (typeof LENSES)[number]["key"];

/** The lens a cited fact key belongs to, or null for launch dates and human-record counts, which feed no lens. */
export function lensOfKey(key: string): LensKey | null {
	const [group, signal] = key.split(".");
	for (const l of LENSES) {
		const keys: readonly string[] = group === "attestations" ? l.attestations : l.facts;
		if (keys.includes((group === "attestations" ? signal : group) ?? "")) return l.key;
	}
	return null;
}

/**
 * One lens tile. `quality` is what the snapshot holds for the lens: something measured, only the planter's answer, or
 * nothing (rubric v1 §5b; Unknown is never healthy). `standing` is the assessment's judgment: the strongest point that
 * cites the lens, `not_raised` when no point does, and `insufficient` when no point does and nothing is known.
 */
export const lensTile = z.strictObject({
	key: lensKey,
	label: z.string(),
	quality: z.enum(["measured", "attested", "unknown"]),
	standing: z.enum(["attention", "watch", "noted", "strength", "not_raised", "insufficient"]),
	/** The measured facts behind the tile, at most three. */
	evidence: z.array(evidenceFact).max(3),
	/** Each attestation the lens rests on, with its own date and age; a stale answer stays attested. */
	attestations: z.array(
		z.strictObject({
			key: z.string(),
			label: z.string(),
			answered: z.boolean(),
			asOf: localDate.nullable(),
			needsRenewing: z.boolean(),
		}),
	),
	/** The ordinals of the points that cite this lens, strongest first. */
	points: z.array(z.int().min(0)),
});
export type LensTile = z.infer<typeof lensTile>;

/**
 * The snapshot facts that are evidence for each exit criterion the facts can speak to. A criterion with none shows no
 * evidence, and stays as the snapshot measured it (Unknown unless measured).
 */
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
};

/** One exit criterion of the assessed phase, as the snapshot measured it, with the facts behind it. */
export const assessedCriterion = z.strictObject({
	key: criterionKey,
	label: z.string(),
	status: z.enum(["met", "not_met", "unknown", "not_tracked"]),
	evidence: z.array(evidenceFact),
});
export type AssessedCriterion = z.infer<typeof assessedCriterion>;

/**
 * A concern: a point the assessment raised at watch or urgent. Its id is the run and the point's ordinal, so the
 * planter's screen and an organization's oversight read name the same concern with the same fact evidence. Only
 * structured fields: never the point's words, a passage, a person or a check-in.
 */
export const concern = z.strictObject({
	id: z.string().regex(/^[0-9a-f-]{36}:\d+$/),
	ordinal: z.int().min(0),
	severity: z.enum(["medium", "high"]),
	lens: lensKey.nullable(),
	evidence: z.array(evidenceFact),
});
export type Concern = z.infer<typeof concern>;
export const concernId = (runId: string, ordinal: number) => `${runId}:${ordinal}`;

/** The reader's own rating of one point of one run, with an optional comment. Nobody else reads it. */
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
/** intelligence.submitFeedback: a rating and an optional comment (blank means none) on one point of one run. */
export const submitFeedbackRequest = z.strictObject({
	runId: recordId,
	ordinal: z.int().min(0).max(5),
	rating: feedbackRating,
	comment: z.string().max(FEEDBACK_COMMENT_MAX),
});
export const feedbackReceipt = z.strictObject({ outcome: z.enum(["saved", "unchanged"]), feedback: ownFeedback });
export type FeedbackReceipt = z.infer<typeof feedbackReceipt>;

/** intelligence.markAssessmentSeen: the Owner's or Admin's explicit open of one published run. */
export const markSeenRequest = z.strictObject({ runId: recordId });
export const seenReceipt = z.strictObject({ outcome: z.enum(["recorded", "already_seen"]) });
export type SeenReceipt = z.infer<typeof seenReceipt>;

/**
 * The facts the trends view follows, by their path in the stored snapshot. A snapshot written before a fact existed holds no value for it: it
 * reads Not measured, never zero. A fact the snapshot measured as Unknown reads Unknown.
 */
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
/** At most this many complete original snapshots, newest first. */
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
