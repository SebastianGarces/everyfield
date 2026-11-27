import type { Clock } from "@everyfield/contracts/common";
import { LENSES } from "@everyfield/contracts/intelligence";
import * as C from "@everyfield/contracts/oversight";
import type { Database } from "@everyfield/db/client";
import { sql, type SQL, type SqlLiteral } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { liveRows, type RequestActor } from "../access/session.ts";
import { linkActive, type Reader } from "../organizations/core.ts";
import {
	areaOf,
	countryKey,
	latestGeography,
	regionKey,
	stateCode,
	stateName,
	unplacedRegion,
} from "../organizations/geography.ts";
import { one, parse, refuse, seatOf, write } from "../organizations/seat.ts";
import { overdueFollowUpsJson } from "../followups/queries.ts";
import { factInputs, growthDays, peopleJson } from "../intelligence/facts.ts";
import { releasedRun } from "../intelligence/views.ts";
import { preparationJson, requiredTrainingCount } from "./launch.ts";
import { activeReference } from "./reference.ts";
import { capturedReleasedJson, released, releasedHealth, releasedOf } from "./released.ts";

type Db = Pick<Database, "execute">;

export const NETWORK_LEASE_MS = 120_000;
export class NetworkProviderDeadline extends Error {}
export class NetworkRetrievalUnavailable extends Error {}
type NetworkFinding = {
	level: C.Level;
	group: string;
	rule: C.PatternRuleId;
	key: string;
	citation: { rubric: string; rule: string; source: string };
} & Record<string, unknown>;
type NetworkOutput = { findings: Record<string, unknown>[] };
type NetworkReference = { activation: number; citations: string[] };
export type RefreshConfig = {
	compose?: (input: { findings: NetworkFinding[] }) => Promise<NetworkOutput>;
	retrieve?: (db: Db) => Promise<NetworkReference | null>;
	clock?: Clock;
};
type RefreshClaim = { runId: string; organization: string; generation: number; owner: string };

const VIOLATIONS = ["unsupported_numeric_value", "prohibited_fields", "invalid_reference_citation"] as const;
type Violation = (typeof VIOLATIONS)[number];
const PROHIBITED_KEYS = new Set([
	"person",
	"person_id",
	"person_name",
	"people",
	"interview",
	"four_cs",
	"private_note",
	"private_care",
	"private_checkin",
	"street",
	"street_address",
	"coordinates",
	"raw_assessment",
	"plant_metrics",
	"ranking",
]);
const keysOf = (value: unknown): string[] =>
	Array.isArray(value)
		? value.flatMap(keysOf)
		: value !== null && typeof value === "object"
			? Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)])
			: [];

function validateOutput(output: NetworkOutput, expected: NetworkFinding[], citations: string[]): Violation[] {
	const found = new Set<Violation>();
	const byKey = new Map(expected.map((f) => [`${f.level}:${f.key}`, f]));
	for (const f of output.findings) {
		const want = byKey.get(`${String(f.level)}:${String(f.key)}`);
		for (const [k, v] of Object.entries(f))
			if (typeof v === "number" && (!want || want[k] !== v)) found.add("unsupported_numeric_value");
		const cite = f.citation as NetworkFinding["citation"] | undefined;
		const source = cite && `${cite.rubric}#${cite.rule}#${cite.source}`;
		if (!want || !source || !citations.includes(source) || cite.rule !== want.rule)
			found.add("invalid_reference_citation");
	}
	if (keysOf(output).some((k) => PROHIBITED_KEYS.has(k))) found.add("prohibited_fields");
	return VIOLATIONS.filter((v) => found.has(v));
}

const defaultRetrieve = async (db: Db): Promise<NetworkReference | null> => {
	const { rows } = await db.execute(sql`SELECT n.activation_number AS n, n.rubric_version AS v FROM network_reference n
	WHERE n.activation_number=${activeReference}`);
	const r = z.object({ n: z.int(), v: z.string() }).safeParse(rows[0]);
	if (!r.success || r.data.v !== C.RUBRIC_VERSION) return null;
	const cite = (rule: C.PatternRuleId) => {
		const c = C.citationOf(rule);
		return `${c.rubric}#${c.rule}#${c.source}`;
	};
	return { activation: r.data.n, citations: C.PATTERN_RULE_IDS.map(cite) };
};

const at = (config: RefreshConfig) =>
	config.clock ? sql`${new Date(config.clock.now()).toISOString()}::timestamptz` : sql`clock_timestamp()`;

const liveContributors = (o: SQL) => sql`(SELECT DISTINCT ON (k.plant_id) k.plant_id,k.revision AS rev,
	(SELECT rr.id FROM ${releasedRun(sql`k.plant_id`, sql`clock_timestamp()`)} rr) AS rel
	FROM affiliation k WHERE k.organization_id=${o} AND k.plant_id IS NOT NULL AND ${linkActive("k")} AND k.shared_findings
	ORDER BY k.plant_id,k.revision DESC)`;
const contributorsChanged = (o: SQL, run: SQL) => sql`(EXISTS(SELECT plant_id,rev,rel FROM ${liveContributors(o)} l
	EXCEPT SELECT plant_id,affiliation_revision,released_run_id FROM network_intelligence_plant WHERE run_id=${run})
	OR EXISTS(SELECT plant_id,affiliation_revision,released_run_id FROM network_intelligence_plant WHERE run_id=${run}
	EXCEPT SELECT plant_id,rev,rel FROM ${liveContributors(o)} l))`;

async function capture(tx: Db, run: string, organization: string) {
	const o = sql`${organization}::uuid`;
	const people = await tx.execute(sql`SELECT DISTINCT ON (k.plant_id) k.plant_id,
	(clock_timestamp() AT TIME ZONE pl.timezone)::date::text AS today, ${peopleJson(sql`k.plant_id`)} AS people
	FROM affiliation k JOIN plant pl ON pl.id=k.plant_id
	WHERE k.organization_id=${o} AND k.plant_id IS NOT NULL AND ${linkActive("k")} AND k.shared_findings AND k.share_people
	AND NOT EXISTS(SELECT FROM network_intelligence_plant WHERE run_id=${run}::uuid) ORDER BY k.plant_id`);
	const growth = Object.fromEntries(
		z
			.array(z.object({ plant_id: z.string(), today: z.string(), people: factInputs.shape.people }))
			.parse(people.rows)
			.map((r) => [r.plant_id, growthDays(r.people, r.today)]),
	);
	const { rows } = await tx.execute(sql`WITH r AS (SELECT id FROM network_intelligence_run WHERE id=${run}::uuid
	AND NOT EXISTS(SELECT FROM network_intelligence_plant WHERE run_id=${run}::uuid)),
x AS (SELECT DISTINCT ON (k.plant_id) k.plant_id, k.revision, ${preparationJson(sql`k.plant_id`, sql`k.share_ministry_teams`)} AS prep,
	CASE WHEN k.share_meetings AND k.share_tasks THEN ${overdueFollowUpsJson(sql`k.plant_id`)} END AS followups,
	CASE WHEN k.share_people THEN (${JSON.stringify(growth)}::jsonb->>k.plant_id::text)::int END AS growth_days,
	CASE WHEN k.share_ministry_teams THEN ${requiredTrainingCount(sql`k.plant_id`)} END AS required_training,
	(SELECT rr.id FROM ${releasedRun(sql`k.plant_id`, sql`clock_timestamp()`)} rr) AS released_run_id,
	g.region_item_id, CASE WHEN g.plant_id IS NULL THEN p.state_province ELSE g.state_province END AS state_province,
	CASE WHEN g.plant_id IS NULL THEN p.country ELSE g.country END AS country
	FROM affiliation k JOIN plant p ON p.id=k.plant_id LEFT JOIN LATERAL ${latestGeography(sql`p.id`)} g ON true
	WHERE k.organization_id=${o} AND k.plant_id IS NOT NULL AND ${linkActive("k")} AND k.shared_findings
	ORDER BY k.plant_id,k.revision DESC),
c AS (INSERT INTO network_intelligence_plant (run_id,plant_id,launched,days_to_launch,unfilled_roles,outstanding_training,
	region_item_id,state_province,country,overdue_followups,unowned_followups,growth_days,required_training,
	affiliation_revision,released_run_id)
	SELECT r.id,x.plant_id,(x.prep->>'launched')::boolean,(x.prep->>'daysToLaunch')::int,(x.prep->>'unfilledRoles')::int,
		(x.prep->>'outstandingTraining')::int,x.region_item_id,x.state_province,x.country,(x.followups->>'overdue')::int,
		(x.followups->>'unowned')::int,x.growth_days,x.required_training,x.revision,x.released_run_id FROM r,x RETURNING plant_id),
u AS (UPDATE network_intelligence_run SET ran_at=clock_timestamp(),reference_activation=${activeReference}
	WHERE id IN (SELECT id FROM r) RETURNING id)
SELECT (SELECT count(*) FROM c)::int AS plants`);
	return z.object({ plants: z.int() }).parse(rows[0]).plants;
}

const claimRow = z.object({ id: z.uuid(), organization_id: z.uuid(), claim_generation: z.int() });

export async function claimIntelligenceRefresh(
	db: Database,
	config: RefreshConfig = {},
	runId: string | null = null,
): Promise<RefreshClaim | null> {
	const owner = randomUUID();
	const now = at(config);
	return db.transaction(async (tx) => {
		const { rows } = await tx.execute(sql`UPDATE network_intelligence_run r SET claim_generation=r.claim_generation+1,
	outcome='pending',lease_owner=${owner},lease_until=${now}+make_interval(secs=>${NETWORK_LEASE_MS / 1000})
	WHERE r.id=(SELECT q.id FROM network_intelligence_run q WHERE (q.outcome='deferred'
		OR (q.outcome='pending' AND (q.lease_until IS NULL OR q.lease_until<=${now})))
		${runId ? sql`AND q.id=${runId}::uuid` : sql``} ORDER BY q.ran_at,q.id LIMIT 1 FOR UPDATE SKIP LOCKED)
	RETURNING r.id,r.organization_id,r.claim_generation`);
		const r = claimRow.safeParse(rows[0]);
		if (!r.success) return null;
		await capture(tx, r.data.id, r.data.organization_id);
		return { runId: r.data.id, organization: r.data.organization_id, generation: r.data.claim_generation, owner };
	});
}

async function settle(tx: Db, claim: RefreshClaim, outcome: string, violations: Violation[] | null = null) {
	await tx.execute(sql`UPDATE network_intelligence_run SET outcome=${outcome},
	violations=${violations ? sql`${JSON.stringify(violations)}::jsonb` : sql`NULL`},
	settled_at=${outcome === "deferred" ? sql`NULL` : sql`clock_timestamp()`},lease_owner=NULL,lease_until=NULL
	WHERE id=${claim.runId}::uuid AND claim_generation=${claim.generation} AND outcome='pending'`);
}

async function publish(tx: Db, claim: RefreshClaim, config: RefreshConfig, violations: Violation[]) {
	const { rows } =
		await tx.execute(sql`WITH run AS (SELECT * FROM network_intelligence_run WHERE id=${claim.runId}::uuid
	FOR UPDATE)
SELECT run.claim_generation=${claim.generation} AND run.lease_owner IS NOT DISTINCT FROM ${claim.owner}
	AND run.outcome='pending' AS current,
	coalesce(run.lease_until>${at(config)},false) AS leased,
	${activeReference} AS active, run.reference_activation AS captured,
	${contributorsChanged(sql`run.organization_id`, sql`run.id`)} AS changed FROM run`);
	const f = z
		.object({
			current: z.boolean(),
			leased: z.boolean(),
			active: z.int().nullable(),
			captured: z.int().nullable(),
			changed: z.boolean(),
		})
		.parse(rows[0]);
	if (!f.current) return "refused_stale_claim" as const;
	const outcome =
		!f.leased || f.active === null || f.active !== f.captured || f.changed
			? "superseded"
			: violations.length
				? "failed"
				: "published";
	await settle(tx, claim, outcome, outcome === "failed" ? violations : null);
	return outcome;
}

async function findingsOf(db: Db, organization: string, runId: string): Promise<NetworkFinding[]> {
	const { ranOn, rows } = await runContributions(db, sql`${organization}::uuid`, sql`${runId}::uuid`);
	if (!ranOn) return [];
	const finding = (level: C.Level, group: string, p: z.input<typeof C.intelligencePattern>) =>
		({
			...Object.fromEntries(Object.entries(p).filter(([k]) => k !== "plants" && k !== "rating")),
			level,
			group,
		}) as NetworkFinding;
	return C.LEVELS.flatMap((level) =>
		groupsOf(level, ranOn, rows, [], {}).flatMap((g) => g.patterns.map((p) => finding(level, g.key, p))),
	);
}

export async function runIntelligenceRefresh(db: Database, claim: RefreshClaim, config: RefreshConfig = {}) {
	let reference: NetworkReference | null;
	try {
		reference = await (config.retrieve ?? defaultRetrieve)(db);
	} catch (error) {
		if (!(error instanceof NetworkRetrievalUnavailable)) throw error;
		await db.transaction((tx) => settle(tx, claim, "degraded"));
		return "degraded" as const;
	}
	if (!reference) {
		await db.transaction((tx) => settle(tx, claim, "superseded"));
		return "reference_not_ready" as const;
	}
	const expected = await findingsOf(db, claim.organization, claim.runId);
	let output: NetworkOutput;
	try {
		output = await (config.compose ?? (async (x) => x))({ findings: expected });
	} catch (error) {
		if (!(error instanceof NetworkProviderDeadline)) throw error;
		await db.transaction((tx) => settle(tx, claim, "deferred"));
		return "deferred" as const;
	}
	const violations = validateOutput(output, expected, reference.citations);
	return db.transaction((tx) => publish(tx, claim, config, violations));
}

export async function scheduleIntelligenceRefresh(db: Db) {
	const { rows } = await db.execute(sql`WITH latest AS (SELECT DISTINCT ON (r.organization_id) r.id,r.organization_id,
	r.reference_activation FROM network_intelligence_run r WHERE r.outcome='published'
	ORDER BY r.organization_id,r.ran_at DESC,r.id DESC),
due AS (SELECT l.organization_id FROM latest l WHERE ${activeReference} IS NOT NULL
	AND NOT EXISTS(SELECT FROM network_intelligence_run q WHERE q.organization_id=l.organization_id
		AND q.outcome IN ('pending','deferred'))
	AND (l.reference_activation IS DISTINCT FROM ${activeReference}
		OR ${contributorsChanged(sql`l.organization_id`, sql`l.id`)})),
q AS (INSERT INTO network_intelligence_run (id,organization_id,requested_by,rubric_version,outcome)
	SELECT gen_random_uuid(),due.organization_id,NULL,${C.RUBRIC_VERSION},'pending' FROM due RETURNING organization_id)
SELECT coalesce(json_agg(organization_id ORDER BY organization_id),'[]') AS queued FROM q`);
	return z.object({ queued: z.array(z.uuid()) }).parse(rows[0]).queued;
}

export async function runIntelligenceRefreshBatch(db: Database, config: RefreshConfig = {}, limit = 2) {
	let ran = 0;
	for (; ran < limit; ran++) {
		const claim = await claimIntelligenceRefresh(db, config);
		if (!claim) break;
		await runIntelligenceRefresh(db, claim, config);
	}
	return ran;
}

export async function requestIntelligenceRefresh(
	db: Database,
	authority: RequestActor,
	raw: unknown,
	config: RefreshConfig = {},
) {
	return write(db, authority, true, async (w) => {
		const input = parse(C.refreshRequest, raw);
		const o = sql`${w.organization}::uuid`;
		const owner = randomUUID();
		const row = await one(
			w,
			z.object({ added: z.boolean(), existing: z.boolean(), ready: z.boolean() }),
			sql`WITH ready AS (SELECT ${activeReference} IS NOT NULL AS ok),
r AS (INSERT INTO network_intelligence_run (id,organization_id,requested_by,rubric_version,outcome,lease_owner,lease_until)
	SELECT ${input.runId}::uuid,${o},${w.actor}::uuid,${C.RUBRIC_VERSION},'pending',${owner},
		${at(config)}+make_interval(secs=>${NETWORK_LEASE_MS / 1000})
	FROM ready WHERE ready.ok ON CONFLICT (id) DO NOTHING RETURNING id)
SELECT EXISTS(SELECT FROM r) AS added, (SELECT ok FROM ready) AS ready,
	EXISTS(SELECT FROM network_intelligence_run WHERE id=${input.runId}::uuid AND organization_id=${o}) AS existing`,
		);
		if (!row.ready) refuse({ code: "reference_not_ready" });
		if (!row.added && !row.existing) refuse({ code: "conflict" });
		if (row.added) {
			const claim = { runId: input.runId, organization: w.organization, generation: 1, owner };
			const plants = await capture(w.tx, input.runId, w.organization);
			await w.tx.execute(
				w.audit({
					action: "settings.changed",
					kind: "create",
					subjectType: "organization",
					subject: o,
					metadata: { category: "network_intelligence", runId: input.runId, plants },
				}),
			);
			const reference = await (config.retrieve ?? defaultRetrieve)(w.tx);
			const expected = await findingsOf(w.tx, w.organization, input.runId);
			const output = await (config.compose ?? (async (x) => x))({ findings: expected });
			await publish(w.tx, claim, config, validateOutput(output, expected, reference?.citations ?? []));
		}
		return { runId: input.runId, outcome: row.added ? ("changed" as const) : ("noop" as const) };
	});
}
export async function submitIntelligenceFeedback(db: Database, authority: RequestActor, raw: unknown) {
	return write(db, authority, false, async (w) => {
		const input = parse(C.feedbackRequest, raw);
		if (!(await readPattern(w.tx, authority, input))) refuse();
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
	meetings: z.boolean(),
	tasks: z.boolean(),
	region_key: z.string().nullable(),
	saved: z.boolean(),
	city: z.string().nullable(),
	state_province: z.string().nullable(),
	country: z.string().nullable(),
	release_key: z.string().nullable(),
	release_credit: z.string().nullable(),
	released,
});
const unshared = z.object({
	plant_id: z.string(),
	name: z.string(),
	region_key: z.string().nullable(),
	saved: z.boolean(),
	city: z.string().nullable(),
	state_province: z.string().nullable(),
	country: z.string().nullable(),
});
const iso = <VName extends string>(v: SqlLiteral<VName>) =>
	sql`to_char(${sql.raw(v)} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export async function readPattern(db: Reader, authority: RequestActor, input: { runId: string; patternKey: string }) {
	const level = input.patternKey.split(":").find((part) => C.LEVELS.some((l) => l === part)) as C.Level | undefined;
	const view = level ? await readIntelligence(db, authority, { level, runId: input.runId }) : null;
	const group = view?.groups.find((g) => g.patterns.some((p) => p.key === input.patternKey));
	const pattern = group?.patterns.find((p) => p.key === input.patternKey);
	if (!view?.run || !group || !pattern) return null;
	return { pattern, level: view.level, group: group.label, ranAt: view.run.ranAt, timeZone: view.timeZone };
}

const linksSql = (o: SQL) => sql`(SELECT DISTINCT ON (k.plant_id) k.plant_id, k.shared_findings, k.share_ministry_teams,
	k.share_people, k.share_meetings, k.share_tasks FROM affiliation k
	WHERE k.organization_id=${o} AND k.plant_id IS NOT NULL AND ${linkActive("k")} ORDER BY k.plant_id)`;
const contributionsSql = (o: SQL, run: SQL) => sql`(SELECT coalesce(json_agg(json_build_object('plant_id', c.plant_id,
		'name', p.name, 'launched', c.launched,
		'days_to_launch', c.days_to_launch, 'unfilled_roles', c.unfilled_roles, 'outstanding_training', c.outstanding_training,
		'overdue_followups', c.overdue_followups, 'unowned_followups', c.unowned_followups, 'growth_days', c.growth_days,
		'required_training', c.required_training, 'teams', l.share_ministry_teams, 'people', l.share_people,
		'meetings', l.share_meetings, 'tasks', l.share_tasks, 'region_key', ri.canonical_key, 'saved', g.id IS NOT NULL,
		'city', g.city, 'state_province', c.state_province, 'country', c.country, 'release_key', gr.release_key,
		'release_credit', gv.source_credit, 'released', ${capturedReleasedJson(sql`c.released_run_id`)})),
		'[]')
		FROM network_intelligence_plant c JOIN network_intelligence_run s ON s.id=c.run_id AND s.id=${run}
		JOIN ${linksSql(o)} l ON l.plant_id=c.plant_id AND l.shared_findings
		JOIN plant p ON p.id=c.plant_id LEFT JOIN reference_item ri ON ri.id=c.region_item_id
		LEFT JOIN LATERAL (SELECT x.* FROM plant_geography x WHERE x.plant_id=c.plant_id AND x.effective_at<=s.ran_at
			ORDER BY x.effective_at DESC, x.id DESC LIMIT 1) g ON true
		LEFT JOIN reference_version gv ON gv.id=g.reference_version_id
		LEFT JOIN reference_release gr ON gr.id=gv.release_id)`;
const ranOnSql = (o: SQL, run: SQL) => sql`(SELECT (r.ran_at AT TIME ZONE o.timezone)::date::text
	FROM network_intelligence_run r JOIN organization o ON o.id=r.organization_id WHERE r.id=${run} AND o.id=${o})`;

async function runContributions(db: Db, o: SQL, run: SQL) {
	const { rows } = await db.execute(sql`SELECT ${ranOnSql(o, run)} AS ran_on, ${contributionsSql(o, run)} AS rows`);
	const r = z.object({ ran_on: z.string().nullable(), rows: z.array(contribution) }).parse(rows[0]);
	return { ranOn: r.ran_on, rows: r.rows };
}

export async function readIntelligence(
	db: Reader,
	authority: RequestActor,
	request: { level: C.Level; runId: string | null },
): Promise<C.IntelligenceView | null> {
	const seat = seatOf(authority);
	if (!seat) return null;
	if (request.runId !== null && !z.uuid().safeParse(request.runId).success) return null;
	const o = sql`${seat.organization}::uuid`;
	const shown = sql`(SELECT id FROM network_intelligence_run WHERE organization_id=${o} AND outcome='published'
		${request.runId === null ? sql`` : sql`AND id=${request.runId}::uuid`} ORDER BY ran_at DESC, id DESC LIMIT 1)`;
	const rows = await liveRows(
		db,
		seat.live,
		sql`SELECT (SELECT name FROM organization WHERE id=${o}) AS organization_name,
	(SELECT timezone FROM organization WHERE id=${o}) AS timezone,
	${activeReference} IS NOT NULL AS ready,
	(SELECT coalesce(json_agg(json_build_object('id', id, 'ran_at', ${iso("ran_at")}) ORDER BY ran_at DESC, id DESC), '[]')
		FROM network_intelligence_run WHERE organization_id=${o} AND outcome='published') AS history,
	${shown} AS shown,
	${ranOnSql(o, shown)} AS shown_on,
	${contributionsSql(o, shown)} AS rows,
	(SELECT coalesce(json_agg(json_build_object('plant_id', p.id, 'name', p.name, 'region_key', ri.canonical_key,
		'saved', g.id IS NOT NULL, 'city', CASE WHEN g.plant_id IS NULL THEN p.city ELSE g.city END,
		'state_province', CASE WHEN g.plant_id IS NULL THEN p.state_province ELSE g.state_province END,
		'country', CASE WHEN g.plant_id IS NULL THEN p.country ELSE g.country END)), '[]')
		FROM ${linksSql(o)} l JOIN plant p ON p.id=l.plant_id LEFT JOIN LATERAL ${latestGeography(sql`p.id`)} g ON true
		LEFT JOIN reference_item ri ON ri.id=g.region_item_id WHERE NOT l.shared_findings) AS unshared,
	(SELECT coalesce(json_object_agg(f.pattern_key, f.rating), '{}') FROM network_intelligence_feedback f
		WHERE f.run_id=${shown} AND f.account_id=${seat.accountId}::uuid) AS ratings`,
	);
	const row = rows?.[0];
	if (!row) return null;
	const r = z
		.object({
			organization_name: z.string(),
			timezone: z.string(),
			ready: z.boolean(),
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
	const run = r.ready ? (history.find((h) => h.runId === r.shown) ?? null) : null;
	const releases = new Map(
		r.rows.flatMap((c) => (c.release_key && c.release_credit ? [[c.release_key, c.release_credit] as const] : [])),
	);
	return C.intelligenceView.parse({
		status: r.ready ? "ready" : "reference_not_ready",
		organizationName: r.organization_name,
		timeZone: r.timezone,
		level: request.level,
		run,
		history,
		groups: run && r.shown_on !== null ? groupsOf(request.level, r.shown_on, r.rows, r.unshared, r.ratings) : [],
		geographyReleases: run ? [...releases].sort().map(([key, credit]) => ({ key, credit })) : [],
		canRefresh: seat.administrator,
	});
}

type Placed = {
	plantId: string;
	name: string;
	regionKey: string | null;
	saved: boolean;
	city: string | null;
	state: string | null;
	country: string | null;
};
function placeOf(level: C.Level, p: Placed): { key: string; label: string; placement: C.Placement } {
	const country = countryKey(p.country);
	const placed = (key: string, label: string) => ({ key, label, placement: "placed" as const });
	const none = (placement: Exclude<C.Placement, "placed">) => ({
		key: placement,
		label: placement === "missing" ? MISSING[level] : REGION_STATUS[placement],
		placement,
	});
	if (level === "portfolio") return placed("portfolio", "Whole portfolio");
	if (level === "country")
		return country ? placed(country, country === "US" ? "United States" : country) : none("missing");
	if (level === "state") {
		if (!country || !p.state?.trim()) return none("missing");
		const code = country === "US" ? stateCode(p.state) : null;
		if (country === "US" && !code) return none("missing");
		return code ? placed(`US:${code}`, stateName(code)) : placed(`${country}:${p.state.trim()}`, p.state.trim());
	}
	const area = areaOf(p.regionKey);
	if (area) return placed(area.code, C.regionLabel(area));
	return none(unplacedRegion(p.saved, { city: p.city, stateProvince: p.state, country: p.country }));
}
export function placedIn(p: {
	region: C.RegionArea | null;
	city: string | null;
	stateProvince: string | null;
	country: string | null;
}): string[] {
	const placed: Placed = {
		plantId: "",
		name: "",
		regionKey: p.region ? regionKey(p.region.code) : null,
		saved: p.region !== null,
		city: p.city,
		state: p.stateProvince,
		country: p.country,
	};
	return C.LEVELS.flatMap((level) => {
		const at = placeOf(level, placed);
		return at.placement === "placed" ? [at.label] : [];
	});
}
const MISSING: Record<C.Level, string> = {
	region: "No Region set",
	state: "No state set",
	country: "No country set",
	portfolio: "",
};
const REGION_STATUS: Record<Exclude<C.Placement, "placed" | "missing">, string> = {
	unresolved: "Region unresolved",
	outside_reference: "Outside the official Region list",
	unsupported_country: "Region not supported outside the United States",
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
			const assessment = releasedOf(
				true,
				{ people: c.people, meetings: c.meetings, tasks: c.tasks, ministry: c.teams },
				c.released,
			);
			const counts: C.RuleCounts = {
				overdueFollowUps: c.meetings && c.tasks ? c.overdue_followups : null,
				unownedFollowUps: c.meetings && c.tasks ? c.unowned_followups : null,
				growthDays: c.people ? c.growth_days : null,
				requiredTraining: c.teams ? c.required_training : null,
				outstandingTraining: c.teams ? c.outstanding_training : null,
			};
			const preparation = {
				launched: c.launched,
				daysToLaunch: c.days_to_launch,
				unfilledRoles: c.teams ? c.unfilled_roles : null,
				outstandingTraining: counts.outstandingTraining,
			};
			return {
				place: {
					plantId: c.plant_id,
					name: c.name,
					regionKey: c.region_key,
					saved: c.saved,
					city: c.city,
					state: c.state_province,
					country: c.country,
				},
				counts,
				row: {
					status: "shared" as const,
					plantId: c.plant_id,
					name: c.name,
					health: C.healthOf(true, preparation, releasedHealth(assessment)),
					assessment,
					results: {
						"NIR-03": C.nearLaunch(preparation),
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
				saved: u.saved,
				city: u.city,
				state: u.state_province,
				country: u.country,
			},
			counts: null,
			row: { status: "not_shared" as const, plantId: u.plant_id, name: u.name },
		})),
	];
	const groups = new Map<string, { label: string; placement: C.Placement; members: Member[] }>();
	for (const m of members) {
		const { key, label, placement } = placeOf(level, m.place);
		const group = groups.get(key) ?? { label, placement, members: [] };
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
				placement: g.placement,
				patterns: g.placement === "placed" ? patternsOf(`${level}:${key}`, asOf, members, ratings) : [],
			};
		})
		.sort(
			(a, b) => Number(a.placement !== "placed") - Number(b.placement !== "placed") || a.label.localeCompare(b.label),
		);
}

function patternsOf(
	place: string,
	asOf: string,
	members: { row: z.input<typeof C.intelligenceRow>; counts: C.RuleCounts | null }[],
	ratings: Record<string, "useful" | "not_useful">,
): z.input<typeof C.intelligencePattern>[] {
	const shared = members.flatMap((m) =>
		m.row.status === "shared" && m.counts
			? [
					{
						plantId: m.row.plantId,
						name: m.row.name,
						counts: m.counts,
						results: m.row.results,
						assessment: m.row.assessment,
					},
				]
			: [],
	);
	const sum = (plants: typeof shared, of: (c: C.RuleCounts) => number | null) =>
		plants.reduce((n, p) => n + (of(p.counts) ?? 0), 0);
	const out: z.input<typeof C.intelligencePattern>[] = [];
	const assessed = shared.filter((p) => p.assessment.status === "released");
	for (const { key: lens } of LENSES) {
		const plants = assessed.filter(
			(p) => p.assessment.status === "released" && p.assessment.concerns.some((x) => x.lens === lens),
		);
		if (plants.length < 2) continue;
		const key = `NIR-01:${lens}:${place}`;
		out.push({
			key,
			rule: "NIR-01",
			theme: "shared_concern",
			lens,
			support: plants.length,
			observed: assessed.length,
			plants: plants.map(({ plantId, name }) => ({ plantId, name })),
			rating: ratings[key] ?? null,
			citation: C.citationOf("NIR-01"),
		});
	}
	for (const { key: lens } of LENSES) {
		const plants = assessed.filter(
			(p) => p.assessment.status === "released" && p.assessment.strengths.some((x) => x.lens === lens),
		);
		if (plants.length < 2) continue;
		const key = `NIR-02:${lens}:${place}`;
		out.push({
			key,
			rule: "NIR-02",
			theme: "shared_strength",
			lens,
			support: plants.length,
			observed: assessed.length,
			plants: plants.map(({ plantId, name }) => ({ plantId, name })),
			rating: ratings[key] ?? null,
			citation: C.citationOf("NIR-02"),
		});
	}
	const add = <R extends C.RuleId>(
		rule: R,
		theme: string,
		qualifies: (r: (typeof shared)[number]["results"][R]) => boolean,
		claims: (plants: typeof shared) => object,
	) => {
		const observed = shared.filter((p) => p.results[rule] !== "unknown");
		const plants = observed.filter((p) => qualifies(p.results[rule]));
		if (plants.length < 2) return;
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
