import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { LENSES } from "../../../packages/contracts/src/intelligence/index.ts";
import { teamsWriter, trainingWriter, withTeamsWrite } from "../../../packages/domain/src/teams/index.ts";
import { referenceTeamKey } from "../../../packages/domain/src/teams/responsibilities/playbook.ts";
import { GLOBAL } from "../adapters/wiki/corpus.mts";
import { ok, refused, type Actor } from "../../support/fixture.mts";
import { caseWorld, propose, read, rowsOf, sql, type CaseWorld, type Church, type Reply } from "./case-world.mts";

let w: CaseWorld;
before(async () => {
	w = await caseWorld("familywork");
});
after(() => w?.close());

const labels = (reply: Reply, kind?: string) => rowsOf(reply, kind).map((r) => r.label);
const revision = async (table: string, id: string) =>
	(await w.one<{ r: string }>(sql.raw(`SELECT revision::text AS r FROM ${table} WHERE id='${id}'`))).r;
async function native(who: Actor, op: unknown, raw: object): Promise<Reply> {
	const authority = await w.authorityOf(who);
	return withTeamsWrite(w.db, authority, (tx, ctx) =>
		(op as (t: unknown, c: unknown, i: unknown) => Promise<never>)(tx, ctx, { requestKey: randomUUID(), ...raw }),
	);
}
const teamNamed = async (c: Church, name: string) =>
	String((await w.one(sql`SELECT id FROM team WHERE plant_id=${c.P.id} AND name=${name}`)).id);
const roleNamed = async (team: string, name: string) =>
	String((await w.one(sql`SELECT id FROM team_role WHERE team_id=${team} AND name=${name}`)).id);
const programNamed = async (c: Church, name: string) =>
	String((await w.one(sql`SELECT id FROM training_program WHERE plant_id=${c.P.id} AND name=${name}`)).id);
const tenures = (person: string) =>
	w.rows(sql`SELECT t.name AS team,r.name AS role,tn.ended_on IS NULL AS current FROM team_tenure tn
		JOIN team_role r ON r.id=tn.role_id JOIN team t ON t.id=r.team_id WHERE tn.person_id=${person} ORDER BY t.name,r.name,tn.id`);
const seats = () => w.count(sql`SELECT count(*)::int AS n FROM seat`);

async function playbookReference(templateKey: string) {
	const [release, item, token] = [randomUUID(), randomUUID(), randomUUID().replaceAll("-", "")];
	await w.admin
		.execute(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,chunker_version,embedding_profile,embedding_dimensions,tenant_id,expected_passages)
		VALUES(${release},${token},'memory',${token},'validated','0','none',1,${GLOBAL},0)`);
	await w.admin.execute(
		sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${item},'ministry_template',${referenceTeamKey(templateKey)},${GLOBAL})`,
	);
	await w.admin
		.execute(sql`INSERT INTO reference_version(id,item_id,release_id,version_number,artifact_path,content_hash,source_credit)
		VALUES(${randomUUID()},${item},${release},1,'lines',${token},'test')`);
}

async function ministries() {
	const c = await w.church();
	const L = await w.seated(c.P, "member", { user: { name: "Lena Leader" } });
	const lena = await c.person("Lena Leader");
	const jamie = await c.person("Jamie Later");
	await w.admin.execute(sql`UPDATE person SET linked_account_id=${L.id} WHERE id=${lena}`);
	for (const name of ["Worship", "Hospitality", "Kids"]) await w.apply(c.A, "teams.create", { name });
	const [worship, hospitality, kids] = [
		await teamNamed(c, "Worship"),
		await teamNamed(c, "Hospitality"),
		await teamNamed(c, "Kids"),
	];
	await w.apply(c.A, "teams.createRole", { teamId: worship, name: "Vocals", timeCommitment: "2 hours" });
	for (const name of ["Greeter", "Coffee host", "Parking"])
		await w.apply(c.A, "teams.createRole", { teamId: hospitality, name });
	const vocals = await roleNamed(worship, "Vocals");
	const [greeter, coffee, parking] = [
		await roleNamed(hospitality, "Greeter"),
		await roleNamed(hospitality, "Coffee host"),
		await roleNamed(hospitality, "Parking"),
	];
	await w.apply(c.A, "teams.assignRole", { roleId: vocals, personId: c.rivera });
	return { c, L, lena, jamie, worship, hospitality, kids, vocals, greeter, coffee, parking };
}

test("AC:EVRY-FAMILY-TEAMS additive roles, one active holder, kept history, distinct denominators, own-team leader floor and unforced templates", async () => {
	const m = await ministries();
	const { c, worship, hospitality, kids, greeter, coffee, parking } = m;
	const [alex, casey] = [c.rivera, c.casey];
	const before = { seats: await seats(), worship: await tenures(alex) };

	await w.apply(c.A, "teams.assignMember", { teamId: hospitality, roleId: coffee, personId: alex });
	assert.deepEqual(await tenures(alex), [
		{ team: "Hospitality", role: "Coffee host", current: true },
		{ team: "Worship", role: "Vocals", current: true },
	]);
	const taken = await w.ask(c.A, "Put Casey in Coffee host", [
		() => propose("teams.assignRole", { roleId: coffee, personId: casey }),
	]);
	assert.match(String(taken.proposals[0]!.review.refusal), /already fills this role/);
	await assert.rejects(w.approve(c.A, taken.proposals[0]!), { code: "review_closed" });
	assert.deepEqual(await tenures(casey), [], "a filled role keeps its one holder");
	await w.apply(c.A, "teams.editRole", { roleId: greeter, desiredSkills: "warmth" });
	assert.deepEqual(await w.one(sql`SELECT name,desired_skills FROM team_role WHERE id=${greeter}`), {
		name: "Greeter",
		desired_skills: "warmth",
	});

	const summary = await w.look(c.A, "teams.staffingSummary");
	assert.deepEqual(summary.facts, { roles: 4, filledRoles: 2, openRoles: 2, peopleServing: 1 });
	assert.deepEqual(
		rowsOf(summary)
			.map((r) => [r.label, r.fields.roles, r.fields.filledRoles, r.fields.openRoles, r.fields.people])
			.sort(),
		[
			["Hospitality", 3, 1, 2, 1],
			["Kids", 0, 0, 0, 0],
			["Worship", 1, 1, 0, 1],
		],
	);
	assert.deepEqual(
		rowsOf(await w.look(c.A, "teams.personTeamCounts", { minTeams: 2 })).map((r) => r.id),
		[alex],
	);
	assert.deepEqual(rowsOf(await w.look(c.A, "teams.personAssignments", { personId: alex })).length, 2);
	assert.deepEqual(rowsOf(await w.look(c.A, "teams.searchMembers", { teamId: hospitality })).length, 1);
	const roles = await w.look(c.A, "teams.listRoles", { teamId: hospitality });
	assert.deepEqual(
		rowsOf(roles)
			.map((r) => [r.label, r.fields.open])
			.sort(),
		[
			["Coffee host", false],
			["Greeter", true],
			["Parking", true],
		],
	);
	const roster = await w.look(c.A, "teams.get", { teamId: hospitality });
	assert.deepEqual(
		rowsOf(roster, "person").map((r) => r.id),
		[alex],
	);
	assert.doesNotMatch(JSON.stringify([roles, roster]), /background|certif|clearance/i);

	for (const name of ["Q", "Z"])
		await w.apply(c.A, "teams.createProgram", {
			name: `Program ${name}`,
			required: true,
			teamId: name === "Q" ? worship : kids,
		});
	const [Q, Z] = [await programNamed(c, "Program Q"), await programNamed(c, "Program Z")];
	const listed = [alex, casey];
	const preview = await w.look(c.A, "teams.previewRequiredTrainingParticipants", { programId: Q, personIds: listed });
	assert.deepEqual(
		rowsOf(preview, "person")
			.map((r) => r.id)
			.sort(),
		[...listed].sort(),
	);
	const required = () =>
		w.rows(sql`SELECT person_id,state,version FROM training_assignment WHERE program_id=${Q} ORDER BY person_id`);
	assert.deepEqual(await required(), [], "a preview saves nothing");
	await w.apply(c.A, "teams.setRequiredTrainingParticipants", { programId: Q, personIds: listed });
	const saved = await required();
	assert.deepEqual(
		saved.map((r) => [r.person_id, r.state]),
		[...listed].sort().map((id) => [id, "active"]),
	);
	await w.apply(c.A, "teams.attestCompletion", { personId: alex, programId: Q, earnedOn: "2026-10-10" });
	const credits = () =>
		w.rows(
			sql`SELECT person_id,kind,version,earned_on::text AS on FROM training_credit WHERE program_id=${Q} ORDER BY recorded_at,id`,
		);
	const earned = await credits();
	assert.deepEqual(
		earned.map((r) => [r.person_id, r.kind, r.on]),
		[[alex, "earned", "2026-10-10"]],
	);
	await w.apply(c.A, "teams.assignRole", { roleId: greeter, personId: m.jamie });
	assert.deepEqual(await required(), saved, "a later joiner is not added to the saved list");
	const complete = await w.look(c.A, "teams.readRequiredTrainingParticipants", { programId: Q });
	assert.deepEqual(complete.facts, { complete: 1, of: 2 });
	const percent = async (teamId: string) =>
		rowsOf(await w.look(c.A, "teams.health", { teamId }))[0].fields.trainingPercent;
	assert.deepEqual([await percent(worship), await percent(kids)], [50, null], "rate 50; no applicability is not zero");
	const matrix = await w.look(c.A, "teams.trainingMatrix");
	assert.deepEqual(
		rowsOf(matrix, "training")
			.map((r) => [r.id, r.fields.complete, r.fields.of])
			.sort(),
		[
			[Q, 1, 2],
			[Z, 0, 0],
		].sort(),
	);
	assert.deepEqual(labels(await w.look(c.A, "teams.listTraining")).sort(), ["Program Q", "Program Z"]);
	const church = await w.look(c.A, "teams.aggregateHealth");
	assert.ok(rowsOf(church).every((r) => r.fields.composite === "Unknown"));
	assert.equal(church.facts.composite, "Unknown");
	const facts = await w.look(c.A, "teams.staffingFacts", { teamId: hospitality });
	const raw = rowsOf(facts)[0].fields;
	assert.deepEqual([raw.filledRoles, raw.openRoles, raw.people, raw.trainingPercent], [2, 1, 2, null]);
	const person = await w.look(c.A, "teams.personTraining", { personId: alex });
	assert.match(JSON.stringify(person), /Hospitality/);

	await w.apply(c.A, "teams.revokeCompletion", { personId: alex, programId: Q });
	assert.deepEqual((await w.look(c.A, "teams.readRequiredTrainingParticipants", { programId: Q })).facts, {
		complete: 0,
		of: 2,
	});
	await w.apply(c.A, "teams.recompleteTraining", { personId: alex, programId: Q, earnedOn: "2026-10-12" });
	const after = await credits();
	assert.deepEqual(after.slice(0, 1), earned, "the earlier completion stays as recorded");
	assert.deepEqual(
		after.map((r) => r.kind),
		["earned", "revoked", "earned"],
	);
	assert.equal(rowsOf(await w.look(c.A, "teams.trainingHistory", { personId: alex })).length, 3);
	await w.apply(c.A, "teams.correctProgram", { programId: Q, name: "Program Q1", required: false, reason: "Renamed" });
	assert.deepEqual(await w.one(sql`SELECT name,required FROM training_program WHERE id=${Q}`), {
		name: "Program Q1",
		required: false,
	});
	assert.deepEqual([await credits(), await required()], [after, saved], "correcting the program rewrites no history");

	await w.apply(c.A, "teams.appointLeader", { teamId: hospitality, personId: m.lena });
	const leader = async () =>
		(await w.one(sql`SELECT leader_person_id FROM team WHERE id=${hospitality}`)).leader_person_id;
	assert.deepEqual([await leader(), await seats()], [m.lena, before.seats], "a title grants no seat");
	assert.deepEqual(labels(await w.look(c.A, "teams.leaderCandidates", { q: "Lena" })), ["Lena Leader"]);
	for (const [operation, input] of [
		["teams.edit", { teamId: hospitality, name: "Mine" }],
		["teams.assignRole", { roleId: parking, personId: casey }],
		["teams.archive", { teamId: worship }],
	] as const) {
		const asked = await w.quiet(() => w.ask(m.L, "As leader, change it", [() => propose(operation, input)]));
		assert.deepEqual([asked.replies[0].error, asked.proposals], ["not_offered", []], operation);
	}
	await w.apply(c.A, "teams.createProgram", { name: "Host training", required: true, teamId: hospitality });
	const host = await programNamed(c, "Host training");
	await w.apply(c.A, "teams.setRequiredTrainingParticipants", { programId: host, personIds: [alex] });
	const attest = async (programId: string) =>
		native(m.L, trainingWriter.attestCompletion, {
			expectedRevision: await revision("training_program", programId),
			input: { kind: "program", personId: alex, programId, earnedOn: "2026-10-12" },
		});
	ok(await attest(host));
	refused(await attest(Z), "access_denied");
	await w.apply(c.A, "teams.createRole", { teamId: worship, name: "Keys" });
	const keys = await roleNamed(worship, "Keys");
	const place = async (roleId: string, teamId: string) =>
		native(m.L, teamsWriter.assignRole, {
			expectedRevision: await revision("team_role", roleId),
			input: { roleId, teamId, personId: casey },
		});
	ok(await place(parking, hospitality));
	refused(await place(keys, worship), "access_denied");
	assert.deepEqual(await tenures(casey), [{ team: "Hospitality", role: "Parking", current: true }]);

	await w.apply(c.A, "teams.addResponsibility", { teamId: hospitality, text: "Order coffee" });
	const duty = () =>
		w.rows(
			sql`SELECT id,text,completed_on::text AS done,removed_at IS NULL AS live FROM responsibility WHERE team_id=${hospitality}`,
		);
	const [line] = await duty();
	await w.apply(c.A, "teams.editResponsibility", { responsibilityId: line!.id, text: "Order tea" });
	await w.apply(c.A, "teams.completeResponsibility", { responsibilityId: line!.id, done: true });
	assert.deepEqual(await duty(), [{ id: line!.id, text: "Order tea", done: "2026-10-13", live: true }]);
	const duties = await w.look(c.A, "teams.listResponsibilities", { teamId: hospitality });
	assert.deepEqual(
		rowsOf(duties).map((r) => [r.label, r.fields]),
		[["Order tea", { done: true, doneOn: "2026-10-13" }]],
	);
	await w.apply(c.A, "teams.deleteResponsibility", { responsibilityId: line!.id });
	assert.equal((await duty())[0]!.live, false);

	const current = () =>
		w.count(sql`SELECT count(*)::int AS n FROM team_tenure WHERE plant_id=${c.P.id} AND ended_on IS NULL`);
	await w.apply(c.A, "teams.removeRole", { roleId: coffee, personId: alex });
	assert.deepEqual(await tenures(alex), [
		{ team: "Hospitality", role: "Coffee host", current: false },
		{ team: "Worship", role: "Vocals", current: true },
	]);
	await w.apply(c.A, "teams.reactivateMembership", { roleId: coffee, personId: alex });
	assert.deepEqual((await tenures(alex)).map((t) => [t.role, t.current]).sort(), [
		["Coffee host", false],
		["Coffee host", true],
		["Vocals", true],
	]);
	await w.apply(c.A, "teams.endMembership", { teamId: hospitality, personId: alex });
	assert.deepEqual(
		(await tenures(alex)).filter((t) => t.current),
		before.worship,
		"Worship is untouched",
	);
	const past = await w.look(c.A, "teams.membershipHistory", { teamId: hospitality });
	assert.equal(rowsOf(past).filter((r) => r.label.includes("Alex Rivera")).length, 2);
	await w.apply(c.A, "teams.retireRole", { roleId: parking });
	assert.equal((await w.one(sql`SELECT retired_at IS NULL AS live FROM team_role WHERE id=${parking}`)).live, false);
	const held = await current();
	await w.apply(c.A, "teams.archive", { teamId: kids });
	assert.equal(labels(await w.look(c.A, "teams.list")).includes("Kids"), false);
	assert.ok(labels(await w.look(c.A, "teams.list", { includeArchived: true })).includes("Kids"));
	assert.equal(
		rowsOf(await w.look(c.A, "teams.staffingSummary")).some((r) => r.label === "Kids"),
		false,
	);
	await w.apply(c.A, "teams.restore", { teamId: kids });
	assert.ok(labels(await w.look(c.A, "teams.list")).includes("Kids"));
	assert.equal(await current(), held);
	await w.apply(c.A, "teams.edit", { teamId: worship, description: "Sunday worship, our own words" });
	assert.ok(rowsOf(await w.look(c.A, "teams.history", { teamId: worship })).length > 0);
	await w.apply(c.A, "teams.scheduleMeeting", {
		teamId: worship,
		date: "2026-10-20",
		time: "18:30",
		subtype: "training",
	});
	assert.deepEqual(
		await w.rows(sql`SELECT type,subtype,local_date::text AS d,team_id FROM meeting WHERE plant_id=${c.P.id}`),
		[{ type: "team_meeting", subtype: "training", d: "2026-10-20", team_id: worship }],
	);
	assert.equal(rowsOf(await w.look(c.A, "teams.listMeetings", { teamId: worship, window: "upcoming" })).length, 1);
	const chart = await w.look(c.A, "teams.orgChart");
	assert.deepEqual(
		labels(chart, "team").sort(),
		["Hospitality", "Kids", "Worship"],
		"no invented hierarchy or forced teams",
	);
	const exported = await w.look(c.A, "teams.exportOrgChart");
	assert.match(JSON.stringify(exported), /\.pdf|org-chart|teams/i);

	await playbookReference("small_groups");
	const offered = await w.look(c.A, "teams.listImportTemplates");
	assert.equal(offered.total, 10);
	const chosen = [{ teamKey: "small_groups", roleKeys: ["small_groups_lead"] }];
	const plan = await w.look(c.A, "teams.previewTemplateImport", { selections: chosen });
	assert.deepEqual(
		rowsOf(plan).map((r) => [r.id, r.fields.alreadyHere, r.fields.newRoles]),
		[["small_groups", false, "Small groups lead"]],
	);
	assert.deepEqual(
		labels(await w.look(c.A, "teams.list")).sort(),
		["Hospitality", "Kids", "Worship"],
		"a preview makes none",
	);
	await w.apply(c.A, "teams.initialize", { selections: chosen });
	const groups = await teamNamed(c, "Small groups");
	assert.deepEqual(labels(await w.look(c.A, "teams.list")).sort(), ["Hospitality", "Kids", "Small groups", "Worship"]);
	assert.deepEqual(await w.rows(sql`SELECT name,template_key FROM team_role WHERE team_id=${groups}`), [
		{ name: "Small groups lead", template_key: "small_groups_lead" },
	]);
	assert.equal(LENSES.length, 8, "eight rubric areas, whatever teams the church keeps");
	await w.apply(c.A, "teams.editRole", { roleId: await roleNamed(groups, "Small groups lead"), name: "Groups coach" });
	const edited = () =>
		w.rows(sql`SELECT t.name,t.description,t.state,r.name AS role,r.time_commitment FROM team t LEFT JOIN team_role r ON r.team_id=t.id
			WHERE t.id IN(${worship},${groups}) AND r.name<>'Worship lead' ORDER BY t.name,r.name`);
	const ours = await edited();
	assert.ok(ours.some((r) => r.description === "Sunday worship, our own words"));
	await w.apply(c.A, "teams.importRoles", { teamId: worship, teamKey: "worship", roleKeys: ["worship_lead"] });
	const twice = await w.ask(c.A, "Import it again", [() => propose("teams.initialize", { selections: chosen })]);
	for (const card of twice.proposals) if (!card.review.refusal) await w.approve(c.A, card);
	assert.deepEqual(await edited(), ours, "a template never overwrites the church's own words");
	assert.equal(
		(await w.one(sql`SELECT count(*)::int AS n FROM team_role WHERE team_id=${worship} AND name='Worship lead'`)).n,
		1,
	);
	const suggested = await w.look(c.A, "teams.previewResponsibilities", { teamId: groups });
	assert.deepEqual([labels(suggested).length, suggested.facts.offer], [5, "not decided"]);
	await w.apply(c.A, "teams.offerResponsibilities", { teamId: groups, decision: "accept", selected: ["Curriculum"] });
	assert.deepEqual(labels(await w.look(c.A, "teams.listResponsibilities", { teamId: groups })), ["Curriculum"]);
	assert.equal(
		await w.count(
			sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='responsibility' AND column_name ~ 'assign|person|account'`,
		),
		0,
		"a responsibility names nobody",
	);
	assert.equal(await seats(), before.seats);

	const stale = await w.prepare(c.A, "teams.assignRole", { roleId: coffee, personId: casey });
	await w.apply(c.A, "teams.editRole", { roleId: coffee, name: "Coffee lead" });
	const was = await tenures(casey);
	assert.equal((await w.approve(c.A, stale)).review.outcome, "refused");
	assert.deepEqual(await tenures(casey), was, "a stale review applies nothing");

	const said = "Change our ministries and training";
	const card = await w.prepare(c.A, "teams.assignRole", { roleId: coffee, personId: casey });
	await c.foreignReview(card);
	await c.foreign(
		said,
		[
			() => [read("teams.get", { teamId: worship }), read("teams.listRoles", { teamId: hospitality })],
			() => [
				read("teams.readRequiredTrainingParticipants", { programId: Q }),
				read("teams.membershipHistory", { teamId: hospitality }),
			],
			() => propose("teams.assignRole", { roleId: coffee, personId: casey }),
		],
		{ secrets: ["Hospitality", "Coffee", "Program Q", "Lena Leader"], on: { onError: "go_on" } },
	);
	await c.failedWrite(card, "team_tenure");
	assert.equal((await tenures(casey)).filter((t) => t.current && t.role === "Coffee lead").length, 1);
});

async function task(
	plant: string,
	title: string,
	fields: {
		due?: string;
		status?: string;
		owners?: string[];
		priority?: string;
		person?: string;
		category?: string;
	} = {},
) {
	const id = randomUUID();
	await w.admin
		.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,due_date,completed_at,person_id)
		VALUES(${id},${plant},${title},${fields.category ?? "general"},${fields.priority ?? "medium"},${fields.status ?? "not_started"},clock_timestamp(),
			${fields.due ? "date_only" : "undated"},${fields.due ?? null}::date,
			${fields.status === "complete" ? sql`clock_timestamp()` : sql`NULL`},${fields.person ?? null})`);
	for (const account of fields.owners ?? [])
		await w.admin.execute(
			sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${plant},${id},${account})`,
		);
	return id;
}
const taskRow = (id: string) =>
	w.one(sql`SELECT status,due_date::text AS due,title,deleted_at IS NOT NULL AS deleted,prerequisite_ids AS waits,
		(SELECT coalesce(array_agg(a.account_id),'{}') FROM task_assignee a WHERE a.task_id=task.id) AS owners FROM task WHERE id=${id}`);

test("AC:EVRY-FAMILY-TASKS exact cohorts and owners, contact credit only for a conversation, stable successors and obligations, real child tasks and chosen template tasks", async () => {
	const c = await w.church();
	const jordan = await w.seated(c.P, "member", { user: { name: "Jordan Member" } });
	const B = await w.seated(c.P, "admin", { user: { name: "Beth Admin" } });
	const mine = [c.A.id];
	const today = "2026-10-13";
	const due = await task(c.P.id, "due_today", { due: today, owners: mine, priority: "high" });
	const overdue = await task(c.P.id, "overdue", { due: "2026-10-12", owners: mine });
	const tomorrow = await task(c.P.id, "tomorrow", { due: "2026-10-14", owners: mine });
	const complete = await task(c.P.id, "complete", { due: today, owners: mine, status: "complete" });
	const undated = await task(c.P.id, "undated", { owners: mine });
	const theirs = await task(c.P.id, "other_assignee", { due: today, owners: [jordan.id] });

	const said = "Work through today's tasks and follow-ups";
	const cohort = async (input: object) =>
		rowsOf(await w.look(c.A, "tasks.list", input)).map((r) => [r.label, r.fields.due]);
	assert.deepEqual(
		(await cohort({ mine: true, due: "today", followUps: "exclude" })).filter(([, day]) => day === today),
		[["due_today", today]],
		"today is exactly the one task due today",
	);
	assert.deepEqual(await cohort({ mine: true, due: "overdue" }), [["overdue", "2026-10-12"]]);
	const first = await w.ask(c.A, "Show my tasks today", [() => read("tasks.list", { mine: true, due: "today" })]);
	const then = await w.ask(c.A, "And the undated ones?", [() => read("tasks.list", { mine: true, due: "undated" })], {
		conversation: first.conversation,
	});
	assert.deepEqual(labels(then.replies[0]), ["undated"]);
	assert.ok(
		[...rowsOf(first.replies[0]), ...rowsOf(then.replies[0])].every((r) => r.fields.yours),
		"the same account",
	);
	const counted = await w.look(c.A, "tasks.count", { mine: true });
	assert.deepEqual(
		rowsOf(counted).map((r) => [r.label, r.fields.count]),
		[
			["complete", 1],
			["not_started", 4],
			["checklist rows", 0],
		],
	);
	for (const operation of ["tasks.complete", "tasks.bulkComplete"]) {
		const asked = await w.quiet(() =>
			w.ask(jordan, "Complete it", [
				() => propose(operation, operation === "tasks.complete" ? { taskId: due } : { taskIds: [due] }),
			]),
		);
		assert.deepEqual([asked.replies[0].error, asked.proposals], ["not_assigned", []]);
	}
	await w.apply(jordan, "tasks.complete", { taskId: theirs });
	assert.equal((await taskRow(theirs)).status, "complete");

	await w.apply(c.A, "tasks.create", { title: "Print cards", due: "2026-10-20", priority: "low", assigneeIds: ["me"] });
	const made = String((await w.one(sql`SELECT id FROM task WHERE plant_id=${c.P.id} AND title='Print cards'`)).id);
	await w.apply(c.A, "tasks.edit", { taskId: made, patch: { title: "Print the cards", assigneeIds: [jordan.id] } });
	assert.deepEqual(await taskRow(made), {
		status: "not_started",
		due: "2026-10-20",
		title: "Print the cards",
		deleted: false,
		waits: [],
		owners: [jordan.id],
	});
	await w.apply(c.A, "tasks.changeStatus", { taskId: made, status: "in_progress" });
	await w.apply(c.A, "tasks.waive", { taskId: made, reason: "Not needed" });
	assert.equal((await taskRow(made)).status, "no_longer_needed");
	await w.apply(c.A, "tasks.reopen", { taskId: made });
	const history = rowsOf(await w.look(c.A, "tasks.statusHistory", { taskId: made }));
	assert.ok(history.length >= 4, "every status stays in the history");
	await w.apply(c.A, "tasks.bulkReschedule", { taskIds: [made, undated], due: "2026-10-22" });
	assert.deepEqual([(await taskRow(made)).due, (await taskRow(undated)).due], ["2026-10-22", "2026-10-22"]);
	await w.apply(c.A, "tasks.delete", { taskId: made });
	assert.equal((await taskRow(made)).deleted, true);
	assert.equal(
		rowsOf(await w.look(c.A, "tasks.eligibleAssignees")).some((r) => r.id === jordan.id),
		true,
	);
	assert.deepEqual(labels(await w.look(c.A, "tasks.relationOptions", { kind: "person", search: "Casey" })), [
		"Casey Reed",
	]);

	await w.apply(c.A, "tasks.replacePrerequisites", { taskId: due, prerequisiteIds: [tomorrow] });
	assert.deepEqual(labels(await w.look(c.A, "tasks.listPrerequisites", { taskId: due })), ["tomorrow"]);
	assert.equal(
		labels(await w.look(c.A, "tasks.prerequisiteCandidates", { taskId: tomorrow })).includes("due_today"),
		false,
		"a task that waits on it is no candidate",
	);
	const cycle = await w.ask(c.A, "Make it wait back", [
		() => propose("tasks.replacePrerequisites", { taskId: tomorrow, prerequisiteIds: [due] }),
	]);
	assert.deepEqual([cycle.replies[0].error, cycle.proposals], ["dependency_cycle", []]);
	assert.deepEqual((await taskRow(tomorrow)).waits, []);

	await w.apply(c.A, "tasks.createSubtask", { parentId: due, add: ["Chairs", "Sound"] });
	const children = () =>
		w.rows(sql`SELECT t.id,t.title,t.status,(SELECT count(*)::int FROM task_assignee a WHERE a.task_id=t.id) AS owners
			FROM task t WHERE t.parent_id=${due} AND t.deleted_at IS NULL ORDER BY t.title`);
	const [chairs, sound] = await children();
	await w.apply(c.A, "tasks.edit", { taskId: String(sound!.id), patch: { assigneeIds: [] } });
	assert.deepEqual(
		(await children()).map((k) => k.owners),
		[1, 0],
		"a child's owner is optional and its own",
	);
	await w.apply(c.A, "tasks.setSubtaskCompletion", {
		parentId: due,
		tick: [chairs, sound].map((k) => ({ taskId: k!.id, complete: true })),
	});
	assert.deepEqual(
		(await children()).map((k) => k.status),
		["complete", "complete"],
	);
	assert.equal((await taskRow(due)).status, "not_started", "every child ticked completes no parent");
	assert.equal(
		rowsOf(await w.look(c.A, "tasks.statusHistory", { taskId: chairs!.id })).length > 0,
		true,
		"a child has its own history",
	);
	const list = await w.look(c.A, "tasks.listSubtasks", { parentId: due });
	assert.deepEqual(labels(list).sort(), ["Chairs", "Sound"]);
	const opened = await w.look(c.A, "tasks.get", { taskId: due });
	assert.ok(rowsOf(opened).some((r) => r.id === chairs!.id && r.fields.status === "complete"));

	await w.apply(c.A, "tasks.configureRecurrence", { taskId: due, rule: { frequency: "weekly" } });
	const series = () =>
		w.rows(sql`SELECT t.id,t.due_date::text AS due,t.status FROM task t WHERE t.parent_id IS NULL AND t.deleted_at IS NULL
			AND t.series_id=(SELECT series_id FROM task WHERE id=${due}) ORDER BY t.due_date`);
	await w.apply(c.A, "tasks.completeOccurrence", { taskId: due });
	const grown = await series();
	assert.deepEqual(
		grown.map((t) => [t.due, t.status]),
		[
			["2026-10-13", "complete"],
			["2026-10-20", "not_started"],
		],
	);
	const S = String(grown[1]!.id);
	assert.deepEqual(labels(await w.look(c.A, "tasks.findOpenOccurrence", { taskId: due })), ["due_today"]);
	assert.equal(rowsOf(await w.look(c.A, "tasks.findOpenOccurrence", { taskId: due }))[0].id, S);
	const fresh = await w.rows(
		sql`SELECT title,status FROM task WHERE parent_id=${S} AND deleted_at IS NULL ORDER BY title`,
	);
	assert.deepEqual(fresh, [
		{ title: "Chairs", status: "not_started" },
		{ title: "Sound", status: "not_started" },
	]);
	const again = await w.ask(c.A, "Complete it again", [() => propose("tasks.completeOccurrence", { taskId: due })]);
	for (const card of again.proposals) if (!card.review.refusal) await w.approve(c.A, card);
	assert.deepEqual(await series(), grown, "completing twice makes no second successor");
	await w.apply(c.A, "tasks.removeSubtask", {
		parentId: S,
		remove: [String((await w.one(sql`SELECT id FROM task WHERE parent_id=${S} AND title='Sound'`)).id)],
	});
	assert.deepEqual((await children()).length, 2, "the finished occurrence keeps its own rows");
	await w.apply(c.A, "tasks.bulkComplete", { taskIds: [overdue, tomorrow] });
	assert.deepEqual([(await taskRow(overdue)).status, (await taskRow(tomorrow)).status], ["complete", "complete"]);

	for (const [account, name] of [
		[c.A, "Alex Admin"],
		[B, "Beth Admin"],
	] as const) {
		const id = await c.person(name, { stage: "leader" });
		await w.admin.execute(sql`UPDATE person SET linked_account_id=${account.id} WHERE id=${id}`);
	}
	const jamie = await c.person("Jamie First");
	const refusedOwner = await w.ask(c.A, "Give it to Jordan", [
		() => propose("tasks.createFollowUp", { personId: c.casey, assigneeIds: [jordan.id] }),
	]);
	assert.deepEqual([refusedOwner.replies[0].error, refusedOwner.proposals], ["owner_ineligible", []]);
	await w.apply(c.A, "tasks.createFollowUp", { personId: c.casey, due: today, assigneeIds: [B.id] });
	await w.apply(c.A, "tasks.createFollowUp", { personId: c.rivera, due: today, assigneeIds: ["me"] });
	const follow = async (person: string) =>
		String(
			(await w.one(sql`SELECT id FROM task WHERE person_id=${person} AND category='follow_up' AND deleted_at IS NULL`))
				.id,
		);
	const [caseyTask, alexTask] = [await follow(c.casey), await follow(c.rivera)];
	const bystander = await taskRow(alexTask);
	const planned = await w.look(c.A, "tasks.planHandoff", { fromAccountId: B.id });
	assert.match(JSON.stringify(planned), /Casey Reed/);
	assert.doesNotMatch(JSON.stringify(planned.rows), /Alex Rivera/);
	await w.apply(c.A, "tasks.executeHandoff", { fromAccountId: B.id, toAccountId: c.A.id });
	assert.deepEqual([(await taskRow(caseyTask)).owners, await taskRow(alexTask)], [[c.A.id], bystander]);
	await w.apply(c.A, "tasks.assignFollowUp", { items: [{ taskId: caseyTask, assigneeIds: [] }] });
	const unowned = await w.look(c.A, "tasks.listFollowUpOwners", { owner: "needs_owner" });
	assert.deepEqual(labels(unowned), ["Casey Reed"], "unassigned work is told as such");
	const coverage = await w.look(c.A, "tasks.followUpCoverage", { personId: c.rivera });
	assert.deepEqual(
		rowsOf(coverage).map((r) => r.fields.coverage),
		["owned"],
	);

	const contacted = async (person: string) =>
		rowsOf(await w.look(c.A, "followups.listContactHistory", { personId: person })).map((r) => [
			r.fields.outcome,
			r.fields.conversationHappened,
		]);
	const credit = async (person: string) =>
		(
			await w.one(
				sql`SELECT count(*) FILTER (WHERE outcome='contacted' AND voided_at IS NULL)::int AS n FROM contact_outcome WHERE person_id=${person}`,
			)
		).n;
	for (const outcome of ["attempted_no_contact", "administrative_completion"])
		await w.apply(c.A, "followups.recordOutcome", { taskId: alexTask, outcome, occurred: "now", completeTask: false });
	await w.apply(c.A, "followups.recordOutcome", {
		taskId: caseyTask,
		outcome: "no_longer_needed",
		occurred: "now",
		completeTask: false,
	});
	assert.deepEqual(
		(await contacted(c.rivera)).map((r) => r[1]),
		[false, false],
	);
	assert.deepEqual(
		[await credit(c.rivera), await credit(c.casey)],
		[0, 0],
		"an attempt, an administrative close and a waiver earn nothing",
	);
	const freshness = async () =>
		JSON.stringify(rowsOf(await w.look(c.A, "tasks.followUpCoverage", { personId: c.rivera })));
	const staleAs = await freshness();
	await w.apply(c.A, "followups.recordOutcome", {
		taskId: alexTask,
		outcome: "contacted",
		occurred: "now",
		channel: "phone",
		completeTask: true,
	});
	assert.equal(await credit(c.rivera), 1);
	assert.notEqual(await freshness(), staleAs);
	const entry = String(
		(await w.one(sql`SELECT id FROM contact_outcome WHERE person_id=${c.rivera} AND outcome='contacted'`)).id,
	);
	await w.apply(c.A, "followups.correctOutcome", {
		outcomeId: entry,
		correction: { kind: "replace", outcome: "attempted_no_contact" },
		reason: "It was voicemail",
	});
	assert.equal(await credit(c.rivera), 0);
	assert.equal(
		await w.count(sql`SELECT count(*)::int AS n FROM contact_outcome WHERE person_id=${c.rivera}`),
		4,
		"the first entry stays",
	);

	await w.apply(c.A, "meetings.schedule", {
		type: "vision_meeting",
		date: "2026-10-10",
		time: "10:00",
		guestIds: [jamie],
	});
	const V = String((await w.one(sql`SELECT id FROM meeting WHERE plant_id=${c.P.id}`)).id);
	await w.apply(c.A, "meetings.finalizeAttendance", { meetingId: V, attendeeIds: [jamie] });
	const obligations = () =>
		w.rows(sql`SELECT b.id,b.kind,b.person_id,t.id AS task,t.status FROM obligation b LEFT JOIN task t ON t.obligation_id=b.id AND t.deleted_at IS NULL
			WHERE b.plant_id=${c.P.id} ORDER BY b.kind`);
	const O = await obligations();
	const followed = O.find((o) => o.kind === "follow_up")!;
	assert.deepEqual([followed.person_id, O.filter((o) => o.kind === "follow_up").length], [jamie, 1]);
	await w.apply(c.A, "meetings.reconcileAttendance", {
		meetingId: V,
		attendeeIds: [jamie, c.chen],
		reason: "Missed Chen",
	});
	const kept = (await obligations()).find((o) => o.person_id === jamie)!;
	assert.deepEqual([kept.id, kept.task], [followed.id, followed.task], "one stable obligation and task");
	const owed = await w.look(c.A, "followups.readObligations", { personId: jamie });
	assert.equal(rowsOf(owed).length, 1);
	await w.apply(c.A, "followups.recordOutcome", {
		taskId: followed.task,
		outcome: "contacted",
		occurred: "now",
		completeTask: true,
	});
	assert.equal((await obligations()).find((o) => o.person_id === jamie)!.status, "complete");
	await w.apply(c.A, "tasks.reopenObligation", { obligationId: followed.id });
	assert.equal((await obligations()).find((o) => o.person_id === jamie)!.status, "not_started");
	assert.ok(rowsOf(await w.look(c.A, "tasks.statusHistory", { taskId: followed.task })).length >= 3);

	const templates = await w.look(c.A, "tasks.listTemplates");
	const K = "discernment-and-preparation";
	assert.ok(rowsOf(templates).some((r) => r.id === K));
	const previewed = rowsOf(await w.look(c.A, "tasks.previewTemplate", { checklistKey: K })).slice(1, 4);
	const keyOf = (r: Reply) => String(r.id).split("/")[1]!;
	const [offer1, offer2, offer3] = previewed;
	await w.apply(c.A, "tasks.importTemplate", { checklistKey: K, itemKeys: [keyOf(offer1), keyOf(offer2)] });
	const copied = () =>
		w.rows<{ title: string }>(
			sql`SELECT title FROM task WHERE plant_id=${c.P.id} AND title IN(${offer1.label},${offer2.label},${offer3.label}) ORDER BY title`,
		);
	assert.deepEqual(
		(await copied()).map((t) => t.title),
		[offer1.label, offer2.label].sort(),
		"the third is not made",
	);
	const edited = String((await w.one(sql`SELECT id FROM task WHERE plant_id=${c.P.id} AND title=${offer1.label}`)).id);
	await w.apply(c.A, "tasks.edit", { taskId: edited, patch: { title: "Our own words" } });
	assert.ok(rowsOf(await w.look(c.A, "tasks.importReceipt")).length > 0);
	const criteria = async () =>
		rowsOf(await w.look(c.A, "phases.readReadiness"), "criterion").map((r) => [r.label, r.fields.status]);
	const unmet = await criteria();
	await w.apply(c.A, "tasks.importTemplate", { checklistKey: K, itemKeys: [keyOf(offer2)] });
	assert.equal((await taskRow(edited)).title, "Our own words", "importing again overwrites no edit");
	assert.deepEqual(await criteria(), unmet, "a template completes no criterion");

	const open = async () => rowsOf(await w.look(c.A, "tasks.readPhaseOffer")).map((r) => r.id);
	const taskCount = () => w.count(sql`SELECT count(*)::int AS n FROM task WHERE plant_id=${c.P.id}`);
	await w.apply(c.A, "phases.transition", { toPhase: 2, reason: "Ready" });
	assert.equal((await open()).length, 3);
	const n0 = await taskCount();
	await w.apply(c.A, "tasks.answerPhaseOffer", { accept: ["launch-date-planning"] });
	assert.equal(await taskCount(), n0 + 7, "only the accepted checklist is copied");
	await w.apply(c.A, "phases.transition", { toPhase: 3, reason: "Ready" });
	const n1 = await taskCount();
	await w.apply(c.A, "tasks.declinePhaseOffer", {});
	assert.equal(await taskCount(), n1);
	await w.apply(c.A, "phases.transition", { toPhase: 4, reason: "Ready" });
	const offered = rowsOf(await w.look(c.A, "tasks.readPhaseOffer")).reduce((n, r) => n + r.fields.taskCount, 0);
	await w.apply(c.A, "tasks.acceptPhaseOffer", {});
	assert.equal(await taskCount(), n1 + offered);

	const card = await w.prepare(c.A, "tasks.complete", { taskId: S });
	await c.foreignReview(card);
	await c.foreign(
		said,
		[
			() => [read("tasks.get", { taskId: S }), read("tasks.statusHistory", { taskId: S })],
			() => [
				read("followups.listContactHistory", { personId: c.rivera }),
				read("tasks.listPrerequisites", { taskId: due }),
			],
			() => propose("tasks.complete", { taskId: S }),
		],
		{ secrets: ["due_today", "Chairs", "Jamie First"], on: { onError: "go_on" } },
	);
	await c.failedWrite(card, "task");
	assert.equal((await taskRow(S)).status, "complete");
	assert.equal((await taskRow(complete)).status, "complete");
});
