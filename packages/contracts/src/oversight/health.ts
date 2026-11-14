import { z } from "zod";
import rubric from "../../../../docs/reference/network-rubric-v1.json" with { type: "json" };
import { instant, localDate } from "../common/time.ts";
import { tenantId } from "../common/values.ts";
import { GROWTH_SLOWED_DAYS, GROWTH_STALLED_DAYS } from "../intelligence/facts.ts";

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

/** The rubric rules this page runs, in page order. Each keeps the rubric's own words (D-1423: other words are ours). */
export const RULE_IDS = ["NIR-03", "NIR-04", "NIR-05", "NIR-06"] as const;
export type RuleId = (typeof RULE_IDS)[number];
const ruleOf = (id: RuleId) => {
	const r = rubric.rules.find((x) => x.id === id);
	if (!r) throw new Error(`network rubric v1 has no ${id}`);
	return { id, template: r.template, nextStep: r.next_step } as const;
};
/** The rubric's template and suggested next step of each rule, word for word (docs/reference/network-rubric-v1.json). */
export const RULES = Object.fromEntries(RULE_IDS.map((id) => [id, ruleOf(id)])) as Record<
	RuleId,
	ReturnType<typeof ruleOf>
>;
export const NEAR_LAUNCH_RULE = RULES["NIR-03"];
export const RUBRIC_VERSION = `${rubric.rubric_id}/${rubric.version}`;
/** "2 plants within 30 calendar days of an uncompleted launch have a recorded assignment or required-training gap." */
export const nearLaunchSentence = (support: number) =>
	NEAR_LAUNCH_RULE.template.replace("{support_count}", String(support));

/**
 * The counts a run stores for one plant beyond its preparation (D-1420: each rule reads only while the plant shares its
 * categories; null is Unknown). `overdueFollowUps` and `unownedFollowUps` are open follow-ups past due and those of
 * them with no eligible owner, by the Follow-ups module's own definitions (D-1422). `growthDays` is the plant-local
 * days since the newest first-time committed adult's first commitment, null whenever Plant Intelligence facts read
 * growth as Unknown. `requiredTraining` is the saved required person/program obligations, null when none is assigned.
 * A run from before these were stored holds null for every one (D-1424).
 */
export const ruleCounts = z.strictObject({
	overdueFollowUps: count.nullable(),
	unownedFollowUps: count.nullable(),
	growthDays: count.nullable(),
	requiredTraining: z.int().min(1).nullable(),
	/** Of `requiredTraining`, those with no current compatible completion (the preparation count). */
	outstandingTraining: count.nullable(),
});
export type RuleCounts = z.infer<typeof ruleCounts>;

/** A rule's result for one plant: it qualifies (gap), it is observed and does not (clear), or Unknown. */
type Result = "gap" | "clear" | "unknown";
/** NIR-04: any overdue follow-up qualifies; zero is an observed "no". */
export const followUpResult = (c: RuleCounts): Result =>
	c.overdueFollowUps === null ? "unknown" : c.overdueFollowUps > 0 ? "gap" : "clear";
/** NIR-05: stalled from 28 days, slowed from 21 to 27 (the facts' own thresholds), each plant in one theme only. */
export const growthResult = (c: RuleCounts): "slowed" | "stalled" | "clear" | "unknown" =>
	c.growthDays === null
		? "unknown"
		: c.growthDays >= GROWTH_STALLED_DAYS
			? "stalled"
			: c.growthDays >= GROWTH_SLOWED_DAYS
				? "slowed"
				: "clear";
/** NIR-06: a plant with no required training assigned is Unknown, never complete. */
export const trainingResult = (c: RuleCounts): Result =>
	c.requiredTraining === null || c.outstandingTraining === null
		? "unknown"
		: c.outstandingTraining > 0
			? "gap"
			: "clear";

/** One plant row of a group: one short result per rule, or Not shared with no value at all. */
export const intelligenceRow = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("not_shared"), plantId: tenantId, name: z.string() }),
	z.strictObject({
		status: z.literal("shared"),
		plantId: tenantId,
		name: z.string(),
		results: z.strictObject({
			"NIR-03": z.enum(["gap", "clear", "unknown"]),
			"NIR-04": z.enum(["gap", "clear", "unknown"]),
			"NIR-05": z.enum(["slowed", "stalled", "clear", "unknown"]),
			"NIR-06": z.enum(["gap", "clear", "unknown"]),
		}),
	}),
]);
export type IntelligenceRow = z.infer<typeof intelligenceRow>;

const patternBase = {
	key: z.string(),
	support: z.int().min(2),
	/** Sharing plants whose evidence is known for this rule (the rule's observed count). */
	observed: z.int().min(2),
	plants: z.array(z.strictObject({ plantId: tenantId, name: z.string() })),
	/** This seat's own rating of the pattern in this run; nobody else's. */
	rating: z.enum(["useful", "not_useful"]).nullable(),
};
/** One pattern: two or more distinct sharing plants in a group with the same rule theme, and the rule's sums. */
export const intelligencePattern = z.discriminatedUnion("theme", [
	z.strictObject({ ...patternBase, rule: z.literal("NIR-03"), theme: z.literal("near_launch") }),
	z.strictObject({
		...patternBase,
		rule: z.literal("NIR-04"),
		theme: z.literal("overdue_followup"),
		overdue: z.int().min(2),
		/** The unowned subclaim, only when two distinct plants have overdue follow-ups with no owner. */
		unowned: z.strictObject({ support: z.int().min(2), overdue: z.int().min(2) }).nullable(),
	}),
	z.strictObject({
		...patternBase,
		rule: z.literal("NIR-05"),
		theme: z.enum(["slowed", "stalled"]),
		/** The run's date in the organization's time zone. */
		asOf: localDate,
	}),
	z.strictObject({
		...patternBase,
		rule: z.literal("NIR-06"),
		theme: z.literal("required_training"),
		outstanding: z.int().min(2),
		/** Saved required obligations of the supporting plants, and how many of them are complete. */
		applicable: z.int().min(2),
		complete: count,
	}),
]);
export type IntelligencePattern = z.infer<typeof intelligencePattern>;

const MOMENTUM = { slowed: "momentum has slowed", stalled: "growth has stalled" } as const;
const plants = (n: number) => `${n} ${n === 1 ? "plant" : "plants"}`;
/** "Oct 13, 2026" for a calendar date. */
const dayLabel = (d: string) =>
	new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));
/**
 * A pattern's words: its title, the rubric template filled with its counts, any further claim the rule allows, the
 * rubric's next step and the evidence footer. Words outside the template are ours (D-1423) and claim nothing more.
 */
export function patternText(p: IntelligencePattern): {
	title: string;
	lines: string[];
	nextStep: string;
	evidence: string;
} {
	const rule = RULES[p.rule];
	const fill = (values: Record<string, string | number>) =>
		Object.entries(values).reduce((t, [k, v]) => t.replace(`{${k}}`, String(v)), rule.template);
	const evidence = (what: string) => `From ${plants(p.observed)} with ${what} evidence available.`;
	const base = { nextStep: rule.nextStep };
	switch (p.theme) {
		case "near_launch":
			return {
				...base,
				title: "Near-launch preparation",
				lines: [nearLaunchSentence(p.support)],
				evidence: evidence("launch"),
			};
		case "overdue_followup":
			return {
				...base,
				title: "Follow-up ownership",
				lines: [
					fill({ support_count: p.support, sum_overdue_obligations: p.overdue }),
					...(p.unowned
						? [
								`Of these, ${plants(p.unowned.support)} have ${p.unowned.overdue} overdue follow-up obligations with no owner.`,
							]
						: []),
				],
				evidence: evidence("follow-up"),
			};
		case "slowed":
		case "stalled":
			return {
				...base,
				title: p.theme === "slowed" ? "Acquisition momentum slowed" : "Acquisition growth stalled",
				lines: [fill({ support_count: p.support, momentum_label: MOMENTUM[p.theme], as_of: dayLabel(p.asOf) })],
				evidence: evidence("first-adult-acquisition"),
			};
		case "required_training":
			return {
				...base,
				title: "Required training",
				lines: [
					fill({ support_count: p.support, sum_outstanding_required_obligations: p.outstanding }),
					`${p.complete} of ${p.applicable} saved required obligations are complete across these plants.`,
				],
				evidence: evidence("required-training"),
			};
	}
}

export const intelligenceGroup = z.strictObject({
	/** "US:TX", a CBSA code, "US", or "portfolio". */
	key: z.string(),
	label: z.string(),
	rows: z.array(intelligenceRow),
	/** Each rule theme where two distinct sharing plants qualify in this group, in rule order. */
	patterns: z.array(intelligencePattern),
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
