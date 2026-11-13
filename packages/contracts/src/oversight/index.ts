import { z } from "zod";
import { localDate } from "../common/time.ts";
import { tenantId } from "../common/values.ts";
import { phaseNumber } from "../phases/index.ts";

// Organization oversight (REQ-IDN-023, REQ-IDN-024): what a sending church or network seat reads about the plants that
// link to it. Every shape here is a name, a locality without street, a phase, a date or a count. No person but the
// plant's named lead planter, no account id, email, phone or street ever appears.

/** How the plant reaches this organization: its own link, also seen through the named sending churches (D-1093). */
export const plantProvenance = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("direct") }),
	z.strictObject({ kind: z.literal("through"), sendingChurches: z.array(z.string().min(1)).min(1) }),
]);

/** One row of the plant directory (oversight.listPlants). */
export const plantDirectoryRow = z.strictObject({
	plantId: tenantId,
	name: z.string().min(1),
	city: z.string().nullable(),
	stateProvince: z.string().nullable(),
	country: z.string().nullable(),
	/** The phase the church declared; Everyfield never moves it. */
	phase: phaseNumber,
	/** The planned Launch Sunday, or null when none is set. */
	launchDate: localDate.nullable(),
	provenance: plantProvenance,
	/** The display name of the Person holding the recorded lead role now, or null when there is none. */
	leadPlanter: z.string().nullable(),
});
export type PlantDirectoryRow = z.infer<typeof plantDirectoryRow>;

/**
 * One shared category as the organization sees it: not shared (a choice, never a zero), shared with nothing recorded,
 * shared with counts, or a read that failed.
 */
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
/** Live people, each once, by pipeline stage (a plant's people always have one). */
export const peopleCounts = z.strictObject({
	total: count,
	byStage: z.strictObject(
		Object.fromEntries(PERSON_STAGES.map((s) => [s, count])) as Record<(typeof PERSON_STAGES)[number], typeof count>,
	),
});
/** Open and overdue top-level tasks; checklist rows, waived and deleted tasks never count. */
export const taskCounts = z.strictObject({ open: count, overdue: count });
/** The last held meetings, at most 12, oldest first: each one's local date and attended people. */
export const meetingCounts = z.strictObject({
	/** `attended` is null until the meeting's attendance is finalized, as the meeting reports count it. */
	meetings: z.array(z.strictObject({ date: localDate, attended: count.nullable() })).min(1).max(12),
	/** Average days between consecutive meetings, rounded; null with one meeting. */
	averageDaysBetween: z.int().min(0).nullable(),
	/** Attended people summed over the finalized meetings. */
	attendedTotal: count,
});
export const teamCounts = z.strictObject({
	teams: count,
	roles: count,
	rolesFilled: count,
	/** People assigned required training, and those who have completed it. */
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

/** One plant as this organization sees it (oversight.getPlant). */
export const plantView = z.strictObject({ plant: plantDirectoryRow, sections: plantSections });
export type PlantView = z.infer<typeof plantView>;

/** One sending church on a network's roster (oversight.listSendingChurches). */
export const sendingChurchRow = z.strictObject({
	organizationId: tenantId,
	name: z.string().min(1),
	/** Plants linked to both this sending church and the network. */
	plants: count,
});
export const sendingChurchRoster = z.strictObject({
	churches: z.array(sendingChurchRow),
	/** Requests from sending churches to this network that are pending and not expired. */
	pendingInvitations: count,
});
export type SendingChurchRoster = z.infer<typeof sendingChurchRoster>;

/** One sending church and the plants linked to both it and the network (oversight.getSendingChurch). */
export const sendingChurchView = z.strictObject({
	organizationId: tenantId,
	name: z.string().min(1),
	plants: z.array(plantDirectoryRow),
});
export type SendingChurchView = z.infer<typeof sendingChurchView>;
