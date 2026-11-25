import { dayText } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/intelligence";
import type { Transaction } from "@everyfield/db/client";
import { createAssessments, createFacts } from "@everyfield/domain/intelligence";
import { z } from "zod";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import { present } from "../../../runtime/captured.ts";
import { plantAdmin } from "../../native.ts";

const assessments = createAssessments();
const facts = createFacts();
const SCREEN = "[Plant Intelligence](/intelligence)";

type Reply<T> = { status: "ok"; value: T } | { status: "refused"; error: { code: string } };
function valueOf<T>(reply: Reply<T>): T {
	if (reply.status === "ok") return reply.value;
	throw new EvryRefusal(reply.error.code === "access_denied" ? "access_denied" : "source_unavailable");
}
const result = (
	operation: string,
	rows: SourceRow[],
	facts: SourceResult["facts"],
	exclusions: string[] = [],
): SourceResult => ({
	operation,
	status: "available",
	rows,
	total: rows.length,
	page: 1,
	next: null,
	completeness: "complete",
	exclusions,
	facts,
});
const noAssessment = (operation: string): SourceResult => ({
	operation,
	status: "not_found",
	rows: [],
	total: 0,
	page: 1,
	next: null,
	completeness: "complete",
	exclusions: ["an assessment, because none has been published yet"],
	facts: { assessed: false, screen: SCREEN },
});

function factText(value: c.EvidenceFact["value"]): string | number {
	if (value === null) return "Unknown";
	if (typeof value === "boolean") return value ? "Yes" : "No";
	if (Array.isArray(value)) return value.join(", ") || "None";
	if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return dayText(value);
	if (typeof value === "string") {
		const words = value.replaceAll("_", " ");
		return words.charAt(0).toUpperCase() + words.slice(1);
	}
	return value;
}
const SEVERITY: Record<string, string> = {
	critical: "Urgent",
	high: "Urgent",
	medium: "Watch",
	low: "Worth knowing",
	info: "Going well",
};
const STANDING: Record<c.LensTile["standing"], string> = {
	attention: "Attention",
	watch: "Watch",
	noted: "Noted",
	strength: "Strength",
	not_raised: "Not raised",
	insufficient: "Not enough evidence",
};
const QUALITY: Record<c.LensTile["quality"], string> = {
	measured: "Measured",
	attested: "Attested",
	unknown: "Unknown",
};
const CRITERION: Record<c.AssessedCriterion["status"], string> = {
	met: "Met",
	not_met: "Not met",
	unknown: "Unknown",
	not_tracked: "Not tracked",
};
const evidence = (e: readonly c.EvidenceFact[]) => e.map((x) => `${x.label}: ${factText(x.value)}`).join("; ") || null;

export const RATING = { useful: "Useful", not_useful: "Not useful" } as const;
const PRIVATE = ["the names a fact counted, which stay on the Plant Intelligence screen", "private weekly check-ins"];

const none = z.strictObject({});

export const readCommittedAdultCohort: ReadAdapter<Record<string, never>> = {
	operation: "intelligence.readCommittedAdultCohort",
	description:
		"Committed adults as Plant Intelligence measures them today, the same count its screen shows: adults with a signed core group or launch team commitment, never a People stage. known is the counted adults; exact is the total, or null while needsClassifying people with a commitment have no adult or child classification, and then whether the 30-adult criterion is met is Unknown. Says the date it was measured. Owners and Admins",
	input: none,
	allowed: plantAdmin,
	async invoke(tx, actor): Promise<SourceResult> {
		const f = valueOf(await facts.readFacts(tx, actor.authority, {}));
		const a = f.committedAdults;
		const criterion = a.status === "met" ? "met" : a.status === "not_met" ? "not met" : "unknown";
		const row: SourceRow = {
			kind: "item",
			id: actor.owner.id,
			label: "Committed adults",
			fields: {
				known: a.known,
				exact: a.exact,
				needsClassifying: a.needsClassifying.length,
				measuredOn: dayText(f.today),
			},
		};
		return result("intelligence.readCommittedAdultCohort", [row], {
			known: a.known,
			exact: a.exact,
			needsClassifying: a.needsClassifying.length,
			childrenNotCounted: a.children,
			target: c.ADULT_TARGET,
			criterion,
			measuredOn: dayText(f.today),
			counts: "signed core group or launch team commitments only; a People stage is not a commitment",
			screen: SCREEN,
		});
	},
};

const currentOf = async (tx: Transaction, actor: EvryActor) =>
	valueOf(await assessments.readAssessment(tx, actor.authority, {})).current;
const assessedFacts = (a: c.Assessment) => ({
	assessed: true,
	measuredOn: dayText(a.measuredOn),
	ageDays: a.ageDays,
	phase: a.phase,
	rubricVersion: a.rubricVersion,
	screen: SCREEN,
});

function scorecardRows(a: c.Assessment): SourceRow[] {
	return [
		...a.lenses.map((l) => ({
			kind: "item" as const,
			id: `${a.runId}:${l.key}`,
			label: l.label,
			fields: {
				lens: l.key,
				standing: STANDING[l.standing],
				evidence: QUALITY[l.quality],
				facts: evidence(l.evidence),
			},
		})),
		...a.criteria.map((x) => ({
			kind: "criterion" as const,
			id: `${a.runId}:${x.key}`,
			label: x.label,
			fields: { status: CRITERION[x.status], facts: evidence(x.evidence) },
		})),
	];
}

export const readScorecard: ReadAdapter<Record<string, never>> = {
	operation: "intelligence.readScorecard",
	description:
		"The latest assessment's scorecard as the Plant Intelligence screen shows it: the eight lens tiles (lens rows: Measured, Attested or Unknown, the assessment's standing and the facts behind it) and the assessed phase's exit criteria (criterion rows: Met, Not met, Unknown), with the date the assessment measured them. Quote the standings as the assessment gives them; give no opinion of health. Owners and Admins",
	input: none,
	allowed: plantAdmin,
	async invoke(tx, actor): Promise<SourceResult> {
		const a = await currentOf(tx, actor);
		if (!a) return noAssessment("intelligence.readScorecard");
		return result("intelligence.readScorecard", scorecardRows(a), {
			...assessedFacts(a),
			summary: a.summary,
		});
	},
};

const CITED = 16;
async function findingRows(tx: Transaction, actor: EvryActor, a: c.Assessment): Promise<SourceRow[]> {
	const points = [
		{ role: "focus", p: a.focus },
		...a.supporting.map((p) => ({ role: "supporting", p })),
		...a.positives.map((p) => ({ role: "positive", p })),
	];
	const keys = [
		...new Set(points.flatMap(({ p }) => p.citations.filter((x) => x.kind === "fact").map((x) => x.key))),
	];
	const values = new Map<string, string | number>();
	for (const key of keys.slice(0, CITED)) {
		const v = await assessments.resolveCitation(tx, actor.authority, { runId: a.runId, key });
		if (v.status === "ok" && v.value.status === "verified" && v.value.kind === "fact")
			values.set(key, factText(v.value.value));
	}
	return points.map(({ role, p }, ordinal) => ({
		kind: "item",
		id: `${a.runId}:${ordinal}`,
		label: p.title,
		fields: {
			role,
			ordinal,
			severity: SEVERITY[p.severity] ?? p.severity,
			body: p.body,
			cites: p.citations
				.map((x) =>
					x.kind === "fact" ? `${x.label}: ${values.get(x.key) ?? "not resolved"}` : `Methodology: ${x.label}`,
				)
				.join("; "),
		},
	}));
}

export const readAssessment: ReadAdapter<Record<string, never>> = {
	operation: "intelligence.readAssessment",
	description:
		"The latest published assessment as the Plant Intelligence screen shows it: its summary and its findings (item rows: the focus, two supporting points and the positives, each with its title, its words, its severity and the facts it cites with their values from the assessment's own snapshot), with the date it measured them. Quote the findings; never add a finding, a judgment of a person or an opinion of your own. Owners and Admins",
	input: none,
	allowed: plantAdmin,
	async invoke(tx, actor): Promise<SourceResult> {
		const a = await currentOf(tx, actor);
		if (!a) return noAssessment("intelligence.readAssessment");
		const rows = await findingRows(tx, actor, a);
		return result("intelligence.readAssessment", rows, { ...assessedFacts(a), runId: a.runId, summary: a.summary }, PRIVATE);
	},
};

export const readAssessmentDelta: ReadAdapter<Record<string, never>> = {
	operation: "intelligence.readAssessmentDelta",
	description:
		"What moved between the latest published assessment and the one before it, as the assessment saved it: each changed fact (item rows: before and after) and both assessments' dates. The first assessment has nothing to compare with. Owners and Admins",
	input: none,
	allowed: plantAdmin,
	async invoke(tx, actor): Promise<SourceResult> {
		const a = await currentOf(tx, actor);
		if (!a) return noAssessment("intelligence.readAssessmentDelta");
		const rows: SourceRow[] = (a.delta?.changed ?? []).map((x) => ({
			kind: "item",
			id: `${a.runId}:${x.key}`,
			label: x.label,
			fields: { before: factText(x.before), after: factText(x.after) },
		}));
		return result("intelligence.readAssessmentDelta", rows, {
			...assessedFacts(a),
			previous: a.delta ? dayText(a.delta.previousAsOf.slice(0, 10)) : null,
			firstAssessment: a.delta === null,
		});
	},
};

const newerText = (newest: c.NewestRun | null) =>
	newest?.state === "preparing"
		? "A newer assessment is being prepared."
		: newest?.state === "deferred"
			? "A newer assessment is waiting for the assessment service and will try again shortly."
			: null;
const trendText = (v: c.TrendValue) =>
	v.state === "measured" ? v.value : v.state === "unknown" ? "Unknown" : "Not measured";

export const readAssessmentHistory: ReadAdapter<Record<string, never>> = {
	operation: "intelligence.readAssessmentHistory",
	description:
		"How this church's assessments changed over time, as the Plant Intelligence Trends screen shows it: its published assessments, newest first, up to twelve (item rows, one per assessment with its date, phase and the six trend facts it measured then; Not measured means that assessment was made before Everyfield measured the fact, and is not a zero). Give a row's id to intelligence.readAssessmentRun for that assessment itself. When newer says one is being prepared or waiting, say so and say the answer uses the published assessment it names. Owners and Admins",
	input: none,
	allowed: plantAdmin,
	async invoke(tx, actor): Promise<SourceResult> {
		const operation = "intelligence.readAssessmentHistory";
		const history = valueOf(await assessments.readHistory(tx, actor.authority, {}));
		const view = valueOf(await assessments.readAssessment(tx, actor.authority, {}));
		const [latest] = history.runs;
		if (!latest) return noAssessment(operation);
		return result(
			operation,
			history.runs.map((r, n) => ({
				kind: "item",
				id: r.runId,
				label: dayText(r.measuredOn),
				fields: {
					latest: n === 0,
					phase: `Phase ${r.phase}`,
					...Object.fromEntries(c.TREND_FACTS.map((f, i) => [f.label, trendText(present(r.values[i]))])),
				},
			})),
			{
				assessed: true,
				newer: newerText(view.newest),
				published: `The latest published assessment was measured ${dayText(latest.measuredOn)}.`,
				screen: "[Trends](/intelligence/trends)",
			},
		);
	},
};

export const readAssessmentRun: ReadAdapter<{ runId: string }> = {
	operation: "intelligence.readAssessmentRun",
	description:
		"One published assessment of this church, an earlier one or the latest, by its id from intelligence.readAssessmentHistory: its summary, date and phase in facts, its findings (item rows with a role, as intelligence.readAssessment gives them) and its scorecard (lens and criterion rows), all from that assessment's own snapshot. Say the date it measured. When newer says one is being prepared or waiting, say so and say which assessment this is. Owners and Admins",
	input: z.strictObject({ runId: z.uuid() }),
	allowed: plantAdmin,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const operation = "intelligence.readAssessmentRun";
		const read = await assessments.readRun(tx, actor.authority, input);
		if (read.status !== "ok" && read.error.code === "not_found")
			return { ...result(operation, [], { screen: SCREEN }), status: "not_found", total: 0 };
		const a = valueOf(read);
		const view = valueOf(await assessments.readAssessment(tx, actor.authority, {}));
		return result(
			operation,
			[...(await findingRows(tx, actor, a)), ...scorecardRows(a)],
			{
				...assessedFacts(a),
				runId: a.runId,
				summary: a.summary,
				latest: view.current?.runId === a.runId,
				newer: newerText(view.newest),
				published: `This is the published assessment measured ${dayText(a.measuredOn)}.`,
			},
			PRIVATE,
		);
	},
};

export const readColdStartGuidance: ReadAdapter<Record<string, never>> = {
	operation: "intelligence.readColdStartGuidance",
	description:
		"Where to start while this church has no published assessment, as the Plant Intelligence screen says it: the title and body for the actual state in facts (not prepared yet, on its way, or couldn't be prepared) and the next steps from the church's own records (step rows, in order, each with its detail and href). Say them as returned, in their order, and call nothing met or unmet. When assessed is true the church has an assessment: use intelligence.readAssessment instead. It asks for no new assessment. Owners and Admins",
	input: none,
	allowed: plantAdmin,
	async invoke(tx, actor): Promise<SourceResult> {
		const operation = "intelligence.readColdStartGuidance";
		const view = valueOf(await assessments.readAssessment(tx, actor.authority, {}));
		if (view.current) return result(operation, [], assessedFacts(view.current));
		const guidance = c.coldStartGuidance(view.newest, valueOf(await facts.readFacts(tx, actor.authority, {})));
		return result(
			operation,
			guidance.steps.map((s, n) => ({
				kind: "item",
				id: `step:${n + 1}`,
				label: s.title,
				fields: { step: n + 1, detail: s.detail, href: s.href },
			})),
			{
				assessed: false,
				title: guidance.title,
				body: guidance.body,
				results: guidance.results,
				noSteps: guidance.steps.length ? null : guidance.noSteps,
				screen: SCREEN,
			},
		);
	},
};

export const readOwnFeedback: ReadAdapter<Record<string, never>> = {
	operation: "intelligence.readOwnFeedback",
	description:
		"The signed-in user's own ratings of this church's published assessments, newest assessment first: each finding they rated with their rating, their comment and the day they saved it, and which assessment it was. Empty means they gave none. Nobody else's rating is ever read. Owners and Admins",
	input: none,
	allowed: plantAdmin,
	async invoke(tx, actor): Promise<SourceResult> {
		const own = valueOf(await assessments.readOwnFeedback(tx, actor.authority, {}));
		return result(
			"intelligence.readOwnFeedback",
			own.findings.map((f) => ({
				kind: "item",
				id: `${f.runId}:${f.ordinal}`,
				label: f.title,
				fields: {
					assessment: dayText(f.measuredOn),
					rating: RATING[f.rating],
					comment: f.comment,
					ratedOn: new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: own.timeZone }).format(
						new Date(f.recordedAt),
					),
				},
			})),
			{ rated: own.findings.length, screen: SCREEN },
			["anyone else's rating"],
		);
	},
};

export const ASSESSMENT_INTELLIGENCE_READS = [
	readCommittedAdultCohort,
	readScorecard,
	readAssessment,
	readAssessmentDelta,
	readAssessmentHistory,
	readAssessmentRun,
	readColdStartGuidance,
	readOwnFeedback,
] as const;
