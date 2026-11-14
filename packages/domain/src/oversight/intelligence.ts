import * as C from "@everyfield/contracts/oversight";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { liveRows, type RequestActor } from "../access/session.ts";
import { linkActive, type Reader } from "../organizations/core.ts";
import { areaOf, countryKey, latestGeography, stateCode, stateName } from "../organizations/geography.ts";
import { one, parse, refuse, seatOf, write } from "../organizations/seat.ts";
import { overdueFollowUpsJson } from "../followups/queries.ts";
import { factInputs, growthDays, peopleJson } from "../intelligence/facts.ts";
import { preparationJson, requiredTrainingCount } from "./launch.ts";

// The Network Intelligence page (WP-047b, T-372: organizationIntelligence.read, .readHistory, .requestRefresh and
// .submitFeedback) with the rubric's rule-based patterns NIR-03 to NIR-06 in their fixed wording. A run stores each
// plant that shares Plant Intelligence findings at that moment, as counts only: its preparation counts, its overdue
// and unowned follow-ups, its growth clock in days and its saved required-training obligations, each only while it
// shares the categories that rule reads (D-1420), and its reporting state, country and Region. Every read keeps only
// the rows of plants that share findings with this organization now, and each rule only while they still share its
// categories, so turning sharing off removes a plant from every run, past ones included. Patterns are computed at read
// time from those rows: two distinct qualifying plants per rule, theme and group, never a score or a ranking.

/**
 * organizationIntelligence.requestRefresh: a new run of this organization's portfolio, by an Owner or Admin. The
 * browser names the run id, so a repeated press records one run. Its audit row names the run and how many plants
 * contributed, nothing else.
 */
export async function requestIntelligenceRefresh(db: Database, authority: RequestActor, raw: unknown) {
	return write(db, authority, true, async (w) => {
		const input = parse(C.refreshRequest, raw);
		const o = sql`${w.organization}::uuid`;
		// The growth clock is the facts' own rule (NIR-05), so it is computed here from the same inputs and stored as days.
		const people = await w.tx.execute(sql`SELECT DISTINCT ON (k.plant_id) k.plant_id,
	(clock_timestamp() AT TIME ZONE pl.timezone)::date::text AS today, ${peopleJson(sql`k.plant_id`)} AS people
	FROM affiliation k JOIN plant pl ON pl.id=k.plant_id
	WHERE k.organization_id=${o} AND k.plant_id IS NOT NULL AND ${linkActive("k")} AND k.shared_findings AND k.share_people
	AND NOT EXISTS(SELECT FROM network_intelligence_run WHERE id=${input.runId}::uuid) ORDER BY k.plant_id`);
		const growth = Object.fromEntries(
			z
				.array(z.object({ plant_id: z.string(), today: z.string(), people: factInputs.shape.people }))
				.parse(people.rows)
				.map((r) => [r.plant_id, growthDays(r.people, r.today)]),
		);
		const row = await one(
			w,
			z.object({ added: z.boolean(), existing: z.boolean() }),
			sql`WITH r AS (INSERT INTO network_intelligence_run (id,organization_id,requested_by,rubric_version)
	VALUES (${input.runId}::uuid,${o},${w.actor}::uuid,${C.RUBRIC_VERSION}) ON CONFLICT (id) DO NOTHING RETURNING id),
x AS (SELECT DISTINCT ON (k.plant_id) k.plant_id, ${preparationJson(sql`k.plant_id`, sql`k.share_ministry_teams`)} AS prep,
	CASE WHEN k.share_meetings AND k.share_tasks THEN ${overdueFollowUpsJson(sql`k.plant_id`)} END AS followups,
	CASE WHEN k.share_people THEN (${JSON.stringify(growth)}::jsonb->>k.plant_id::text)::int END AS growth_days,
	CASE WHEN k.share_ministry_teams THEN ${requiredTrainingCount(sql`k.plant_id`)} END AS required_training,
	g.region_item_id, CASE WHEN g.plant_id IS NULL THEN p.state_province ELSE g.state_province END AS state_province,
	CASE WHEN g.plant_id IS NULL THEN p.country ELSE g.country END AS country
	FROM affiliation k JOIN plant p ON p.id=k.plant_id LEFT JOIN LATERAL ${latestGeography(sql`p.id`)} g ON true
	WHERE k.organization_id=${o} AND k.plant_id IS NOT NULL AND ${linkActive("k")} AND k.shared_findings
	ORDER BY k.plant_id),
c AS (INSERT INTO network_intelligence_plant (run_id,plant_id,launched,days_to_launch,unfilled_roles,outstanding_training,
	region_item_id,state_province,country,overdue_followups,unowned_followups,growth_days,required_training)
	SELECT r.id,x.plant_id,(x.prep->>'launched')::boolean,(x.prep->>'daysToLaunch')::int,(x.prep->>'unfilledRoles')::int,
		(x.prep->>'outstandingTraining')::int,x.region_item_id,x.state_province,x.country,(x.followups->>'overdue')::int,
		(x.followups->>'unowned')::int,x.growth_days,x.required_training FROM r,x RETURNING plant_id),
a AS (${w.audit({
				action: "settings.changed",
				kind: "create",
				subjectType: "organization",
				subject: o,
				metadata: sql`jsonb_build_object('category','network_intelligence','runId',${input.runId}::text,
	'plants',(SELECT count(*) FROM c))`,
			})} FROM r RETURNING id)
SELECT EXISTS(SELECT FROM r) AS added,
	EXISTS(SELECT FROM network_intelligence_run WHERE id=${input.runId}::uuid AND organization_id=${o}) AS existing`,
		);
		if (!row.added && !row.existing) refuse({ code: "conflict" });
		return { runId: input.runId, outcome: row.added ? ("changed" as const) : ("noop" as const) };
	});
}

/**
 * organizationIntelligence.submitFeedback: this Owner's or Admin's own rating of one pattern in one run of their
 * organization. Nobody else reads it, and it changes no pattern, rule or run. The audit row names the run, never the
 * rating.
 */
export async function submitIntelligenceFeedback(db: Database, authority: RequestActor, raw: unknown) {
	return write(db, authority, true, async (w) => {
		const input = parse(C.feedbackRequest, raw);
		const row = await one(
			w,
			z.object({ found: z.boolean(), changed: z.boolean() }),
			sql`WITH r AS (SELECT id FROM network_intelligence_run WHERE id=${input.runId}::uuid
	AND organization_id=${w.organization}::uuid),
f AS (INSERT INTO network_intelligence_feedback (run_id,account_id,pattern_key,rating)
	SELECT r.id,${w.actor}::uuid,${input.patternKey},${input.rating} FROM r
	ON CONFLICT (run_id,account_id,pattern_key) DO UPDATE SET rating=excluded.rating,recorded_at=clock_timestamp()
	WHERE network_intelligence_feedback.rating<>excluded.rating RETURNING run_id),
a AS (${w.audit({
				action: "settings.changed",
				kind: "edit",
				subjectType: "organization",
				subject: sql`${w.organization}::uuid`,
				metadata: { category: "network_intelligence_feedback", runId: input.runId },
			})} FROM f RETURNING id)
SELECT EXISTS(SELECT FROM r) AS found, EXISTS(SELECT FROM f) AS changed`,
		);
		if (!row.found) refuse();
		return { outcome: row.changed ? ("changed" as const) : ("noop" as const) };
	});
}

const runRow = z.object({ id: z.string(), ran_at: z.string() });
const contribution = z.object({
	plant_id: z.string(),
	name: z.string(),
	launched: z.boolean(),
	days_to_launch: z.int().nullable(),
	unfilled_roles: z.int().nullable(),
	outstanding_training: z.int().nullable(),
	overdue_followups: z.int().nullable(),
	unowned_followups: z.int().nullable(),
	growth_days: z.int().nullable(),
	required_training: z.int().nullable(),
	teams: z.boolean(),
	people: z.boolean(),
	followups: z.boolean(),
	region_key: z.string().nullable(),
	state_province: z.string().nullable(),
	country: z.string().nullable(),
});
const unshared = z.object({
	plant_id: z.string(),
	name: z.string(),
	region_key: z.string().nullable(),
	state_province: z.string().nullable(),
	country: z.string().nullable(),
});
const iso = (v: string) => sql`to_char(${sql.raw(v)} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * organizationIntelligence.read and .readHistory: one run of this organization (the latest without `runId`) grouped
 * at `level`, with every run's date. Null for an actor without a live seat of an organization, or a run id that is not
 * this organization's. One statement with the live seat check (C13).
 */
export async function readIntelligence(
	db: Reader,
	authority: RequestActor,
	request: { level: C.Level; runId: string | null },
): Promise<C.IntelligenceView | null> {
	const seat = seatOf(authority);
	if (!seat) return null;
	if (request.runId !== null && !z.uuid().safeParse(request.runId).success) return null;
	const o = sql`${seat.organization}::uuid`;
	const rows = await liveRows(
		db,
		seat.live,
		sql`WITH runs AS (SELECT id, ran_at FROM network_intelligence_run WHERE organization_id=${o}),
	shown AS (SELECT id FROM runs WHERE ${request.runId === null ? sql`true` : sql`id=${request.runId}::uuid`}
		ORDER BY ran_at DESC, id DESC LIMIT 1),
	links AS (SELECT DISTINCT ON (k.plant_id) k.plant_id, k.shared_findings, k.share_ministry_teams, k.share_people,
		k.share_meetings AND k.share_tasks AS share_followups FROM affiliation k
		WHERE k.organization_id=${o} AND k.plant_id IS NOT NULL AND ${linkActive("k")} ORDER BY k.plant_id)
	SELECT (SELECT name FROM organization WHERE id=${o}) AS organization_name,
	(SELECT timezone FROM organization WHERE id=${o}) AS timezone,
	(SELECT coalesce(json_agg(json_build_object('id', id, 'ran_at', ${iso("ran_at")}) ORDER BY ran_at DESC, id DESC), '[]')
		FROM runs) AS history,
	(SELECT id FROM shown) AS shown,
	(SELECT (r.ran_at AT TIME ZONE o.timezone)::date::text FROM runs r JOIN shown s ON s.id=r.id
		JOIN organization o ON o.id=${o}) AS shown_on,
	(SELECT coalesce(json_agg(json_build_object('plant_id', c.plant_id, 'name', p.name, 'launched', c.launched,
		'days_to_launch', c.days_to_launch, 'unfilled_roles', c.unfilled_roles, 'outstanding_training', c.outstanding_training,
		'overdue_followups', c.overdue_followups, 'unowned_followups', c.unowned_followups, 'growth_days', c.growth_days,
		'required_training', c.required_training, 'teams', l.share_ministry_teams, 'people', l.share_people,
		'followups', l.share_followups, 'region_key', ri.canonical_key, 'state_province', c.state_province,
		'country', c.country)), '[]')
		FROM network_intelligence_plant c JOIN shown s ON s.id=c.run_id JOIN links l ON l.plant_id=c.plant_id AND l.shared_findings
		JOIN plant p ON p.id=c.plant_id LEFT JOIN reference_item ri ON ri.id=c.region_item_id) AS rows,
	(SELECT coalesce(json_agg(json_build_object('plant_id', p.id, 'name', p.name, 'region_key', ri.canonical_key,
		'state_province', CASE WHEN g.plant_id IS NULL THEN p.state_province ELSE g.state_province END,
		'country', CASE WHEN g.plant_id IS NULL THEN p.country ELSE g.country END)), '[]')
		FROM links l JOIN plant p ON p.id=l.plant_id LEFT JOIN LATERAL ${latestGeography(sql`p.id`)} g ON true
		LEFT JOIN reference_item ri ON ri.id=g.region_item_id WHERE NOT l.shared_findings) AS unshared,
	(SELECT coalesce(json_object_agg(f.pattern_key, f.rating), '{}') FROM network_intelligence_feedback f
		JOIN shown s ON s.id=f.run_id WHERE f.account_id=${seat.accountId}::uuid) AS ratings`,
	);
	const row = rows?.[0];
	if (!row) return null;
	const r = z
		.object({
			organization_name: z.string(),
			timezone: z.string(),
			history: z.array(runRow),
			shown: z.string().nullable(),
			shown_on: z.string().nullable(),
			rows: z.array(contribution),
			unshared: z.array(unshared),
			ratings: z.record(z.string(), z.enum(["useful", "not_useful"])),
		})
		.parse(row);
	if (request.runId !== null && r.shown === null) return null;
	const history = r.history.map((h) => ({ runId: h.id, ranAt: h.ran_at }));
	const run = history.find((h) => h.runId === r.shown) ?? null;
	return C.intelligenceView.parse({
		organizationName: r.organization_name,
		timeZone: r.timezone,
		level: request.level,
		run,
		history,
		groups: run ? groupsOf(request.level, r.shown_on!, r.rows, r.unshared, r.ratings) : [],
		canRefresh: seat.administrator,
	});
}

type Placed = { plantId: string; name: string; regionKey: string | null; state: string | null; country: string | null };
/** A plant's group key and label at `level`, or null when it has no location at that level. */
function placeOf(level: C.Level, p: Placed): { key: string; label: string } | null {
	const country = countryKey(p.country);
	if (level === "portfolio") return { key: "portfolio", label: "Whole portfolio" };
	if (level === "country")
		return country ? { key: country, label: country === "US" ? "United States" : country } : null;
	if (level === "state") {
		if (!country || !p.state?.trim()) return null;
		const code = country === "US" ? stateCode(p.state) : null;
		if (country === "US" && !code) return null;
		return code
			? { key: `US:${code}`, label: stateName(code) }
			: { key: `${country}:${p.state.trim()}`, label: p.state.trim() };
	}
	const area = areaOf(p.regionKey);
	return area ? { key: area.code, label: C.regionLabel(area) } : null;
}
const UNPLACED: Record<C.Level, string> = {
	region: "No Region set",
	state: "No state set",
	country: "No country set",
	portfolio: "",
};

function groupsOf(
	level: C.Level,
	asOf: string,
	contributions: z.infer<typeof contribution>[],
	unsharedRows: z.infer<typeof unshared>[],
	ratings: Record<string, "useful" | "not_useful">,
): z.input<typeof C.intelligenceGroup>[] {
	type Row = z.input<typeof C.intelligenceRow>;
	type Member = { place: Placed; row: Row; counts: C.RuleCounts | null };
	const members: Member[] = [
		...contributions.map((c) => {
			// A plant that stopped sharing a rule's categories keeps no evidence for it: that rule reads as Unknown.
			const counts: C.RuleCounts = {
				overdueFollowUps: c.followups ? c.overdue_followups : null,
				unownedFollowUps: c.followups ? c.unowned_followups : null,
				growthDays: c.people ? c.growth_days : null,
				requiredTraining: c.teams ? c.required_training : null,
				outstandingTraining: c.teams ? c.outstanding_training : null,
			};
			return {
				place: {
					plantId: c.plant_id,
					name: c.name,
					regionKey: c.region_key,
					state: c.state_province,
					country: c.country,
				},
				counts,
				row: {
					status: "shared" as const,
					plantId: c.plant_id,
					name: c.name,
					results: {
						"NIR-03": C.nearLaunch({
							launched: c.launched,
							daysToLaunch: c.days_to_launch,
							unfilledRoles: c.teams ? c.unfilled_roles : null,
							outstandingTraining: counts.outstandingTraining,
						}),
						"NIR-04": C.followUpResult(counts),
						"NIR-05": C.growthResult(counts),
						"NIR-06": C.trainingResult(counts),
					},
				},
			};
		}),
		...unsharedRows.map((u) => ({
			place: {
				plantId: u.plant_id,
				name: u.name,
				regionKey: u.region_key,
				state: u.state_province,
				country: u.country,
			},
			counts: null,
			row: { status: "not_shared" as const, plantId: u.plant_id, name: u.name },
		})),
	];
	const groups = new Map<string, { label: string; unplaced: boolean; members: Member[] }>();
	for (const m of members) {
		const place = placeOf(level, m.place);
		const key = place?.key ?? "unplaced";
		const group = groups.get(key) ?? { label: place?.label ?? UNPLACED[level], unplaced: !place, members: [] };
		group.members.push(m);
		groups.set(key, group);
	}
	const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
	return [...groups.entries()]
		.map(([key, g]) => {
			const members = [...g.members].sort((a, b) => byName(a.row, b.row));
			return {
				key,
				label: g.label,
				rows: members.map((m) => m.row),
				unplaced: g.unplaced,
				patterns: g.unplaced ? [] : patternsOf(`${level}:${key}`, asOf, members, ratings),
			};
		})
		.sort((a, b) => Number(a.unplaced) - Number(b.unplaced) || a.label.localeCompare(b.label));
}

/** Each rule theme of one group where at least two distinct sharing plants qualify, in rule order. */
function patternsOf(
	place: string,
	asOf: string,
	members: { row: z.input<typeof C.intelligenceRow>; counts: C.RuleCounts | null }[],
	ratings: Record<string, "useful" | "not_useful">,
): z.input<typeof C.intelligencePattern>[] {
	const shared = members.flatMap((m) =>
		m.row.status === "shared" && m.counts
			? [{ plantId: m.row.plantId, name: m.row.name, counts: m.counts, results: m.row.results }]
			: [],
	);
	const sum = (plants: typeof shared, of: (c: C.RuleCounts) => number | null) =>
		plants.reduce((n, p) => n + (of(p.counts) ?? 0), 0);
	const out: z.input<typeof C.intelligencePattern>[] = [];
	const add = <R extends C.RuleId>(
		rule: R,
		theme: string,
		qualifies: (r: (typeof shared)[number]["results"][R]) => boolean,
		claims: (plants: typeof shared) => object,
	) => {
		const observed = shared.filter((p) => p.results[rule] !== "unknown");
		const plants = observed.filter((p) => qualifies(p.results[rule]));
		if (plants.length < 2) return;
		// NIR-03's key predates the themes, so ratings of earlier runs still find their pattern.
		const key = rule === "NIR-03" ? `${rule}:${place}` : `${rule}:${theme}:${place}`;
		out.push({
			key,
			rule,
			theme,
			support: plants.length,
			observed: observed.length,
			plants: plants.map(({ plantId, name }) => ({ plantId, name })),
			rating: ratings[key] ?? null,
			citation: C.citationOf(rule),
			...claims(plants),
		} as z.input<typeof C.intelligencePattern>);
	};
	add(
		"NIR-03",
		"near_launch",
		(r) => r === "gap",
		() => ({}),
	);
	add(
		"NIR-04",
		"overdue_followup",
		(r) => r === "gap",
		(plants) => {
			const unowned = plants.filter((p) => (p.counts.unownedFollowUps ?? 0) > 0);
			return {
				overdue: sum(plants, (c) => c.overdueFollowUps),
				unowned:
					unowned.length >= 2 ? { support: unowned.length, overdue: sum(unowned, (c) => c.unownedFollowUps) } : null,
			};
		},
	);
	add(
		"NIR-05",
		"slowed",
		(r) => r === "slowed",
		() => ({ asOf }),
	);
	add(
		"NIR-05",
		"stalled",
		(r) => r === "stalled",
		() => ({ asOf }),
	);
	add(
		"NIR-06",
		"required_training",
		(r) => r === "gap",
		(plants) => {
			const outstanding = sum(plants, (c) => c.outstandingTraining);
			const applicable = sum(plants, (c) => c.requiredTraining);
			return { outstanding, applicable, complete: applicable - outstanding };
		},
	);
	return out;
}
