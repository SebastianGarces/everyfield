import { z } from "zod";
import { defineSafeError, recordId, type Reply } from "../common/values.ts";
import { instant, localDate } from "../common/time.ts";
import { phaseNumber } from "../phases/index.ts";
import { ADULT_TARGET, GROWTH_SLOWED_DAYS, GROWTH_STALLED_DAYS, VISION_TARGET_DAYS, type PlantFacts } from "./facts.ts";

// Plant Intelligence assessments (WP-041 and WP-042). A run captures the measured facts (WP-040), the methodology
// passages a keyword search found for the plant's phase, and the exact reference and rubric versions, then asks the
// model for a draft. A draft is published only when every number matches a recorded fact, Unknown stays Unknown, every
// point cites a fact or passage the run offered, and it judges nothing outside launch progress. Citations stay
// checkable: each read compares the cited value or passage text with what the run stored.

/**
 * The plant rubric versions, active and historical, pinned to their exact bytes (docs/reference/rubric-v1.md and
 * rubric-v0.md, preserved byte for byte). Every run records the active one; a test checks each hash against its file.
 */
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

/** The run budget (docs/architecture/assessment.md, Execution and budgets). */
export const ASSESSMENT_BUDGET = {
	attemptsPerDraft: 4,
	drafts: 3,
	inputTokens: 60_000,
	outputTokens: 12_000,
	callMs: 45_000,
} as const;
/** Title, body and summary bounds (methodology-intelligence.md, Persisted plant views). */
const title = z.string().trim().min(3).max(140);
const body = z.string().trim().min(10).max(1200);

/** What the model returns: one main focus, two supporting points and what's going well, each naming its citations. */
const draftPoint = z.strictObject({ title, body, citations: z.array(z.string().max(80)).max(8) });
export const draftOutput = z.strictObject({
	summary: z.string().trim().min(10).max(600),
	focus: draftPoint,
	supporting: z.tuple([draftPoint, draftPoint]),
	positives: z.array(draftPoint).max(3),
});
export type DraftOutput = z.infer<typeof draftOutput>;
export type DraftPoint = z.infer<typeof draftPoint>;

/** Every rule a draft can break. Each failure names one, so a report never hides a failure behind an average. */
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
	/** "summary", "focus", "supporting.0", "positives.1" or "draft". */
	where: z.string(),
	/** The exact token, phrase or citation key that broke the rule. */
	detail: z.string().max(300),
});
export type Violation = z.infer<typeof violation>;

// The model-purpose projection of the facts. Only counts, statuses, dates and the formula's own thresholds: no person,
// no name, no note, score, interview result or check-in. A fact citation names one of these keys.

/** One citable measured fact. `value` is null exactly when the records cannot answer (Unknown). */
export const factEntry = z.strictObject({
	key: z.string(),
	label: z.string(),
	value: z.union([z.number(), z.string(), z.boolean(), z.array(z.number()), z.null()]),
	/** The fact's own measured state, when it has one: met, not_met, unknown, on_track, slowed and so on. */
	status: z.string().nullable(),
});
export type FactEntry = z.infer<typeof factEntry>;

/** Fact topics and the measured fact that says whether each is Unknown. */
export const FACT_TOPICS = ["committedAdults", "growth", "vision", "cohesion", "followUps", "training"] as const;
export type FactTopic = (typeof FACT_TOPICS)[number];

/** Every citable fact of a fact snapshot, in a fixed order. The citation read rebuilds it from the stored snapshot. */
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
	];
	for (const s of f.attestations)
		entries.push(
			{ key: `attestations.${s.key}`, label: `Answer: ${s.key}`, value: s.value, status: s.state },
			{ key: `attestations.${s.key}.asOf`, label: `Answer date: ${s.key}`, value: s.asOf, status: s.state },
		);
	return entries.map((e) => factEntry.parse(e));
}

/** A methodology passage the keyword search offered: one heading section of a Wiki article the plant can read. */
export const passage = z.strictObject({
	key: z.string(),
	articleId: recordId,
	revisionId: recordId,
	/** The Wiki source: the global methodology, or the sending church's or network's own article. */
	sourceKind: z.enum(["global", "church", "network"]),
	sourceId: z.uuid(),
	title: z.string(),
	slug: z.string(),
	/** The section heading; null for the article's opening text. */
	section: z.string().nullable(),
	/** The phase the article is tagged for, or null for general guidance. */
	phase: phaseNumber.nullable(),
	text: z.string().max(1600),
	textHash: z.string().regex(/^[0-9a-f]{64}$/),
	/** The version the run read: the activated reference release and the article's own revision number. */
	version: z.strictObject({ release: z.string(), activation: z.number().int(), revision: z.number().int() }),
});
export type Passage = z.infer<typeof passage>;

/** The exact input a draft is written from. It is stored with the run before any model call. */
export const modelInput = z.strictObject({
	phase: phaseNumber,
	asOf: instant,
	today: localDate,
	rubric: z.literal(ACTIVE_PLANT_RUBRIC),
	facts: z.array(factEntry),
	passages: z.array(passage),
});
export type ModelInput = z.infer<typeof modelInput>;

// What a run stores and what readers see.

/** A cited fact or passage as the published assessment lists it; the citation read opens it. */
const citationRef = z.strictObject({ key: z.string(), kind: z.enum(["fact", "passage"]), label: z.string() });
const point = z.strictObject({ title: z.string(), body: z.string(), citations: z.array(citationRef).min(1) });
export const assessment = z.strictObject({
	runId: recordId,
	asOf: instant,
	/** Plant-local days between the run's as-of date and today: the assessment's real age. */
	ageDays: z.int().min(0),
	phase: phaseNumber,
	rubricVersion: z.string(),
	reference: z.strictObject({ release: z.string(), activation: z.number().int() }),
	summary: z.string(),
	focus: point,
	supporting: z.tuple([point, point]),
	positives: z.array(point),
});
export type Assessment = z.infer<typeof assessment>;

/** How a run ended. Only `published` writes advice; every other outcome leaves the previous assessment current. */
export const runOutcome = z.enum(["published", "failed", "deferred", "degraded"]);
export type RunOutcome = z.infer<typeof runOutcome>;
export const assessmentView = z.strictObject({
	/** The latest published assessment, or null before the first. */
	current: assessment.nullable(),
	/** The latest run, whatever its outcome. "degraded" means guidance couldn't be checked when it ran. */
	latest: z
		.strictObject({
			runId: recordId,
			asOf: instant,
			outcome: runOutcome,
			grounding: z.enum(["grounded", "degraded"]),
		})
		.nullable(),
});
export type AssessmentView = z.infer<typeof assessmentView>;

/** A run's result as its caller sees it: each draft with the rules it broke. */
export const runResult = z.strictObject({
	runId: recordId,
	outcome: runOutcome,
	grounding: z.enum(["grounded", "degraded"]),
	/** Why a run did not publish: the last draft's violations, the budget or the unread guidance. */
	reason: z.enum(["invalid_drafts", "attempts", "budget", "guidance_unavailable", "reference_missing"]).nullable(),
	drafts: z.array(z.strictObject({ ordinal: z.int().min(1), violations: z.array(violation) })),
	usage: z.strictObject({ attempts: z.int().min(0), inputTokens: z.int().min(0), outputTokens: z.int().min(0) }),
});
export type RunResult = z.infer<typeof runResult>;

/** The citation read (intelligence.resolveCitation), which the Plant Intelligence screen opens. */
export const resolveCitationRequest = z.strictObject({ runId: recordId, key: z.string().min(1).max(80) });
export const citationView = z.union([
	z.strictObject({
		status: z.literal("verified"),
		kind: z.literal("fact"),
		key: z.string(),
		label: z.string(),
		value: factEntry.shape.value,
		/** The run's as-of instant and the plant-local date the fact was measured on. */
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
		/** False when the reference has since moved to a newer version: the passage is the one the run read. */
		currentVersion: z.boolean(),
	}),
	/** The stored source no longer matches what the run cited: no text or link is offered as if valid. */
	z.strictObject({ status: z.literal("unverifiable"), key: z.string() }),
	/** The reader can no longer reach the source, such as a network's article after leaving that network. */
	z.strictObject({ status: z.literal("unavailable"), key: z.string() }),
]);
export type CitationView = z.infer<typeof citationView>;

export const evaluateAssessmentRequest = z.strictObject({ runId: recordId });
export const readAssessmentRequest = z.strictObject({});

export const assessmentError = z.discriminatedUnion("code", [
	defineSafeError("invalid_input", {}, "never"),
	defineSafeError("access_denied", {}, "never"),
	defineSafeError("not_found", {}, "never"),
]);
export type AssessmentError = z.infer<typeof assessmentError>;
export type AssessmentReply<T> = Reply<T, AssessmentError>;

// The language evaluation (PI-036): a graded judge scores each draft for plain, warm and useful wording, and lists any
// hype or pressure as a failure on that draft. Tests and CI use the scripted judge only.
const grade = z.int().min(1).max(5);
export const languageGrade = z.strictObject({
	plain: grade,
	warm: grade,
	useful: grade,
	failures: z.array(z.strictObject({ rule: z.enum(["hype", "pressure"]), quote: z.string() })),
});
export type LanguageGrade = z.infer<typeof languageGrade>;
/** A draft passes the language evaluation with no hype or pressure and at least 3 on each scale. */
export const languagePasses = (g: LanguageGrade) =>
	g.failures.length === 0 && g.plain >= 3 && g.warm >= 3 && g.useful >= 3;
