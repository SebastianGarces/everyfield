import { fixture, ok, refused } from "../../../support/fixture.mts";
import { sql } from "../../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { peopleMerge, peopleUnmerge, peopleWriter as people } from "../../../../packages/domain/src/people/index.ts";
import { meetingsReader } from "../../../../packages/domain/src/meetings/index.ts";
import { taskReader } from "../../../../packages/domain/src/tasks/index.ts";
import { teamsReader } from "../../../../packages/domain/src/teams/index.ts";
import { pipelineWriter, readPipelineBoard } from "../../../../packages/domain/src/organizations/pipeline.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import { mergeBlockedText, unmergeBlockedText } from "../../../../packages/contracts/src/people/merge/copy.ts";

const database = await fixture({ prefix: "t554" });
const { admin } = database;
const db = database.pools.runtime;
const plant = database.tenant.id;
const other = (await database.plant()).id;
const org = await database.organization("sending_church", { name: "Grace Austin", timezone: "America/Chicago" });
const actors = {
	owner: database.actors.owner,
	member: database.actors.member,
	stranger: await database.actor({ kind: "plant", id: other }, "admin"),
	orgOwner: await database.actor(org, "owner"),
};
const ctx = (who = "owner") => ({
	session: actors[who].session,
	selected: who === "stranger" ? { kind: "plant", id: other } : who === "orgOwner" ? org : { kind: "plant", id: plant },
});
const tx = (body) => gatedTransaction(db, body);
const key = () => randomUUID();
const rows = async (query) => (await admin.execute(query)).rows;
const authority = (who = "owner") => RequestActor.resolve(db, actors[who].session);
after(() => database.close());

async function person(name) {
	return ok(
		await tx((t) =>
			people.createPerson(t, ctx(), { requestKey: key(), input: { displayName: name, adultClassification: "adult" } }),
		),
	).person.id;
}
async function meeting(title, day) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,
 resolver_version,status,attendance_revision) VALUES(${id},${plant},'vision_meeting',${title},${day}::date,'18:00',
 'America/Chicago',(${day}||'T23:00:00Z')::timestamptz,'1','completed',1)`);
	return id;
}
async function attend(meetingId, personId, { presence = "attended", rsvp = null, inviter = null } = {}) {
	const id = randomUUID();
	const answered = rsvp === "confirmed" || rsvp === "declined";
	await admin.execute(sql`INSERT INTO participation(id,plant_id,meeting_id,person_id,inviter_person_id,roster_member,rsvp,
 rsvp_source,rsvp_at,presence) VALUES(${id},${plant},${meetingId},${personId},${inviter}::uuid,false,${rsvp},
 ${answered ? "admin" : null},${answered ? "2026-11-01T12:00:00Z" : null}::timestamptz,${presence})`);
	return id;
}
async function kit(meetingId, personId, text, checked = false) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO meeting_kit_item(id,plant_id,meeting_id,item_key,position,category,text,
 assignee_person_id,checked,checked_at) VALUES(${id},${plant},${meetingId},${`k-${id}`},1,'materials',${text},${personId},
 ${checked},${checked ? sql`clock_timestamp()` : sql`NULL`})`);
	return id;
}
async function task(personId, title, { due = null, status = "not_started" } = {}) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,due_date,person_id,
 completed_at) VALUES(${id},${plant},${title},'general','medium',${status},clock_timestamp(),${due ? "date_only" : "undated"},
 ${due}::date,${personId},${status === "complete" ? sql`clock_timestamp()` : sql`NULL`})`);
	return id;
}
async function subtask(parentId, title) {
	await admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,parent_id,position)
 VALUES(${randomUUID()},${plant},${title},'general','medium','not_started',clock_timestamp(),'undated',${parentId},1)`);
}
async function team(name, leader = null) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO team(id,plant_id,name,state,sort_order,leader_person_id,leader_source)
 VALUES(${id},${plant},${name},'active',1,${leader}::uuid,${leader ? "explicit" : null})`);
	return id;
}
async function role(teamId, name) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO team_role(id,plant_id,team_id,name,leadership,sort_order)
 VALUES(${id},${plant},${teamId},${name},false,1)`);
	return id;
}
async function tenure(roleId, personId, started, ended = null, previous = null) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO team_tenure(id,plant_id,role_id,person_id,started_on,ended_on,previous_tenure_id)
 VALUES(${id},${plant},${roleId},${personId},${started}::date,${ended}::date,${previous}::uuid)`);
	return id;
}

const TABLES = [
	["participation", "person_id"],
	["participation", "inviter_person_id"],
	["meeting_kit_item", "assignee_person_id"],
	["task", "person_id"],
	["team", "leader_person_id"],
	["team_tenure", "person_id"],
	["invitation", "resident_person_id"],
];
async function history(...ids) {
	const out = {};
	for (const [table, column] of TABLES)
		out[`${table}.${column}`] = (
			await rows(sql`SELECT to_jsonb(x)-'revision' AS row FROM ${sql.identifier(table)} x
 WHERE x.${sql.identifier(column)}=ANY(${sql.param(ids)}::uuid[]) ORDER BY x.id`)
		).map((r) => r.row);
	return out;
}
const idsOf = (h, personId) =>
	Object.fromEntries(
		Object.entries(h).map(([k, list]) => [k, list.filter((r) => r[k.split(".")[1]] === personId).map((r) => r.id)]),
	);
const totals = async () =>
	Object.fromEntries(
		await Promise.all(
			["participation", "meeting_kit_item", "task", "team", "team_tenure", "invitation"].map(async (t) => [
				t,
				Number((await rows(sql`SELECT count(*)::int AS n FROM ${sql.identifier(t)}`))[0].n),
			]),
		),
	);
const people_ = async (...ids) =>
	rows(sql`SELECT id,state,revision::text,merged_into_person_id FROM person WHERE id=ANY(${sql.param(ids)}::uuid[])
 ORDER BY id`);
const review = (sourceId, survivorId, who = "owner") =>
	tx((t) => peopleMerge.getMergeReview(t, ctx(who), { sourceId, survivorId }));
const mergeWith = (sourceId, survivorId, reviewDigest, requestKey = key(), who = "owner") =>
	tx((t) => peopleMerge.mergePeople(t, ctx(who), { requestKey, input: { sourceId, survivorId, reviewDigest } }));
const preview = (mergeId, who = "owner") => tx((t) => peopleUnmerge.previewUnmerge(t, ctx(who), { mergeId }));
const unmerge = (mergeId, expectedRevision, who = "owner", requestKey = key()) =>
	tx((t) => peopleUnmerge.unmergePeople(t, ctx(who), { requestKey, expectedRevision, input: { mergeId } }));
const counts = (r) => Object.fromEntries(r.references.map((x) => [x.kind, [x.count, x.treatment]]));
const attended = async (meetingId) =>
	Number(
		(
			await rows(sql`SELECT count(*)::int AS n FROM participation WHERE meeting_id=${meetingId}::uuid
 AND presence='attended' AND removed_at IS NULL`)
		)[0].n,
	);

async function seedBrooks(brooks, morgan, tag) {
	const night = await meeting(`Vision night ${tag}`, "2026-11-01");
	const lunch = await meeting(`Newcomer lunch ${tag}`, "2026-11-08");
	const guest = await person(`Dana Guest ${tag}`);
	const seed = {
		night,
		lunch,
		guest,
		attendance: await attend(night, brooks),
		invited: await attend(lunch, guest, { inviter: brooks, rsvp: "confirmed" }),
		morganAt: await attend(lunch, morgan, { rsvp: "confirmed" }),
		kitItem: await kit(night, brooks, `Bring the welcome cards ${tag}`),
		packed: await kit(night, brooks, `Name tags ${tag}`, true),
		openTask: await task(brooks, `Call about small groups ${tag}`, { due: "2026-12-01" }),
		doneTask: await task(brooks, `Send the welcome note ${tag}`, { status: "complete" }),
	};
	await subtask(seed.openTask, `Find their number ${tag}`);
	seed.team = await team(`Hospitality ${tag}`, brooks);
	seed.role = await role(seed.team, `Greeter ${tag}`);
	seed.earlier = await tenure(seed.role, brooks, "2026-01-01", "2026-05-31");
	seed.current = await tenure(seed.role, brooks, "2026-06-01", null, seed.earlier);
	const kids = await team(`Kids ${tag}`);
	seed.morganRole = await tenure(await role(kids, `Check-in ${tag}`), morgan, "2026-03-01");
	return seed;
}

test("AC:TARGET-PPL-025 AC:TARGET-PPL-017 a merge carries attendance, a guest they invited, kit items, tasks, a ministry role with its tenure history and team leadership to the survivor, refuses a stale review, repeats as the earlier result, and Unmerge restores it", async () => {
	const brooks = await person("Casey Brooks"),
		morgan = await person("Casey Morgan");
	const s = await seedBrooks(brooks, morgan, "A");
	const before = await history(brooks, morgan);
	const tablesBefore = await totals();

	const r = ok(await review(brooks, morgan));
	assert.deepEqual([r.survivor.displayName, r.source.displayName], ["Casey Morgan", "Casey Brooks"]);
	const c = counts(r);
	assert.deepEqual(
		[c.participation, c.participation_inviter, c.meeting_kit_item, c.task, c.team_tenure, c.team_leader],
		[
			[1, "move"],
			[1, "move"],
			[2, "move"],
			[2, "move"],
			[2, "move"],
			[1, "move"],
		],
	);
	assert.deepEqual(r.blockers, { causes: [], leadership: [], invitations: [] });
	assert.deepEqual(r.attendance, []);
	assert.deepEqual(r.openTasks, [{ title: "Call about small groups A", dueDate: "2026-12-01" }]);
	assert.deepEqual(r.openKitItems, [{ meeting: "Vision night A", text: "Bring the welcome cards A" }]);
	assert.doesNotMatch(JSON.stringify(r), /not available|unregistered_reference/);

	await admin.execute(
		sql`UPDATE task SET title='Call about small groups soon',revision=revision+1 WHERE id=${s.openTask}`,
	);
	const stale = { people: await people_(brooks, morgan), history: await history(brooks, morgan) };
	refused(await mergeWith(brooks, morgan, r.reviewDigest), "conflict");
	assert.deepEqual({ people: await people_(brooks, morgan), history: await history(brooks, morgan) }, stale);
	await admin.execute(
		sql`UPDATE task SET title='Call about small groups A',revision=revision+1 WHERE id=${s.openTask}`,
	);

	const fresh = ok(await review(brooks, morgan));
	const requestKey = key();
	const merged = ok(await mergeWith(brooks, morgan, fresh.reviewDigest, requestKey));
	const moved = await history(brooks, morgan);
	assert.deepEqual(await totals(), tablesBefore);
	const onBrooks = idsOf(moved, brooks);
	assert.ok(
		Object.values(onBrooks).every((ids) => ids.length === 0),
		JSON.stringify(onBrooks),
	);
	assert.deepEqual(idsOf(moved, morgan), {
		"participation.person_id": [s.attendance, s.morganAt].sort(),
		"participation.inviter_person_id": [s.invited],
		"meeting_kit_item.assignee_person_id": [s.kitItem, s.packed].sort(),
		"task.person_id": [s.openTask, s.doneTask].sort(),
		"team.leader_person_id": [s.team],
		"team_tenure.person_id": [s.earlier, s.current, s.morganRole].sort(),
		"invitation.resident_person_id": [],
	});
	for (const list of Object.values(moved)) assert.ok(list.every((x) => (x.plant_id ?? x.tenant_id) === plant));

	const owner = await authority();
	const night = ok(await meetingsReader.listGuests(db, owner, { meetingId: s.night }));
	assert.deepEqual(
		night.guests.map((g) => [g.person.displayName, g.presence]),
		[["Casey Morgan", "attended"]],
	);
	const lunch = ok(await meetingsReader.listGuests(db, owner, { meetingId: s.lunch }));
	assert.deepEqual(lunch.guests.map((g) => [g.person.displayName, g.inviter?.displayName ?? null]).sort(), [
		["Casey Morgan", null],
		["Dana Guest A", "Casey Morgan"],
	]);
	const items = ok(await meetingsReader.listKit(db, owner, { meetingId: s.night })).items;
	assert.deepEqual(items.map((i) => [i.text, i.assignee?.displayName, i.checked]).sort(), [
		["Bring the welcome cards A", "Casey Morgan", false],
		["Name tags A", "Casey Morgan", true],
	]);
	const open = ok(await tx((t) => taskReader.get(t, owner, { taskId: s.openTask }))).task;
	assert.deepEqual(
		[open.status, open.relation],
		["not_started", { kind: "person", id: morgan, label: "Casey Morgan" }],
	);
	assert.match(JSON.stringify(open.due), /2026-12-01/);
	const subtasks = ok(await tx((t) => taskReader.listSubtasks(t, owner, { parentId: s.openTask })));
	assert.deepEqual(
		subtasks.items.map((x) => x.title),
		["Find their number A"],
	);
	const hospitality = ok(await teamsReader.get(db, owner, { teamId: s.team }));
	assert.equal(hospitality.team.leaderPersonId, morgan);
	const roles = ok(await teamsReader.listPersonAssignments(db, owner, { personId: morgan })).assignments;
	assert.deepEqual(roles.map((x) => [x.roleName, x.startedOn, x.endedOn]).sort(), [
		["Check-in A", "2026-03-01", null],
		["Greeter A", "2026-01-01", "2026-05-31"],
		["Greeter A", "2026-06-01", null],
	]);

	const settled = { people: await people_(brooks, morgan), history: await history(brooks, morgan) };
	assert.deepEqual(ok(await mergeWith(brooks, morgan, fresh.reviewDigest, requestKey)), merged);
	assert.deepEqual({ people: await people_(brooks, morgan), history: await history(brooks, morgan) }, settled);
	refused(await mergeWith(brooks, morgan, fresh.reviewDigest));
	assert.deepEqual({ people: await people_(brooks, morgan), history: await history(brooks, morgan) }, settled);

	const p = ok(await preview(merged.mergeId));
	assert.deepEqual(p.conflicts, []);
	assert.deepEqual(
		Object.fromEntries(p.restores.map((x) => [x.kind, x.count])),
		Object.fromEntries(merged.moved.map((x) => [x.kind, x.count])),
	);
	assert.equal(ok(await unmerge(merged.mergeId, p.reviewRevision)).outcome, "changed");
	assert.deepEqual(await history(brooks, morgan), before);
	assert.deepEqual(await totals(), tablesBefore);
});

test("AC:TARGET-PPL-025 same-meeting attendance combines, an answered RSVP replaces a pending one, an inviter of the other is cleared, and Unmerge restores every row", async () => {
	const brooks = await person("Jamie Brooks"),
		morgan = await person("Jamie Morgan");
	const both = await meeting("Vision night B", "2026-11-01");
	const excused = await meeting("Vision night C", "2026-11-02");
	const onlySource = await meeting("Vision night D", "2026-11-03");
	const morganInvited = await meeting("Vision night E", "2026-11-04");
	const brooksInvited = await meeting("Vision night F", "2026-11-05");
	await attend(both, brooks, { rsvp: "pending" });
	await attend(both, morgan, { rsvp: "confirmed" });
	await attend(excused, brooks, { presence: "excused" });
	await attend(excused, morgan, { presence: "absent" });
	const pending = await attend(onlySource, brooks, { presence: "absent", rsvp: "pending" });
	await attend(morganInvited, morgan);
	const invitedByMorgan = await attend(morganInvited, brooks, { inviter: morgan });
	const invitedByBrooks = await attend(brooksInvited, morgan, { inviter: brooks });
	await attend(brooksInvited, brooks);
	const before = await history(brooks, morgan);
	assert.equal(await attended(both), 2);

	const r = ok(await review(brooks, morgan));
	const sorted = (list) => [...list].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
	assert.deepEqual(
		sorted(r.attendance),
		sorted([
			{ change: "rsvp_replaced", meeting: "Vision night B", pendingPersonId: brooks, answer: "confirmed" },
			{ change: "combined", meeting: "Vision night B", presence: "attended" },
			{ change: "combined", meeting: "Vision night C", presence: "excused" },
			{ change: "combined", meeting: "Vision night E", presence: "attended" },
			{ change: "inviter_cleared", meeting: "Vision night E", inviterPersonId: morgan },
			{ change: "inviter_cleared", meeting: "Vision night F", inviterPersonId: brooks },
			{ change: "combined", meeting: "Vision night F", presence: "attended" },
		]),
	);
	assert.deepEqual(r.blockers.causes, []);
	const merged = ok(await mergeWith(brooks, morgan, r.reviewDigest));

	const live = async (meetingId, personId) =>
		rows(sql`SELECT presence,rsvp,inviter_person_id FROM participation WHERE meeting_id=${meetingId}::uuid
 AND person_id=${personId}::uuid AND removed_at IS NULL`);
	assert.deepEqual(await live(both, morgan), [{ presence: "attended", rsvp: "confirmed", inviter_person_id: null }]);
	assert.deepEqual(await live(both, brooks), []);
	assert.equal(await attended(both), 1);
	assert.deepEqual(await live(excused, morgan), [{ presence: "excused", rsvp: null, inviter_person_id: null }]);
	assert.deepEqual(await live(onlySource, morgan), [{ presence: "absent", rsvp: "pending", inviter_person_id: null }]);
	assert.deepEqual(await live(morganInvited, morgan), [{ presence: "attended", rsvp: null, inviter_person_id: null }]);
	assert.deepEqual(await live(brooksInvited, morgan), [{ presence: "attended", rsvp: null, inviter_person_id: null }]);
	assert.deepEqual(
		(await rows(sql`SELECT person_id FROM participation WHERE id=${pending}::uuid`)).map((x) => x.person_id),
		[morgan],
	);
	assert.deepEqual(
		await rows(sql`SELECT id FROM participation WHERE plant_id=${plant}::uuid AND inviter_person_id=person_id`),
		[],
	);
	assert.deepEqual(
		await rows(sql`SELECT id FROM participation WHERE person_id=${brooks}::uuid AND removed_at IS NULL`),
		[],
	);
	const owner = await authority();
	const guests = ok(await meetingsReader.listGuests(db, owner, { meetingId: both })).guests;
	assert.deepEqual(
		guests.map((g) => [g.person.displayName, g.rsvp, g.presence]),
		[["Jamie Morgan", "confirmed", "attended"]],
	);

	const p = ok(await preview(merged.mergeId));
	assert.deepEqual(p.conflicts, []);
	assert.deepEqual(sorted(p.attendance), sorted(r.attendance));
	assert.ok(p.restores.some((x) => x.kind === "participation" && x.count === 5));
	assert.equal(ok(await unmerge(merged.mergeId, p.reviewRevision)).outcome, "changed");
	assert.deepEqual(await history(brooks, morgan), before);
	assert.equal(await attended(both), 2);
	assert.deepEqual(
		(
			await rows(sql`SELECT inviter_person_id FROM participation WHERE id IN (${invitedByMorgan}::uuid,${invitedByBrooks}::uuid)
 ORDER BY id`)
		).map((x) => x.inviter_person_id),
		[invitedByMorgan, invitedByBrooks].sort().map((id) => (id === invitedByMorgan ? morgan : brooks)),
	);
});

test("AC:TARGET-PPL-025 Unmerge after a moved record changed names it and changes nothing", async () => {
	const brooks = await person("Robin Brooks"),
		morgan = await person("Robin Morgan");
	const s = await seedBrooks(brooks, morgan, "G");
	const merged = ok(await mergeWith(brooks, morgan, ok(await review(brooks, morgan)).reviewDigest));
	await admin.execute(sql`UPDATE task SET status='in_progress',revision=revision+1 WHERE id=${s.openTask}`);
	const p = ok(await preview(merged.mergeId));
	assert.deepEqual([p.conflicts, p.changed], [["references_changed"], ["task"]]);
	assert.equal(
		unmergeBlockedText(p.conflicts, { source: "Robin Brooks", survivor: "Robin Morgan" }, p.changed),
		"Cannot unmerge. Robin Morgan’s tasks changed after the merge. An Unmerge would lose those changes, so Everyfield will not run it. Correct Robin’s details by hand instead; each change is kept in the history.",
	);
	const state = { people: await people_(brooks, morgan), history: await history(brooks, morgan) };
	const error = refused(await unmerge(merged.mergeId, p.reviewRevision), "inverse_conflict");
	assert.deepEqual(error.details, { causes: ["references_changed"], changed: ["task"] });
	assert.deepEqual({ people: await people_(brooks, morgan), history: await history(brooks, morgan) }, state);
});

test("AC:TARGET-PPL-025 both people holding a current role on the same team refuses the review and the confirm, naming the team and both roles, and changes nothing", async () => {
	const brooks = await person("Avery Brooks"),
		morgan = await person("Avery Morgan");
	const worship = await team("Worship");
	await tenure(await role(worship, "Vocals"), brooks, "2026-02-01");
	await tenure(await role(worship, "Guitar"), morgan, "2026-03-01");
	const ended = await team("Parking");
	await tenure(await role(ended, "Lot lead"), brooks, "2026-01-01", "2026-04-01");
	await tenure(await role(ended, "Attendant"), morgan, "2026-01-01");
	const details = {
		causes: ["leadership_conflict"],
		leadership: [{ team: "Worship", sourceRole: "Vocals", survivorRole: "Guitar" }],
		invitations: [],
	};
	const state = { people: await people_(brooks, morgan), history: await history(brooks, morgan) };
	const r = ok(await review(brooks, morgan));
	assert.deepEqual(r.blockers, details);
	assert.equal(
		mergeBlockedText(r.blockers, { source: "Avery Brooks", survivor: "Avery Morgan" }),
		"This merge cannot run. Avery Brooks is Vocals and Avery Morgan is Guitar on Worship. One person can’t hold two current roles on one team, so end one of those roles first.",
	);
	const error = refused(await mergeWith(brooks, morgan, r.reviewDigest), "merge_blocked");
	assert.deepEqual(error.details, details);
	assert.deepEqual({ people: await people_(brooks, morgan), history: await history(brooks, morgan) }, state);
});

test("AC:TARGET-PPL-025 a pending residency invitation refuses when the survivor already has one, and any other invitation moves to the survivor", async () => {
	const owner = await authority("orgOwner");
	const board = ok(await readPipelineBoard(db, owner, {}));
	const added = async (displayName) => {
		const personId = randomUUID();
		ok(
			await pipelineWriter.addPerson(db, owner, {
				personId,
				displayName,
				email: null,
				responsibleSeatId: null,
				stageId: board.stages[0].id,
			}),
		);
		return personId;
	};
	const invite = async (personId, email, state = "pending") => {
		const id = randomUUID();
		await admin.execute(sql`INSERT INTO invitation(id,tenant_id,purpose,recipient_email,token_hash,state,created_at,
 resident_person_id) VALUES(${id},${org.id},'residency_link',${email},${randomUUID()},${state},clock_timestamp(),${personId})`);
		return id;
	};
	const review_ = (sourceId, survivorId) =>
		tx((t) => peopleMerge.getMergeReview(t, ctx("orgOwner"), { sourceId, survivorId }));
	const merge_ = (sourceId, survivorId, reviewDigest) =>
		tx((t) =>
			peopleMerge.mergePeople(t, ctx("orgOwner"), { requestKey: key(), input: { sourceId, survivorId, reviewDigest } }),
		);

	const source = await added("Riley Stone"),
		survivor = await added("Riley Stone Keep");
	await invite(source, "riley@example.test");
	await invite(survivor, "riley.keep@example.test");
	const details = {
		causes: ["residency_invitation_collision"],
		leadership: [],
		invitations: [{ recipientEmail: "riley@example.test" }],
	};
	const state = { people: await people_(source, survivor), history: await history(source, survivor) };
	const r = ok(await review_(source, survivor));
	assert.deepEqual(r.blockers, details);
	assert.equal(
		mergeBlockedText(r.blockers, { source: "Riley Stone", survivor: "Riley Stone Keep" }),
		"This merge cannot run. Riley Stone has a pending residency invitation to riley@example.test, and Riley Stone Keep already has a residency link or a pending residency invitation. Revoke the invitation first.",
	);
	assert.deepEqual(refused(await merge_(source, survivor, r.reviewDigest), "merge_blocked").details, details);
	assert.deepEqual({ people: await people_(source, survivor), history: await history(source, survivor) }, state);

	const quinn = await added("Quinn Park"),
		keep = await added("Quinn Park Keep");
	const pending = await invite(quinn, "quinn@example.test");
	const expired = await invite(quinn, "quinn.old@example.test", "expired");
	await invite(keep, "quinn.keep@example.test", "revoked");
	const fine = ok(await review_(quinn, keep));
	assert.deepEqual(fine.blockers.causes, []);
	assert.deepEqual(counts(fine).invitation, [2, "move"]);
	ok(await merge_(quinn, keep, fine.reviewDigest));
	assert.deepEqual(
		(
			await rows(
				sql`SELECT id,resident_person_id,state FROM invitation WHERE id IN (${pending}::uuid,${expired}::uuid) ORDER BY id`,
			)
		).map((x) => [x.id, x.resident_person_id, x.state]),
		[
			[pending, keep, "pending"],
			[expired, keep, "expired"],
		].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
	);
});

test("AC:TARGET-PPL-025 a Member, another church and an organization seat cannot review, merge or unmerge, and learn nothing of the attendance, tasks, roles or invitations", async () => {
	const brooks = await person("Sky Brooks"),
		morgan = await person("Sky Morgan");
	await seedBrooks(brooks, morgan, "H");
	const digest = ok(await review(brooks, morgan)).reviewDigest;
	const secret = /Vision night H|Hospitality H|Greeter H|small groups H|welcome cards H|participation|team_tenure/;
	const state = { people: await people_(brooks, morgan), history: await history(brooks, morgan) };
	for (const who of ["member", "stranger", "orgOwner"]) {
		const r = await review(brooks, morgan, who);
		refused(r);
		assert.doesNotMatch(JSON.stringify(r), secret, who);
		refused(await mergeWith(brooks, morgan, digest, key(), who));
	}
	assert.deepEqual({ people: await people_(brooks, morgan), history: await history(brooks, morgan) }, state);
	const merged = ok(await mergeWith(brooks, morgan, digest));
	const revision = ok(await preview(merged.mergeId)).reviewRevision;
	for (const who of ["member", "stranger", "orgOwner"]) {
		const p = await preview(merged.mergeId, who);
		refused(p);
		assert.doesNotMatch(JSON.stringify(p), secret, who);
		refused(await unmerge(merged.mergeId, revision, who));
	}
	for (const list of Object.values(await history(morgan)))
		assert.ok(list.every((x) => (x.plant_id ?? x.tenant_id) === plant));
});
