import { z } from "zod";
import { instant, localDate } from "../common/time.ts";
import { stage } from "./values.ts";

export const NEXT_STAGE: Partial<Record<z.infer<typeof stage>, z.infer<typeof stage>>> = {
	prospect: "attendee",
	attendee: "following_up",
	following_up: "interviewed",
	interviewed: "core_group",
	core_group: "launch_team",
	launch_team: "leader",
};

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
	sourceRevision: z.int().min(0),
	window: z.strictObject({ from: localDate, through: localDate, timeZone: z.string() }),
	unit: z.literal("distinct_canonical_people"),
	currentStageCounts: z.record(stage, z.int().min(0)),
	transition: z.strictObject({ from: stage, to: stage }),
	distinctTransitionPeople: z.int().min(0),
	denominator: z.int().min(0).nullable(),
	conversionRatio: z.strictObject({ numerator: z.int().min(0), denominator: z.int().min(1) }).nullable(),
	conversionRatioStatus: z.enum(["known", "unknown"]),
	reason: z.enum(["empty_cohort", "cohort_unavailable"]).nullable(),
});
export type PipelineMetrics = z.infer<typeof pipelineMetrics>;
