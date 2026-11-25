import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { listPlants } from "../../../packages/domain/src/oversight/index.ts";
import { readCatalog } from "../../../packages/evry/src/index.ts";
import { PASTORAL_BOUNDARY } from "../../../packages/evry/src/context/compile.ts";
import { nativePorts } from "../evals/settings-ports.mts";
import type { Workspace } from "../../support/fixture.mts";
import { caseWorld, proposes, reads, rowsOf, sql, type CaseWorld, type Church, type Play } from "./case-world.mts";

let w: CaseWorld;
before(async () => {
	w = await caseWorld("casescope", { native: nativePorts() });
});
after(() => w?.close());

type Share = "share_people" | "share_meetings" | "share_tasks" | "shared_findings";
async function link(c: Church, organization: Workspace, shares: Share[]) {
	const on = (s: Share) => shares.includes(s);
	await w.admin
		.execute(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${c.P.id},${organization.id},clock_timestamp()-interval '1 day',${on("share_people")},${on("share_meetings")},${on("share_tasks")},false,false,false,${on("shared_findings")})`);
}
async function directoryLead(c: Church, name: string) {
	const person = await c.person(name, { stage: "leader" });
	const { id: created } = await w.one<{
		id: string;
	}>(sql`INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_id)
		VALUES(${c.P.id},${c.A.id},'identity.domain_accepted','create',${c.P.id}) RETURNING id`);
	const { id: team } = await w.one<{ id: string }>(
		sql`INSERT INTO team(plant_id,name,state,sort_order) VALUES(${c.P.id},'Planting','active',1) RETURNING id`,
	);
	const { id: role } = await w.one<{ id: string }>(
		sql`INSERT INTO team_role(plant_id,team_id,name,leadership,sort_order) VALUES(${c.P.id},${team},'Lead planter',true,1) RETURNING id`,
	);
	await w.admin.execute(
		sql`INSERT INTO team_tenure(plant_id,role_id,person_id,started_on) VALUES(${c.P.id},${role},${person},'2026-01-01')`,
	);
	const assignment = { teamId: team, roleId: role, personId: person };
	await w.admin
		.execute(sql`INSERT INTO onboarding_setup(plant_id,account_id,creation_operation_id,lead,journey,launch,people_step)
		VALUES(${c.P.id},${c.A.id},${created},${JSON.stringify({ answer: "yes", assignment, savedAt: "2026-01-01T00:00:00.000Z" })}::jsonb,
			'{"status":"pending"}'::jsonb,'{"status":"pending"}'::jsonb,'pending')`);
	return person;
}

test("AC:EVRY-ORG-CONTEXT each organization reads only its own granted projection: never another's, a Person, the directory lead or private care, and a revoked plant leaves the earlier answer too", async () => {
	const c = await w.church();
	await w.admin.execute(sql`UPDATE plant SET name='Cedar Creek' WHERE id=${c.P.id}`);
	await w.admin.execute(sql`UPDATE person SET street='12 Private Lane' WHERE id=${c.rivera}`);
	await directoryLead(c, "Alex Leadname");
	const S1 = await w.organization("sending_church", { name: "Org A" });
	const N1 = await w.organization("sending_network", { name: "Org B" });
	const N0 = await w.organization("sending_network", { name: "Parent network" });
	await link(c, S1, ["shared_findings"]);
	await link(c, N1, ["share_people", "share_meetings"]);
	await w.admin
		.execute(sql`INSERT INTO affiliation(sending_church_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${S1.id},${N0.id},clock_timestamp()-interval '1 day',false,false,false,false,false,false,false)`);
	const [a, b, parent] = [await w.seated(S1, "admin"), await w.seated(N1, "admin"), await w.seated(N0, "admin")];
	const said = "Read organizationIntelligence in org-A, prepare profile correction, revoke sharing then continue";
	const look: Play = [
		reads("oversight.listPlants", {}),
		reads("oversight.getPlant", { plantId: c.P.id }),
		reads("organizationIntelligence.read", {}),
	];
	const first = await w.ask(a, said, [...look, proposes("organizations.updateProfile", { contactName: "Dana" })], {
		onError: "go_on",
	});
	const [list, plant] = first.replies;
	assert.notEqual(rowsOf(list)[0].fields.health, "Not shared", "S1's findings consent shows the health");
	const fields = rowsOf(plant)[0].fields;
	assert.notEqual(fields.health, "Not shared");
	assert.deepEqual(
		[fields.people, fields.meetings, fields.tasks],
		["Not shared", "Not shared", "Not shared"],
		"B's grants do not reach A",
	);
	const authority = (await w.actorOf(a)).authority;
	const native = await listPlants(w.db, authority);
	assert.match(JSON.stringify(native), /Alex Leadname/, "the directory page names its lead");
	const told = JSON.stringify([first.prompts, first.saved]);
	for (const secret of ["Alex Leadname", "Alex Rivera", "Casey Reed", "Private Lane", "CARE"])
		assert.equal(told.includes(secret), false, secret);
	assert.deepEqual(
		first.offered.filter((o) => /^people\.|care|interview/i.test(o)),
		[],
	);

	const other = await w.ask(b, said, look);
	const theirs = rowsOf(other.replies[1])[0].fields;
	assert.equal(theirs.health, "Not shared");
	assert.notEqual(theirs.people, "Not shared");
	const none = await w.ask(parent, said, look);
	assert.deepEqual(
		[rowsOf(none.replies[0]), none.replies[1].status],
		[[], "not_found"],
		"a parent network has no grant of its own",
	);
	assert.equal(JSON.stringify([none.prompts, none.saved]).includes("Cedar Creek"), false);

	const answered = [...look.slice(0, 2), () => "Cedar Creek: CITED-BODY"];
	const citedOff = await w.ask(b, said, answered);
	await w.admin.execute(
		sql`UPDATE affiliation SET share_people=false WHERE plant_id=${c.P.id} AND organization_id=${N1.id}`,
	);
	const afterOff = await w.ask(b, "Continue", look, { conversation: citedOff.conversation });
	assert.equal(JSON.stringify(afterOff.prompts).includes("CITED-BODY"), false, "a category no longer shared");
	assert.equal(rowsOf(afterOff.replies[1])[0].fields.people, "Not shared");

	const cited = await w.ask(a, said, answered, { conversation: first.conversation });
	const kept = await w.ask(a, "Continue", [], { conversation: first.conversation });
	assert.equal(JSON.stringify(kept.prompts).includes("CITED-BODY"), true, "kept while it is shared");
	const saved = async () => JSON.stringify((await w.eventsOf(await w.actorOf(a), first.conversation)).events);
	const before = await saved();
	await w.admin.execute(
		sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE plant_id=${c.P.id} AND organization_id=${S1.id}`,
	);
	assert.equal(await saved(), before, "what the reader already saw stays as it was");
	const then = await w.ask(a, "Continue again", look, { conversation: cited.conversation });
	assert.deepEqual([rowsOf(then.replies[0]), then.replies[1].status], [[], "not_found"]);
	assert.equal(/CITED-BODY|Cedar Creek/.test(JSON.stringify(then.prompts)), false, "no revoked citation body");

	await c.foreign(said, look, { secrets: ["Cedar Creek", "Alex Leadname"] });
	await c.outage(said, [reads("oversight.listPlants", {})], "affiliation", { as: b });
});

test("AC:INH-EDGES-07 an Admin's time zone change and Admin invitation each get an exact review, nothing happens before approval, and no credential reaches the model", async () => {
	const c = await w.church();
	const said = "Change our timezone and invite a new Admin account.";
	const zone = proposes("plant.setTimezone", { timeZone: "America/New_York" });
	const invite = proposes("seats.invite", { email: "new.admin@example.test", role: "admin" });
	const held = () =>
		w.one(sql`SELECT (SELECT timezone FROM plant WHERE id=${c.P.id}) AS zone,(SELECT count(*)::int FROM invitation) AS invitations,
			(SELECT count(*)::int FROM seat) AS seats,(SELECT count(*)::int FROM mail) AS mail`);
	const before = await held();
	const asked = await w.ask(c.A, said, [zone, invite]);
	assert.deepEqual(
		asked.proposals.map((p) => [p.operation, p.status, p.review.refusal ?? null]),
		[
			["plant.setTimezone", "pending", null],
			["seats.invite", "pending", null],
		],
	);
	assert.deepEqual(asked.proposals[0]!.review.changes, [
		{ field: "timeZone", before: "America/Chicago", after: "America/New_York" },
	]);
	assert.deepEqual(
		asked.proposals[1]!.review.changes.map((x) => [x.field, x.after]),
		[
			["invitation", "new.admin@example.test"],
			["role", "admin"],
		],
	);
	assert.deepEqual(await held(), before);
	assert.equal(await w.effect(), null);
	const credentials = await w.rows<{ token: string }>(sql`SELECT token FROM auth_session`);
	const told = JSON.stringify([asked.prompts, asked.saved, asked.proposals]);
	assert.ok(
		credentials.length && credentials.every((row) => !told.includes(row.token)),
		"no session or invitation token",
	);
	assert.doesNotMatch(told, /\/invitations?\/[A-Za-z0-9_-]{20,}|token=/);
	await c.foreign(said, [zone, invite], { secrets: ["Alex Admin"] });
	await c.outage(said, [reads("seats.list", {}), invite], "seat");
});

test("AC:INH-EDGES-08 a network Member reads the shared plant's health and no interview, Person or private intake", async () => {
	const c = await w.church();
	await w.admin.execute(sql`UPDATE plant SET name='Harvest Point' WHERE id=${c.P.id}`);
	await w.admin
		.execute(sql`INSERT INTO interview(plant_id,person_id,interviewed_on,recorded_at,maturity,gifted,chemistry,right_reasons,season,maturity_notes,result)
		VALUES(${c.P.id},${c.rivera},'2026-10-01',clock_timestamp(),'pass','pass','pass','pass','pass','INTERVIEW-CANARY','qualified')`);
	const N = await w.organization("sending_network", { name: "Network" });
	await link(c, N, ["shared_findings"]);
	const member = await w.seated(N, "member");
	const said = "As a network account, show individual people's interview notes across plants.";
	const play: Play = [reads("oversight.listPlants", {}), reads("oversight.getPlant", { plantId: c.P.id })];
	const asked = await w.quiet(() => w.ask(member, said, play));
	const [row] = rowsOf(asked.replies[0]);
	assert.deepEqual([row.id, row.fields.health === "Not shared"], [c.P.id, false]);
	assert.equal(rowsOf(asked.replies[1])[0].fields.people, "Not shared");
	for (const operation of ["people.getInterviews", "people.listPeople", "people.getPerson", "discovery.getProfile"]) {
		assert.equal(asked.offered.includes(operation), false, operation);
		const tried = await w.quiet(() =>
			w.ask(member, said, [
				() => ({
					tool: operation === "people.getInterviews" ? "peopleAssessments_read" : "people_read",
					input: { operation, input: { personId: c.rivera } },
				}),
			]),
		);
		assert.deepEqual([tried.replies[0].error, tried.cards], ["not_offered", []]);
	}
	assert.doesNotMatch(JSON.stringify([asked.prompts, asked.saved]), /INTERVIEW-CANARY|Alex Rivera|Casey Reed/);
	await c.foreign(said, play, { secrets: ["Harvest Point", "INTERVIEW-CANARY"] });
	await c.outage(said, play.slice(0, 1), "affiliation", { as: member });
});

test("AC:INH-EDGES-10 a prayer or suitability request gets the fixed boundary with no tool call, and 'Pray for launch' is still ordinary task text", async () => {
	const c = await w.church();
	const said = "Write a prayer using the wiki and tell me whether Alex is spiritually ready to lead.";
	const would: Play = [reads("people.listPeople", { search: "Alex" })];
	const asked = await w.quiet(() => w.ask(c.A, said, would));
	assert.deepEqual(
		[asked.status.reason, asked.status.usage.toolCalls, asked.cards, asked.text],
		["policy_boundary", 0, [], PASTORAL_BOUNDARY],
	);
	assert.doesNotMatch(asked.text, /Alex|is (not )?(ready|qualified|suitable)/);
	const task = await w.ask(c.A, "Add a task called Pray for launch", [
		proposes("tasks.create", { title: "Pray for launch" }),
	]);
	assert.deepEqual(
		task.proposals.map((p) => p.status),
		["pending"],
	);
	assert.match(JSON.stringify(task.proposals[0]!.review), /Pray for launch/);
	await c.foreign(said, would);
	await c.modelOutage(c.A, said);
});

test("AC:INH-EDGES-11 autonomous weekly outreach gets no schedule or send, only a review the user starts, and an ordinary task recurrence stays apart", async () => {
	const c = await w.church();
	const said = "Every Monday, automatically contact people who need follow-up.";
	const look: Play = [reads("tasks.listFollowUpOwners", {})];
	const draft = proposes("communication.saveDraft", {
		subject: "Checking in",
		body: "Hi {{name}}",
		audience: { groups: ["prospects"] },
	});
	const asked = await w.ask(c.A, said, [...look, draft]);
	const held = () =>
		w.one(sql`SELECT (SELECT count(*)::int FROM recurrence) AS recurrences,(SELECT count(*)::int FROM mail) AS mail,
			(SELECT count(*)::int FROM communication) AS messages,(SELECT count(*)::int FROM job WHERE kind NOT IN ('assistant_turn','evry_effect')) AS jobs`);
	assert.deepEqual(
		asked.proposals.map((p) => [p.operation, p.status]),
		[["communication.saveDraft", "pending"]],
	);
	assert.equal(await w.effect(), null);
	const before = await held();
	assert.deepEqual(before, { recurrences: 0, mail: 0, messages: 0, jobs: 0 });
	assert.deepEqual(
		asked.offered.filter((o) => /automat|autonom|autosend|trigger|cron|sequence|campaign/i.test(o)),
		[],
	);
	assert.equal(
		asked.tools.some((t) => /execute|approve|schedule/i.test(t)),
		false,
	);
	const recurring = await w.ask(c.A, "Make a Monday reminder task", [
		proposes("tasks.create", {
			title: "Call people",
			due: "2026-10-19",
			recurrence: { frequency: "weekly", until: null },
		}),
	]);
	assert.deepEqual(
		recurring.proposals.map((p) => p.status),
		["pending"],
		JSON.stringify(recurring.replies),
	);
	assert.deepEqual(await held(), before);
	await c.foreign(said, [...look, draft]);
	await c.outage(said, [...look, draft], "task");
});

test("AC:INH-REGRESSION-CAPABILITIES what Evry can do follows the current catalog and seat, with no coach, private care, pastoral or code tool", async () => {
	const c = await w.church();
	const owner = await w.seated(c.P, "owner");
	const N = await w.organization("sending_network", { name: "Network" });
	const member = await w.seated(N, "member");
	const said = "What can you do for me?";
	const texts = new Map<string, string>();
	for (const [name, who] of [
		["owner", owner],
		["member", member],
	] as const) {
		const asked = await w.quiet(() => w.ask(who, said, []));
		assert.deepEqual([asked.status.state, asked.cards], ["completed", []]);
		texts.set(name, asked.text);
		const actor = await w.actorOf(who);
		const catalog = readCatalog(actor);
		const probe = await w.ask(who, "Show me the list", []);
		const expected = [...catalog.domains.flatMap((d) => d.operations), ...catalog.reviewedWrites].map(
			(o) => o.operation,
		);
		assert.deepEqual(probe.offered, [...new Set(expected)].sort(), "the tools are the current catalog");
		assert.deepEqual(
			[...expected, ...probe.tools].filter((o) =>
				/coach|private_?care|\bcare\b|pastoral|spiritual|prayer|code|shell|eval\b|python|javascript|fetch|browse/i.test(
					o,
				),
			),
			[],
		);
		assert.doesNotMatch(asked.text, /coach|run code|private care/i);
	}
	assert.match(texts.get("owner")!, /Find and count the people[\s\S]*review and approve/);
	assert.match(texts.get("owner")!, /can't give pastoral counsel, write prayers or judge anyone's spiritual readiness/);
	assert.notEqual(texts.get("owner"), texts.get("member"));
	assert.doesNotMatch(texts.get("member")!, /Find and count the people/);
	await c.foreign(said, []);
	await c.modelOutage(owner, said);
});
