import { counted } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/intelligence";
import type { Catalog, CriterionKey, CriterionStatus } from "@everyfield/contracts/phases";
import { sql, type SQL, type SqlLiteral } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { readinessOf } from "../phases/readiness.ts";

const pointsOf = (d: c.DraftOutput) => [d.focus, ...d.supporting, ...d.positives].map((p, ordinal) => ({ p, ordinal }));
const RANK: Record<c.Urgency, number> = { urgent: 0, watch: 1, positive: 2, info: 3 };
const STANDING = { urgent: "attention", watch: "watch", positive: "strength", info: "noted" } as const;

function catalogOf(facts: unknown): { facts: c.PlantFacts | null; entries: Map<string, c.FactEntry> } {
	const parsed = c.plantFacts.safeParse(facts);
	if (!parsed.success) return { facts: null, entries: new Map() };
	return { facts: parsed.data, entries: new Map(c.factCatalog(parsed.data).map((f) => [f.key, f])) };
}
const evidenceOf = (entries: Map<string, c.FactEntry>, keys: readonly string[]): c.EvidenceFact[] =>
	keys.flatMap((k) => {
		const f = entries.get(k);
		return f ? [{ key: f.key, label: f.label, value: f.value }] : [];
	});

export function lensesOf(facts: unknown, draft: c.DraftOutput): c.LensTile[] {
	const { facts: f, entries } = catalogOf(facts);
	const points = pointsOf(draft);
	return c.LENSES.map((lens) => {
		const measured = lens.facts.some((g) => {
			const status = entries.get(`${g}.status`)?.value;
			return status !== undefined && status !== "unknown";
		});
		const attestations = lens.attestations.map((key) => {
			const a = f?.attestations.find((x) => x.key === key);
			return {
				key,
				label: c.definitionOf(key).label,
				answered: a?.state === "answered",
				asOf: a?.state === "answered" ? a.asOf : null,
				needsRenewing: a?.renewal.status === "needs_renewing",
			};
		});
		const quality = measured ? "measured" : attestations.some((a) => a.answered) ? "attested" : "unknown";
		const citing = points
			.filter(({ p }) => p.citations.some((k) => c.lensOfKey(k) === lens.key))
			.sort((a, b) => RANK[a.p.urgency] - RANK[b.p.urgency] || a.ordinal - b.ordinal);
		const top = citing[0];
		return {
			key: lens.key,
			label: lens.label,
			quality,
			standing: top ? STANDING[top.p.urgency] : quality === "unknown" ? "insufficient" : "not_raised",
			evidence: evidenceOf(entries, lens.headline),
			attestations,
			points: citing.map((x) => x.ordinal),
		} satisfies z.output<typeof c.lensTile>;
	});
}

export function criteriaOf(catalog: Catalog, phase: number, facts: unknown): c.AssessedCriterion[] {
	const { facts: f, entries } = catalogOf(facts);
	const results: Partial<Record<CriterionKey, CriterionStatus>> = f
		? { ...c.launchCriteria(f.launch), ...f.criteria }
		: {};
	const assessed = catalog.phases[phase];
	if (!assessed || assessed.terminal) return [];
	return readinessOf(assessed, results).criteria.map((x) =>
		c.assessedCriterion.parse({ ...x, evidence: evidenceOf(entries, c.CRITERION_EVIDENCE[x.key] ?? []) }),
	);
}

const ANSWERED = { yes: "Answered yes", not_yet: "Answered not yet" } as const;
const answerReading = (value: c.EvidenceFact["value"], asOf: c.EvidenceFact["value"]) =>
	value === "yes" || value === "not_yet" ? `${ANSWERED[value]} as of ${String(asOf)}` : null;
const READINGS: Partial<Record<CriterionKey, (v: (key: string) => c.EvidenceFact["value"]) => string | null>> = {
	values_documented: (v) =>
		answerReading(v("attestations.values_documented"), v("attestations.values_documented.asOf")),
	committed_adults: (v) => {
		const exact = v("committedAdults.count");
		if (typeof exact === "number") return `${exact} of ${c.ADULT_TARGET} committed adults`;
		const known = v("committedAdults.atLeast");
		const open = Number(v("committedAdults.needsClassifying") ?? 0);
		return typeof known === "number"
			? `At least ${known} of ${c.ADULT_TARGET} committed adults; ${counted(open, "person needs", "people need")} an adult or child classification`
			: null;
	},
	growth_trajectory: (v) => {
		const days = v("growth.daysSince");
		return typeof days === "number"
			? `${counted(days, "day")} since the newest committed adult, on ${String(v("growth.lastAcquiredOn"))}`
			: null;
	},
	financial_base: (v) =>
		answerReading(v("attestations.financial_base_established"), v("attestations.financial_base_established.asOf")),
	all_team_leaders: (v) =>
		`${String(v("coverage.filled"))} of ${String(v("coverage.slots"))} ministry responsibilities filled, by ${counted(Number(v("coverage.people")), "person", "people")}`,
	launch_date_set: (v) =>
		typeof v("launch.targetOn") === "string" ? `Launch Sunday set for ${String(v("launch.targetOn"))}` : null,
	training_complete: (v) => {
		const done = v("training.complete");
		return typeof done === "number" ? `${done} of ${String(v("training.total"))} required trainings completed` : null;
	},
	systems_tested: (v) => answerReading(v("attestations.systems_tested"), v("attestations.systems_tested.asOf")),
	launch_window: (v) => {
		const days = v("launch.daysToLaunch");
		if (typeof days !== "number") return null;
		return days >= 0
			? `${counted(days, "day")} to Launch Sunday`
			: `Launch Sunday's date was ${counted(-days, "day")} ago`;
	},
	first_service_complete: (v) => {
		const on = v("firstService.heldOn");
		if (typeof on !== "string") return null;
		const milestone = v("firstService.milestone");
		return typeof milestone === "string" ? `${milestone} reached on ${on}` : `Launch Sunday held on ${on}`;
	},
};

export function readingOf(criterion: c.AssessedCriterion): string | null {
	const read = READINGS[criterion.key];
	if (!read || !criterion.evidence.length) return null;
	return read((key) => criterion.evidence.find((e) => e.key === key)?.value ?? null);
}

export const concernsSql = <RName extends string>(r: SqlLiteral<RName>) => {
	const run = sql.raw(r);
	return sql`(SELECT coalesce(json_agg(json_build_object('ordinal',e.n-1,'urgency',e.p->>'urgency','keys',e.p->'citations',
	'evidence',(SELECT coalesce(json_agg(json_build_object('key',k.v,'label',f.cite->>'label','value',f.cite->'value')
		ORDER BY k.n),'[]'::json) FROM jsonb_array_elements_text(e.p->'citations') WITH ORDINALITY k(v,n)
		CROSS JOIN LATERAL (SELECT ${run}.result->'citations'->k.v AS cite) f WHERE f.cite->>'kind'='fact'))
	ORDER BY e.n),'[]'::json)
	FROM jsonb_array_elements(jsonb_build_array(${run}.result->'draft'->'focus')||(${run}.result->'draft'->'supporting')
		||coalesce(${run}.result->'draft'->'positives','[]'::jsonb)) WITH ORDINALITY e(p,n)
	WHERE e.p->>'urgency' IN ('watch','urgent'))`;
};
export const storedConcern = z.object({
	ordinal: z.int(),
	urgency: z.enum(["watch", "urgent"]),
	keys: z.array(z.string()),
	evidence: z.array(c.evidenceFact),
});
export type StoredConcern = z.infer<typeof storedConcern>;
export const concernOf = (runId: string, s: StoredConcern): c.Concern =>
	({
		id: c.concernId(runId, s.ordinal),
		ordinal: s.ordinal,
		severity: c.SEVERITY[s.urgency],
		lens: s.keys.map(c.lensOfKey).find((l) => l !== null) ?? null,
		evidence: s.evidence,
	}) satisfies z.output<typeof c.concern>;

export const RELEASE_HOURS = 72;
export const releasedRun = (plant: SQL, now: SQL) => sql`(SELECT r.* FROM assessment_run r WHERE r.plant_id=${plant}
	AND r.outcome='published' AND least(r.available_at+make_interval(hours=>${RELEASE_HOURS}),
		(SELECT min(s.seen_at) FROM assessment_seen s WHERE s.run_id=r.id))<=${now}
	ORDER BY r.available_at DESC,r.id DESC LIMIT 1)`;

const UNKNOWN_WITH_STATUS = new Set(["followUps", "training", "cohesion"]);
export const trendCellsSql = <RName extends string>(r: SqlLiteral<RName>) =>
	sql`json_build_array(${sql.join(
		c.TREND_FACTS.map(({ key }) => {
			const [group, field] = key.split(".") as [string, string];
			const g = sql`${sql.raw(r)}.facts->${group}::text`;
			return sql`CASE WHEN jsonb_typeof(${g})='object' AND ${g} ? ${field}::text
				THEN jsonb_build_object('status',${g}->'status','value',${g}->${field}::text) END`;
		}),
		sql`,`,
	)})`;
export const trendCells = z.array(z.object({ status: z.unknown(), value: z.unknown() }).nullable());
export function trendOf(cells: z.infer<typeof trendCells>): c.TrendValue[] {
	return c.TREND_FACTS.map(({ key }, i) => {
		const cell = cells[i];
		if (!cell) return { state: "not_measured" };
		const [group = key] = key.split(".");
		if (cell.status === "unknown" && UNKNOWN_WITH_STATUS.has(group)) return { state: "unknown" };
		return typeof cell.value === "number" ? { state: "measured", value: cell.value } : { state: "unknown" };
	});
}
