import * as c from "@everyfield/contracts/intelligence";
import type { Catalog, CriterionKey, CriterionStatus } from "@everyfield/contracts/phases";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { readinessOf } from "../phases/readiness.ts";

// The Plant Intelligence views of one published run (WP-044): the eight lens tiles, the assessed phase's exit criteria
// with their evidence, the concerns an organization may see once the run is released, and the run's trend values. All
// are pure readings of the run's own stored snapshot and result: reads call no model and change nothing.

/** A point of a published draft with its insight ordinal: focus 0, the two supporting points, then positives. */
const pointsOf = (d: c.DraftOutput) => [d.focus, ...d.supporting, ...d.positives].map((p, ordinal) => ({ p, ordinal }));
/** Strongest first. A positive point is a strength; an info point only notes. */
const RANK: Record<c.Urgency, number> = { urgent: 0, watch: 1, positive: 2, info: 3 };
const STANDING = { urgent: "attention", watch: "watch", positive: "strength", info: "noted" } as const;

/** The snapshot's citable facts, or none when it is not this formula's (an older run reads as nothing measured). */
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

/**
 * The eight lens tiles (PI-027, rubric v1 §5b). A lens is measured when one of its fact groups has a measured status,
 * attested when only the planter's answer stands for it, and Unknown otherwise; a stale answer stays attested and says
 * it needs renewing. Its standing is the strongest point citing it, never a pass when nothing is known.
 */
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

/**
 * The exit criteria of the phase the run assessed (PI-028), as its snapshot measured them, each with the snapshot
 * facts behind it. The launch-date criteria read the snapshot's own launch date and countdown; every other criterion
 * the facts do not measure stays Unknown. Phase 6 has none.
 */
export function criteriaOf(catalog: Catalog, phase: number, facts: unknown): c.AssessedCriterion[] {
	const { facts: f, entries } = catalogOf(facts);
	const results: Partial<Record<CriterionKey, CriterionStatus>> = { ...f?.criteria };
	if (f?.launch.targetOn) results.launch_date_set ??= "met";
	const days = f?.launch.daysToLaunch;
	if (typeof days === "number") results.launch_window ??= days >= 0 && days <= 28 ? "met" : "not_met";
	const assessed = catalog.phases[phase];
	if (!assessed || assessed.terminal) return [];
	return readinessOf(assessed, results).criteria.map((x) =>
		c.assessedCriterion.parse({ ...x, evidence: evidenceOf(entries, c.CRITERION_EVIDENCE[x.key] ?? []) }),
	);
}

/**
 * The run's concerns as one JSON array, for run row `r`: each point at watch or urgent with its insight ordinal, its
 * citation keys and the fact citations it rests on (key, label, value). Passages and the point's words stay out. The
 * planter's read and every organization read use this one fragment, so both name the same concern with the same
 * evidence (PI-032).
 */
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

/** How long after a run becomes available it is released to organizations without a first open (PI-032). */
export const RELEASE_HOURS = 72;
/**
 * The plant's run released to its organizations at `now`, as a lateral subquery over plant `plant`: the latest
 * published run whose release has come, the earliest of an eligible Owner's or Admin's first open and 72 hours after
 * it became available. A newer run waiting for its release leaves the earlier released one in place.
 */
export const releasedRun = (plant: SQL, now: SQL) => sql`(SELECT r.* FROM assessment_run r WHERE r.plant_id=${plant}
	AND r.outcome='published' AND least(r.available_at+make_interval(hours=>${RELEASE_HOURS}),
		(SELECT min(s.seen_at) FROM assessment_seen s WHERE s.run_id=r.id))<=${now}
	ORDER BY r.available_at DESC,r.id DESC LIMIT 1)`;

const UNKNOWN_WITH_STATUS = new Set(["followUps", "training", "cohesion"]);
/**
 * The trend cells of stored run `r` as one JSON array, one per trend fact: null when the snapshot has no such fact
 * (written before it existed), else the fact's value and its group's measured status.
 */
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
/** The trend values of one snapshot: absent is Not measured, a measured Unknown is Unknown, never zero. */
export function trendOf(cells: z.infer<typeof trendCells>): c.TrendValue[] {
	return c.TREND_FACTS.map(({ key }, i) => {
		const cell = cells[i];
		if (!cell) return { state: "not_measured" };
		// As the fact catalog reads them: these counts mean nothing while their own measure is Unknown.
		if (cell.status === "unknown" && UNKNOWN_WITH_STATUS.has(key.split(".")[0]!)) return { state: "unknown" };
		return typeof cell.value === "number" ? { state: "measured", value: cell.value } : { state: "unknown" };
	});
}
