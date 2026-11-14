// Network Intelligence rule patterns NIR-04 (follow-up ownership), NIR-05 (genuine-acquisition momentum) and NIR-06
// (required-training coordination) beside NIR-03, as a network seat reads them (rubric cases NEX-012 to NEX-018). The
// Hill Country example: Harvest Point (Round Rock, Austin metro), Oak Cliff Church (Dallas metro), Eastside Commons
// (Austin metro) and Mueller Fellowship (Austin, does not share findings). Dates count from today in each plant's zone.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import * as S from "../organizations/support.mts";
import { RequestActor } from "../../../packages/domain/src/access/index.ts";
import {
	createOrganizationAdapter,
	geographyReference,
	installGeographyRelease,
	readReportingLocation,
	suggestRegions,
} from "../../../packages/domain/src/organizations/index.ts";
import {
	readIntelligence,
	requestIntelligenceRefresh,
	submitIntelligenceFeedback,
} from "../../../packages/domain/src/oversight/index.ts";
import {
	patternText,
	RULES,
	type IntelligenceGroup,
	type IntelligencePattern,
	type IntelligenceView,
	type Level,
} from "../../../packages/contracts/src/oversight/health.ts";

const ALL = ["people", "meetings", "tasks", "ministry_teams", "wiki", "activity", "findings"] as const;
type Category = (typeof ALL)[number];
const COLUMN: Record<Category, string> = {
	people: "share_people",
	meetings: "share_meetings",
	tasks: "share_tasks",
	ministry_teams: "share_ministry_teams",
	wiki: "share_wiki",
	activity: "share_activity",
	findings: "shared_findings",
};
const SHARING = ["people", "meetings", "tasks", "ministry_teams", "findings"] as const;
type Owner = Awaited<ReturnType<typeof S.tenant>>;
const api = createOrganizationAdapter(S.effects as never, geographyReference);
const as = async (actor: { session: string }) => RequestActor.resolve(S.runtime, actor.session as never) as never;
const today = (days: number) => sql`(clock_timestamp() AT TIME ZONE 'America/Chicago')::date + ${days}::int`;

async function link(subject: Owner, org: Owner, shared: readonly Category[]) {
	const r = await S.db.execute(
		sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,${sql.raw(ALL.map((c) => COLUMN[c]).join(","))})
		VALUES(${subject.id},${org.id},clock_timestamp(),${sql.join(
			ALL.map((c) => sql`${shared.includes(c)}`),
			sql`,`,
		)}) RETURNING id`,
	);
	return r.rows[0]!.id as string;
}
const share = (id: string, category: Category, on: boolean) =>
	S.db.execute(sql`UPDATE affiliation SET ${sql.raw(COLUMN[category])}=${on} WHERE id=${id}`);
async function plant(name: string, city: string) {
	const p = await S.tenant("plant", name);
	await S.db.execute(sql`UPDATE plant SET city=${city}, state_province='TX', country='US', street='12 Private Lane',
		timezone='America/Chicago' WHERE id=${p.id}`);
	return p;
}
/** The plant's own Owner saves its reporting Region from the offered candidates. */
async function place(p: Owner, city: string) {
	const owner = await S.identity(p, "owner");
	const a = await as(owner);
	const where = (await readReportingLocation(S.runtime, a))!;
	const [c] = (await suggestRegions(S.runtime, a, { city, stateProvince: "TX", country: "US" }))!;
	await S.write(owner, (tx) =>
		api["organizations.correctReportingLocation"](tx, owner.session, owner.selected, {
			requestKey: randomUUID(),
			expectedRevision: where.revision,
			input: {
				plant: p,
				locality: { city, stateProvince: "TX", country: "US" },
				referenceVersionId: where.referenceVersionId,
				regionItemId: c!.regionItemId,
			},
		} as never),
	);
}
async function person(
	p: Owner,
	name: string,
	o: { adult?: "adult" | "unknown"; account?: string; stage?: string } = {},
) {
	const id = randomUUID();
	await S.db.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,
		adult_classification,commitment_state,pipeline_position,state,created_at,linked_account_id)
		VALUES(${id},${p.id},${p.id},${name},${randomUUID() + "@example.test"},'other',${o.stage ?? "launch_team"},
		${o.adult ?? "unknown"},'unknown','1','live',clock_timestamp(),${o.account ?? null})`);
	return id;
}
/** An account that may own follow-ups in `p`: a seat and a linked, committed Person. */
async function ownerAccount(p: Owner, name: string) {
	const seat = await S.identity(p, "admin");
	await person(p, name, { account: seat.account });
	return seat.account;
}
type FollowUp = { due: number | null; status?: string; owner?: string };
/** A follow-up about `who`, due `due` plant-local days from today (null: undated), open unless `status` says. */
async function followUp(p: Owner, who: string, f: FollowUp) {
	const id = randomUUID();
	await S.db.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,due_date,
		person_id,completed_at) VALUES(${id},${p.id},'Call Private Person','follow_up','medium',${f.status ?? "not_started"},
		clock_timestamp(),${f.due === null ? "undated" : "date_only"},${f.due === null ? null : today(f.due)},${who},
		${f.status === "complete" ? sql`clock_timestamp()` : null})`);
	if (f.owner)
		await S.db.execute(sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${p.id},${id},${f.owner})`);
	return id;
}
/** An adult whose first commitment card was signed `days` plant-local days ago. */
async function acquired(p: Owner, name: string, days: number, adult: "adult" | "unknown" = "adult") {
	const id = await person(p, name, { adult });
	await S.db.execute(sql`INSERT INTO commitment(id,plant_id,person_id,kind,signed_on,recorded_at)
		VALUES(${randomUUID()},${p.id},${id},'launch_team',${today(-days)},clock_timestamp())`);
	return id;
}
let programs = 0;
/** `total` saved required obligations of `p`, `complete` of them complete, one program each. */
async function obligations(p: Owner, total: number, complete: number) {
	const who = await person(p, "Trainee " + total);
	const ids: string[] = [];
	for (let i = 0; i < total; i++) {
		const g = await S.db.execute(sql`INSERT INTO training_program(plant_id,name,required)
			VALUES(${p.id},${"Private Program " + ++programs},true) RETURNING id, version`);
		const { id, version } = g.rows[0] as { id: string; version: number };
		const a = await S.db.execute(sql`INSERT INTO training_assignment(plant_id,program_id,person_id,version,state,
			effective_on) VALUES(${p.id},${id},${who},${version},'active','2026-01-01') RETURNING id`);
		ids.push(a.rows[0]!.id as string);
		if (i < complete)
			await S.db.execute(sql`INSERT INTO training_credit(plant_id,person_id,program_id,kind,version,earned_on)
				VALUES(${p.id},${who},${id},'earned',${version},'2026-02-01')`);
	}
	return ids;
}

const read = async (who: { session: string }, level: Level = "portfolio", runId: string | null = null) =>
	(await readIntelligence(S.runtime, await as(who), { level, runId }))!;
const refresh = async (who: { session: string }) => {
	const runId = randomUUID();
	assert.equal((await requestIntelligenceRefresh(S.runtime, await as(who), { runId })).status, "ok");
	return runId;
};
const find = <T extends IntelligencePattern["theme"]>(g: IntelligenceGroup, theme: T) =>
	(g.patterns.find((p) => p.theme === theme) as Extract<IntelligencePattern, { theme: T }> | undefined) ?? null;
const names = (p: IntelligencePattern | null) => p?.plants.map((x) => x.name) ?? null;
const results = (g: IntelligenceGroup, rule: keyof typeof RULES) =>
	g.rows.map((r) => [r.name, r.status === "shared" ? r.results[rule] : r.status]);
/** The run's calendar date in the organization's zone, as the NIR-05 sentence says it. */
const asOfLabel = (v: IntelligenceView) =>
	new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: v.timeZone }).format(new Date(v.run!.ranAt));

let N: Owner, HP: Owner, OC: Owner, EC: Owner, MF: Owner;
let admin: Awaited<ReturnType<typeof S.identity>>, member: typeof admin, owner: typeof admin;
let hpLink: string, ocLink: string, firstRun: string;
let ocUnowned: string[] = [],
	ocOwner: string,
	hpAssignments: string[];

before(async () => {
	await installGeographyRelease(S.db);
	N = await S.tenant("sending_network", "Hill Country Network");
	HP = await plant("Harvest Point", "Round Rock");
	OC = await plant("Oak Cliff Church", "Dallas");
	EC = await plant("Eastside Commons", "Austin");
	MF = await plant("Mueller Fellowship", "Austin");
	await place(HP, "Round Rock");
	await place(OC, "Dallas");
	await place(EC, "Austin");
	await place(MF, "Austin");
	admin = await S.identity(N, "admin");
	member = await S.identity(N, "member");
	owner = await S.identity(N, "owner");
	hpLink = await link(HP, N, SHARING);
	ocLink = await link(OC, N, SHARING);
	await link(EC, N, SHARING);
	await link(MF, N, ["people", "meetings", "tasks", "ministry_teams"]);

	// Harvest Point: 2 overdue follow-ups, 1 with no owner, plus some that are never overdue.
	const hpOwner = await ownerAccount(HP, "Hank Owner");
	const hpPerson = await person(HP, "Private Visitor");
	await followUp(HP, hpPerson, { due: -3 });
	await followUp(HP, hpPerson, { due: -1, owner: hpOwner });
	await followUp(HP, hpPerson, { due: 0 });
	await followUp(HP, hpPerson, { due: -5, status: "complete" });
	await followUp(HP, hpPerson, { due: -5, status: "no_longer_needed" });
	await followUp(HP, hpPerson, { due: null });
	// Oak Cliff: 3 overdue, 2 with no owner. Eastside: one owned and not yet due. Mueller has some but does not share.
	ocOwner = await ownerAccount(OC, "Olive Owner");
	const ocPerson = await person(OC, "Private Guest");
	ocUnowned = [await followUp(OC, ocPerson, { due: -2 }), await followUp(OC, ocPerson, { due: -7 })];
	await followUp(OC, ocPerson, { due: -1, owner: ocOwner });
	const ecPerson = await person(EC, "Private Friend");
	await followUp(EC, ecPerson, { due: 3, owner: await ownerAccount(EC, "Erin Owner") });
	await followUp(MF, await person(MF, "Private Neighbor"), { due: -2 });

	// Growth: Harvest Point's newest first-time committed adult 24 days ago, Oak Cliff's 26 (one withdrew later).
	await acquired(HP, "Private Adult A", 60);
	await acquired(HP, "Private Adult B", 24);
	const withdrawn = await acquired(OC, "Private Adult C", 26);
	await S.db.execute(sql`INSERT INTO commitment_change(id,plant_id,person_id,kind,effective_on)
		VALUES(${randomUUID()},${OC.id},${withdrawn},'withdrawn',${today(-3)})`);
	await acquired(EC, "Private Adult D", 20);
	await acquired(MF, "Private Adult E", 30);

	// Required training: Harvest Point 3 saved, 1 complete; Oak Cliff 4, 2 complete; Eastside every one complete.
	hpAssignments = await obligations(HP, 3, 1);
	await obligations(OC, 4, 2);
	await obligations(EC, 2, 2);
	await obligations(MF, 2, 0);
	firstRun = await refresh(admin);
});
after(async () => {
	await S.teardown();
});

test("NIR-04, NIR-05 and NIR-06 name the two qualifying plants in the rubric's words, with its next steps", async () => {
	const view = await read(admin);
	assert.equal(view.groups.length, 1);
	const [g] = view.groups;
	assert.deepEqual(
		g!.patterns.map((p) => p.theme),
		["overdue_followup", "slowed", "required_training"],
	);

	const followUps = find(g!, "overdue_followup")!;
	assert.deepEqual(
		{ ...followUps, plants: names(followUps) },
		{
			key: "NIR-04:overdue_followup:portfolio:portfolio",
			rule: "NIR-04",
			theme: "overdue_followup",
			support: 2,
			observed: 3,
			plants: ["Harvest Point", "Oak Cliff Church"],
			rating: null,
			citation: { rubric: "everyfield-network/v1", rule: "NIR-04", source: "docs/reference/network-rubric-v1.json" },
			overdue: 5,
			unowned: { support: 2, overdue: 3 },
		},
	);
	assert.deepEqual(patternText(followUps), {
		title: "Follow-up ownership",
		lines: [
			"2 plants have 5 recorded overdue follow-up obligations in the available shared evidence.",
			"Of these, 2 plants have 3 overdue follow-up obligations with no owner.",
		],
		nextStep: RULES["NIR-04"].nextStep,
		evidence: "From 3 plants with follow-up evidence available.",
	});
	assert.match(RULES["NIR-04"].nextStep, /^Offer help reviewing existing task ownership/);

	const slowed = find(g!, "slowed")!;
	assert.deepEqual(names(slowed), ["Harvest Point", "Oak Cliff Church"]);
	assert.equal(slowed.observed, 3);
	assert.deepEqual(patternText(slowed).lines, [
		`2 plants show momentum has slowed in their available first-adult-acquisition evidence as of ${asOfLabel(view)}.`,
	]);
	assert.equal(patternText(slowed).nextStep, RULES["NIR-05"].nextStep);

	const training = find(g!, "required_training")!;
	assert.deepEqual(
		[
			training.support,
			training.observed,
			training.outstanding,
			training.applicable,
			training.complete,
			names(training),
		],
		[2, 3, 4, 7, 3, ["Harvest Point", "Oak Cliff Church"]],
	);
	assert.deepEqual(patternText(training), {
		title: "Required training",
		lines: [
			"2 plants have 4 outstanding saved required-training obligations in the available shared evidence.",
			"3 of 7 saved required obligations are complete across these plants.",
		],
		nextStep: RULES["NIR-06"].nextStep,
		evidence: "From 3 plants with required-training evidence available.",
	});

	// Every rule's pattern cites the Everyfield network rubric with its own rule id, never the plant rubric.
	assert.deepEqual(
		g!.patterns.map((p) => p.citation),
		(["NIR-04", "NIR-05", "NIR-06"] as const).map((rule) => ({
			rubric: "everyfield-network/v1",
			rule,
			source: "docs/reference/network-rubric-v1.json",
		})),
	);

	// One short result per rule and plant, in name order; Not shared carries nothing but its name and link.
	assert.deepEqual(
		g!.rows.map((r) => (r.status === "shared" ? [r.name, r.results] : [r.name, r.status])),
		[
			["Eastside Commons", { "NIR-03": "unknown", "NIR-04": "clear", "NIR-05": "clear", "NIR-06": "clear" }],
			["Harvest Point", { "NIR-03": "unknown", "NIR-04": "gap", "NIR-05": "slowed", "NIR-06": "gap" }],
			["Mueller Fellowship", "not_shared"],
			["Oak Cliff Church", { "NIR-03": "unknown", "NIR-04": "gap", "NIR-05": "slowed", "NIR-06": "gap" }],
		],
	);
	assert.deepEqual(Object.keys(g!.rows.find((r) => r.name === "Mueller Fellowship")!).sort(), [
		"name",
		"plantId",
		"status",
	]);
	// No person, person id, task title, training program or per-plant count leaves the server.
	const payload = JSON.stringify(view);
	assert.doesNotMatch(payload, /Private|Hank|Olive|Erin|Trainee|Call /);
	const people = await S.db.execute(sql`SELECT id FROM person WHERE plant_id IN (${HP.id},${OC.id},${EC.id},${MF.id})`);
	for (const { id } of people.rows) assert.doesNotMatch(payload, new RegExp(String(id)));
	assert.doesNotMatch(payload, /overdueFollowUps|growthDays|requiredTraining|"days/);
});

test("each rule, theme and group counts on its own at every level, and the metro groups show only rows", async () => {
	const counts = async (level: Level) =>
		Object.fromEntries((await read(admin, level)).groups.map((g) => [g.label, g.patterns.map((p) => p.theme)]));
	const all = ["overdue_followup", "slowed", "required_training"];
	assert.deepEqual(await counts("state"), { Texas: all });
	assert.deepEqual(await counts("country"), { "United States": all });
	assert.deepEqual(await counts("portfolio"), { "Whole portfolio": all });
	const region = await read(admin, "region");
	assert.deepEqual(
		region.groups.map((g) => [g.label, g.rows.map((r) => r.name), g.patterns.length]),
		[
			["Austin-Round Rock-San Marcos, TX (metro area)", ["Eastside Commons", "Harvest Point", "Mueller Fellowship"], 0],
			["Dallas-Fort Worth-Arlington, TX (metro area)", ["Oak Cliff Church"], 0],
		],
	);
});

test("growth themes keep their boundaries; an unclassified newer signer is Unknown; a withdrawal keeps the date", async () => {
	const net = await S.tenant("sending_network", "Boundary Network");
	const seat = await S.identity(net, "admin");
	for (const [name, days] of [
		["At 20", 20],
		["At 21", 21],
		["At 27", 27],
		["At 28", 28],
		["At 35", 35],
	] as const) {
		const p = await plant(name, "Austin");
		await link(p, net, SHARING);
		await acquired(p, "Private " + name, days);
	}
	// Old known date, but an unclassified person signed after it: the clock cannot prove a slowdown.
	const unsure = await plant("Unsure", "Austin");
	await link(unsure, net, SHARING);
	await acquired(unsure, "Private Old Adult", 40);
	await acquired(unsure, "Private Unclassified", 5, "unknown");
	// A plant that shares findings but not People: Unknown for NIR-05 whatever its dates.
	const quiet = await plant("Quiet", "Austin");
	await link(quiet, net, ["meetings", "tasks", "ministry_teams", "findings"]);
	await acquired(quiet, "Private Quiet Adult", 30);
	await refresh(seat);

	const view = await read(seat);
	const [g] = view.groups;
	assert.deepEqual(results(g!, "NIR-05"), [
		["At 20", "clear"],
		["At 21", "slowed"],
		["At 27", "slowed"],
		["At 28", "stalled"],
		["At 35", "stalled"],
		["Quiet", "unknown"],
		["Unsure", "unknown"],
	]);
	const slowed = find(g!, "slowed")!;
	const stalled = find(g!, "stalled")!;
	assert.deepEqual([names(slowed), slowed.observed], [["At 21", "At 27"], 5]);
	assert.deepEqual([names(stalled), stalled.observed], [["At 28", "At 35"], 5]);
	assert.equal(stalled.key, "NIR-05:stalled:portfolio:portfolio");
	assert.deepEqual(patternText(stalled).lines, [
		`2 plants show growth has stalled in their available first-adult-acquisition evidence as of ${asOfLabel(view)}.`,
	]);
	assert.equal(patternText(stalled).evidence, "From 5 plants with first-adult-acquisition evidence available.");
	// Oak Cliff's adult withdrew after signing 26 days ago: the signing date still counts (main network, above).
	assert.deepEqual(results((await read(admin)).groups[0]!, "NIR-05")[3], ["Oak Cliff Church", "slowed"]);
});

test("one unowned plant gives no unowned line; zero overdue is observed; a missing category is Unknown", async () => {
	// Oak Cliff's two unowned follow-ups get an owner: only Harvest Point still has an unowned one.
	for (const task of ocUnowned)
		await S.db.execute(sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${OC.id},${task},${ocOwner})`);
	const run = await refresh(admin);
	const g = (await read(admin)).groups[0]!;
	const followUps = find(g, "overdue_followup")!;
	assert.deepEqual([followUps.support, followUps.overdue, followUps.unowned], [2, 5, null]);
	assert.deepEqual(patternText(followUps).lines, [
		"2 plants have 5 recorded overdue follow-up obligations in the available shared evidence.",
	]);

	// Each category off in turn: that rule reads Unknown for Oak Cliff in this run and the earlier ones.
	for (const [category, rule, theme] of [
		["tasks", "NIR-04", "overdue_followup"],
		["meetings", "NIR-04", "overdue_followup"],
		["people", "NIR-05", "slowed"],
		["ministry_teams", "NIR-06", "required_training"],
	] as const) {
		await share(ocLink, category, false);
		for (const runId of [run, firstRun]) {
			const group = (await read(admin, "portfolio", runId)).groups[0]!;
			assert.equal(results(group, rule)[3]![1], "unknown", `${category} off: ${rule}`);
			assert.equal(find(group, theme), null, `${category} off: no ${theme}`);
			assert.equal(group.patterns.length, 2, `${category} off: the other rules stay`);
		}
		// A run taken while it is off stores nothing for that rule, so turning it back on does not bring it back.
		const off = await refresh(admin);
		await share(ocLink, category, true);
		assert.equal(results((await read(admin, "portfolio", off)).groups[0]!, rule)[3]![1], "unknown");
	}
});

test("no required training is Unknown, all complete is clear, and a later assignment change leaves the run", async () => {
	const net = await S.tenant("sending_network", "Training Network");
	const seat = await S.identity(net, "admin");
	const none = await plant("Nothing Assigned", "Austin");
	await link(none, net, SHARING);
	const done = await plant("All Complete", "Austin");
	await link(done, net, SHARING);
	await obligations(done, 2, 2);
	await link(HP, net, SHARING);
	await refresh(seat);
	const g = (await read(seat)).groups[0]!;
	assert.deepEqual(results(g, "NIR-06"), [
		["All Complete", "clear"],
		["Harvest Point", "gap"],
		["Nothing Assigned", "unknown"],
	]);
	assert.equal(find(g, "required_training"), null);

	// Harvest Point's assignment ends after the first run: that run's numbers stay as they were.
	const before = find((await read(admin, "portfolio", firstRun)).groups[0]!, "required_training");
	assert.equal(before?.applicable, 7);
	await S.db.execute(
		sql`UPDATE training_assignment SET state='removed',ended_on='2026-03-01' WHERE id=${hpAssignments[2]!}`,
	);
	assert.deepEqual(find((await read(admin, "portfolio", firstRun)).groups[0]!, "required_training"), before);
	await S.db.execute(sql`UPDATE training_assignment SET state='active',ended_on=NULL WHERE id=${hpAssignments[2]!}`);
});

test("a run from before these rules reads NIR-03 as before and Unknown for the rest, and findings off empties every run", async () => {
	// A run as T-303 stored it: preparation counts and location only.
	const old = randomUUID();
	await S.db.execute(sql`INSERT INTO network_intelligence_run(id,organization_id,rubric_version,ran_at)
		VALUES(${old},${N.id},'everyfield-network/v1',clock_timestamp()-interval '1 day')`);
	await S.db.execute(sql`INSERT INTO network_intelligence_plant(run_id,plant_id,launched,days_to_launch,unfilled_roles,
		outstanding_training,state_province,country) VALUES(${old},${HP.id},false,10,1,0,'TX','US'),
		(${old},${OC.id},false,20,0,2,'TX','US')`);
	const g = (await read(admin, "portfolio", old)).groups[0]!;
	assert.deepEqual(
		g.patterns.map((p) => p.key),
		["NIR-03:portfolio:portfolio"],
	);
	assert.deepEqual(
		g.rows.flatMap((r) => (r.status === "shared" ? [[r.name, r.results]] : [])),
		[
			["Harvest Point", { "NIR-03": "gap", "NIR-04": "unknown", "NIR-05": "unknown", "NIR-06": "unknown" }],
			["Oak Cliff Church", { "NIR-03": "gap", "NIR-04": "unknown", "NIR-05": "unknown", "NIR-06": "unknown" }],
		],
	);

	await share(hpLink, "findings", false);
	for (const runId of [old, firstRun]) {
		const view = (await read(admin, "portfolio", runId)).groups[0]!;
		assert.equal(view.rows.find((r) => r.name === "Harvest Point")!.status, "not_shared");
		assert.deepEqual(view.patterns, []);
	}
	await share(hpLink, "findings", true);
});

test("a rating sticks to its own pattern and its own seat, and a Member reads without Refresh", async () => {
	const seat = await as(admin);
	const g = (await read(admin, "portfolio", firstRun)).groups[0]!;
	const followUps = find(g, "overdue_followup")!.key;
	const slowed = find(g, "slowed")!.key;
	for (const [patternKey, rating] of [
		[followUps, "useful"],
		[slowed, "not_useful"],
	] as const)
		assert.equal(
			(await submitIntelligenceFeedback(S.runtime, seat, { runId: firstRun, patternKey, rating })).status,
			"ok",
		);
	const mine = (await read(admin, "portfolio", firstRun)).groups[0]!;
	assert.deepEqual(
		mine.patterns.map((p) => [p.theme, p.rating]),
		[
			["overdue_followup", "useful"],
			["slowed", "not_useful"],
			["required_training", null],
		],
	);
	const theirs = (await read(owner, "portfolio", firstRun)).groups[0]!;
	assert.deepEqual(
		theirs.patterns.map((p) => p.rating),
		[null, null, null],
	);
	assert.deepEqual(
		mine.patterns.map((p) => ({ ...p, rating: null })),
		theirs.patterns,
	);
	const view = await read(member, "portfolio", firstRun);
	assert.equal(view.canRefresh, false);
	assert.deepEqual(view.groups[0]!.patterns, theirs.patterns);
});
