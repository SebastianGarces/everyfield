import * as c from "@everyfield/contracts/intelligence";
import type { Transaction } from "@everyfield/db/client";
import { createAssessments, createFacts } from "@everyfield/domain/intelligence";
import { z } from "zod";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import { plantAdmin } from "../../native.ts";
import { dayText } from "../../pipeline/reads/index.ts";

// Plant Intelligence as Evry reads it (WP-073): the same domain reads /intelligence makes (WP-040, WP-044), under the
// asker's live Owner or Admin seat. Evry quotes the saved assessment and the measured facts; it never scores health or
// writes a finding of its own. Committed adults are the facts' own count: only signed commitments count, never a
// People stage, and the count stays Unknown while someone with a commitment has no adult or child classification
// (PI-002, CA024). Private weekly check-ins have no read here, and no result names a person a fact counted.

const assessments = createAssessments();
const facts = createFacts();
/** Where the planter reads all of this. */
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
/** No published assessment yet: the answer says so, never that the church is healthy. */
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

/** A fact value in words, as the screen says it: Unknown for null, Yes or No, a date, or the number. */
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

/** The current published assessment, or null before the first. */
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

export const readScorecard: ReadAdapter<Record<string, never>> = {
	operation: "intelligence.readScorecard",
	description:
		"The latest assessment's scorecard as the Plant Intelligence screen shows it: the eight lens tiles (lens rows: Measured, Attested or Unknown, the assessment's standing and the facts behind it) and the assessed phase's exit criteria (criterion rows: Met, Not met, Unknown), with the date the assessment measured them. Quote the standings as the assessment gives them; give no opinion of health. Owners and Admins",
	input: none,
	allowed: plantAdmin,
	async invoke(tx, actor): Promise<SourceResult> {
		const a = await currentOf(tx, actor);
		if (!a) return noAssessment("intelligence.readScorecard");
		const lenses: SourceRow[] = a.lenses.map((l) => ({
			kind: "item",
			id: `${a.runId}:${l.key}`,
			label: l.label,
			fields: {
				lens: l.key,
				standing: STANDING[l.standing],
				evidence: QUALITY[l.quality],
				facts: evidence(l.evidence),
			},
		}));
		const criteria: SourceRow[] = a.criteria.map((x) => ({
			kind: "criterion",
			id: `${a.runId}:${x.key}`,
			label: x.label,
			fields: { status: CRITERION[x.status], facts: evidence(x.evidence) },
		}));
		return result("intelligence.readScorecard", [...lenses, ...criteria], {
			...assessedFacts(a),
			summary: a.summary,
		});
	},
};

/** At most this many cited facts are resolved per read: a draft cites at most eight per point, and repeats most. */
const CITED = 16;
export const readAssessment: ReadAdapter<Record<string, never>> = {
	operation: "intelligence.readAssessment",
	description:
		"The latest published assessment as the Plant Intelligence screen shows it: its summary and its findings (item rows: the focus, two supporting points and the positives, each with its title, its words, its severity and the facts it cites with their values from the assessment's own snapshot), with the date it measured them. Quote the findings; never add a finding, a judgment of a person or an opinion of your own. Owners and Admins",
	input: none,
	allowed: plantAdmin,
	async invoke(tx, actor): Promise<SourceResult> {
		const a = await currentOf(tx, actor);
		if (!a) return noAssessment("intelligence.readAssessment");
		const points = [
			{ role: "focus", p: a.focus },
			...a.supporting.map((p) => ({ role: "supporting", p })),
			...a.positives.map((p) => ({ role: "positive", p })),
		];
		// Each cited fact resolves against the run's own snapshot through the screen's citation read; a passage names
		// its article. The people a fact counted stay on the screen.
		const keys = [
			...new Set(points.flatMap(({ p }) => p.citations.filter((x) => x.kind === "fact").map((x) => x.key))),
		];
		const values = new Map<string, string | number>();
		for (const key of keys.slice(0, CITED)) {
			const v = await assessments.resolveCitation(tx, actor.authority, { runId: a.runId, key });
			if (v.status === "ok" && v.value.status === "verified" && v.value.kind === "fact")
				values.set(key, factText(v.value.value));
		}
		const rows: SourceRow[] = points.map(({ role, p }, ordinal) => ({
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
		return result("intelligence.readAssessment", rows, { ...assessedFacts(a), runId: a.runId, summary: a.summary }, [
			"the names a fact counted, which stay on the Plant Intelligence screen",
			"private weekly check-ins",
		]);
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

/** The installed Plant Intelligence assessment reads. */
export const ASSESSMENT_INTELLIGENCE_READS = [
	readCommittedAdultCohort,
	readScorecard,
	readAssessment,
	readAssessmentDelta,
] as const;
