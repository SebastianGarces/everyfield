import { pipelineMetrics, pipelineMetricsRequest, stage, type PipelineMetrics } from "@everyfield/contracts/people";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { liveRead, type RequestActor } from "../access/session.ts";
import { plantViewer } from "../documents/access.ts";

type Stage = z.infer<typeof stage>;
const STAGES = stage.options;

const row = z.object({
	ok: z.boolean(),
	timezone: z.string().nullable(),
	opens_at: z.string().nullable(),
	closes_at: z.string().nullable(),
	persons: z
		.array(
			z.object({
				id: z.uuid(),
				canonical: z.uuid(),
				stage: stage.nullable(),
				live: z.boolean(),
				createdAt: z.string(),
			}),
		)
		.nullable(),
	events: z
		.array(z.object({ person: z.uuid(), at: z.string(), from: z.string().nullable(), to: z.string().nullable() }))
		.nullable(),
});
type Row = z.infer<typeof row>;
type Move = { at: number; from: Stage | null; to: Stage | null };
const known = (v: string | null): Stage | null => stage.safeParse(v).data ?? null;

/**
 * people.readPipelineMetrics (PPL-023): an internal, same-church count of recorded pipeline moves at a frozen asOf. Any
 * live seat of the church reads it; an organization seat or another church gets access_denied. No screen or Evry tool
 * calls it. One statement reads the church's People with the record each one is merged into, and every recorded stage
 * move; the counts are worked out from those rows:
 * - Current stage counts: live canonical People by their stage at asOf.
 * - Transition people: distinct canonical People with at least one exact `from` to `to` move inside the window, so a
 *   repeat after a move back counts once, and a merged record's moves count for the Person it was merged into.
 * - Denominator: the canonical People in `from` when the window opened. It is Unknown when the history cannot rebuild
 *   it: a Person whose records were merged, or a move recorded without its stages. Nobody in `from` is Unknown too, never
 *   a division by zero. The rate is never combined from current counts and historical moves.
 */
export async function readPipelineMetrics(
	db: Pick<Database, "execute">,
	authority: RequestActor,
	raw: unknown,
): Promise<{ status: "ok"; value: PipelineMetrics } | { status: "refused"; error: { code: "access_denied" | "invalid_input" } }> {
	const viewer = plantViewer(authority);
	if (!viewer) return { status: "refused", error: { code: "access_denied" } };
	const input = pipelineMetricsRequest.safeParse(raw);
	if (!input.success) return { status: "refused", error: { code: "invalid_input" } };
	const q = input.data;
	const p = sql`${viewer.plantId}::uuid`;
	const iso = (v: ReturnType<typeof sql>) => sql`to_char(${v} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
	const { rows } = await db.execute(sql`WITH RECURSIVE g AS (SELECT ${liveRead(viewer.access)} AS ok),
 chain AS (SELECT x.id, x.id AS canonical, 0 AS depth FROM person x, g WHERE g.ok AND x.plant_id=${p}
	UNION ALL SELECT ch.id, m.survivor_id, ch.depth+1 FROM chain ch JOIN person_merge m ON m.source_id=ch.canonical
	AND m.tenant_id=${p} AND m.unmerged_at IS NULL WHERE ch.depth<32),
 pl AS (SELECT timezone FROM plant, g WHERE g.ok AND id=${p})
SELECT g.ok, pl.timezone,
	${iso(sql`(${q.from}::date)::timestamp AT TIME ZONE pl.timezone`)} AS opens_at,
	${iso(sql`((${q.through}::date)+1)::timestamp AT TIME ZONE pl.timezone`)} AS closes_at,
	(SELECT jsonb_agg(jsonb_build_object('id',x.id,'stage',x.stage,'live',x.state='live',
		'createdAt',${iso(sql`x.created_at`)},
		'canonical',(SELECT ch.canonical FROM chain ch WHERE ch.id=x.id ORDER BY ch.depth DESC LIMIT 1)))
		FROM person x WHERE g.ok AND x.plant_id=${p}) AS persons,
	(SELECT jsonb_agg(jsonb_build_object('person',a.subject_id,'at',${iso(sql`a.occurred_at`)},
		'from',a.before_value->>'stage','to',a.after_value->>'stage') ORDER BY a.occurred_at,a.id)
		FROM audit_event a WHERE g.ok AND a.tenant_id=${p} AND a.action='people.stage_changed' AND a.kind='stage_change'
		AND a.subject_type='person' AND a.occurred_at<=${q.asOf}::timestamptz) AS events
 FROM g LEFT JOIN pl ON true`);
	const r = row.parse(rows[0]);
	if (!r.ok || !r.timezone || !r.opens_at || !r.closes_at) return { status: "refused", error: { code: "access_denied" } };
	return { status: "ok", value: pipelineMetrics.parse(measure(r, q)) };
}

/** The counts from the statement's rows. Pure: the same rows and request always give the same answer. */
function measure(r: Row, q: z.infer<typeof pipelineMetricsRequest>): z.input<typeof pipelineMetrics> {
	const asOf = Date.parse(q.asOf);
	const opens = Date.parse(r.opens_at!);
	const closes = Math.min(Date.parse(r.closes_at!), asOf + 1);
	const persons = new Map((r.persons ?? []).map((x) => [x.id, x]));
	// Each record's moves in order. A move saved without its source stage takes it from the move before.
	const moves = new Map<string, Move[]>();
	for (const e of r.events ?? []) {
		const list = moves.get(e.person) ?? [];
		list.push({ at: Date.parse(e.at), from: known(e.from) ?? list.at(-1)?.to ?? null, to: known(e.to) });
		moves.set(e.person, list);
	}
	/** A record's stage at `t`, or null when its history cannot say. */
	const stageAt = (id: string, t: number): Stage | null | undefined => {
		const list = moves.get(id) ?? [];
		const before = list.filter((m) => m.at <= t).at(-1);
		if (before) return before.to;
		const after = list.find((m) => m.at > t);
		return after ? after.from : (persons.get(id)?.stage ?? null);
	};
	// The live canonical People, and the records folded into each.
	const groups = new Map<string, string[]>();
	for (const x of persons.values()) {
		const head = persons.get(x.canonical);
		if (!head?.live) continue;
		groups.set(x.canonical, [...(groups.get(x.canonical) ?? []), x.id]);
	}
	const created = (id: string) => Date.parse(persons.get(id)!.createdAt);

	const currentStageCounts = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
	for (const id of groups.keys()) {
		if (created(id) > asOf) continue;
		const s = stageAt(id, asOf);
		if (s) currentStageCounts[s]++;
	}

	const crossed = new Set<string>();
	for (const [head, ids] of groups)
		for (const id of ids)
			for (const m of moves.get(id) ?? [])
				if (m.at >= opens && m.at < closes && m.from === q.transition.from && m.to === q.transition.to)
					crossed.add(head);

	let cohort = 0,
		rebuilt = true;
	for (const [head, ids] of groups) {
		if (created(head) >= opens) continue;
		// A merge folds two histories into one Person: who was in which stage when the window opened is lost.
		if (ids.filter((id) => moves.has(id)).length > 1) {
			rebuilt = false;
			continue;
		}
		const s = stageAt(head, opens);
		if (s === null || s === undefined) rebuilt = false;
		else if (s === q.transition.from) cohort++;
	}
	const denominator = rebuilt ? cohort : null;
	const ratio = denominator ? { numerator: crossed.size, denominator } : null;
	return {
		asOf: q.asOf,
		sourceRevision: (r.events ?? []).length,
		window: { from: q.from, through: q.through, timeZone: r.timezone! },
		unit: "distinct_canonical_people",
		currentStageCounts,
		transition: q.transition,
		distinctTransitionPeople: crossed.size,
		denominator,
		conversionRatio: ratio,
		conversionRatioStatus: ratio ? "known" : "unknown",
		reason: ratio ? null : rebuilt ? "empty_cohort" : "cohort_unavailable",
	};
}
