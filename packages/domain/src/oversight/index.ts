import { localDate, recordId, type Clock, type Owner } from "@everyfield/contracts/common";
import * as C from "@everyfield/contracts/oversight";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { liveAccess, liveRead, liveRows, type RequestActor } from "../access/session.ts";
import { createLaunchReader, offersTo } from "../launch/reads.ts";
import { linkActive, type Reader } from "../organizations/core.ts";
import { areaOf, latestGeography } from "../organizations/geography.ts";
import { compatible } from "../teams/training/reads.ts";
import { launchJson, plantLaunchOf, preparationJson } from "./launch.ts";
import { released, releasedHealth, releasedJson, releasedOf } from "./released.ts";
export { requestIntelligenceRefresh, readIntelligence, submitIntelligenceFeedback } from "./intelligence.ts";

type Organization = Extract<Owner, { kind: "organization" }>;
function organizationOf(authority: RequestActor): Organization | null {
	const context = authority.actor.context;
	return context.kind === "seat" && context.owner.kind === "organization" ? context.owner : null;
}
const live = (authority: RequestActor) => liveRead(liveAccess(authority));

const nowOf = (clock?: Clock) => (clock ? sql`${clock.now()}::timestamptz` : sql`clock_timestamp()`);

const directory = (org: SQL, where: SQL, now: SQL = nowOf()) => sql`SELECT p.id AS plant_id, p.name,
	CASE WHEN g.plant_id IS NULL THEN p.city ELSE g.city END AS city,
	CASE WHEN g.plant_id IS NULL THEN p.state_province ELSE g.state_province END AS state_province,
	CASE WHEN g.plant_id IS NULL THEN p.country ELSE g.country END AS country,
	ri.canonical_key AS region_key, k.shared_findings,
	CASE WHEN k.shared_findings THEN ${preparationJson(sql`p.id`, sql`k.share_ministry_teams`)} END AS preparation,
	CASE WHEN k.shared_findings THEN ${releasedJson(sql`p.id`, now)} END AS released,
	k.share_people, k.share_meetings, k.share_tasks, k.share_ministry_teams,
	p.phase, l.target_date::text AS launch_date, l.gathering_path,
	CASE WHEN go.id=${org} THEN go.name END AS chosen_by, go.gathering_milestone_name AS offered_name,
	coalesce(${offersTo("go", sql`p.id`)}, false) AS offered,
	CASE WHEN k.shared_findings THEN l.gathering_reached_on::text END AS reached_on,
	CASE WHEN k.shared_findings THEN l.gathering_reached_name END AS reached_name,
	(SELECT coalesce(json_agg(DISTINCT o.name), '[]'::json) FROM affiliation ps
		JOIN organization o ON o.id=ps.organization_id AND o.kind='sending_church'
		JOIN affiliation sn ON sn.sending_church_id=ps.organization_id AND sn.organization_id=${org} AND ${linkActive("sn")}
		WHERE ps.plant_id=p.id AND ${linkActive("ps")}) AS through,
	(SELECT CASE WHEN count(*)=1 THEN min(pe.display_name) END FROM onboarding_setup s
		JOIN team_role r ON r.id=(s.lead->'assignment'->>'roleId')::uuid AND r.plant_id=s.plant_id AND r.retired_at IS NULL
		JOIN team_tenure tn ON tn.role_id=r.id AND tn.plant_id=r.plant_id AND tn.ended_on IS NULL
		JOIN person pe ON pe.id=tn.person_id AND pe.plant_id=r.plant_id AND pe.state='live'
		WHERE s.plant_id=p.id AND s.lead->>'answer'='yes') AS lead_planter
	FROM affiliation k JOIN plant p ON p.id=k.plant_id LEFT JOIN launch l ON l.plant_id=p.id
	LEFT JOIN organization go ON go.id=l.gathering_organization_id AND l.gathering_path='milestone'
	LEFT JOIN LATERAL ${latestGeography(sql`p.id`)} g ON true
	LEFT JOIN reference_item ri ON ri.id=g.region_item_id AND ri.kind='geography_region'
	WHERE k.organization_id=${org} AND k.plant_id IS NOT NULL AND ${linkActive("k")} AND ${where}`;
const directoryRow = z.object({
	plant_id: z.string(),
	name: z.string(),
	city: z.string().nullable(),
	state_province: z.string().nullable(),
	country: z.string().nullable(),
	phase: z.number(),
	launch_date: localDate.nullable(),
	gathering_path: z.enum(["launch_sunday", "milestone"]).nullable(),
	chosen_by: z.string().nullable(),
	offered_name: z.string().nullable(),
	offered: z.boolean(),
	reached_on: localDate.nullable(),
	reached_name: z.string().nullable(),
	through: z.array(z.string()),
	lead_planter: z.string().nullable(),
	region_key: z.string().nullable(),
	shared_findings: z.boolean(),
	preparation: z.unknown().nullable(),
	released,
	share_people: z.boolean(),
	share_meetings: z.boolean(),
	share_tasks: z.boolean(),
	share_ministry_teams: z.boolean(),
});
type DirectoryRow = z.infer<typeof directoryRow>;

const assessmentOf = (r: DirectoryRow) =>
	releasedOf(
		r.shared_findings,
		{ people: r.share_people, meetings: r.share_meetings, tasks: r.share_tasks, ministry: r.share_ministry_teams },
		r.released,
	);

function pathOf(r: DirectoryRow): C.PlantPath {
	if (r.gathering_path !== "milestone") return { kind: "launch_sunday", date: r.launch_date };
	const progress: C.MilestoneProgress = !r.shared_findings
		? { status: "withheld" }
		: r.reached_on
			? { status: "reached", date: r.reached_on }
			: r.offered
				? { status: "not_reached" }
				: { status: "withdrawn" };
	const name = progress.status === "reached" ? r.reached_name : r.offered_name;
	return { kind: "milestone", name, chosenBy: r.chosen_by, progress };
}

function plantRow(raw: unknown): C.PlantDirectoryRow {
	const r = directoryRow.parse(raw);
	const assessment = assessmentOf(r);
	return C.plantDirectoryRow.parse({
		plantId: r.plant_id,
		name: r.name,
		city: r.city,
		stateProvince: r.state_province,
		country: r.country,
		phase: r.phase,
		path: pathOf(r),
		provenance: r.through.length ? { kind: "through", sendingChurches: [...r.through].sort() } : { kind: "direct" },
		leadPlanter: r.lead_planter,
		region: areaOf(r.region_key),
		health: C.healthOf(
			r.shared_findings,
			r.preparation ? C.preparation.parse(r.preparation) : null,
			releasedHealth(assessment),
		),
	});
}
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
const uuid = (id: string) => sql`${id}::uuid`;

const plantsJson = (plants: SQL) => sql`(SELECT coalesce(json_agg(d), '[]'::json) FROM (${plants}) d)`;
const plantList = (raw: unknown) => z.array(z.unknown()).parse(raw).map(plantRow).sort(byName);

export async function listPlants(db: Reader, authority: RequestActor, clock?: Clock): Promise<C.PlantDirectory | null> {
	const org = organizationOf(authority);
	if (!org) return null;
	const o = uuid(org.id);
	const rows = await liveRows(
		db,
		live(authority),
		sql`SELECT o.name, ${plantsJson(directory(o, sql`true`, nowOf(clock)))} AS plants FROM organization o WHERE o.id=${o}`,
	);
	const row = rows?.[0];
	return row ? C.plantDirectory.parse({ organizationName: row.name, plants: plantList(row.plants) }) : null;
}

const SECTIONS = {
	people: {
		share: "share_people",
		body: (p: SQL) => sql`SELECT json_build_object('total', coalesce(sum(x.n), 0)::int,
			'byStage', coalesce(json_object_agg(x.stage, x.n), '{}'::json)) FROM
			(SELECT pe.stage, count(*)::int AS n FROM person pe
				WHERE pe.plant_id=${p} AND pe.state='live' GROUP BY 1) x`,
		parse: (raw: unknown) => {
			const r = z.object({ total: z.int(), byStage: z.record(z.string(), z.int()) }).parse(raw);
			const byStage = Object.fromEntries(C.PERSON_STAGES.map((s) => [s, r.byStage[s] ?? 0]));
			return r.total ? C.peopleCounts.parse({ total: r.total, byStage }) : null;
		},
	},
	tasks: {
		share: "share_tasks",
		body: (p: SQL) => {
			const open = sql`t.status IN ('not_started','in_progress','blocked')`;
			const late = sql`CASE t.due_kind WHEN 'timed' THEN t.due_at < clock_timestamp()
				WHEN 'date_only' THEN clock_timestamp() >= ((t.due_date + 1)::timestamp AT TIME ZONE pl.timezone) ELSE false END`;
			return sql`SELECT json_build_object('recorded', count(*)::int, 'open', (count(*) FILTER (WHERE ${open}))::int,
				'overdue', (count(*) FILTER (WHERE ${open} AND ${late}))::int)
				FROM task t JOIN plant pl ON pl.id=t.plant_id
				WHERE t.plant_id=${p} AND t.parent_id IS NULL AND t.deleted_at IS NULL`;
		},
		parse: (raw: unknown) => {
			const r = z.object({ recorded: z.int(), open: z.int(), overdue: z.int() }).parse(raw);
			return r.recorded ? C.taskCounts.parse({ open: r.open, overdue: r.overdue }) : null;
		},
	},
	meetings: {
		share: "share_meetings",
		body: (p: SQL) => sql`SELECT coalesce(json_agg(json_build_object('date', x.local_date, 'attended', x.attended)
			ORDER BY x.occurred, x.id), '[]'::json) FROM (SELECT m.id, m.local_date, coalesce(m.actual_occurrence_at, m.starts_at) AS occurred,
				CASE WHEN m.finalized_at IS NOT NULL THEN (SELECT count(DISTINCT g.person_id) FROM participation g
					WHERE g.meeting_id=m.id AND g.presence='attended' AND g.removed_at IS NULL)::int END AS attended
				FROM meeting m WHERE m.plant_id=${p} AND m.retired_at IS NULL AND m.occurrence_voided_at IS NULL
					AND m.status <> 'cancelled' AND coalesce(m.actual_occurrence_at, m.starts_at) <= clock_timestamp()
				ORDER BY occurred DESC, m.id DESC LIMIT 12) x`,
		parse: (raw: unknown) => {
			const meetings = z.array(z.object({ date: z.string(), attended: z.int().nullable() })).parse(raw);
			if (!meetings.length) return null;
			const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
			const span = day(meetings.at(-1)!.date) - day(meetings[0]!.date);
			return C.meetingCounts.parse({
				meetings,
				averageDaysBetween: meetings.length > 1 ? Math.round(span / (meetings.length - 1)) : null,
				attendedTotal: meetings.reduce((sum, m) => sum + (m.attended ?? 0), 0),
			});
		},
	},
	ministryTeams: {
		share: "share_ministry_teams",
		body: (p: SQL) => sql`SELECT json_build_object(
			'teams', (SELECT count(*)::int FROM team t WHERE t.plant_id=${p} AND t.archived_at IS NULL),
			'roles', (SELECT count(*)::int FROM team_role r JOIN team t ON t.id=r.team_id AND t.archived_at IS NULL
				WHERE r.plant_id=${p} AND r.retired_at IS NULL),
			'rolesFilled', (SELECT count(*)::int FROM team_role r JOIN team t ON t.id=r.team_id AND t.archived_at IS NULL
				WHERE r.plant_id=${p} AND r.retired_at IS NULL AND EXISTS(SELECT FROM team_tenure tn
					JOIN person pe ON pe.id=tn.person_id AND pe.plant_id=tn.plant_id AND pe.state='live'
					WHERE tn.role_id=r.id AND tn.plant_id=r.plant_id AND tn.ended_on IS NULL)),
			'trainingAssigned', count(*)::int,
			'trainingComplete', (count(*) FILTER (WHERE coalesce(${compatible}, false)))::int)
			FROM training_assignment a
			JOIN training_program g ON g.id=a.program_id AND g.plant_id=a.plant_id AND g.required AND g.archived_at IS NULL
			JOIN person pe ON pe.id=a.person_id AND pe.plant_id=a.plant_id AND pe.state='live'
			WHERE a.plant_id=${p} AND a.state='active'`,
		parse: (raw: unknown) => {
			const r = C.teamCounts.parse(raw);
			return r.teams ? r : null;
		},
	},
	wiki: {
		share: "share_wiki",
		body: (
			p: SQL,
		) => sql`SELECT json_build_object('finished', (count(*) FILTER (WHERE r.completed_at IS NOT NULL))::int,
			'inProgress', (count(*) FILTER (WHERE r.completed_at IS NULL))::int) FROM reading r WHERE r.plant_context_id=${p}`,
		parse: (raw: unknown) => {
			const r = C.wikiCounts.parse(raw);
			return r.finished + r.inProgress ? r : null;
		},
	},
} as const satisfies Record<
	C.SectionKey,
	{ share: string; body: (plant: SQL) => SQL; parse: (raw: unknown) => object | null }
>;

async function readSection<K extends C.SectionKey>(
	db: Reader,
	authority: RequestActor,
	org: Organization,
	plantId: string,
	key: K,
): Promise<C.Section<K>> {
	const s = SECTIONS[key],
		p = uuid(plantId);
	const rows = await liveRows(
		db,
		live(authority),
		sql`SELECT k.${sql.raw(s.share)} AS shared, CASE WHEN k.${sql.raw(s.share)} THEN (${s.body(p)}) END AS counts
		FROM affiliation k WHERE k.organization_id=${uuid(org.id)} AND k.plant_id=${p} AND ${linkActive("k")}`,
	);
	if (!rows) return { status: "unavailable" } as C.Section<K>;
	const row = rows[0];
	if (row?.shared !== true) return { status: "withheld" } as C.Section<K>;
	const counts = s.parse(row.counts);
	return (counts ? { status: "shared", counts } : { status: "empty" }) as C.Section<K>;
}

const KEYS = Object.keys(SECTIONS) as C.SectionKey[];
export async function getPlant(
	db: Reader,
	authority: RequestActor,
	plantId: string,
	report: (section: C.SectionKey, error: unknown) => void = () => {},
	clock?: Clock,
): Promise<C.PlantView | null> {
	const org = organizationOf(authority);
	if (!org || !recordId.safeParse(plantId).success) return null;
	const p = uuid(plantId);
	const rows = await liveRows(
		db,
		live(authority),
		sql`SELECT d.*, CASE WHEN d.shared_findings THEN ${launchJson(p)} END AS launch,
			(SELECT timezone FROM plant WHERE id=${p}) AS timezone
		FROM (${directory(uuid(org.id), sql`p.id=${p}`, nowOf(clock))}) d`,
	);
	if (!rows?.[0]) return null;
	const [summary, ...read] = await Promise.all([
		createLaunchReader().readPublishedSummary(db, authority, plantId),
		...KEYS.map((key) =>
			readSection(db, authority, org, plantId, key).catch((error: unknown) => {
				report(key, error);
				return { status: "unavailable" as const };
			}),
		),
	]);
	const sections = Object.fromEntries(KEYS.map((key, i) => [key, read[i]]));
	const row = rows[0];
	const launch = row.launch ? plantLaunchOf(row.launch, row.preparation) : { status: "withheld" };
	return C.plantView.parse({
		plant: plantRow(row),
		timeZone: row.timezone,
		sections,
		launch,
		summary,
		assessment: assessmentOf(directoryRow.parse(row)),
	});
}

const churchLink = (net: SQL, church: SQL) =>
	sql`sn.organization_id=${net} AND sn.sending_church_id=${church} AND ${linkActive("sn")}`;
const networkOf = (authority: RequestActor) => {
	const org = organizationOf(authority);
	return org?.organizationKind === "sending_network" ? org : null;
};

export async function listSendingChurches(db: Reader, authority: RequestActor): Promise<C.SendingChurchRoster | null> {
	const net = networkOf(authority);
	if (!net) return null;
	const n = uuid(net.id);
	const rows = await liveRows(
		db,
		live(authority),
		sql`SELECT (SELECT count(*)::int FROM relationship_invitation r JOIN invitation i ON i.id=r.invitation_id
			WHERE r.organization_id=${n} AND r.sending_church_id IS NOT NULL AND i.state='pending'
			AND i.created_at > clock_timestamp() - interval '30 days') AS pending,
		(SELECT coalesce(json_agg(json_build_object('organizationId', o.id, 'name', o.name, 'plants',
			(SELECT count(*)::int FROM affiliation ps JOIN affiliation k ON k.plant_id=ps.plant_id AND k.organization_id=${n}
				AND ${linkActive("k")} WHERE ps.organization_id=o.id AND ps.plant_id IS NOT NULL AND ${linkActive("ps")}))), '[]'::json)
			FROM affiliation sn JOIN organization o ON o.id=sn.sending_church_id
			WHERE ${churchLink(n, sql`sn.sending_church_id`)}) AS churches`,
	);
	if (!rows?.[0]) return null;
	const r = z.object({ pending: z.int(), churches: z.array(z.unknown()) }).parse(rows[0]);
	return C.sendingChurchRoster.parse({
		pendingInvitations: r.pending,
		churches: r.churches.map((c) => C.sendingChurchRow.parse(c)).sort(byName),
	});
}

export async function getSendingChurch(
	db: Reader,
	authority: RequestActor,
	churchId: string,
): Promise<C.SendingChurchView | null> {
	const net = networkOf(authority);
	if (!net || !recordId.safeParse(churchId).success) return null;
	const n = uuid(net.id),
		church = uuid(churchId);
	const plants = directory(
		n,
		sql`EXISTS(SELECT FROM affiliation ps WHERE ps.plant_id=p.id AND ps.organization_id=${church} AND ${linkActive("ps")})`,
	);
	const rows = await liveRows(
		db,
		live(authority),
		sql`SELECT o.id, o.name, ${plantsJson(plants)} AS plants
		FROM affiliation sn JOIN organization o ON o.id=sn.sending_church_id WHERE ${churchLink(n, church)}`,
	);
	if (!rows?.[0]) return null;
	const r = z.object({ id: z.string(), name: z.string(), plants: z.unknown() }).parse(rows[0]);
	return C.sendingChurchView.parse({
		organizationId: r.id,
		name: r.name,
		plants: plantList(r.plants),
	});
}
