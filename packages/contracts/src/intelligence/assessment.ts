import { z } from "zod";
import { defineSafeError, recordId, type Reply } from "../common/values.ts";
import { instant, localDate } from "../common/time.ts";
import { phaseNumber } from "../phases/index.ts";
import { ADULT_TARGET, GROWTH_SLOWED_DAYS, GROWTH_STALLED_DAYS, VISION_TARGET_DAYS, type PlantFacts } from "./facts.ts";
import { assessedCriterion, concern, lensTile, ownFeedback } from "./views.ts";

export const PLANT_RUBRICS = {
	v1: {
		path: "docs/reference/rubric-v1.md",
		sha256: "5575450dff37bb730361f71a8152257622c5f089c84e448648f1c8543b1704c7",
	},
	v0: {
		path: "docs/reference/rubric-v0.md",
		sha256: "969c1fd0e796eb4af311bc691b26ccbefbfd1fa7b4f6fa3b02aee46d456a9f6e",
	},
} as const;
export const ACTIVE_PLANT_RUBRIC = "v1" as const;

export const ASSESSMENT_BUDGET = {
	attemptsPerDraft: 4,
	drafts: 3,
	inputTokens: 60_000,
	outputTokens: 12_000,
	callMs: 45_000,
} as const;
export const HELD_AFTER_FAILURES = 3;
const title = z.string().trim().min(3).max(140);
const body = z.string().trim().min(10).max(1200);

export const urgency = z.enum(["positive", "info", "watch", "urgent"]);
export type Urgency = z.infer<typeof urgency>;
export const SEVERITY = { positive: "info", info: "low", watch: "medium", urgent: "high" } as const;
export const severity = z.enum(["info", "low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof severity>;

const draftPoint = z.strictObject({ title, body, urgency, citations: z.array(z.string().max(80)).max(8) });
export const draftOutput = z.strictObject({
	summary: z.string().trim().min(10).max(600),
	focus: draftPoint,
	supporting: z.tuple([draftPoint, draftPoint]),
	positives: z.array(draftPoint).max(3),
});
export type DraftOutput = z.infer<typeof draftOutput>;
export type DraftPoint = z.infer<typeof draftPoint>;

export const draftRule = z.enum([
	"shape",
	"missing_citation",
	"invented_citation",
	"invented_number",
	"invented_date",
	"unknown_as_known",
	"private_content",
	"judgment",
	"readiness_verdict",
	"action_claim",
]);
export type DraftRule = z.infer<typeof draftRule>;
export const violation = z.strictObject({
	rule: draftRule,
	where: z.string(),
	detail: z.string().max(300),
});
export type Violation = z.infer<typeof violation>;

export const factEntry = z.strictObject({
	key: z.string(),
	label: z.string(),
	value: z.union([z.number(), z.string(), z.boolean(), z.array(z.number()), z.null()]),
	status: z.string().nullable(),
});
export type FactEntry = z.infer<typeof factEntry>;

export const FACT_TOPICS = ["committedAdults", "growth", "vision", "cohesion", "followUps", "training"] as const;
export type FactTopic = (typeof FACT_TOPICS)[number];

export function factCatalog(f: PlantFacts): FactEntry[] {
	const a = f.committedAdults,
		g = f.growth,
		v = f.vision,
		h = f.cohesion,
		u = f.followUps,
		c = f.coverage,
		t = f.training;
	const unknownIf = (status: string, value: number | string | null) => (status === "unknown" ? null : value);
	const entries: FactEntry[] = [
		{ key: "committedAdults.status", label: "Committed adults (Phase 1 criterion)", value: a.status, status: a.status },
		{ key: "committedAdults.count", label: "Committed adults", value: a.exact, status: a.status },
		{ key: "committedAdults.atLeast", label: "Committed adults known so far", value: a.known, status: a.status },
		{ key: "committedAdults.target", label: "Phase 1 committed-adult target", value: ADULT_TARGET, status: null },
		{
			key: "committedAdults.needsClassifying",
			label: "People who need an adult or child classification",
			value: a.needsClassifying.length,
			status: null,
		},
		{ key: "growth.status", label: "Growth", value: g.status, status: g.status },
		{ key: "growth.daysSince", label: "Days since the newest committed adult", value: g.daysSince, status: g.status },
		{ key: "growth.lastAcquiredOn", label: "Newest committed adult", value: g.lastAcquiredOn, status: g.status },
		{ key: "growth.current", label: "New adults in the last 28 days", value: g.current, status: null },
		{ key: "growth.prior", label: "New adults in the 28 days before", value: g.prior, status: null },
		{
			key: "growth.slowedDays",
			label: "Days without a new adult before momentum slows",
			value: GROWTH_SLOWED_DAYS,
			status: null,
		},
		{
			key: "growth.stalledDays",
			label: "Days without a new adult before growth stalls",
			value: GROWTH_STALLED_DAYS,
			status: null,
		},
		{ key: "vision.status", label: "Vision meeting rhythm", value: v.status, status: v.status },
		{ key: "vision.daysSince", label: "Days since the last Vision meeting", value: v.daysSince, status: v.status },
		{ key: "vision.lastHeldOn", label: "Last Vision meeting", value: v.lastHeldOn, status: v.status },
		{
			key: "vision.lastAttendance",
			label: "Attendance at the last two Vision meetings",
			value: v.lastAttendance,
			status: v.status,
		},
		{ key: "vision.nextScheduledOn", label: "Next scheduled Vision meeting", value: v.nextScheduledOn, status: null },
		{
			key: "vision.targetDays",
			label: "Vision meeting rhythm target in days",
			value: VISION_TARGET_DAYS,
			status: null,
		},
		{ key: "cohesion.status", label: "Core group cohesion", value: h.status, status: h.status },
		{
			key: "cohesion.disengaged",
			label: "Committed people with no recent attendance",
			value: unknownIf(h.status, h.disengaged.length),
			status: h.status,
		},
		{ key: "cohesion.committed", label: "People with an active commitment", value: h.committed, status: null },
		{ key: "followUps.status", label: "Follow-ups", value: u.status, status: u.status },
		{
			key: "followUps.onTime",
			label: "Follow-ups done within 48 hours",
			value: unknownIf(u.status, u.onTime),
			status: u.status,
		},
		{ key: "followUps.measured", label: "Follow-ups measured", value: u.measured, status: u.status },
		{ key: "followUps.contacted", label: "Follow-ups with a recorded contact", value: u.contacted, status: null },
		{ key: "followUps.windowHours", label: "Follow-up window in hours", value: 48, status: null },
		{ key: "coverage.status", label: "Ministry responsibilities", value: c.status, status: c.status },
		{ key: "coverage.filled", label: "Ministry responsibilities filled", value: c.filled, status: c.status },
		{ key: "coverage.slots", label: "Ministry responsibilities", value: c.slots, status: null },
		{ key: "coverage.people", label: "Distinct people across the responsibilities", value: c.people, status: null },
		{ key: "coverage.prayerLeader", label: "Prayer leaders", value: c.prayerLeader.length, status: null },
		{ key: "training.status", label: "Required training", value: t.status, status: t.status },
		{
			key: "training.complete",
			label: "Required training completed",
			value: unknownIf(t.status, t.complete),
			status: t.status,
		},
		{ key: "training.total", label: "Required training assigned", value: t.total, status: t.status },
		{
			key: "humanRecords.interviews",
			label: "Interviews recorded",
			value: f.humanRecords.interviews.count,
			status: null,
		},
		{
			key: "humanRecords.interviewsLatestOn",
			label: "Latest interview",
			value: f.humanRecords.interviews.latestOn,
			status: null,
		},
		{ key: "humanRecords.fourCs", label: "4 C's records", value: f.humanRecords.fourCs.count, status: null },
		{
			key: "humanRecords.fourCsLatestOn",
			label: "Latest 4 C's record",
			value: f.humanRecords.fourCs.latestOn,
			status: null,
		},
		{ key: "launch.targetOn", label: "Scheduled launch date", value: f.launch.targetOn, status: null },
		{ key: "launch.daysToLaunch", label: "Days to the launch date", value: f.launch.daysToLaunch, status: null },
	];
	const s = f.firstService;
	if (s) {
		entries.push({
			key: "firstService.status",
			label: "First service held (Phase 5 criterion)",
			value: s.status,
			status: s.status,
		});
		if (s.path === "milestone" && s.milestone !== null)
			entries.push({
				key: "firstService.milestone",
				label: "Gathering milestone",
				value: s.milestone,
				status: s.status,
			});
		entries.push({
			key: "firstService.heldOn",
			label: s.path === "milestone" ? "Milestone reached" : "Launch Sunday held",
			value: s.heldOn,
			status: s.status,
		});
	}
	for (const s of f.attestations)
		entries.push(
			{ key: `attestations.${s.key}`, label: `Answer: ${s.key}`, value: s.value, status: s.state },
			{ key: `attestations.${s.key}.asOf`, label: `Answer date: ${s.key}`, value: s.asOf, status: s.state },
		);
	return entries.map((e) => factEntry.parse(e));
}

export const passage = z.strictObject({
	key: z.string(),
	articleId: recordId,
	revisionId: recordId,
	sourceKind: z.enum(["global", "church", "network"]),
	sourceId: z.uuid(),
	title: z.string(),
	slug: z.string(),
	section: z.string().nullable(),
	phase: phaseNumber.nullable(),
	text: z.string().max(1600),
	textHash: z.string().regex(/^[0-9a-f]{64}$/),
	version: z.strictObject({ release: z.string(), activation: z.number().int(), revision: z.number().int() }),
});
export type Passage = z.infer<typeof passage>;

export const modelInput = z.strictObject({
	phase: phaseNumber,
	asOf: instant,
	today: localDate,
	rubric: z.literal(ACTIVE_PLANT_RUBRIC),
	facts: z.array(factEntry),
	passages: z.array(passage),
});
export type ModelInput = z.infer<typeof modelInput>;

export const snapshotDelta = z.strictObject({
	previousRunId: recordId,
	previousAsOf: instant,
	changed: z.array(
		z.strictObject({ key: z.string(), label: z.string(), before: factEntry.shape.value, after: factEntry.shape.value }),
	),
});
export type SnapshotDelta = z.infer<typeof snapshotDelta>;

const citationRef = z.strictObject({ key: z.string(), kind: z.enum(["fact", "passage"]), label: z.string() });
const point = z.strictObject({
	title: z.string(),
	body: z.string(),
	severity,
	citations: z.array(citationRef).min(1),
});
export const assessment = z.strictObject({
	runId: recordId,
	asOf: instant,
	ageDays: z.int().min(0),
	measuredOn: localDate,
	daysToLaunch: z.int().nullable(),
	phase: phaseNumber,
	rubricVersion: z.string(),
	reference: z.strictObject({ release: z.string(), activation: z.number().int() }),
	summary: z.string(),
	focus: point,
	supporting: z.tuple([point, point]),
	positives: z.array(point),
	insights: z.array(z.strictObject({ role: z.enum(["focus", "supporting", "positive"]), title: z.string(), severity })),
	delta: snapshotDelta.nullable(),
	lenses: z.array(lensTile).length(8),
	criteria: z.array(assessedCriterion),
	concerns: z.array(concern),
});
export type Assessment = z.infer<typeof assessment>;

export const runOutcome = z.enum(["pending", "deferred", "published", "failed", "degraded", "superseded"]);
export type RunOutcome = z.infer<typeof runOutcome>;
export const runReason = z.enum([
	"invalid_drafts",
	"attempts",
	"budget",
	"busy",
	"model_unavailable",
	"deadline",
	"persistence",
	"guidance_unavailable",
	"reference_missing",
	"changed_input",
	"changed_reference",
]);
export type RunReason = z.infer<typeof runReason>;
export const demandKind = z.enum(["change", "time", "manual", "followup"]);
export type DemandKind = z.infer<typeof demandKind>;
export const failureCause = z.enum(["provider", "output_check", "budget", "persistence", "deadline", "guidance"]);
export type FailureCause = z.infer<typeof failureCause>;

export const newestRun = z.strictObject({
	state: z.enum(["preparing", "deferred", "failed", "needs_review"]),
	retryAt: instant.nullable(),
	grounding: z.enum(["grounded", "degraded"]).nullable(),
});
export type NewestRun = z.infer<typeof newestRun>;
export const assessmentView = z.strictObject({
	current: assessment.nullable(),
	newest: newestRun.nullable(),
	currentPhase: phaseNumber,
	seen: z.boolean(),
	feedback: z.array(ownFeedback),
});
export type AssessmentView = z.infer<typeof assessmentView>;

export const requestRefreshRequest = z.strictObject({ requestId: recordId });
export const refreshReceipt = z.strictObject({ requestId: recordId, state: z.literal("preparing") });
export type RefreshReceipt = z.infer<typeof refreshReceipt>;

export const reviewRun = z.strictObject({
	runId: recordId,
	plantName: z.string(),
	demand: demandKind,
	asOf: instant,
	settledAt: instant,
	outcome: runOutcome,
	cause: failureCause,
	violations: z.array(z.strictObject({ rule: draftRule, where: z.string() })),
	drafts: z.int().min(0),
	usage: z.strictObject({ attempts: z.int().min(0), inputTokens: z.int().min(0), outputTokens: z.int().min(0) }),
	streak: z.array(z.strictObject({ runId: recordId, settledAt: instant, cause: failureCause })),
});
export type ReviewRun = z.infer<typeof reviewRun>;
export const describeRunFailureRequest = z.strictObject({ runId: recordId });
export const listRunsForReviewRequest = z.strictObject({});

export const resolveCitationRequest = z.strictObject({ runId: recordId, key: z.string().min(1).max(80) });
export const citationView = z.union([
	z.strictObject({
		status: z.literal("verified"),
		kind: z.literal("fact"),
		key: z.string(),
		label: z.string(),
		value: factEntry.shape.value,
		people: z.strictObject({
			shown: z.array(z.strictObject({ personId: recordId, name: z.string() })),
			hidden: z.int().min(0),
		}),
		asOf: instant,
		measuredOn: localDate,
		formulaVersion: z.string(),
	}),
	z.strictObject({
		status: z.literal("verified"),
		kind: z.literal("passage"),
		key: z.string(),
		title: z.string(),
		slug: z.string(),
		section: z.string().nullable(),
		phase: phaseNumber.nullable(),
		sourceKind: passage.shape.sourceKind,
		text: z.string(),
		version: passage.shape.version,
		currentVersion: z.boolean(),
	}),
	z.strictObject({ status: z.literal("unverifiable"), key: z.string() }),
	z.strictObject({ status: z.literal("unavailable"), key: z.string() }),
]);
export type CitationView = z.infer<typeof citationView>;

export const readAssessmentRequest = z.strictObject({});

export const assessmentError = z.discriminatedUnion("code", [
	defineSafeError("invalid_input", {}, "never"),
	defineSafeError("access_denied", {}, "never"),
	defineSafeError("not_found", {}, "never"),
]);
export type AssessmentError = z.infer<typeof assessmentError>;
export type AssessmentReply<T> = Reply<T, AssessmentError>;

const grade = z.int().min(1).max(5);
export const languageGrade = z.strictObject({
	plain: grade,
	warm: grade,
	useful: grade,
	failures: z.array(z.strictObject({ rule: z.enum(["hype", "pressure"]), quote: z.string() })),
});
export type LanguageGrade = z.infer<typeof languageGrade>;
export const languagePasses = (g: LanguageGrade) =>
	g.failures.length === 0 && g.plain >= 3 && g.warm >= 3 && g.useful >= 3;
