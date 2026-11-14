import * as C from "@everyfield/contracts/oversight";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { liveRows, type RequestActor } from "../access/session.ts";
import { linkActive, type Reader } from "../organizations/core.ts";
import { areaOf, countryKey, latestGeography, stateCode, stateName } from "../organizations/geography.ts";
import { one, parse, refuse, seatOf, write } from "../organizations/seat.ts";
import { preparationJson } from "./launch.ts";

// The first Network Intelligence page (WP-047b: organizationIntelligence.read, .readHistory, .requestRefresh and
// .submitFeedback) with the rubric's near-launch rule NIR-03 in its fixed wording. A run stores each plant that shares
// Plant Intelligence findings at that moment: its preparation counts (gap counts only while it also shares Ministry
// teams) and its reporting state, country and Region. Every read keeps only the rows of plants that share findings
// with this organization now, so turning sharing off removes a plant from every run, past ones included. Patterns are
// computed at read time from those rows: two distinct qualifying plants in a group, never a score or a ranking.

/**
 * organizationIntelligence.requestRefresh: a new run of this organization's portfolio, by an Owner or Admin. The
 * browser names the run id, so a repeated press records one run. Its audit row names the run and how many plants
 * contributed, nothing else.
 */
export async function runIntelligence(db: Database, authority: RequestActor, raw: unknown) {
	return write(db, authority, true, async (w) => {
		const input = parse(C.refreshRequest, raw);
		const o = sql`${w.organization}::uuid`;
		const row = await one(
			w,
			z.object({ added: z.boolean(), existing: z.boolean() }),
			sql`WITH r AS (INSERT INTO network_intelligence_run (id,organization_id,requested_by,rubric_version)
	VALUES (${input.runId}::uuid,${o},${w.actor}::uuid,${C.RUBRIC_VERSION}) ON CONFLICT (id) DO NOTHING RETURNING id),
x AS (SELECT DISTINCT ON (k.plant_id) k.plant_id, ${preparationJson(sql`k.plant_id`, sql`k.share_ministry_teams`)} AS prep,
	g.region_item_id, CASE WHEN g.plant_id IS NULL THEN p.state_province ELSE g.state_province END AS state_province,
	CASE WHEN g.plant_id IS NULL THEN p.country ELSE g.country END AS country
	FROM affiliation k JOIN plant p ON p.id=k.plant_id LEFT JOIN LATERAL ${latestGeography(sql`p.id`)} g ON true
	WHERE k.organization_id=${o} AND k.plant_id IS NOT NULL AND ${linkActive("k")} AND k.shared_findings
	ORDER BY k.plant_id),
c AS (INSERT INTO network_intelligence_plant (run_id,plant_id,launched,days_to_launch,unfilled_roles,outstanding_training,
	region_item_id,state_province,country)
	SELECT r.id,x.plant_id,(x.prep->>'launched')::boolean,(x.prep->>'daysToLaunch')::int,(x.prep->>'unfilledRoles')::int,
		(x.prep->>'outstandingTraining')::int,x.region_item_id,x.state_province,x.country FROM r,x RETURNING plant_id),
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
export async function rateIntelligence(db: Database, authority: RequestActor, raw: unknown) {
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
	teams: z.boolean(),
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
	links AS (SELECT DISTINCT ON (k.plant_id) k.plant_id, k.shared_findings, k.share_ministry_teams FROM affiliation k
		WHERE k.organization_id=${o} AND k.plant_id IS NOT NULL AND ${linkActive("k")} ORDER BY k.plant_id)
	SELECT (SELECT name FROM organization WHERE id=${o}) AS organization_name,
	(SELECT timezone FROM organization WHERE id=${o}) AS timezone,
	(SELECT coalesce(json_agg(json_build_object('id', id, 'ran_at', ${iso("ran_at")}) ORDER BY ran_at DESC, id DESC), '[]')
		FROM runs) AS history,
	(SELECT id FROM shown) AS shown,
	(SELECT coalesce(json_agg(json_build_object('plant_id', c.plant_id, 'name', p.name, 'launched', c.launched,
		'days_to_launch', c.days_to_launch, 'unfilled_roles', c.unfilled_roles, 'outstanding_training', c.outstanding_training,
		'teams', l.share_ministry_teams, 'region_key', ri.canonical_key, 'state_province', c.state_province,
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
		groups: run ? groupsOf(request.level, r.rows, r.unshared, r.ratings) : [],
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
	contributions: z.infer<typeof contribution>[],
	unsharedRows: z.infer<typeof unshared>[],
	ratings: Record<string, "useful" | "not_useful">,
): z.input<typeof C.intelligenceGroup>[] {
	type Row = z.input<typeof C.intelligenceRow>;
	type Member = { place: Placed; row: Row };
	const members: Member[] = [
		...contributions.map((c) => ({
			place: {
				plantId: c.plant_id,
				name: c.name,
				regionKey: c.region_key,
				state: c.state_province,
				country: c.country,
			},
			row: {
				status: "shared" as const,
				plantId: c.plant_id,
				name: c.name,
				// A plant that stopped sharing Ministry teams keeps no gap evidence: its counts read as Unknown.
				result: C.nearLaunch({
					launched: c.launched,
					daysToLaunch: c.days_to_launch,
					unfilledRoles: c.teams ? c.unfilled_roles : null,
					outstandingTraining: c.teams ? c.outstanding_training : null,
				}),
			},
		})),
		...unsharedRows.map((u) => ({
			place: {
				plantId: u.plant_id,
				name: u.name,
				regionKey: u.region_key,
				state: u.state_province,
				country: u.country,
			},
			row: { status: "not_shared" as const, plantId: u.plant_id, name: u.name },
		})),
	];
	const groups = new Map<string, { label: string; unplaced: boolean; rows: Row[] }>();
	for (const m of members) {
		const place = placeOf(level, m.place);
		const key = place?.key ?? "unplaced";
		const group = groups.get(key) ?? { label: place?.label ?? UNPLACED[level], unplaced: !place, rows: [] };
		group.rows.push(m.row);
		groups.set(key, group);
	}
	const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
	return [...groups.entries()]
		.map(([key, g]) => {
			const rows = [...g.rows].sort(byName);
			const qualifying = rows.flatMap((x) =>
				x.status === "shared" && x.result === "gap" ? [{ plantId: x.plantId, name: x.name }] : [],
			);
			const observed = rows.filter((x) => x.status === "shared" && x.result !== "unknown").length;
			const patternKey = `${C.NEAR_LAUNCH_RULE.id}:${level}:${key}`;
			return {
				key,
				label: g.label,
				rows,
				unplaced: g.unplaced,
				pattern:
					!g.unplaced && qualifying.length >= 2
						? {
								key: patternKey,
								support: qualifying.length,
								observed,
								plants: qualifying,
								rating: ratings[patternKey] ?? null,
							}
						: null,
			};
		})
		.sort((a, b) => Number(a.unplaced) - Number(b.unplaced) || a.label.localeCompare(b.label));
}
