import { z } from "zod";
import rubric from "../../../../docs/reference/network-rubric-v1.json" with { type: "json" };
import { instant, localDate } from "../common/time.ts";
import { tenantId } from "../common/values.ts";

// Plant health, launch and Network Intelligence as an organization sees them (WP-047b: REQ-PI-031, REQ-PI-043,
// REQ-PI-044). Everything is a count, a date, a fixed rule result or a plant's name and link: no person, note,
// assessment text, street or coordinate. The rule functions are pure, so the planter's own Launch screen, the
// organization's pages and the stored Network Intelligence runs read the same concern from the same counts.

const count = z.int().min(0);

/** One official US metropolitan or micropolitan statistical area (OMB Bulletin 23-01). */
export const regionArea = z.strictObject({
	code: z.string().regex(/^\d{5}$/),
	title: z.string().min(1),
	type: z.enum(["metro", "micro"]),
});
export type RegionArea = z.infer<typeof regionArea>;
/** "Austin-Round Rock-San Marcos, TX (metro area)". */
export const regionLabel = (a: RegionArea) => `${a.title} (${a.type} area)`;

/** The window of the near-launch rule (NIR-03): 0 to 30 plant-local calendar days before Launch Sunday. */
const NEAR_LAUNCH_DAYS = 30;

/**
 * A plant's launch preparation counts. `daysToLaunch` is plant-local days to an uncompleted, dated Launch Sunday (null
 * without one); `launched` says Launch Sunday is recorded. Each gap count is null when the plant has no evidence for it
 * (no role carries a Playbook responsibility, no required training is assigned) or does not share Ministry teams.
 */
export const preparation = z.strictObject({
	launched: z.boolean(),
	daysToLaunch: z.int().nullable(),
	unfilledRoles: count.nullable(),
	outstandingTraining: count.nullable(),
});
export type Preparation = z.infer<typeof preparation>;

/** NIR-03 for one plant: it qualifies (gap), it is observed and does not (clear), or evidence is missing (unknown). */
type NearLaunch = "gap" | "clear" | "unknown";
export function nearLaunch(p: Preparation): NearLaunch {
	if (p.launched) return "clear";
	if (p.daysToLaunch === null) return "unknown";
	// A near date alone never qualifies, and a date outside the window is an observed "no".
	if (p.daysToLaunch < 0 || p.daysToLaunch > NEAR_LAUNCH_DAYS) return "clear";
	if ((p.unfilledRoles ?? 0) > 0 || (p.outstandingTraining ?? 0) > 0) return "gap";
	return p.unfilledRoles === null || p.outstandingTraining === null ? "unknown" : "clear";
}

/**
 * The home's health value. A plant that does not share Plant Intelligence findings is Limited visibility; one inside
 * the near-launch window with a recorded gap is Launch readiness. Anything else is not yet assessed: silence is never
 * On track, and Watch and On track come from released assessments (WP-044).
 */
export const health = z.enum(["limited_visibility", "launch_readiness", "not_assessed"]);
export type Health = z.infer<typeof health>;
export const healthOf = (sharesFindings: boolean, p: Preparation | null): Health =>
	!sharesFindings || !p ? "limited_visibility" : nearLaunch(p) === "gap" ? "launch_readiness" : "not_assessed";

/** Where Launch Sunday stands: not set, scheduled, moved to a new date, postponed, past with no outcome, or held. */
const launchState = z.enum(["not_set", "scheduled", "moved", "postponed", "overdue", "completed"]);
export type LaunchState = z.infer<typeof launchState>;

/** Launch on the plant view: only while the plant shares Plant Intelligence findings with this organization. */
export const plantLaunch = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("withheld") }),
	z.strictObject({
		status: z.literal("shared"),
		state: launchState,
		plannedDate: localDate.nullable(),
		/** Readiness milestones completed (and not waiting for review) out of the plan's milestones (nine once seeded). */
		milestones: z.strictObject({ completed: count, total: count }),
		/** The recorded Launch Sunday: its actual date and counts, each null when not recorded. */
		outcome: z
			.strictObject({ actualDate: localDate, attendance: count.nullable(), decisions: count.nullable() })
			.nullable(),
		preparation,
	}),
]);
export type PlantLaunch = z.infer<typeof plantLaunch>;

/** The planter's latest published launch summary: never a draft, a debrief answer or a guest. */
export const publishedSummary = z.strictObject({ version: z.int().min(1), body: z.string(), publishedAt: instant });

// Network Intelligence (organizationIntelligence.read). One run stores each sharing plant's preparation counts and its
// reporting location at that time; every read keeps only plants that share findings and Ministry teams with this
// organization now, so a plant that stops sharing leaves every run, past ones included.

export const LEVELS = ["region", "state", "country", "portfolio"] as const;
export const level = z.enum(LEVELS);
export type Level = z.infer<typeof level>;

const rule = rubric.rules.find((r) => r.id === "NIR-03");
if (!rule) throw new Error("network rubric v1 has no NIR-03");
/** The rubric's own words for NIR-03, word for word (docs/reference/network-rubric-v1.json). */
export const NEAR_LAUNCH_RULE = { id: "NIR-03", template: rule.template, nextStep: rule.next_step } as const;
export const RUBRIC_VERSION = `${rubric.rubric_id}/${rubric.version}`;
/**
 * What every NIR-03 pattern cites: the Everyfield network rubric, a source separate from the plant rubric. It names the
 * rule and the file, never a plant assessment, so a pattern opens nothing a director could not otherwise read.
 */
export const NEAR_LAUNCH_CITATION = {
	rubric: RUBRIC_VERSION,
	rule: NEAR_LAUNCH_RULE.id,
	source: "docs/reference/network-rubric-v1.json",
} as const;
/** "2 plants within 30 calendar days of an uncompleted launch have a recorded assignment or required-training gap." */
export const nearLaunchSentence = (support: number) =>
	NEAR_LAUNCH_RULE.template.replace("{support_count}", String(support));

/** One plant row of a group: its rule result, or Not shared with no value at all. */
export const intelligenceRow = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("not_shared"), plantId: tenantId, name: z.string() }),
	z.strictObject({
		status: z.literal("shared"),
		plantId: tenantId,
		name: z.string(),
		result: z.enum(["gap", "clear", "unknown"]),
	}),
]);
export type IntelligenceRow = z.infer<typeof intelligenceRow>;
export const intelligenceGroup = z.strictObject({
	/** "US:TX", a CBSA code, "US", or "portfolio". */
	key: z.string(),
	label: z.string(),
	rows: z.array(intelligenceRow),
	/** The near-launch pattern, only when two distinct sharing plants qualify in this group. */
	pattern: z
		.strictObject({
			key: z.string(),
			support: z.int().min(2),
			/** Sharing plants whose evidence is known for this rule (the rule's observed count). */
			observed: z.int().min(2),
			plants: z.array(z.strictObject({ plantId: tenantId, name: z.string() })),
			/** This seat's own rating of the pattern in this run; nobody else's. */
			rating: z.enum(["useful", "not_useful"]).nullable(),
			citation: z.strictObject({
				rubric: z.literal(RUBRIC_VERSION),
				rule: z.literal(NEAR_LAUNCH_RULE.id),
				source: z.literal(NEAR_LAUNCH_CITATION.source),
			}),
		})
		.nullable(),
	/** Plants with no reporting location at this level: they still count at the larger levels. */
	unplaced: z.boolean(),
});
export type IntelligenceGroup = z.infer<typeof intelligenceGroup>;
const intelligenceRun = z.strictObject({ runId: tenantId, ranAt: instant });
export const intelligenceView = z.strictObject({
	organizationName: z.string(),
	/** The organization's time zone, for run times. */
	timeZone: z.string(),
	level,
	/** The run shown, or null before the first refresh. */
	run: intelligenceRun.nullable(),
	/** Every run, newest first. */
	history: z.array(intelligenceRun),
	groups: z.array(intelligenceGroup),
	/** Owners and Admins may refresh; Members read. */
	canRefresh: z.boolean(),
});
export type IntelligenceView = z.infer<typeof intelligenceView>;

/** The browser names the new run, so a repeated press records one run. */
export const refreshRequest = z.strictObject({ runId: tenantId });
export const feedbackRequest = z.strictObject({
	runId: tenantId,
	patternKey: z.string().min(1).max(200),
	rating: z.enum(["useful", "not_useful"]),
});
