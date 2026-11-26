import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { RequestActor, WriteTx } from "../../../packages/domain/src/access/session.ts";
import { meetingsWriter, venuesWriter, withMeetingsWrite } from "../../../packages/domain/src/meetings/index.ts";
import {
	responsibilityWriter,
	teamsWriter,
	trainingWriter,
	withTeamsWrite,
} from "../../../packages/domain/src/teams/index.ts";
import { approveProposal } from "../../../packages/evry/src/index.ts";
import { ok } from "../../support/fixture.mts";
import { caseOf } from "../../integration/target/sql/core/support.mts";
import {
	caseWorld,
	proposes,
	read,
	reads,
	rowsOf,
	sql,
	type CaseWorld,
	type Church,
	type Play,
	type Reply,
} from "./case-world.mts";

let w: CaseWorld;
before(async () => {
	w = await caseWorld("caseteams");
});
after(() => w?.close());

type Op = (tx: WriteTx, context: never, raw: unknown) => Promise<unknown>;
async function native(c: Church, op: unknown, raw: object, gate: unknown = withTeamsWrite) {
	const authority = await w.authorityOf(c.A);
	const through = gate as (db: unknown, a: RequestActor, body: (tx: never, ctx: never) => unknown) => Promise<Reply>;
	return ok(await through(w.db, authority, (tx, ctx) => (op as Op)(tx, ctx, raw))) as Reply;
}
const created = (c: Church, op: unknown, input: object, gate?: unknown) =>
	native(c, op, { requestKey: randomUUID(), input }, gate);
const revision = async (table: string, id: string) =>
	(await w.one<{ r: string }>(sql.raw(`SELECT revision::text AS r FROM ${table} WHERE id='${id}'`))).r;
const changed = async (c: Church, op: unknown, on: [string, string], input: object) =>
	native(c, op, { requestKey: randomUUID(), expectedRevision: await revision(...on), input });
const team = async (c: Church, name: string): Promise<string> =>
	(await created(c, teamsWriter.create, { name })).team.id;
const role = async (c: Church, teamId: string, name: string, fields = {}): Promise<string> =>
	(await created(c, teamsWriter.createRole, { teamId, name, ...fields })).role.id;
const assign = (c: Church, teamId: string, roleId: string, personId: string) =>
	changed(c, teamsWriter.assignRole, ["team_role", roleId], { roleId, teamId, personId });
const program = async (c: Church, name: string, teamId: string | null): Promise<string> =>
	(await created(c, trainingWriter.createProgram, { name, required: true, teamId })).program.id;
async function meeting(c: Church, date: string, fields: object = {}): Promise<string> {
	const made = await created(
		c,
		meetingsWriter.schedule,
		{ type: "vision_meeting", date, time: "10:00", ...fields },
		withMeetingsWrite,
	);
	return made.meeting.id;
}
const status = async (c: Church, meetingId: string, ...path: string[]) => {
	for (const to of path)
		await native(
			c,
			meetingsWriter.changeStatus,
			{ requestKey: randomUUID(), expectedRevision: await revision("meeting", meetingId), input: { meetingId, to } },
			withMeetingsWrite,
		);
};
const venue = async (c: Church, name: string, fields = {}): Promise<string> =>
	(await created(c, venuesWriter.create, { name, address: "1 Main St", ...fields }, withMeetingsWrite)).venue.id;
const ids = (reply: Reply, kind?: string) => rowsOf(reply, kind).map((r) => r.id);
const tenures = (person: string) =>
	w.rows(sql`SELECT t.name AS team,r.name AS role,r.id AS role_id,tn.ended_on IS NULL AS current,tn.revision::text AS revision FROM team_tenure tn
		JOIN team_role r ON r.id=tn.role_id JOIN team t ON t.id=r.team_id WHERE tn.person_id=${person} ORDER BY t.name,r.name`);

test("AC:GAP-EVR-408 a meeting query counts recorded meetings by type, status and interval, and a new meeting needs no search first", async () => {
	const c = await w.church();
	const V1 = await meeting(c, "2026-10-06");
	const V3 = await meeting(c, "2026-10-13");
	const V2 = await meeting(c, "2026-10-14");
	const worship = await team(c, "Worship");
	const T1 = await meeting(c, "2026-10-20", { type: "team_meeting", subtype: "training", teamId: worship });
	await w.admin.execute(sql`UPDATE meeting SET status='completed' WHERE id=${V1}`);
	await status(c, V3, "cancelled");
	const said = "Search/count/group Vision completed in interval";
	const play: Play = [
		reads("meetings.list", { window: "past", types: ["vision_meeting"], statuses: ["completed"] }),
		reads("meetings.list", {}),
		reads("meetings.hasHistory", { types: ["orientation"] }),
	];
	const asked = await w.quiet(() => w.ask(c.A, said, play));
	const [done, all, none] = asked.replies;
	assert.deepEqual([ids(done), done.total, done.completeness], [[V1], 1, "complete"]);
	assert.deepEqual(
		rowsOf(done).map((r) => [r.fields.date, r.fields.status]),
		[["2026-10-06", "completed"]],
	);
	assert.deepEqual(
		rowsOf(all)
			.map((r) => [r.id, r.fields.status])
			.sort(),
		[
			[V1, "completed"],
			[V2, "planning"],
			[V3, "cancelled"],
			[T1, "planning"],
		].sort(),
	);
	assert.equal(rowsOf(none)[0].fields.hasHistory, false);
	const direct = await w.ask(c.A, "Schedule a Vision meeting on October 27 at 7pm.", [
		proposes("meetings.schedule", { type: "vision_meeting", date: "2026-10-27", time: "19:00" }),
	]);
	assert.deepEqual([direct.cards, direct.proposals.map((p) => p.status)], [[], ["pending"]], "no read came first");
	await c.foreign(said, play, { found: ["Meeting history"] });
	await c.outage(said, play, "meeting");
});

test("AC:GAP-EVR-409 a known meeting reads its own agenda, kit and missing evaluation, and a shared title names both meetings", async () => {
	const c = await w.church();
	const title = "Orientation";
	const M1 = await meeting(c, "2026-10-20", { type: "orientation", title });
	const M2 = await meeting(c, "2026-10-27", { type: "orientation", title });
	const V = await meeting(c, "2026-10-10");
	const said = "Read known M agenda/kit/evaluation then request ambiguous title";
	const known: Play = [
		reads("meetings.get", { meetingId: M1 }),
		reads("meetings.readAgenda", { meetingId: M1 }),
		reads("meetings.listKit", { meetingId: M1 }),
		reads("meetings.getEvaluation", { meetingId: M1 }),
		reads("meetings.getEvaluation", { meetingId: V }),
		reads("meetings.list", { window: "upcoming", types: ["orientation"] }),
	];
	const asked = await w.quiet(() => w.ask(c.A, said, known));
	const [got, agenda, kit, evaluation, vision, same] = asked.replies;
	assert.deepEqual(
		rowsOf(got).map((r) => [r.id, r.fields.date, r.label]),
		[[M1, "2026-10-20", title]],
	);
	assert.deepEqual([ids(agenda, "meeting"), ids(kit, "item")], [[M1], []]);
	for (const reply of [evaluation, vision])
		assert.ok(
			rowsOf(reply).every((r) => r.fields.recorded === false && !("average" in r.fields)),
			JSON.stringify(reply),
		);
	assert.deepEqual(
		rowsOf(vision).map((r) => r.fields),
		[{ recorded: false }],
	);
	assert.deepEqual(
		rowsOf(same).map((r) => [r.id, r.label, r.fields.date]),
		[
			[M1, title, "2026-10-20"],
			[M2, title, "2026-10-27"],
		],
		"both meetings of that title, each with its date",
	);
	assert.deepEqual([asked.proposals, asked.status.state], [[], "completed"]);
	await c.foreign(said, known, { secrets: [`"label":"${title}"`] });
	await c.outage(said, known, "meeting");
});

test("AC:GAP-EVR-410 vacancies count roles, the roster counts people once, and no responsibility gets an invented owner", async () => {
	const c = await w.church();
	const hospitality = await team(c, "Hospitality");
	const worship = await team(c, "Worship");
	const [H1, H2] = [await role(c, hospitality, "Greeter"), await role(c, hospitality, "Coffee host")];
	const W1 = await role(c, worship, "Vocals");
	await assign(c, hospitality, H1, c.rivera);
	await assign(c, hospitality, H2, c.casey);
	await changed(c, teamsWriter.removeRole, ["team_role", H2], { roleId: H2, personId: c.casey });
	await changed(c, responsibilityWriter.addResponsibility, ["team", hospitality], {
		teamId: hospitality,
		text: "Order coffee",
	});
	const said = "Query vacancies, roster and responsibilities";
	const play: Play = [
		reads("teams.staffingSummary"),
		reads("teams.get", { teamId: hospitality }),
		reads("teams.listResponsibilities", { teamId: hospitality }),
		reads("teams.listRoles", { teamId: worship }),
	];
	const asked = await w.quiet(() => w.ask(c.A, said, play));
	const [summary, roster, duties, open] = asked.replies;
	assert.deepEqual(summary.facts, { roles: 3, filledRoles: 1, openRoles: 2, peopleServing: 1 });
	assert.deepEqual(
		rowsOf(summary).map((r) => [r.label, r.fields.roles, r.fields.filledRoles, r.fields.openRoles, r.fields.people]),
		[
			["Hospitality", 2, 1, 1, 1],
			["Worship", 1, 0, 1, 0],
		],
	);
	assert.deepEqual([ids(roster, "person"), roster.total], [[c.rivera], 1], "an ended membership is not on the roster");
	assert.deepEqual(
		rowsOf(open).map((r) => [r.id, r.fields.open, r.fields.filledBy]),
		[[W1, true, null]],
	);
	assert.deepEqual(
		rowsOf(duties).map((r) => [r.label, r.fields]),
		[["Order coffee", { done: false, doneOn: null }]],
	);
	await c.foreign(said, play, { secrets: ["Hospitality", "Order coffee"] });
	await c.outage(said, play, "team_tenure");
});

test("AC:GAP-EVR-411 a known ministry keeps its role's skills, time and training, with no background requirement or certification", async () => {
	const c = await w.church();
	const hospitality = await team(c, "Hospitality");
	const H1 = await role(c, hospitality, "Greeter", { desiredSkills: "hospitality", timeCommitment: "2 hours" });
	await assign(c, hospitality, H1, c.rivera);
	const R1 = await program(c, "R1", hospitality);
	const said = "Read full known team and role detail";
	const play: Play = [
		reads("teams.get", { teamId: hospitality }),
		reads("teams.listRoles", { teamId: hospitality }),
		reads("teams.trainingMatrix", { teamId: hospitality }),
	];
	const asked = await w.quiet(() => w.ask(c.A, said, play));
	const [detail, roles, training] = asked.replies;
	assert.deepEqual(ids(detail), [hospitality, H1, c.rivera]);
	assert.deepEqual(
		rowsOf(roles).map((r) => [r.id, r.fields.desiredSkills, r.fields.timeCommitment, r.fields.filledBy]),
		[[H1, "hospitality", "2 hours", "Alex Rivera"]],
	);
	assert.deepEqual(
		rowsOf(training).map((r) => [r.id, r.label, r.fields.required]),
		[[R1, "R1", true]],
	);
	assert.doesNotMatch(JSON.stringify(asked.replies), /background|certif/i);
	await c.foreign(said, play, { secrets: ["Hospitality", "Greeter"] });
	await c.outage(said, play, "training_program");
});

test("AC:GAP-EVR-412 required completion is one of the two saved people, and a program nobody must take is not a zero rate", async () => {
	const c = await w.church();
	const worship = await team(c, "Worship");
	const greeting = await team(c, "Greeting");
	const helper = await role(c, worship, "Helper");
	const A = await program(c, "Program A", worship);
	const B = await program(c, "Program B", greeting);
	for (const person of [c.rivera, c.casey])
		await w.admin.execute(sql`INSERT INTO training_assignment(plant_id,program_id,person_id,version,state,effective_on)
			VALUES(${c.P.id},${A},${person},1,'active','2026-10-01')`);
	await changed(c, trainingWriter.attestCompletion, ["training_program", A], {
		kind: "program",
		personId: c.rivera,
		programId: A,
		earnedOn: "2026-10-01",
	});
	const history = () =>
		w.rows(
			sql`SELECT person_id,program_id,state,effective_on::text AS on FROM training_assignment WHERE plant_id=${c.P.id} ORDER BY person_id`,
		);
	const saved = await history();
	const jamie = await c.person("Jamie");
	await assign(c, worship, helper, jamie);
	const said = "Read required completion by team/program";
	const play: Play = [
		reads("teams.readRequiredTrainingParticipants", { programId: A }),
		reads("teams.trainingMatrix", {}),
		reads("teams.health", { teamId: greeting }),
		reads("teams.health", { teamId: worship }),
	];
	const asked = await w.quiet(() => w.ask(c.A, said, play));
	const [required, matrix, none, half] = asked.replies;
	assert.deepEqual(required.facts, { complete: 1, of: 2 });
	assert.deepEqual(
		rowsOf(required, "person").map((r) => [r.id, r.fields.complete]),
		[
			[c.rivera, "yes"],
			[c.casey, "no"],
		],
		"a later joiner is not on the saved list",
	);
	assert.deepEqual(
		rowsOf(matrix, "training")
			.map((r) => [r.id, r.fields.complete, r.fields.of])
			.sort(),
		[
			[A, 1, 2],
			[B, 0, 0],
		].sort(),
	);
	assert.deepEqual([rowsOf(half)[0].fields.trainingPercent, rowsOf(none)[0].fields.trainingPercent], [50, null]);
	assert.deepEqual(await history(), saved, "the saved list is not rewritten");
	await c.foreign(said, play, { secrets: ["Program A", "Jamie"] });
	await c.outage(said, play, "training_assignment");
});

test("AC:GAP-EVR-426 a venue search returns only this church's active saved venues, and nothing for a capacity none of them has", async () => {
	const c = await w.church();
	const Hall = await venue(c, "Hall", { capacity: 80 });
	const Annex = await venue(c, "Hall Annex");
	await w.admin.execute(sql`UPDATE venue SET archived_at=clock_timestamp() WHERE id=${Annex}`);
	await w.admin.execute(
		sql`INSERT INTO venue(id,plant_id,name,address) VALUES(${randomUUID()},${c.Q.id},'Hall foreign','2 Far St')`,
	);
	const said = "Search active saved Hall and request capacity>=100";
	const play: Play = [reads("venues.list", { search: "Hall" })];
	const asked = await w.quiet(() => w.ask(c.A, said, play));
	const [found] = asked.replies;
	assert.deepEqual(
		rowsOf(found).map((r) => [r.id, r.fields.capacity, r.fields.active]),
		[[Hall, "80", true]],
	);
	assert.deepEqual([found.total, found.completeness], [1, "complete"]);
	assert.equal(rowsOf(found).filter((r) => Number(r.fields.capacity) >= 100).length, 0);
	assert.equal(
		asked.tools.some((t) => /web|internet|browse|http/i.test(t)),
		false,
		"no outside research tool",
	);
	await c.foreign(said, play, { found: ["Hall foreign"] });
	await c.outage(said, play, "venue");
});

test("AC:GAP-EVR-427 a known venue is read by its id, and a shared name picks nothing and restores nothing", async () => {
	const c = await w.church();
	const A = await venue(c, "Hall", { address: "100 Main St", capacity: 80 });
	const B = await venue(c, "Hall", { address: "9 Elm St" });
	const old = await venue(c, "Hall Annex");
	await w.admin.execute(sql`UPDATE venue SET archived_at=clock_timestamp() WHERE id=${old}`);
	const said = "Read Hall-A then ask unknown Hall";
	const play: Play = [
		reads("venues.get", { venueId: A }),
		reads("venues.list", { search: "Hall" }),
		reads("venues.get", { venueId: old }),
	];
	const asked = await w.quiet(() => w.ask(c.A, said, play));
	const [known, both, archived] = asked.replies;
	assert.deepEqual(
		rowsOf(known).map((r) => [r.id, r.label, r.fields.address, r.fields.capacity]),
		[[A, "Hall", "100 Main St", "80"]],
	);
	assert.deepEqual(ids(both).sort(), [A, B].sort(), "both halls come back to be asked about");
	assert.deepEqual(
		rowsOf(archived).map((r) => r.fields.active),
		[false],
	);
	assert.equal((await w.one(sql`SELECT archived_at IS NULL AS active FROM venue WHERE id=${old}`)).active, false);
	await c.foreign(said, play, { secrets: ["100 Main St"] });
	await c.outage(said, play, "venue");
});

test("AC:INH-ROLES-05 the chosen Casey is placed in the one open greeter role by a reviewed assignment that grants no seat", async () => {
	const c = await w.church();
	const second = await c.person("Casey Stone");
	const hospitality = await team(c, "Hospitality");
	const greeter = await role(c, hospitality, "greeter");
	const said = "Assign Casey to the open greeter role.";
	const both: Play = [
		reads("people.listPeople", { search: "Casey" }),
		reads("teams.listRoles", { teamId: hospitality }),
	];
	const asked = await w.quiet(() => w.ask(c.A, said, both));
	assert.deepEqual(ids(asked.replies[0]).sort(), [c.casey, second].sort());
	assert.deepEqual(
		rowsOf(asked.replies[1]).map((r) => [r.id, r.fields.open]),
		[[greeter, true]],
	);
	const seats = () => w.count(sql`SELECT count(*)::int AS n FROM seat`);
	const held = await seats();
	const choose: Play = [...both, proposes("teams.assignRole", { roleId: greeter, personId: second })];
	const chosen = await w.ask(c.A, "Casey Stone", choose, { conversation: asked.conversation });
	const [card] = chosen.proposals;
	assert.deepEqual(
		[card!.review.target?.id, card!.review.changes],
		[greeter, [{ field: "filledBy", before: null, after: "Casey Stone" }]],
	);
	assert.deepEqual(await tenures(second), []);
	await w.approve(c.A, card!);
	assert.equal((await approveProposal(w.db, await w.actorOf(c.A), card!.id, w.witness(card!), null)).replayed, true);
	assert.deepEqual(
		(await tenures(second)).map((t) => [t.team, t.role, t.current]),
		[["Hospitality", "greeter", true]],
	);
	assert.deepEqual(await tenures(c.casey), []);
	assert.equal(await seats(), held);
	assert.doesNotMatch(JSON.stringify([chosen.replies, card!.review]), /suitab|qualified|ready|recommend/i);
	const free = await role(c, hospitality, "usher");
	await c.foreign(said, [...both.slice(1), proposes("teams.assignRole", { roleId: free, personId: second })], {
		secrets: ["Casey Stone", "greeter".concat('"')],
	});
	await c.outage(said, choose, "team_role");
});

test("AC:B01-035 the same selected import from the app and from Evry records one outcome, and only a person's approval applies the proposal", async () => {
	const k = caseOf("intelligence", "B01-035");
	const c = await w.church();
	const selections = [{ teamKey: "worship", roleKeys: ["worship_lead"] }];
	const footprint = () =>
		w.one<{
			teams: number;
			roles: number;
		}>(sql`SELECT (SELECT count(*) FROM team WHERE plant_id=${c.P.id})::int AS teams,
			(SELECT count(*) FROM team_role WHERE plant_id=${c.P.id})::int AS roles`);
	const outcomes = () =>
		w.count(sql`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id=${c.P.id}
			AND request_identity->>'operation'='teams.initialize' AND kind<>'noop'`);
	const app = await created(c, teamsWriter.initialize, { expectedVersion: "2", mode: "import", selections });
	assert.deepEqual([app.outcome, app.newTenantRows], ["changed", 2]);
	const made = await footprint();
	const asked = await w.ask(c.A, "Import the worship ministry with its lead role", [
		proposes("teams.initialize", { selections }),
	]);
	const [card] = asked.proposals;
	assert.equal(card!.review.refusal ?? null, null);
	assert.equal(k.action.arguments.human_review, true);
	assert.ok(asked.offered.length > 0);
	assert.deepEqual(
		asked.offered.filter((tool) => /approve|confirm/i.test(tool)),
		[],
		"the model is offered no way to approve",
	);
	assert.equal(k.expected.result.model_approval_allowed, false);
	assert.deepEqual(await footprint(), made, "a proposal applies nothing");
	assert.equal((await w.approve(c.A, card!)).review.outcome, "completed");
	assert.equal((await approveProposal(w.db, await w.actorOf(c.A), card!.id, w.witness(card!), null)).replayed, true);
	assert.deepEqual(await footprint(), made, "the same import from Evry adds nothing");
	assert.equal(await outcomes(), k.expected.result.recorded_outcome_count);
});

test("AC:INH-TEAMS-06 adding Alex to Hospitality adds one role, keeps Worship as it was and meets no capacity gate", async () => {
	const c = await w.church();
	const worship = await team(c, "Worship");
	const hospitality = await team(c, "Hospitality");
	const R1 = await role(c, worship, "R1");
	const R2 = await role(c, hospitality, "R2");
	await assign(c, worship, R1, c.rivera);
	const before = await tenures(c.rivera);
	const said = "Add Alex to hospitality without removing their current worship assignment.";
	const play: Play = [
		reads("people.listPeople", { search: "Alex Rivera" }),
		reads("teams.listRoles", { teamId: hospitality }),
		proposes("teams.assignMember", { teamId: hospitality, roleId: R2, personId: c.rivera }),
	];
	const asked = await w.ask(c.A, said, play);
	const [card] = asked.proposals;
	assert.deepEqual(
		[card!.review.refusal, card!.review.changes],
		[undefined, [{ field: "member", before: null, after: "Alex Rivera as R2" }]],
	);
	assert.deepEqual(await tenures(c.rivera), before);
	const done = await w.approve(c.A, card!);
	assert.equal(done.review.outcome, "completed");
	const after = await tenures(c.rivera);
	assert.deepEqual(
		after.map((t) => [t.role_id, t.current]),
		[
			[R2, true],
			[R1, true],
		],
	);
	assert.deepEqual(
		after.filter((t) => t.team === "Worship"),
		before,
	);
	const other = await role(c, hospitality, "R3");
	await c.foreign(
		said,
		[
			proposes("teams.assignMember", { teamId: hospitality, roleId: other, personId: c.rivera }),
			reads("teams.get", { teamId: worship }),
		],
		{
			secrets: ["Worship"],
		},
	);
	await c.outage(said, play, "team_role");
});

test("AC:INH-TRAINING-05 a reviewed completion records the exact person, program and date once and leaves the required list alone", async () => {
	const c = await w.church();
	const hospitality = await team(c, "Hospitality team");
	const P = await program(c, "Hospitality", hospitality);
	await w.admin.execute(sql`INSERT INTO training_assignment(plant_id,program_id,person_id,version,state,effective_on)
		VALUES(${c.P.id},${P},${c.rivera},1,'active','2026-10-01')`);
	const required = () =>
		w.rows(
			sql`SELECT person_id,program_id,state,revision::text AS r FROM training_assignment WHERE plant_id=${c.P.id}`,
		);
	const credits = () =>
		w.rows(sql`SELECT person_id,program_id,earned_on::text AS on FROM training_credit WHERE plant_id=${c.P.id}`);
	const list = await required();
	const said = "Record Alex's completion of the hospitality training today.";
	const play: Play = [
		reads("calendar.getContext"),
		reads("people.listPeople", { search: "Rivera" }),
		reads("teams.readRequiredTrainingParticipants", { programId: P }),
		(r) => ({
			tool: "propose_change",
			input: {
				operation: "teams.attestCompletion",
				input: { personId: rowsOf(r[1])[0].id, programId: P, earnedOn: rowsOf(r[0])[0].fields.today },
			},
		}),
	];
	const asked = await w.ask(c.A, said, play, { at: new Date("2026-10-13T16:00:00Z") });
	const [card] = asked.proposals;
	assert.ok(card, JSON.stringify(asked.replies.at(-1)));
	assert.deepEqual(await credits(), []);
	assert.match(JSON.stringify(card.review), /2026-10-13/);
	await w.approve(c.A, card);
	assert.equal((await approveProposal(w.db, await w.actorOf(c.A), card.id, w.witness(card), null)).replayed, true);
	assert.deepEqual(await credits(), [{ person_id: c.rivera, program_id: P, on: "2026-10-13" }]);
	assert.deepEqual(await required(), list);
	await c.foreign(
		said,
		[
			proposes("teams.attestCompletion", { personId: c.rivera, programId: P, earnedOn: "2026-10-13" }),
			() => read("teams.trainingMatrix", {}),
		],
		{
			secrets: ['"Hospitality"'],
		},
	);
	await c.outage(said, play, "training_program");
});
