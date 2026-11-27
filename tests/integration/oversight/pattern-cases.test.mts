import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import {
	lensLabel,
	patternText,
	RUBRIC_VERSION,
	RULES,
	type IntelligencePattern,
	type IntelligenceRow,
	type IntelligenceView,
	type Level,
} from "../../../packages/contracts/src/oversight/health.ts";
import {
	createOrganizationAdapter,
	geographyReference,
	installGeographyRelease,
	readReportingLocation,
	suggestRegions,
} from "../../../packages/domain/src/organizations/index.ts";
import {
	activateNetworkReference,
	claimIntelligenceRefresh,
	readIntelligence,
	requestIntelligenceRefresh,
	runIntelligenceRefresh,
	scheduleIntelligenceRefresh,
	submitIntelligenceFeedback,
	validateNetworkReference,
	writeNetworkReference,
	type RefreshConfig,
} from "../../../packages/domain/src/oversight/index.ts";
import { NETWORK_RUBRIC_HASH } from "../../../packages/domain/src/oversight/reference.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { createRelease } from "../../../packages/domain/src/intelligence/index.ts";
import { church, type Church, type ChurchPlant } from "../intelligence/assessment-church.mts";
import { caseOf } from "../target/sql/core/support.mts";

type Concern = { key: string; lens: string; categories: string[] };
type Input = {
	id: string;
	name: string;
	org: string;
	shared_findings: boolean;
	categories: string[];
	country: string;
	state: string;
	region: string | null;
	concerns: Concern[];
	strengths: Concern[];
	observed_lenses: string[];
	launch: { days: number; uncompleted: boolean; unfilled: number | null; training_gap: number | null } | null;
	followup: { overdue: number; unowned_overdue: number } | null;
	growth: {
		days: number;
		certain: boolean;
		current_size?: number;
		real_acquisition_then_withdrawal?: boolean;
		reactivation_is_new?: boolean;
	} | null;
	training: { applicability_known: boolean; applicable: number; complete: number } | null;
};
type Args = {
	organization: string;
	as_of: string;
	groups: Group[];
	plants: Input[];
	revoked_before_publish?: string[];
};
type Group = "region" | "state_province" | "country" | "whole_portfolio";
type Finding = { rule: string; theme_key: string; group_kind: Group; group_id: string } & Record<string, unknown>;
type Expected = {
	findings: Finding[];
	named_rows?: string[];
	sample_body?: string;
	status?: string;
	publication?: string;
} & Record<string, unknown>;

const LEVEL: Record<Group, Level> = {
	region: "region",
	state_province: "state",
	country: "country",
	whole_portfolio: "portfolio",
};
const CONCERN_LENS: Record<string, { lens: "vision" | "ownership"; fact: string }> = {
	cadence_gap: { lens: "vision", fact: "vision.daysSince" },
	distributed_followup: { lens: "ownership", fact: "followUps.onTime" },
};
const THEME: Record<string, string> = { preparation_gap: "near_launch" };
const REGION: Record<string, { code: string; city: string }> = {
	"CBSA:35620:metro:2023-07": { code: "35620", city: "New York" },
	"fixture-region-X": { code: "35620", city: "New York" },
	"fixture-region-Y": { code: "15380", city: "Buffalo" },
};
const CITY: Record<string, string> = { "US:NY": "New York", "US:NJ": "Newark", "CA:ON": "Toronto" };
const RULE_OF: Record<string, "NIR-01" | "NIR-02" | "NIR-03" | "NIR-04" | "NIR-05" | "NIR-06"> = {
	"NEX-008": "NIR-02",
};
for (const n of [1, 2, 3, 4, 5, 6, 7, 19, 20, 21, 22, 23]) RULE_OF[`NEX-${String(n).padStart(3, "0")}`] = "NIR-01";
for (const n of [9, 10, 11]) RULE_OF[`NEX-0${String(n).padStart(2, "0")}`] = "NIR-03";
for (const n of [12, 13]) RULE_OF[`NEX-0${n}`] = "NIR-04";
for (const n of [14, 15, 16]) RULE_OF[`NEX-0${n}`] = "NIR-05";
for (const n of [17, 18]) RULE_OF[`NEX-0${n}`] = "NIR-06";

let c0: Church;
const api = createOrganizationAdapter(
	{ async invitation() {}, invalidate: () => sql`UPDATE job SET state=state WHERE false` } as never,
	geographyReference,
);
type Case = ReturnType<typeof caseOf> & {
	clock: { now: string; zone: string };
	expected: { event: unknown };
};
const nex = (id: string) => caseOf("intelligence", id) as Case;
const CLOCK = nex("NEX-001").clock;

before(async () => {
	c0 = await church("nexpat", { clock: new Date(CLOCK.now) });
	await installGeographyRelease(c0.admin);
});
after(() => c0?.database.close());

async function network(name: string) {
	const org = await c0.database.organization("sending_network", { name, timezone: CLOCK.zone });
	const seat = await c0.database.actor(org, "admin");
	const admin = async () => (await RequestActor.resolve(c0.db, seat.session as never)) as RequestActor;
	return { ...org, admin };
}
type Network = Awaited<ReturnType<typeof network>>;

async function released(p: ChurchPlant, concerns: Concern[], daysAgo: number, strengths: Concern[] = []) {
	const citations: Record<string, unknown> = {};
	const point = (urgency: string) => (x: Concern) => {
		const { fact } = CONCERN_LENS[x.key]!;
		citations[fact] = { kind: "fact", key: fact, label: "A recorded fact", value: 40 };
		return { urgency, citations: [fact] };
	};
	const points = concerns.map(point("watch"));
	const positives = strengths.map(point("positive"));
	const result = { draft: { focus: points[0] ?? null, supporting: points.slice(1), positives }, citations };
	await c0.admin.execute(sql`INSERT INTO assessment_run(id,plant_id,as_of,phase,source_revision,formula_version,
		rubric_version,rubric_sha256,model,outcome,grounding,facts,model_input,drafts,result,attempts,input_tokens,output_tokens,
		demand,demand_key,captured_at,deadline_at,settled_at,available_at)
		VALUES(${randomUUID()},${p.id},clock_timestamp()-make_interval(days=>${daysAgo}),1,${randomUUID()},'f1','v1','sha','scripted',
		'published','grounded','{}'::jsonb,'{}'::jsonb,'[]'::jsonb,${JSON.stringify(result)}::jsonb,1,0,0,'manual',${randomUUID()},
		clock_timestamp()-make_interval(days=>${daysAgo}),clock_timestamp(),clock_timestamp()-make_interval(days=>${daysAgo}),
		clock_timestamp()-make_interval(days=>${daysAgo}))`);
}

async function person(
	p: ChurchPlant,
	name: string,
	adult: "adult" | "unknown" = "adult",
	account: string | null = null,
) {
	const id = randomUUID();
	await c0.admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,
		adult_classification,commitment_state,pipeline_position,state,created_at,linked_account_id)
		VALUES(${id},${p.id},${p.id},${name},${randomUUID() + "@example.test"},'other','launch_team',${adult},'unknown','1',
		'live',clock_timestamp(),${account})`);
	return id;
}
async function acquired(p: ChurchPlant, name: string, days: number, adult: "adult" | "unknown" = "adult") {
	const id = await person(p, name, adult);
	await c0.admin.execute(sql`INSERT INTO commitment(id,plant_id,person_id,kind,signed_on,recorded_at)
		VALUES(${randomUUID()},${p.id},${id},'launch_team',${c0.day(-days)},clock_timestamp())`);
	return id;
}
const change = (p: ChurchPlant, who: string, kind: "withdrawn" | "reactivated", days: number) =>
	c0.admin.execute(sql`INSERT INTO commitment_change(id,plant_id,person_id,kind,effective_on)
		VALUES(${randomUUID()},${p.id},${who},${kind},${c0.day(-days)})`);
let programs = 0;
async function obligations(p: ChurchPlant, total: number, complete: number, assigned = true) {
	const who = await person(p, "Private Trainee");
	const ids: string[] = [];
	for (let i = 0; i < total; i++) {
		const g = await c0.one<{ id: string; version: number }>(sql`INSERT INTO training_program(plant_id,name,required)
			VALUES(${p.id},${"Private Program " + ++programs},true) RETURNING id, version`);
		if (assigned)
			ids.push(
				(
					await c0.one<{ id: string }>(sql`INSERT INTO training_assignment(plant_id,program_id,person_id,version,state,
				effective_on) VALUES(${p.id},${g.id},${who},${g.version},'active','2026-01-01') RETURNING id`)
				).id,
			);
		if (i < complete)
			await c0.admin.execute(sql`INSERT INTO training_credit(plant_id,person_id,program_id,kind,version,earned_on)
				VALUES(${p.id},${who},${g.id},'earned',${g.version},'2026-02-01')`);
	}
	return ids;
}
async function followUp(p: ChurchPlant, who: string, due: number, owner: string | null) {
	const id = randomUUID();
	await c0.admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,due_date,
		person_id) VALUES(${id},${p.id},'Call Private Person','follow_up','medium','not_started',clock_timestamp(),'date_only',
		${c0.day(due)},${who})`);
	if (owner)
		await c0.admin.execute(sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${p.id},${id},${owner})`);
}

async function placeAt(p: ChurchPlant, x: Input) {
	const [country, state] = x.state.split(":") as [string, string];
	const city = x.region && x.state === "US:NY" ? REGION[x.region]!.city : CITY[x.state]!;
	await c0.admin.execute(sql`UPDATE plant SET city=${city},state_province=${state},country=${country},
		street='4100 Private Street' WHERE id=${p.id}`);
	if (!x.region) return;
	const where = { city, stateProvince: state, country };
	const current = (await readReportingLocation(c0.db, p.actor))!;
	const offered = (await suggestRegions(c0.db, p.actor, where))!;
	const region = offered.find((c) => c.area.code === REGION[x.region!]!.code);
	assert.ok(region, `the picker offers ${x.region} for ${city}`);
	const selected = { kind: "plant" as const, id: p.id };
	await gatedTransaction(c0.db, async (tx) => {
		assert.ok(await RequestActor.claimWrite(tx, p.owner.session as never, selected as never));
		return api["organizations.correctReportingLocation"](
			tx,
			p.owner.session as never,
			selected as never,
			{
				requestKey: randomUUID(),
				expectedRevision: current.revision,
				input: {
					plant: selected,
					locality: where,
					referenceVersionId: current.referenceVersionId,
					regionItemId: region.regionItemId,
				},
			} as never,
		);
	});
}

async function seed(c: Case, x: Input, p: ChurchPlant, repeat: boolean) {
	const given = c.given[x.id] as { timezone?: string; phase?: string } | undefined;
	if (!repeat && given?.timezone)
		await c0.admin.execute(sql`UPDATE plant SET timezone=${given.timezone} WHERE id=${p.id}`);
	if (x.concerns.length || x.strengths.length || x.observed_lenses.length)
		await released(p, x.concerns, repeat ? 6 : 4, x.strengths);
	if (repeat) return;
	await placeAt(p, x);
	if (x.launch) {
		const on = c0.day(x.launch.days);
		await c0.admin.execute(
			x.launch.uncompleted
				? sql`INSERT INTO launch(plant_id,status,target_date) VALUES(${p.id},'scheduled',${on}::date)`
				: sql`INSERT INTO launch(plant_id,status,target_date,actual_date,outcome_recorded_at)
					VALUES(${p.id},'completed',${on}::date,${on}::date,clock_timestamp())`,
		);
		if (x.launch.unfilled !== null) {
			await c0.role(p, "worship", { id: await person(p, "Private Worship Lead") });
			for (let i = 0; i < x.launch.unfilled; i++) await c0.role(p, "children", null);
		}
		if (x.launch.training_gap !== null) await obligations(p, 1 + x.launch.training_gap, 1);
	}
	if (x.followup) {
		const seat = await c0.database.actor(p, "admin");
		await person(p, "Private Owner", "adult", seat.id);
		const who = await person(p, "Private Visitor");
		const owned = x.followup.overdue - x.followup.unowned_overdue;
		for (let i = 0; i < x.followup.overdue; i++) await followUp(p, who, -1 - i, i < owned ? seat.id : null);
		await followUp(p, who, 3, seat.id);
	}
	if (x.growth) {
		const g = x.growth;
		for (let i = 0; i < (g.current_size ?? 0); i++) await acquired(p, `Private Adult ${i}`, 60);
		const last = await acquired(p, "Private Newest Adult", g.days);
		if (!g.certain) await acquired(p, "Private Unclassified", 5, "unknown");
		if (g.real_acquisition_then_withdrawal) await change(p, last, "withdrawn", 1);
		if (g.reactivation_is_new === false) {
			await change(p, last, "withdrawn", 2);
			await change(p, last, "reactivated", 0);
		}
	}
	if (x.training) {
		const t = x.training;
		await obligations(p, t.applicability_known ? t.applicable : t.complete, t.complete, t.applicability_known);
	}
}

async function link(p: ChurchPlant, org: { id: string }, x: Input) {
	const on = (k: string) => x.categories.includes(k);
	await c0.admin.execute(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,
		share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${p.id},${org.id},clock_timestamp()-interval '1 day',${on("people")},${on("meetings")},${on("tasks")},
		${on("ministry_teams")},false,false,${x.shared_findings})`);
}

async function build(c: Case) {
	const args = c.action.arguments as unknown as Args;
	const A = await network(`${c.id} ${args.organization}`);
	const foreign: Record<string, Network> = {};
	const plants = new Map<string, ChurchPlant>();
	for (const x of args.plants) {
		const repeat = plants.has(x.id);
		const p = plants.get(x.id) ?? (await c0.plant(`${c.id} ${x.name}`, { phase: 1 }));
		plants.set(x.id, p);
		await seed(c, x, p, repeat);
		if (repeat) continue;
		const org = x.org === args.organization ? A : (foreign[x.org] ??= await network(`${c.id} ${x.org}`));
		await link(p, org, x);
	}
	await createRelease().releaseDueAssessments(c0.db);
	return { A, foreign, plants, args };
}

const refresh = async (net: Network) => {
	const runId = randomUUID();
	assert.equal((await requestIntelligenceRefresh(c0.db, await net.admin(), { runId })).status, "ok");
	return runId;
};
const read = async (net: Network, level: Level, runId: string | null = null) =>
	(await readIntelligence(c0.db, await net.admin(), { level, runId }))!;
const writes = async () =>
	c0.one<Record<string, number>>(sql`SELECT (SELECT count(*)::int FROM audit_event) AS audit,
		(SELECT count(*)::int FROM job) AS job, (SELECT count(*)::int FROM notice) AS notice,
		(SELECT count(*)::int FROM mail) AS mail, (SELECT count(*)::int FROM network_intelligence_run) AS runs`);

function findingOf(level: Group, groupKey: string, organization: string, p: IntelligencePattern, want: Finding) {
	const group_id = level === "whole_portfolio" ? organization : level === "region" ? `region:${groupKey}` : groupKey;
	const base = { rule: p.rule, group_kind: level, group_id, support: p.support };
	const observed = "observed_count" in want ? { observed_count: p.observed } : {};
	switch (p.theme) {
		case "shared_concern":
		case "shared_strength":
			return { ...base, theme_key: `lens:${p.lens}`, ...observed };
		case "near_launch":
		case "slowed":
		case "stalled":
			return { ...base, theme_key: p.theme, ...observed };
		case "overdue_followup":
			return {
				...base,
				theme_key: p.theme,
				sum_overdue_obligations: p.overdue,
				...(p.unowned
					? { unowned_support_count: p.unowned.support, sum_unowned_overdue_obligations: p.unowned.overdue }
					: {}),
			};
		case "required_training":
			return {
				...base,
				theme_key: p.theme,
				sum_outstanding_required_obligations: p.outstanding,
				sum_applicable_required_obligations: p.applicable,
				sum_current_complete_required_obligations: p.complete,
			};
	}
}
function expectedOf(f: Finding) {
	const concern = CONCERN_LENS[f.theme_key];
	const region = f.group_kind === "region" ? `region:${REGION[f.group_id]!.code}` : f.group_id;
	return {
		...f,
		theme_key: concern ? `lens:${concern.lens}` : (THEME[f.theme_key] ?? f.theme_key),
		group_id: region,
	};
}

function rowState(rule: string, r: IntelligenceRow) {
	if (r.status === "not_shared") return "not_shared";
	if (rule === "NIR-01" || rule === "NIR-02")
		return r.assessment.status === "released" && r.assessment.withheld === 0 ? "shared" : "unknown";
	return r.results[rule as keyof typeof r.results] === "unknown" ? "unknown" : "shared";
}

const PATTERN_NAME =
	"AC:NEX-001 AC:NEX-002 AC:NEX-003 AC:NEX-004 AC:NEX-005 AC:NEX-006 AC:NEX-007 AC:NEX-008 AC:NEX-009 AC:NEX-010 AC:NEX-011 AC:NEX-012 AC:NEX-014 AC:NEX-015 AC:NEX-016 AC:NEX-017 AC:NEX-018 AC:NEX-019 AC:NEX-020 AC:NEX-021 AC:NEX-022 ";
const PATTERN_CASES = PATTERN_NAME.trim()
	.split(" ")
	.map((m) => m.slice(3));

test(`${PATTERN_NAME}each pattern rule's findings name their rule, theme and group with exact support, the named rows match, and hidden and foreign values stay out`, async () => {
	for (const id of PATTERN_CASES) {
		const c = nex(id);
		assert.deepEqual(c.clock, CLOCK, `${id}: one pinned clock`);
		assert.equal(c.action.operation, "organizationIntelligence.read");
		const expected = c.expected.result as Expected;
		assert.deepEqual(c.expected.state, {});
		assert.equal(c.expected.event, null);
		const w = await build(c);
		const runId = await refresh(w.A);
		const rule = RULE_OF[id]!;

		const before = await writes();
		const views = new Map<Group, IntelligenceView>();
		for (const g of w.args.groups) views.set(g, await read(w.A, LEVEL[g]));
		assert.deepEqual(await writes(), before, `${id}: the read writes nothing: no audit row, job, notice or mail`);

		const got = w.args.groups.flatMap((g) =>
			views
				.get(g)!
				.groups.flatMap((group) =>
					group.patterns.map((p) =>
						findingOf(
							g,
							group.key,
							w.args.organization,
							p,
							expected.findings.find((f) => f.rule === p.rule) ?? ({} as Finding),
						),
					),
				),
		);
		assert.deepEqual(got, expected.findings.map(expectedOf), `${id}: findings`);
		for (const view of views.values()) assert.equal(view.run?.runId, runId);

		const whole = views.get("whole_portfolio")!;
		const named = whole.groups
			.flatMap((g) => g.rows)
			.map((r) => {
				const x = w.args.plants.find((p) => `${id} ${p.name}` === r.name);
				assert.ok(x, `${id}: ${r.name} is one of the case's plants`);
				return `${x.id}:${rowState(rule, r)}`;
			})
			.sort();
		if (expected.named_rows) assert.deepEqual(named, [...expected.named_rows].sort(), `${id}: named rows`);
		const status = expected.status;
		if (status === "insufficient_contributors")
			for (const view of views.values())
				assert.ok(
					view.groups.every((g) => g.patterns.length === 0) && view.groups.some((g) => g.rows.length > 0),
					`${id}: the singleton row is shown and every pattern is withheld`,
				);
		else assert.equal(status, undefined);

		if (expected.sample_body) {
			const [p] = whole.groups[0]!.patterns;
			assert.ok(p?.theme === "shared_concern");
			const lens = CONCERN_LENS[expected.findings[0]!.theme_key]!.lens;
			assert.deepEqual(patternText(p).lines, [
				expected.sample_body.replace(expected.findings[0]!.theme_key, lensLabel(lens)),
			]);
			assert.equal(patternText(p).nextStep, RULES["NIR-01"].nextStep);
		}

		const payload = JSON.stringify([...views.values()]);
		assert.doesNotMatch(payload, /Private|Street|Trainee|person/i, `${id}: no people, street or record names`);
		const ids = await c0.rows<{ id: string }>(
			sql`SELECT id FROM person WHERE plant_id = ANY(${sql.param([...w.plants.values()].map((p) => p.id))}::uuid[])`,
		);
		for (const { id: person } of ids) assert.ok(!payload.includes(person), `${id}: no person id`);
		for (const [key, value] of Object.entries(expected)) {
			if (["findings", "named_rows", "sample_body", "status"].includes(key)) continue;
			assert.equal(value, key === "support_count" ? 1 : true, `${id}: ${key}`);
			await omitted(id, key, w, whole, runId);
		}
	}
});

const GENERATED = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}T[\d:.]+Z)$/i;
function said(value: unknown): string[] {
	if (typeof value === "string") return GENERATED.test(value) ? [] : [value];
	if (Array.isArray(value)) return value.flatMap(said);
	if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => [k, ...said(v)]);
	return [String(value)];
}

async function omitted(
	id: string,
	key: string,
	w: Awaited<ReturnType<typeof build>>,
	whole: IntelligenceView,
	runId: string,
) {
	const rows = whole.groups.flatMap((g) => g.rows);
	const row = (plant: string) => rows.find((r) => r.plantId === w.plants.get(plant)!.id);
	const saved = async (column: string) =>
		Object.fromEntries(
			(
				await c0.rows<{ plant_id: string; v: number | null }>(
					sql`SELECT plant_id, ${sql.raw(column)} AS v FROM network_intelligence_plant WHERE run_id=${runId}`,
				)
			).map((r) => [[...w.plants].find(([, p]) => p.id === r.plant_id)![0], r.v]),
		);
	switch (key) {
		case "hidden_values_omitted": {
			assert.deepEqual(Object.keys(row("Q")!).sort(), ["name", "plantId", "status"]);
			const q = w.plants.get("Q")!.id;
			assert.deepEqual(Object.keys(await saved("launched")), ["P"], `${id}: the run holds no input from Q`);
			const run = await c0.rows(sql`SELECT id FROM assessment_run WHERE plant_id=${q}`);
			assert.ok(!JSON.stringify(whole).includes(String(run[0]!.id)), `${id}: Q's released result stays out`);
			return;
		}
		case "foreign_rows_omitted": {
			const q = w.plants.get("Q")!;
			const all = JSON.stringify(
				await Promise.all((["region", "state", "country", "portfolio"] as const).map((l) => read(w.A, l))),
			);
			assert.ok(
				!all.includes(q.id) && !all.includes(q.name),
				`${id}: another organization's plant is not in any group`,
			);
			assert.deepEqual(Object.keys(await saved("launched")), ["P"]);
			const B = Object.values(w.foreign)[0]!;
			await refresh(B);
			const theirs = (await read(B, "portfolio")).groups.flatMap((g) => g.rows.map((r) => r.name));
			assert.deepEqual(theirs, [q.name], `${id}: Q counts only in its own organization`);
			return;
		}
		case "restricted_reason_omitted": {
			const q = row("Q")!;
			assert.ok(q.status === "shared" && q.assessment.status === "released");
			assert.deepEqual([q.assessment.concerns, q.assessment.withheld], [[], 1], `${id}: Q's concern is held back`);
			assert.doesNotMatch(JSON.stringify(q), /meeting|categor|vision/i, `${id}: and no reason is given`);
			return;
		}
		case "support_count": {
			const p = row("P")!;
			assert.ok(p.status === "shared" && p.assessment.status === "released");
			assert.equal(p.assessment.concerns.filter((x) => x.lens === "vision").length, 2);
			assert.equal(rows.length, 1);
			assert.deepEqual(Object.keys(await saved("launched")), ["P"]);
			return;
		}
		case "contact_success_claim_forbidden": {
			const p = whole.groups[0]!.patterns.find((x) => x.theme === "overdue_followup")!;
			const text = patternText(p);
			assert.deepEqual(text.lines, [
				"2 plants have 5 recorded overdue follow-up obligations in the available shared evidence.",
				"Of these, 2 plants have 3 overdue follow-up obligations with no owner.",
			]);
			assert.match(text.nextStep, /do not blame a person or claim unsuccessful contact/);
			assert.doesNotMatch(text.lines.join(" "), /contact/i, `${id}: no claim about contact from task status`);
			return;
		}
		case "genuine_dates_retained":
			assert.deepEqual(await saved("growth_days"), { P: 5, Q: 4 });
			return;
		case "saved_roster_no_live_recompute": {
			const before = whole.groups[0]!.patterns;
			const p = w.plants.get("P")!.id;
			await c0.admin.execute(sql`UPDATE training_assignment SET state='removed',ended_on='2026-03-01'
				WHERE id=(SELECT id FROM training_assignment WHERE plant_id=${p} ORDER BY id LIMIT 1)`);
			await obligations(w.plants.get("Q")!, 2, 0);
			assert.deepEqual((await read(w.A, "portfolio", runId)).groups[0]!.patterns, before, `${id}: the saved run`);
			assert.deepEqual(await saved("required_training"), { P: 3, Q: 4 });
			return;
		}
		case "no_100_percent_claim": {
			assert.deepEqual(await saved("required_training"), { P: null, Q: null });
			assert.ok(whole.groups.every((g) => g.patterns.length === 0));
			const claims = said(whole).filter((x) => /100|complete/i.test(x));
			assert.deepEqual(claims, [], `${id}: no key or value claims 100 percent or completion`);
			return;
		}
		default:
			assert.fail(`${id}: ${key} is not asserted`);
	}
}

test("AC:NEX-023 a revoked grant before the run and before the read withholds the plant and the old two-plant pattern", async () => {
	const c = nex("NEX-023");
	assert.deepEqual(c.clock, CLOCK);
	const expected = c.expected.result as Expected;
	const w = await build(c);
	const old = await refresh(w.A);
	const pattern = (await read(w.A, "portfolio")).groups[0]!.patterns[0]!;
	assert.deepEqual([pattern.rule, pattern.support], ["NIR-01", 2], "before: the two-plant pattern");
	const revoked = (c.action.arguments as unknown as Args).revoked_before_publish!;
	assert.deepEqual(revoked, ["Q"]);
	for (const plant of revoked)
		await c0.admin.execute(sql`UPDATE affiliation SET shared_findings=false WHERE plant_id=${w.plants.get(plant)!.id}`);

	const before = await writes();
	for (const runId of [old, null]) {
		const whole = await read(w.A, "portfolio", runId);
		const rows = whole.groups.flatMap((g) => g.rows);
		assert.deepEqual(
			rows.map((r) => `${r.name.slice(-1)}:${rowState("NIR-01", r)}`).sort(),
			expected.named_rows,
			"named rows",
		);
		assert.deepEqual(Object.keys(rows.find((r) => r.status === "not_shared")!).sort(), ["name", "plantId", "status"]);
		for (const level of ["region", "state", "country", "portfolio"] as const)
			assert.deepEqual(
				(await read(w.A, level, runId)).groups.flatMap((g) => g.patterns),
				expected.findings,
				`${level}: the old two-plant pattern is withheld`,
			);
	}
	assert.deepEqual(await writes(), before);
	assert.equal(expected.publication, "refused_current_grant");
	assert.equal(expected.old_two_plant_pattern_withheld, true);
	const rate = await submitIntelligenceFeedback(c0.db, await w.A.admin(), {
		runId: old,
		patternKey: pattern.key,
		rating: "useful",
	});
	assert.notEqual(rate.status, "ok", "the withheld pattern takes no rating");
	assert.deepEqual(await writes(), before);

	const next = await refresh(w.A);
	const saved = await c0.rows<{ plant_id: string }>(
		sql`SELECT plant_id FROM network_intelligence_plant WHERE run_id=${next}`,
	);
	assert.deepEqual(
		saved.map((r) => r.plant_id),
		[w.plants.get("P")!.id],
	);
	assert.deepEqual(
		(await read(w.A, "portfolio", next)).groups.flatMap((g) => g.patterns),
		[],
	);
});

const patternsAt = async (net: Network, level: Level) => (await read(net, level)).groups.flatMap((g) => g.patterns);
const runOf = (runId: string) =>
	c0.one<{ outcome: string; violations: string[] | null; claim_generation: number; lease_owner: string | null }>(
		sql`SELECT outcome,violations,claim_generation,lease_owner FROM network_intelligence_run WHERE id=${runId}`,
	);

test("AC:NEX-008 one plant's released strength alone is a named row and no NIR-02 finding", async () => {
	const c = nex("NEX-008");
	const args = c.action.arguments as unknown as Args;
	const single = {
		...c,
		id: "NEX-008-single",
		action: { ...c.action, arguments: { ...args, plants: [args.plants[0]!] } },
	};
	const w = await build(single as Case);
	await refresh(w.A);
	for (const level of ["region", "state", "country", "portfolio"] as const)
		assert.deepEqual(
			(await patternsAt(w.A, level)).filter((p) => p.rule === "NIR-02"),
			[],
			`${level}: one plant is never a pattern`,
		);
	const [row] = (await read(w.A, "portfolio")).groups.flatMap((g) => g.rows);
	assert.ok(row?.status === "shared" && row.assessment.status === "released");
	assert.deepEqual(
		row.assessment.strengths.map((s) => s.lens),
		["ownership"],
		"the released assessment carries its strength",
	);
});

test("AC:NEX-024 an output with an unsupported number, prohibited fields and an invalid citation is rejected before publication with exactly those violations; a valid output still publishes", async () => {
	const c = nex("NEX-024");
	assert.deepEqual(c.clock, CLOCK);
	const args = c.action.arguments as unknown as Args & {
		candidate_output: { support_count: number; forbidden_field_keys: string[]; citation: string };
	};
	const expected = c.expected.result as Expected & { violations: string[] };
	assert.equal(c.expected.event, null);
	const w = await build(c);
	const out = args.candidate_output;
	const candidate: RefreshConfig = {
		compose: async ({ findings }) => ({
			findings: findings.map((f) => ({
				...f,
				support: out.support_count,
				...Object.fromEntries(out.forbidden_field_keys.map((k) => [k, "fixture"])),
				citation: { ...f.citation, source: out.citation },
			})),
		}),
	};
	const rejected = randomUUID();
	assert.deepEqual(await requestIntelligenceRefresh(c0.db, await w.A.admin(), { runId: rejected }, candidate), {
		status: "ok",
		value: { runId: rejected, outcome: "changed" },
	});
	const run = await runOf(rejected);
	assert.equal(run.outcome, "failed");
	assert.equal(expected.publication, "rejected");
	assert.deepEqual(run.violations, expected.violations, "exactly the three violation codes");
	const before = await writes();
	for (const level of ["region", "state", "country", "portfolio"] as const) {
		const view = await read(w.A, level);
		assert.equal(view.run, null, `${level}: the rejected run is not published`);
		assert.deepEqual(await patternsAt(w.A, level), expected.findings, `${level}: no finding is published`);
	}
	assert.deepEqual(await writes(), before, "the read writes nothing");

	const valid = await refresh(w.A);
	assert.equal((await runOf(valid)).outcome, "published");
	const shown = await read(w.A, "portfolio");
	assert.equal(shown.run?.runId, valid);
	assert.deepEqual(
		(await patternsAt(w.A, "portfolio")).map((p) => [p.rule, p.support]),
		[["NIR-01", 2]],
		"the same evidence with a valid output publishes",
	);
});

test("AC:NEX-025 AC:NI-021 while the network rubric is only a written candidate the read is reference_not_ready with no findings and no new assessment; a candidate is never a fallback, and once activated the same read publishes", async () => {
	const c = nex("NEX-025");
	const ni = caseOf("intelligence", "NI-021") as Case;
	assert.equal((c.action.arguments as { reference_status: string }).reference_status, "building");
	assert.equal(
		(ni.action.arguments as { reference_status: string }).reference_status,
		"written candidate; not fully validated/activated",
	);
	const expected = c.expected.result as Expected;
	const niExpected = ni.expected.result as { error_code: string; new_assessments: number };
	const w = await build(c);
	await c0.admin.execute(sql`UPDATE network_reference SET activation_number=NULL,activated_at=NULL`);
	const candidate = await writeNetworkReference(c0.db, {
		rubricVersion: RUBRIC_VERSION,
		contentHash: NETWORK_RUBRIC_HASH,
	});
	const counts = () =>
		c0.one<{ runs: number; assessments: number }>(sql`SELECT
		(SELECT count(*)::int FROM network_intelligence_run WHERE organization_id=${w.A.id}) AS runs,
		(SELECT count(*)::int FROM assessment_run) AS assessments`);
	const notReady = async (label: string) => {
		const before = await counts();
		const reply = await requestIntelligenceRefresh(c0.db, await w.A.admin(), { runId: randomUUID() });
		assert.deepEqual(reply, { status: "refused", refusal: { code: niExpected.error_code } }, `${label}: refused`);
		for (const level of ["region", "state", "country", "portfolio"] as const) {
			const view = await read(w.A, level);
			assert.equal(view.status, expected.status, `${label}: ${level} is not ready`);
			assert.deepEqual(await patternsAt(w.A, level), expected.findings, `${label}: ${level} has no findings`);
		}
		const after = await counts();
		assert.deepEqual(
			{ runs: after.runs - before.runs, assessments: after.assessments - before.assessments },
			{ runs: niExpected.new_assessments, assessments: 0 },
			`${label}: no new assessment`,
		);
	};
	await notReady("a building candidate");
	assert.equal(await validateNetworkReference(c0.db, candidate), "validated");
	await notReady("a validated candidate that is not activated");
	assert.equal(typeof (await activateNetworkReference(c0.db, candidate)), "number");
	const runId = await refresh(w.A);
	const view = await read(w.A, "portfolio");
	assert.deepEqual([view.status, view.run?.runId], ["ready", runId]);
	assert.deepEqual(
		(await patternsAt(w.A, "portfolio")).map((p) => [p.rule, p.support]),
		[["NIR-01", 2]],
		"after activation the same read publishes",
	);
});

test("AC:NEX-026 a worker whose claim went stale has its valid result refused as refused_stale_claim; nothing of it is published and the prior result survives", async () => {
	const c = nex("NEX-026");
	const args = c.action.arguments as unknown as Args & {
		captured_claim_generation: number;
		current_claim_generation: number;
	};
	const expected = c.expected.result as Expected & { prior_result_survives: boolean };
	const w = await build(c);
	const r0 = await refresh(w.A);
	const prior = await read(w.A, "portfolio");
	assert.equal(prior.run?.runId, r0);
	const P = w.plants.get("P")!;
	await c0.admin.execute(sql`UPDATE affiliation SET share_activity=true,revision=revision+1 WHERE plant_id=${P.id}`);
	assert.deepEqual(await scheduleIntelligenceRefresh(c0.db), [w.A.id], "a sharing change queues one refresh demand");
	const { id: pending } = await c0.one<{ id: string }>(sql`SELECT id FROM network_intelligence_run
		WHERE organization_id=${w.A.id} AND outcome='pending'`);

	const first = (await claimIntelligenceRefresh(c0.db, {}, pending))!;
	let composing!: () => void;
	const entered = new Promise<void>((resolve) => (composing = resolve));
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const running = runIntelligenceRefresh(c0.db, first, {
		compose: async (x) => {
			composing();
			await gate;
			return x;
		},
	});
	await entered;
	const { lease_until } = await c0.one<{ lease_until: string }>(
		sql`SELECT lease_until::text FROM network_intelligence_run WHERE id=${pending}`,
	);
	const later = { now: () => new Date(Date.parse(lease_until) + 1000).toISOString() as never };
	const own = c0.database.connect("runtime", { max: 1 });
	const second = (await claimIntelligenceRefresh(own, { clock: later }, pending))!;
	assert.ok(second, "the second worker takes over the lapsed claim on its own connection");
	assert.equal(
		second.generation - first.generation,
		args.current_claim_generation - args.captured_claim_generation,
		"the live claim is one generation on",
	);
	release();
	assert.equal(await running, expected.publication, "the stale worker's valid result is refused");
	const stored = await runOf(pending);
	assert.deepEqual(
		[stored.outcome, stored.claim_generation, stored.lease_owner],
		["pending", second.generation, second.owner],
		"the run stays with the live claim",
	);
	const after = await read(w.A, "portfolio");
	assert.equal(after.run?.runId, r0, "the prior result survives");
	assert.equal(expected.prior_result_survives, true);
	assert.deepEqual(after.groups, prior.groups);
	assert.ok(!JSON.stringify(after).includes(pending), "nothing of the refused result is published");
	assert.deepEqual(expected.findings, []);
	assert.deepEqual(
		after.history.map((h) => h.runId),
		[r0],
	);
});
