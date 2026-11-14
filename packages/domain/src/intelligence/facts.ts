import { instant, type Clock, type Instant } from "@everyfield/contracts/common";
import { measure } from "@everyfield/contracts/followups";
import * as c from "@everyfield/contracts/intelligence";
import type { CriterionKey, CriterionStatus } from "@everyfield/contracts/phases";
import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { createHash, randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { liveRead, type RequestActor } from "../access/session.ts";
import { plantViewer } from "../documents/access.ts";
import { effectiveAdult } from "../people/adult.ts";
import { commitmentOf } from "../people/commitments/lifecycle.ts";
import { compatible } from "../teams/training/reads.ts";

// Plant Intelligence measured facts (WP-040). One statement reads every input the facts use, under the live Owner or
// Admin check of the exact plant (C13); `buildFacts` turns those inputs into facts with no I/O, so every counting rule
// is testable at a fixed date. The inputs never include private care, and interviews and 4 C's arrive only as a count
// and a latest date: the statement reads no score, note, result or qualification column. `sourceRevision` digests the
// inputs, so any committed change to one of them gives the next read a new revision and leaves earlier assessment
// work stale, while the same records always give the same revision.

const presence = z.strictObject({ count: z.int(), latestOn: z.string().nullable() });

/** Everything the fact builder reads, exactly. A field added to the statement must be added here, or parsing fails. */
export const factInputs = z.strictObject({
	zone: z.string(),
	/** Live people with at least one valid commitment card. */
	people: z.array(
		z.strictObject({
			id: z.uuid(),
			name: z.string(),
			birth: z.string().nullable(),
			manual: z.enum(["adult", "child", "unknown"]).nullable(),
			cards: z.array(z.strictObject({ id: z.uuid(), kind: z.enum(["core_group", "launch_team"]), on: z.string() })),
			changes: z.array(
				z.strictObject({ id: z.uuid(), kind: z.enum(["withdrawn", "reactivated"]), on: z.string(), at: z.number() }),
			),
		}),
	),
	/** The last two completed Vision meetings with attendance, newest first. */
	vision: z.array(z.strictObject({ on: z.string(), attended: z.int() })).max(2),
	nextVision: z.string().nullable(),
	anyAttendance: z.boolean(),
	/** Each person's attended dates of completed meetings in the last 56 days. */
	attendance: z.array(z.strictObject({ personId: z.uuid(), on: z.array(z.string()) })),
	followUps: z.array(
		z.strictObject({
			originAt: instant,
			state: z.enum(["open", "complete", "no_longer_needed", "superseded"]),
			completion: instant.nullable(),
			contacted: z.boolean(),
		}),
	),
	/** Current holders of a role mapped to a methodology responsibility. */
	roles: z.array(z.strictObject({ key: z.string(), id: z.uuid(), name: z.string() })),
	training: z.array(
		z.strictObject({
			id: z.uuid(),
			name: z.string(),
			people: z.array(z.strictObject({ personId: z.uuid(), complete: z.boolean() })),
		}),
	),
	attestations: z.array(
		z.strictObject({
			key: z.string(),
			kind: z.enum(["answered", "corrected", "retracted", "reaffirmed"]),
			answer: z.boolean().nullable(),
			asOf: z.string(),
		}),
	),
	interviews: presence,
	fourCs: presence,
});
export type FactInputs = z.infer<typeof factInputs>;

const DAY = 86_400_000;
const addDays = (date: string, days: number) =>
	new Date(Date.parse(date + "T00:00:00Z") + days * DAY).toISOString().slice(0, 10);
const within = (date: string, from: string, to: string) => date >= from && date <= to;
type Named = { id: string; name: string };
const byName = (a: Named, b: Named) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
const max = (dates: string[]) => dates.reduce<string | null>((m, d) => (m === null || d > m ? d : m), null);

/** The facts of one plant at `asOf`, whose plant-local date is `today`. Pure: the same inputs give the same facts. */
export function buildFacts(inputs: FactInputs, asOf: Instant, today: string): c.PlantFacts {
	const windowStart = addDays(today, -(c.WINDOW_DAYS - 1));
	const priorStart = addDays(today, -(2 * c.WINDOW_DAYS - 1));
	const priorEnd = addDays(today, -c.WINDOW_DAYS);

	const people = inputs.people.map((p) => {
		const adult = effectiveAdult(p.birth, p.manual ?? "unknown", today);
		const commitment = commitmentOf({ cards: p.cards.map(({ id, on }) => ({ id, on })), changes: p.changes });
		const signed = p.cards.filter((k) => k.on <= today);
		return { ...p, adult, commitment, firstOn: signed.length ? signed.map((k) => k.on).sort()[0]! : null, signed };
	});
	const active = people.filter((p) => p.commitment.state === "active");

	// Committed adults: each live person once, whatever teams or signatures they have.
	const counted = active.filter((p) => p.adult.value === "adult");
	const unclassified = active.filter((p) => p.adult.value === "unknown");
	const known = counted.length;
	const committedAdults: z.input<typeof c.committedAdults> = {
		status:
			known >= c.ADULT_TARGET
				? "met"
				: unclassified.length > 0 && known + unclassified.length >= c.ADULT_TARGET
					? "unknown"
					: "not_met",
		known,
		exact: unclassified.length ? null : known,
		needsClassifying: unclassified.map(({ id, name }) => ({ id, name })).sort(byName),
		evidence: counted
			.map((p) => ({
				person: { id: p.id, name: p.name },
				kinds: [...new Set((p.signed.length ? p.signed : p.cards).map((k) => k.kind))].sort(),
				committedSince: p.commitment.effectiveOn!,
				adultFrom: p.adult.source === "birth_date" ? ("birth_date" as const) : ("recorded" as const),
			}))
			.sort((a, b) => byName(a.person, b.person)),
		children: active.filter((p) => p.adult.value === "child").length,
	};

	// Growth: each adult's first valid commitment, whatever happened after it. A withdrawal never removes it.
	const acquired = people.filter((p) => p.adult.value === "adult" && p.firstOn !== null);
	const last = max(acquired.map((p) => p.firstOn!));
	const unresolved = max(people.filter((p) => p.adult.value === "unknown" && p.firstOn).map((p) => p.firstOn!));
	const inCurrent = acquired.filter((p) => within(p.firstOn!, windowStart, today));
	const daysSince = last === null ? null : c.daysBetween(last, today);
	const growthStatus = (): Pick<c.Growth, "status" | "reason"> => {
		if (daysSince === null) return { status: "unknown", reason: unresolved ? "unclassified_newer" : "no_acquisition" };
		// An old known date cannot prove a slowdown while an unclassified person signed after it.
		if (daysSince >= c.GROWTH_SLOWED_DAYS && unresolved !== null && unresolved > last!)
			return { status: "unknown", reason: "unclassified_newer" };
		if (daysSince < c.GROWTH_SLOWED_DAYS) return { status: "on_track", reason: null };
		return { status: daysSince < c.GROWTH_STALLED_DAYS ? "slowed" : "stalled", reason: null };
	};
	const growth: z.input<typeof c.growth> = {
		...growthStatus(),
		lastAcquiredOn: last,
		daysSince,
		current: inCurrent.length,
		prior: acquired.filter((p) => within(p.firstOn!, priorStart, priorEnd)).length,
		currentWithdrawn: inCurrent.filter((p) => p.commitment.state !== "active").length,
		windowStart,
		priorStart,
	};

	// Vision rhythm from held meetings only; a scheduled one never counts.
	const lastVision = inputs.vision[0] ?? null;
	const visionDays = lastVision ? c.daysBetween(lastVision.on, today) : null;
	const vision: z.input<typeof c.visionRhythm> = {
		status:
			visionDays === null || !inputs.anyAttendance
				? "unknown"
				: visionDays <= c.VISION_TARGET_DAYS
					? "on_target"
					: visionDays < c.VISION_WATCH_DAYS
						? "over_target"
						: visionDays < c.VISION_DIRECT_DAYS
							? "watch"
							: "direct",
		reason: !inputs.anyAttendance ? "no_attendance" : lastVision ? null : "no_vision_meeting",
		lastHeldOn: lastVision?.on ?? null,
		daysSince: visionDays,
		lastAttendance: inputs.vision.map((v) => v.attended),
		nextScheduledOn: inputs.nextVision,
	};

	// Cohesion: committed people who attended in the prior 28 days and not in the last 28.
	const attendedOn = new Map(inputs.attendance.map((a) => [a.personId, a.on]));
	const disengaged = active
		.filter((p) => {
			const on = attendedOn.get(p.id) ?? [];
			return on.some((d) => within(d, priorStart, priorEnd)) && !on.some((d) => within(d, windowStart, today));
		})
		.map(({ id, name }) => ({ id, name }))
		.sort(byName);
	const cohesion: z.input<typeof c.cohesion> = {
		status: !inputs.anyAttendance
			? "unknown"
			: disengaged.length >= c.COHESION_MIN && disengaged.length >= c.COHESION_SHARE * active.length
				? "flagged"
				: "steady",
		reason: inputs.anyAttendance ? null : "no_attendance",
		disengaged,
		committed: active.length,
	};

	// Follow-ups: the meetings' own 48-hour measure. No longer needed is left out, never a miss; contact is separate.
	const measures = inputs.followUps.map((f) =>
		measure({ originAt: f.originAt, state: f.state, completion: f.state === "complete" ? f.completion : null }, asOf),
	);
	const measured = measures.filter((m) => m.eligible).length;
	const followUps: z.input<typeof c.followUps> = {
		status: measured ? "measured" : "unknown",
		onTime: measures.filter((m) => m.success === true).length,
		measured,
		noLongerNeeded: measures.filter((m) => m.reason === "waived").length,
		pending: measures.filter((m) => m.reason === "immature").length,
		unmeasured: measures.filter((m) => !m.eligible && m.reason !== "waived" && m.reason !== "immature").length,
		contacted: inputs.followUps.filter((f) => f.contacted && f.state !== "superseded").length,
		total: inputs.followUps.length,
	};

	// Coverage: stable responsibility keys, filled slots and distinct people apart.
	const holders = (key: string) =>
		inputs.roles
			.filter((r) => r.key === key)
			.map(({ id, name }) => ({ id, name }))
			.filter((p, i, all) => all.findIndex((q) => q.id === p.id) === i)
			.sort(byName);
	const responsibilities = c.MINISTRY_RESPONSIBILITIES.map(({ key, label }) => ({ key, label, people: holders(key) }));
	const filled = responsibilities.filter((r) => r.people.length).length;
	const coverage: z.input<typeof c.coverage> = {
		status: filled === c.MINISTRY_RESPONSIBILITIES.length ? "met" : "not_met",
		filled,
		slots: c.MINISTRY_RESPONSIBILITIES.length,
		people: new Set(responsibilities.flatMap((r) => r.people.map((p) => p.id))).size,
		responsibilities,
		prayerLeader: holders("prayer"),
	};

	// Training: every saved required person/program obligation. Complete means all of them, never a rounded share.
	const programs = inputs.training.map((g) => ({
		id: g.id,
		name: g.name,
		complete: g.people.filter((p) => p.complete).length,
		total: g.people.length,
	}));
	const complete = programs.reduce((n, g) => n + g.complete, 0);
	const total = programs.reduce((n, g) => n + g.total, 0);
	const training: z.input<typeof c.training> = {
		status: total === 0 ? "unknown" : complete === total ? "met" : "not_met",
		complete,
		total,
		programs,
	};

	const byKey = new Map(inputs.attestations.map((a) => [a.key, a]));
	const attestations = c.SIGNAL_KEYS.map((key) => {
		const row = byKey.get(key);
		if (!row)
			return {
				key,
				state: "unanswered",
				value: null,
				asOf: null,
				ageDays: null,
				renewal: { status: "unknown" },
			} as const;
		const answered = row.kind !== "retracted";
		const age = answered ? Math.max(0, c.daysBetween(row.asOf, today)) : null;
		return {
			key,
			state: answered ? ("answered" as const) : ("retracted" as const),
			value: answered ? (row.answer ? ("yes" as const) : ("not_yet" as const)) : null,
			asOf: row.asOf,
			ageDays: age,
			renewal: c.renewalOf(key, answered ? "answered" : "retracted", age),
		};
	});
	const answer = (key: c.SignalKey): CriterionStatus => {
		const a = attestations.find((x) => x.key === key)!;
		return a.value === "yes" ? "met" : a.value === "not_yet" ? "not_met" : "unknown";
	};

	const criteria: Partial<Record<CriterionKey, CriterionStatus>> = {
		committed_adults: committedAdults.status,
		growth_trajectory: growth.status === "unknown" ? "unknown" : growth.status === "stalled" ? "not_met" : "met",
		financial_base: answer("financial_base_established"),
		// An actual worship assignment is evidence; no assignment is not proof that nobody agreed to lead.
		worship_leader: coverage.responsibilities[0]!.people.length ? "met" : "unknown",
		all_team_leaders: coverage.status,
		training_complete: training.status,
		systems_tested: answer("systems_tested"),
	};

	return c.plantFacts.parse({
		asOf,
		today,
		zone: inputs.zone,
		formulaVersion: c.FACTS_FORMULA_VERSION,
		sourceRevision: createHash("sha256").update(JSON.stringify(inputs)).digest("hex"),
		committedAdults,
		growth,
		vision,
		cohesion,
		followUps,
		coverage,
		training,
		attestations,
		humanRecords: { interviews: inputs.interviews, fourCs: inputs.fourCs },
		criteria,
	});
}

const iso = (value: SQL) => sql`to_char(${value} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const MANUAL = sql.join(
	c.SIGNAL_KEYS.map((k) => sql`${k}`),
	sql`,`,
);

/**
 * The one statement. `x` holds the plant, its zone, the as-of instant and its plant-local date, and exists only when
 * the live Owner or Admin check holds, so every input below reads nothing otherwise.
 */
function statement(plant: string, ok: SQL, at: SQL) {
	const held = (m: SQL) => sql`${m}.plant_id=x.plant AND ${m}.status='completed' AND ${m}.retired_at IS NULL
 AND ${m}.occurrence_voided_at IS NULL AND coalesce(${m}.actual_occurrence_at,${m}.starts_at)<=x.at`;
	const heldOn = (m: SQL) => sql`(coalesce(${m}.actual_occurrence_at,${m}.starts_at) AT TIME ZONE x.zone)::date`;
	const attended = (m: SQL) =>
		sql`(SELECT count(*)::int FROM participation pa WHERE pa.meeting_id=${m}.id AND pa.plant_id=${m}.plant_id
 AND pa.removed_at IS NULL AND pa.presence='attended')`;
	// An outcome is evidence for the duty it was recorded on and for those one contact finished with it (followups).
	const evidence = sql`(e.obligation_id=o.id OR (e.person_id=o.person_id AND t.id=ANY(e.also_task_ids)))`;
	return sql`WITH gate AS (SELECT ${ok} AS ok),
 x AS (SELECT pl.id AS plant,pl.timezone AS zone,${at} AS at,(${at} AT TIME ZONE pl.timezone)::date AS today
  FROM plant pl WHERE pl.id=${plant}::uuid AND (SELECT ok FROM gate))
 SELECT (SELECT ok FROM gate) AS ok,x.today::text AS today,${iso(sql`x.at`)} AS at,
 jsonb_build_object(
 'zone',x.zone,
 'people',coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',p.display_name,'birth',p.birth_date::text,
   'manual',p.adult_classification,
   'cards',(SELECT jsonb_agg(jsonb_build_object('id',k.id,'kind',k.kind,'on',k.signed_on::text) ORDER BY k.signed_on,k.id)
    FROM commitment k WHERE k.person_id=p.id AND k.plant_id=p.tenant_id AND k.voided_at IS NULL),
   'changes',coalesce((SELECT jsonb_agg(jsonb_build_object('id',g.id,'kind',g.kind,'on',g.effective_on::text,
    'at',extract(epoch FROM g.recorded_at)) ORDER BY g.effective_on,g.recorded_at,g.id)
    FROM commitment_change g WHERE g.person_id=p.id AND g.plant_id=p.tenant_id),'[]'::jsonb)) ORDER BY p.id)
  FROM person p WHERE p.tenant_id=x.plant AND p.state='live'
  AND EXISTS(SELECT FROM commitment k WHERE k.person_id=p.id AND k.plant_id=p.tenant_id AND k.voided_at IS NULL)),'[]'::jsonb),
 'vision',coalesce((SELECT jsonb_agg(jsonb_build_object('on',v.on_date::text,'attended',v.attended) ORDER BY v.at_ DESC,v.id)
  FROM (SELECT m.id,${heldOn(sql`m`)} AS on_date,coalesce(m.actual_occurrence_at,m.starts_at) AS at_,${attended(sql`m`)} AS attended
   FROM meeting m WHERE m.type='vision_meeting' AND ${held(sql`m`)} AND ${attended(sql`m`)}>0
   ORDER BY coalesce(m.actual_occurrence_at,m.starts_at) DESC,m.id LIMIT 2) v),'[]'::jsonb),
 'nextVision',(SELECT min(m.local_date)::text FROM meeting m WHERE m.plant_id=x.plant AND m.type='vision_meeting'
  AND m.status IN ('planning','ready') AND m.retired_at IS NULL AND m.starts_at>x.at),
 'anyAttendance',EXISTS(SELECT FROM meeting m JOIN participation pa ON pa.meeting_id=m.id AND pa.plant_id=m.plant_id
  AND pa.removed_at IS NULL AND pa.presence='attended' WHERE ${held(sql`m`)}),
 'attendance',coalesce((SELECT jsonb_agg(jsonb_build_object('personId',q.person_id,'on',q.days) ORDER BY q.person_id) FROM (
  SELECT pa.person_id,jsonb_agg(DISTINCT ${heldOn(sql`m`)}::text ORDER BY ${heldOn(sql`m`)}::text) AS days
  FROM meeting m JOIN participation pa ON pa.meeting_id=m.id AND pa.plant_id=m.plant_id AND pa.removed_at IS NULL
   AND pa.presence='attended'
  WHERE ${held(sql`m`)} AND ${heldOn(sql`m`)}>=x.today-${2 * c.WINDOW_DAYS - 1}::int
  GROUP BY pa.person_id) q),'[]'::jsonb),
 'followUps',coalesce((SELECT jsonb_agg(jsonb_build_object('originAt',${iso(sql`o.origin_at`)},
   'state',CASE WHEN o.superseded_at IS NOT NULL THEN 'superseded'
    WHEN o.waived_at IS NOT NULL OR (t.deleted_at IS NULL AND t.status='no_longer_needed') THEN 'no_longer_needed'
    WHEN t.deleted_at IS NULL AND t.status='complete' THEN 'complete' ELSE 'open' END,
   'completion',(SELECT ${iso(sql`e.occurred_at`)} FROM contact_outcome e WHERE e.plant_id=o.plant_id AND ${evidence}
    AND e.voided_at IS NULL AND e.completes_task ORDER BY e.occurred_at,e.id LIMIT 1),
   'contacted',EXISTS(SELECT FROM contact_outcome e WHERE e.plant_id=o.plant_id AND ${evidence}
    AND e.voided_at IS NULL AND e.outcome='contacted')) ORDER BY o.origin_at,o.id)
  FROM obligation o LEFT JOIN LATERAL (SELECT k.* FROM task k WHERE k.obligation_id=o.id AND k.plant_id=o.plant_id
   ORDER BY k.deleted_at NULLS FIRST,k.created_at DESC LIMIT 1) t ON true
  WHERE o.plant_id=x.plant AND o.kind='follow_up'),'[]'::jsonb),
 'roles',coalesce((SELECT jsonb_agg(jsonb_build_object('key',r.responsibility_key,'id',p.id,'name',p.display_name)
   ORDER BY r.responsibility_key,p.id,r.id)
  FROM team_role r JOIN team tm ON tm.id=r.team_id AND tm.plant_id=r.plant_id AND tm.archived_at IS NULL
  JOIN team_tenure tn ON tn.role_id=r.id AND tn.plant_id=r.plant_id AND tn.ended_on IS NULL AND tn.started_on<=x.today
  JOIN person p ON p.id=tn.person_id AND p.tenant_id=r.plant_id AND p.state='live'
  WHERE r.plant_id=x.plant AND r.retired_at IS NULL AND r.responsibility_key IS NOT NULL),'[]'::jsonb),
 'training',coalesce((SELECT jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'people',
   (SELECT coalesce(jsonb_agg(jsonb_build_object('personId',a.person_id,'complete',coalesce(${compatible},false))
    ORDER BY a.person_id),'[]'::jsonb) FROM training_assignment a
    JOIN person p ON p.id=a.person_id AND p.tenant_id=a.plant_id AND p.state='live'
    WHERE a.program_id=g.id AND a.plant_id=g.plant_id AND a.state='active')) ORDER BY g.name,g.id)
  FROM training_program g WHERE g.plant_id=x.plant AND g.required AND g.archived_at IS NULL),'[]'::jsonb),
 'attestations',coalesce((SELECT jsonb_agg(jsonb_build_object('key',a.key,'kind',r.kind,'answer',r.answer,
   'asOf',r.as_of::text) ORDER BY a.key)
  FROM attestation a JOIN LATERAL (SELECT v.kind,v.answer,v.as_of FROM attestation_revision v WHERE v.attestation_id=a.id
   ORDER BY v.revision DESC LIMIT 1) r ON true
  WHERE a.plant_id=x.plant AND a.person_id IS NULL AND a.key IN (${MANUAL})),'[]'::jsonb),
 'interviews',(SELECT jsonb_build_object('count',count(*)::int,'latestOn',max(i.interviewed_on)::text)
  FROM interview i JOIN person p ON p.id=i.person_id AND p.tenant_id=i.plant_id AND p.state='live' WHERE i.plant_id=x.plant),
 'fourCs',(SELECT jsonb_build_object('count',count(*)::int,'latestOn',max(f.assessed_on)::text)
  FROM four_cs f JOIN person p ON p.id=f.person_id AND p.tenant_id=f.plant_id AND p.state='live' WHERE f.plant_id=x.plant)
 ) AS inputs
 FROM gate LEFT JOIN x ON true`;
}

const factsRow = z.object({
	ok: z.boolean().nullable(),
	today: z.string().nullable(),
	at: instant.nullable(),
	inputs: z.unknown(),
});

class Refusal extends Error {
	readonly code: c.FactsError["code"];
	constructor(code: c.FactsError["code"]) {
		super(code);
		this.code = code;
	}
}

/** The fact reader. A clock fixes the as-of instant; without one it is the statement's own time. */
export function createFacts(config: { clock?: Clock } = {}) {
	return {
		/** intelligence.readFacts: the plant's measured facts for its Owner or Admin. One statement, whatever the data size. */
		async readFacts(
			db: Pick<Database, "execute">,
			authority: RequestActor,
			raw: unknown = {},
		): Promise<c.FactsReply<c.PlantFacts>> {
			try {
				if (!c.readFactsRequest.safeParse(raw).success) throw new Refusal("invalid_input");
				const viewer = plantViewer(authority);
				if (!viewer || viewer.access.role === "member") throw new Refusal("access_denied");
				const at = config.clock
					? sql`${new Date(config.clock.now()).toISOString()}::timestamptz`
					: sql`statement_timestamp()`;
				const { rows } = await db.execute(statement(viewer.plantId, liveRead(viewer.access, true), at));
				const r = factsRow.parse(rows[0]);
				if (!r.ok || !r.today || !r.at) throw new Refusal("access_denied");
				return { status: "ok", value: buildFacts(factInputs.parse(r.inputs), r.at, r.today) };
			} catch (error) {
				if (!(error instanceof Refusal)) throw error;
				return {
					status: "refused",
					error: c.factsError.parse({ code: error.code, details: {}, correlationId: randomUUID(), retry: "never" }),
				};
			}
		},
	};
}
export type Facts = ReturnType<typeof createFacts>;
