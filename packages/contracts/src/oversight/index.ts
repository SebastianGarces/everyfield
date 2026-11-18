import { z } from "zod";
import { localDate } from "../common/time.ts";
import { tenantId } from "../common/values.ts";
import { phaseNumber } from "../phases/index.ts";
import { health, plantLaunch, publishedSummary, regionArea, releasedAssessment } from "./health.ts";

export * from "./health.ts";

export const plantProvenance = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("direct") }),
	z.strictObject({ kind: z.literal("through"), sendingChurches: z.array(z.string().min(1)).min(1) }),
]);

export const milestoneProgress = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("withheld") }),
	z.strictObject({ status: z.literal("not_reached") }),
	z.strictObject({ status: z.literal("withdrawn") }),
	z.strictObject({ status: z.literal("reached"), date: localDate }),
]);
export type MilestoneProgress = z.infer<typeof milestoneProgress>;
export const plantPath = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("launch_sunday"), date: localDate.nullable() }),
	z.strictObject({
		kind: z.literal("milestone"),
		name: z.string().min(1).nullable(),
		chosenBy: z.string().min(1).nullable(),
		progress: milestoneProgress,
	}),
]);
export type PlantPath = z.infer<typeof plantPath>;

export const plantDirectoryRow = z.strictObject({
	plantId: tenantId,
	name: z.string().min(1),
	city: z.string().nullable(),
	stateProvince: z.string().nullable(),
	country: z.string().nullable(),
	phase: phaseNumber,
	path: plantPath,
	provenance: plantProvenance,
	leadPlanter: z.string().nullable(),
	region: regionArea.nullable(),
	health,
});
export type PlantDirectoryRow = z.infer<typeof plantDirectoryRow>;
export const plantDirectory = z.strictObject({
	organizationName: z.string().min(1),
	plants: z.array(plantDirectoryRow),
});
export type PlantDirectory = z.infer<typeof plantDirectory>;

const section = <T extends z.ZodType>(counts: T) =>
	z.discriminatedUnion("status", [
		z.strictObject({ status: z.literal("withheld") }),
		z.strictObject({ status: z.literal("empty") }),
		z.strictObject({ status: z.literal("shared"), counts }),
		z.strictObject({ status: z.literal("unavailable") }),
	]);

const count = z.int().min(0);
export const PERSON_STAGES = [
	"prospect",
	"attendee",
	"following_up",
	"interviewed",
	"core_group",
	"launch_team",
	"leader",
] as const;
export const peopleCounts = z.strictObject({
	total: count,
	byStage: z.strictObject(
		Object.fromEntries(PERSON_STAGES.map((s) => [s, count])) as Record<(typeof PERSON_STAGES)[number], typeof count>,
	),
});
export const taskCounts = z.strictObject({ open: count, overdue: count });
export const meetingCounts = z.strictObject({
	meetings: z
		.array(z.strictObject({ date: localDate, attended: count.nullable() }))
		.min(1)
		.max(12),
	averageDaysBetween: z.int().min(0).nullable(),
	attendedTotal: count,
});
export const teamCounts = z.strictObject({
	teams: count,
	roles: count,
	rolesFilled: count,
	trainingAssigned: count,
	trainingComplete: count,
});
export const wikiCounts = z.strictObject({ finished: count, inProgress: count });

export const plantSections = z.strictObject({
	people: section(peopleCounts),
	tasks: section(taskCounts),
	meetings: section(meetingCounts),
	ministryTeams: section(teamCounts),
	wiki: section(wikiCounts),
});
export type PlantSections = z.infer<typeof plantSections>;
export type SectionKey = keyof PlantSections;
export type Section<K extends SectionKey> = PlantSections[K];

export const plantView = z.strictObject({
	plant: plantDirectoryRow,
	timeZone: z.string(),
	sections: plantSections,
	launch: plantLaunch,
	summary: publishedSummary.nullable(),
	assessment: releasedAssessment,
});
export type PlantView = z.infer<typeof plantView>;

export const sendingChurchRow = z.strictObject({
	organizationId: tenantId,
	name: z.string().min(1),
	plants: count,
});
export const sendingChurchRoster = z.strictObject({
	churches: z.array(sendingChurchRow),
	pendingInvitations: count,
});
export type SendingChurchRoster = z.infer<typeof sendingChurchRoster>;

export const sendingChurchView = z.strictObject({
	organizationId: tenantId,
	name: z.string().min(1),
	plants: z.array(plantDirectoryRow),
});
export type SendingChurchView = z.infer<typeof sendingChurchView>;
