import { z } from "zod";
import { instant, localDate } from "../common/time.ts";
import { stage } from "./values.ts";

// people.readPipelineMetrics (PPL-023): an internal count of recorded pipeline moves. It has no screen and no Evry tool,
// and its rates are never readiness or a Plant Intelligence measure (REQ-PPL-023).

/** The forward step after each stage, in pipeline order. Leader has none. */
export const NEXT_STAGE: Partial<Record<z.infer<typeof stage>, z.infer<typeof stage>>> = {
	prospect: "attendee",
	attendee: "following_up",
	following_up: "interviewed",
	interviewed: "core_group",
	core_group: "launch_team",
	launch_team: "leader",
};

/**
 * A frozen observation time and an occurrence-date window in the church's own days, inclusive. The transition is one
 * exact adjacent forward step, such as prospect to attendee.
 */
export const pipelineMetricsRequest = z
	.strictObject({
		asOf: instant,
		from: localDate,
		through: localDate,
		transition: z.strictObject({ from: stage, to: stage }),
	})
	.refine((v) => v.from <= v.through && NEXT_STAGE[v.transition.from] === v.transition.to);

export const pipelineMetrics = z.strictObject({
	asOf: instant,
	/** How many recorded stage moves, at or before asOf, the answer read: the source history's revision. */
	sourceRevision: z.int().min(0),
	window: z.strictObject({ from: localDate, through: localDate, timeZone: z.string() }),
	unit: z.literal("distinct_canonical_people"),
	/** Live canonical People in each stage at asOf. */
	currentStageCounts: z.record(stage, z.int().min(0)),
	transition: z.strictObject({ from: stage, to: stage }),
	/** Distinct canonical People who made the step at least once in the window; repeats after a move back count once. */
	distinctTransitionPeople: z.int().min(0),
	/** The People in the source stage when the window opened, when that cohort can be rebuilt from the history. */
	denominator: z.int().min(0).nullable(),
	conversionRatio: z.strictObject({ numerator: z.int().min(0), denominator: z.int().min(1) }).nullable(),
	conversionRatioStatus: z.enum(["known", "unknown"]),
	/** Why the ratio is Unknown: nobody was in the source stage, or the history cannot rebuild who was. */
	reason: z.enum(["empty_cohort", "cohort_unavailable"]).nullable(),
});
export type PipelineMetrics = z.infer<typeof pipelineMetrics>;
