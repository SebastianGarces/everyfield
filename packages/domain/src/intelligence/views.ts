import * as c from "@everyfield/contracts/intelligence";
import type { Catalog, CriterionKey, CriterionStatus } from "@everyfield/contracts/phases";
import { sql, type SQL } from "@everyfield/db/query";
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
				label: c.SIGNAL_DEFINITIONS.find((d) => d.key === key)!.label,
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
		return c.lensTile.parse({
			key: lens.key,
			label: lens.label,
			quality,
			standing: top ? STANDING[top.p.urgency] : quality === "unknown" ? "insufficient" : "not_raised",
			evidence: evidenceOf(entries, lens.headline),
			attestations,
			points: citing.map((x) => x.ordinal),
		});
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

export const concernsSql = (r: string) => {
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
	c.concern.parse({
		id: c.concernId(runId, s.ordinal),
		ordinal: s.ordinal,
		severity: c.SEVERITY[s.urgency],
		lens: s.keys.map(c.lensOfKey).find((l) => l !== null) ?? null,
		evidence: s.evidence,
	});

export const RELEASE_HOURS = 72;
export const releasedRun = (plant: SQL, now: SQL) => sql`(SELECT r.* FROM assessment_run r WHERE r.plant_id=${plant}
	AND r.outcome='published' AND least(r.available_at+make_interval(hours=>${RELEASE_HOURS}),
		(SELECT min(s.seen_at) FROM assessment_seen s WHERE s.run_id=r.id))<=${now}
	ORDER BY r.available_at DESC,r.id DESC LIMIT 1)`;

const UNKNOWN_WITH_STATUS = new Set(["followUps", "training", "cohesion"]);
export const trendCellsSql = (r: string) =>
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
		if (cell.status === "unknown" && UNKNOWN_WITH_STATUS.has(key.split(".")[0]!)) return { state: "unknown" };
		return typeof cell.value === "number" ? { state: "measured", value: cell.value } : { state: "unknown" };
	});
}
