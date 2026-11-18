import { z } from "zod";
import rubric from "../../../../docs/reference/network-rubric-v1.json" with { type: "json" };
import { instant, localDate } from "../common/time.ts";
import { tenantId } from "../common/values.ts";
import { GROWTH_SLOWED_DAYS, GROWTH_STALLED_DAYS } from "../intelligence/facts.ts";
import { concern, lensKey, LENSES } from "../intelligence/views.ts";

const count = z.int().min(0);

export const regionArea = z.strictObject({
	code: z.string().regex(/^\d{5}$/),
	title: z.string().min(1),
	type: z.enum(["metro", "micro"]),
});
export type RegionArea = z.infer<typeof regionArea>;
export const regionLabel = (a: RegionArea) => `${a.title} (${a.type} area)`;

const NEAR_LAUNCH_DAYS = 30;

export const preparation = z.strictObject({
	launched: z.boolean(),
	daysToLaunch: z.int().nullable(),
	unfilledRoles: count.nullable(),
	outstandingTraining: count.nullable(),
});
export type Preparation = z.infer<typeof preparation>;

type NearLaunch = "gap" | "clear" | "unknown";
export function nearLaunch(p: Preparation): NearLaunch {
	if (p.launched) return "clear";
	if (p.daysToLaunch === null) return "unknown";
	if (p.daysToLaunch < 0 || p.daysToLaunch > NEAR_LAUNCH_DAYS) return "clear";
	if ((p.unfilledRoles ?? 0) > 0 || (p.outstandingTraining ?? 0) > 0) return "gap";
	return p.unfilledRoles === null || p.outstandingTraining === null ? "unknown" : "clear";
}

export const health = z.enum(["limited_visibility", "launch_readiness", "watch", "on_track", "not_assessed"]);
export type Health = z.infer<typeof health>;
export type Released = { concerns: number; withheld: boolean } | null;
export function healthOf(sharesFindings: boolean, p: Preparation | null, released: Released = null): Health {
	if (!sharesFindings || !p) return "limited_visibility";
	if (nearLaunch(p) === "gap") return "launch_readiness";
	if (!released) return "not_assessed";
	if (released.withheld) return "limited_visibility";
	return released.concerns ? "watch" : "on_track";
}

export const releasedAssessment = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("withheld") }),
	z.strictObject({ status: z.literal("not_assessed") }),
	z.strictObject({
		status: z.literal("released"),
		runId: tenantId,
		asOf: instant,
		phase: z.int().min(0).max(6),
		concerns: z.array(concern),
		withheld: count,
	}),
]);
export type ReleasedAssessment = z.infer<typeof releasedAssessment>;

const launchState = z.enum(["not_set", "scheduled", "moved", "postponed", "overdue", "completed"]);
export type LaunchState = z.infer<typeof launchState>;

export const plantLaunch = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("withheld") }),
	z.strictObject({
		status: z.literal("shared"),
		state: launchState,
		plannedDate: localDate.nullable(),
		milestones: z.strictObject({ completed: count, total: count }),
		outcome: z
			.strictObject({ actualDate: localDate, attendance: count.nullable(), decisions: count.nullable() })
			.nullable(),
		preparation,
	}),
]);
export type PlantLaunch = z.infer<typeof plantLaunch>;

export const publishedSummary = z.strictObject({ version: z.int().min(1), body: z.string(), publishedAt: instant });

export const LEVELS = ["region", "state", "country", "portfolio"] as const;
export const level = z.enum(LEVELS);
export type Level = z.infer<typeof level>;

export const RULE_IDS = ["NIR-03", "NIR-04", "NIR-05", "NIR-06"] as const;
export type RuleId = (typeof RULE_IDS)[number];
export const PATTERN_RULE_IDS = ["NIR-01", ...RULE_IDS] as const;
export type PatternRuleId = (typeof PATTERN_RULE_IDS)[number];
const ruleOf = (id: PatternRuleId) => {
	const r = rubric.rules.find((x) => x.id === id);
	if (!r) throw new Error(`network rubric v1 has no ${id}`);
	return { id, template: r.template, nextStep: r.next_step } as const;
};
export const RULES = Object.fromEntries(PATTERN_RULE_IDS.map((id) => [id, ruleOf(id)])) as Record<
	PatternRuleId,
	ReturnType<typeof ruleOf>
>;
export const NEAR_LAUNCH_RULE = RULES["NIR-03"];
export const RUBRIC_VERSION = `${rubric.rubric_id}/${rubric.version}`;
export const RUBRIC_SOURCE = "docs/reference/network-rubric-v1.json";
export const citationOf = <R extends PatternRuleId>(rule: R) =>
	({ rubric: RUBRIC_VERSION, rule, source: RUBRIC_SOURCE }) as const;
const citation = <R extends PatternRuleId>(rule: R) =>
	z.strictObject({ rubric: z.literal(RUBRIC_VERSION), rule: z.literal(rule), source: z.literal(RUBRIC_SOURCE) });
export const nearLaunchSentence = (support: number) =>
	NEAR_LAUNCH_RULE.template.replace("{support_count}", String(support));

export type RuleCounts = {
	overdueFollowUps: number | null;
	unownedFollowUps: number | null;
	growthDays: number | null;
	requiredTraining: number | null;
	outstandingTraining: number | null;
};

type Result = "gap" | "clear" | "unknown";
export const followUpResult = (c: RuleCounts): Result =>
	c.overdueFollowUps === null ? "unknown" : c.overdueFollowUps > 0 ? "gap" : "clear";
export const growthResult = (c: RuleCounts): "slowed" | "stalled" | "clear" | "unknown" =>
	c.growthDays === null
		? "unknown"
		: c.growthDays >= GROWTH_STALLED_DAYS
			? "stalled"
			: c.growthDays >= GROWTH_SLOWED_DAYS
				? "slowed"
				: "clear";
export const trainingResult = (c: RuleCounts): Result =>
	c.requiredTraining === null || c.outstandingTraining === null
		? "unknown"
		: c.outstandingTraining > 0
			? "gap"
			: "clear";

export const intelligenceRow = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("not_shared"), plantId: tenantId, name: z.string() }),
	z.strictObject({
		status: z.literal("shared"),
		plantId: tenantId,
		name: z.string(),
		health,
		assessment: releasedAssessment,
		results: z.strictObject({
			"NIR-03": z.enum(["gap", "clear", "unknown"]),
			"NIR-04": z.enum(["gap", "clear", "unknown"]),
			"NIR-05": z.enum(["slowed", "stalled", "clear", "unknown"]),
			"NIR-06": z.enum(["gap", "clear", "unknown"]),
		}),
	}),
]);
export type IntelligenceRow = z.infer<typeof intelligenceRow>;

export const lensLabel = (key: z.infer<typeof lensKey>) => LENSES.find((l) => l.key === key)!.label;

const patternBase = {
	key: z.string(),
	support: z.int().min(2),
	observed: z.int().min(2),
	plants: z.array(z.strictObject({ plantId: tenantId, name: z.string() })),
	rating: z.enum(["useful", "not_useful"]).nullable(),
};
export const intelligencePattern = z.discriminatedUnion("theme", [
	z.strictObject({
		...patternBase,
		rule: z.literal("NIR-01"),
		citation: citation("NIR-01"),
		theme: z.literal("shared_concern"),
		lens: lensKey,
	}),
	z.strictObject({
		...patternBase,
		rule: z.literal("NIR-03"),
		citation: citation("NIR-03"),
		theme: z.literal("near_launch"),
	}),
	z.strictObject({
		...patternBase,
		rule: z.literal("NIR-04"),
		citation: citation("NIR-04"),
		theme: z.literal("overdue_followup"),
		overdue: z.int().min(2),
		unowned: z.strictObject({ support: z.int().min(2), overdue: z.int().min(2) }).nullable(),
	}),
	z.strictObject({
		...patternBase,
		rule: z.literal("NIR-05"),
		citation: citation("NIR-05"),
		theme: z.enum(["slowed", "stalled"]),
		asOf: localDate,
	}),
	z.strictObject({
		...patternBase,
		rule: z.literal("NIR-06"),
		citation: citation("NIR-06"),
		theme: z.literal("required_training"),
		outstanding: z.int().min(2),
		applicable: z.int().min(2),
		complete: count,
	}),
]);
export type IntelligencePattern = z.infer<typeof intelligencePattern>;

const MOMENTUM = { slowed: "momentum has slowed", stalled: "growth has stalled" } as const;
const plants = (n: number) => `${n} ${n === 1 ? "plant" : "plants"}`;
const dayLabel = (d: string) =>
	new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));
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
		case "shared_concern":
			return {
				...base,
				title: `Shared concern: ${lensLabel(p.lens)}`,
				lines: [fill({ support_count: p.support, concern_key: lensLabel(p.lens), observed_lens_count: p.observed })],
				evidence: evidence("released assessment"),
			};
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

export const PLACEMENTS = ["placed", "missing", "unresolved", "outside_reference", "unsupported_country"] as const;
export const placement = z.enum(PLACEMENTS);
export type Placement = z.infer<typeof placement>;
export const intelligenceGroup = z.strictObject({
	key: z.string(),
	label: z.string(),
	rows: z.array(intelligenceRow),
	patterns: z.array(intelligencePattern),
	placement,
});
export type IntelligenceGroup = z.infer<typeof intelligenceGroup>;
const intelligenceRun = z.strictObject({ runId: tenantId, ranAt: instant });
export const geographyRelease = z.strictObject({ key: z.string(), credit: z.string() });
export const intelligenceView = z.strictObject({
	organizationName: z.string(),
	timeZone: z.string(),
	level,
	run: intelligenceRun.nullable(),
	history: z.array(intelligenceRun),
	groups: z.array(intelligenceGroup),
	geographyReleases: z.array(geographyRelease),
	canRefresh: z.boolean(),
});
export type IntelligenceView = z.infer<typeof intelligenceView>;

export const refreshRequest = z.strictObject({ runId: tenantId });
export const feedbackRequest = z.strictObject({
	runId: tenantId,
	patternKey: z.string().min(1).max(200),
	rating: z.enum(["useful", "not_useful"]),
});
