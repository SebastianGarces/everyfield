import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture, ok, refused, type Actor } from "../../support/fixture.mts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { landingFor } from "../../../packages/contracts/src/identity/navigation.ts";
import { dashboardReader, dashboardWriter } from "../../../packages/domain/src/dashboard/index.ts";

// Overview (ADM-004, ADM-005) against a migrated database. Harvest Point (America/Chicago) with its Owner, Admin and
// Member. Rows are seeded the way their writers store them; times come from the database clock.

const database = await fixture({
	prefix: "dashboard",
	max: 6,
	plant: { name: "Harvest Point", timezone: "America/Chicago", onboarding_completed_at: sql`clock_timestamp()` },
});
const { admin, tenant, actors } = database;
const db = database.pools.runtime;
after(() => database.close());

const authority = async (a: Actor) => {
	const r = await RequestActor.resolve(db, a.session as never);
	assert.ok(r instanceof RequestActor, JSON.stringify(r));
	return r;
};
const run = (q: ReturnType<typeof sql>) => admin.execute(q);
const one = async (q: ReturnType<typeof sql>) => (await run(q)).rows[0] as Record<string, unknown>;
const P = tenant.id;

async function person(
	plant: string,
	columns: { stage?: string; state?: string; linked?: string | null; name?: string; created?: ReturnType<typeof sql> } = {},
) {
	const id = randomUUID();
	await run(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,
		pipeline_position,state,linked_account_id,created_at,revision)
		VALUES(${id},${plant},${plant},${columns.name ?? "Someone"},'other',${columns.stage ?? "prospect"},'unknown','unknown',
		random()*1000,${columns.state ?? "live"},${columns.linked ?? null},${columns.created ?? sql`clock_timestamp()`},1)`);
	return id;
}
/** A task assigned to `assignee`, due `days` church-local days from today (negative is past). */
async function task(plant: string, assignee: string | null, days: number, status = "not_started", title = "A task") {
	const id = randomUUID();
	await run(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,completed_at,due_kind,due_date)
		VALUES(${id},${plant},${title},'general','medium',${status},clock_timestamp(),
		${status === "complete" ? sql`clock_timestamp()` : null},'date_only',
		(clock_timestamp() AT TIME ZONE 'America/Chicago')::date + ${days}::int)`);
	if (assignee)
		await run(sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${plant},${id},${assignee})`);
	return id;
}
async function meeting(plant: string, status: string, extra: { voided?: boolean; type?: string; title?: string } = {}) {
	const id = randomUUID();
	await run(sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,status,
		attendance_revision,actual_occurrence_at,occurrence_voided_at)
		VALUES(${id},${plant},${extra.type ?? "vision_meeting"},${extra.title ?? "Vision night"},'2026-10-01','18:00',
		'America/Chicago','2026-10-01T23:00:00Z','1',${status},1,
		${status === "completed" ? sql`clock_timestamp()-interval '1 day'` : null},
		${extra.voided ? sql`clock_timestamp()` : null})`);
	return id;
}
/** An audit row as its writer stores it, `ago` minutes before now. */
async function audit(row: {
	actor: string | null;
	action: string;
	kind: string;
	subjectType: string;
	subject: string;
	ago: number;
	after?: object;
	metadata?: object;
}) {
	await run(sql`INSERT INTO audit_event(tenant_id,actor_id,system_cause,action,kind,subject_type,subject_id,after_value,
		occurred_at,metadata) VALUES(${P},${row.actor},${row.actor ? null : "test"},${row.action},${row.kind},
		${row.subjectType},${row.subject},${row.after ? JSON.stringify(row.after) : null}::jsonb,
		clock_timestamp()-make_interval(mins=>${row.ago}),${JSON.stringify(row.metadata ?? {})}::jsonb)`);
}

test("AC:CASE-ADM-004 home comes from the seat and the saved setup, never from the address", async () => {
	// A Discovery account with no seat lands on its own onboarding page, and no church is created for it.
	const discovery = await database.actor(null);
	const plants = await one(sql`SELECT count(*)::int AS n FROM plant`);
	const none = await dashboardReader.resolveHome(db, await authority(discovery));
	assert.equal(none, "none");
	assert.equal(landingFor({ status: "active", plant: none }), "/onboarding");
	assert.deepEqual(await one(sql`SELECT count(*)::int AS n FROM plant`), plants);

	// A church whose setup is saved complete lands on Overview.
	const done = await dashboardReader.resolveHome(db, await authority(actors.owner));
	assert.equal(done, "complete");
	assert.equal(landingFor({ status: "active", plant: done }), "/overview");

	// An unfinished church returns to setup, whatever the address claims.
	const unfinished = await database.plant({ name: "Eastside", onboarding_completed_at: null });
	const planter = await database.actor(unfinished, "owner");
	const home = await dashboardReader.resolveHome(db, await authority(planter));
	assert.equal(home, "incomplete");
	for (const returnTo of ["/overview", "/overview?setup=done", "/people"])
		assert.equal(landingFor({ status: "active", plant: home, returnTo }), "/onboarding");

	// A sending church's seat goes to its organization home.
	const church = await database.organization("sending_church");
	const reader = await database.actor(church, "owner");
	assert.equal(await dashboardReader.resolveHome(db, await authority(reader)), "organization");
	assert.equal(landingFor({ status: "active", plant: "organization" }), "/network");
	// An organization seat has no plant dashboard to read.
	refused(await dashboardReader.readMetrics(db, await authority(reader)), "access_denied");
	refused(await dashboardReader.readAvailableActions(db, await authority(reader)), "access_denied");
});

test("AC:CASE-ADM-005 four counts: recruited without the church's own logins, live People, my overdue, held Vision Meetings", async () => {
	const w = await database.plant({ name: "Harvest Point", timezone: "America/Chicago" });
	const owner = await database.actor(w, "owner");
	const other = await database.actor(w, "admin");
	const member = await database.actor(w, "member");
	// 30 People in core group, launch team or leader; 2 of them are the church's own logins. A former login whose seat
	// ended is recruited like anyone else.
	await person(w.id, { stage: "core_group", linked: owner.id });
	await person(w.id, { stage: "leader", linked: other.id });
	const former = await database.actor(w, "member");
	await run(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${former.id}`);
	await person(w.id, { stage: "core_group", linked: former.id });
	for (let i = 0; i < 27; i++) await person(w.id, { stage: ["core_group", "launch_team", "leader"][i % 3] });
	// 110 more live People in earlier stages (140 live in all), and People that are not counted at all.
	for (let i = 0; i < 110; i++) await person(w.id, { stage: i % 2 ? "prospect" : "attendee" });
	await person(w.id, { stage: "core_group", state: "retired" });
	await person(w.id, { stage: "leader", state: "merged" });
	// 3 overdue tasks for the Owner, 5 for the Admin, and Owner tasks that are not overdue.
	for (let i = 0; i < 3; i++) await task(w.id, owner.id, -2 - i);
	for (let i = 0; i < 5; i++) await task(w.id, other.id, -3);
	await task(w.id, owner.id, 0);
	await task(w.id, owner.id, 4);
	await task(w.id, owner.id, -5, "complete");
	await task(w.id, owner.id, -5, "no_longer_needed");
	const deleted = await task(w.id, owner.id, -5);
	await run(sql`UPDATE task SET deleted_at=clock_timestamp() WHERE id=${deleted}`);
	// The Member has one overdue task of their own.
	await task(w.id, member.id, -1);
	// 4 held Vision Meetings; a planned one, a voided one, a deleted one and a held orientation are not counted.
	for (let i = 0; i < 4; i++) await meeting(w.id, "completed");
	await meeting(w.id, "planning");
	await meeting(w.id, "completed", { voided: true });
	const gone = await meeting(w.id, "completed");
	await run(sql`UPDATE meeting SET retired_at=clock_timestamp() WHERE id=${gone}`);
	await meeting(w.id, "completed", { type: "orientation" });

	assert.deepEqual(ok(await dashboardReader.readMetrics(db, await authority(owner))), {
		recruited: 28,
		people: 140,
		myOverdueTasks: 3,
		visionMeetings: 4,
	});
	const seen = ok(await dashboardReader.readMetrics(db, await authority(member)));
	assert.equal(seen.myOverdueTasks, 1);
	assert.equal(seen.recruited, 28);

	// Quick actions come from the live seat: every one for an Owner, none for a Member.
	const owners = ok(await dashboardReader.readAvailableActions(db, await authority(owner)));
	assert.deepEqual(owners.actions, ["add_person", "import_people", "plan_meeting", "set_launch_date"]);
	assert.equal(owners.role, "owner");
	const members = ok(await dashboardReader.readAvailableActions(db, await authority(member)));
	assert.deepEqual(members.actions, []);
	assert.deepEqual(members.prompts, []);
	assert.equal(members.role, "member");

	// A seat that ended reads nothing, not zeros.
	const ended = await authority(member);
	await run(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${member.id}`);
	refused(await dashboardReader.readMetrics(db, ended), "access_denied");
	refused(await dashboardReader.readActivity(db, ended), "access_denied");
	refused(await dashboardReader.readAvailableActions(db, ended), "access_denied");
});

test("AC:CASE-ADM-005 the activity feed: 20 newest, who and when, corrections as corrections, only what the viewer can open", async () => {
	const owner = actors.owner.id;
	const maria = await person(P, { name: "Maria Santos" });
	const vision = await meeting(P, "completed", { title: "Vision night #12" });
	const done = await task(P, owner, -1, "complete", "Call James");
	const removed = await task(P, owner, -1, "complete", "Deleted task");
	await run(sql`UPDATE task SET deleted_at=clock_timestamp() WHERE id=${removed}`);
	// Old rows first: 25 people added long ago, so only the newest 20 entries show.
	for (let i = 0; i < 25; i++)
		await audit({
			actor: owner,
			action: "people.created",
			kind: "create",
			subjectType: "person",
			subject: await person(P, { name: `Old ${i}` }),
			ago: 600 + i,
		});
	await audit({ actor: owner, action: "people.created", kind: "create", subjectType: "person", subject: maria, ago: 9 });
	await audit({
		actor: owner,
		action: "meetings.finalized",
		kind: "finalize",
		subjectType: "meeting",
		subject: vision,
		ago: 8,
		metadata: { event: "attendance_finalized" },
	});
	await audit({ actor: owner, action: "tasks.completed", kind: "complete", subjectType: "task", subject: done, ago: 7 });
	await audit({ actor: owner, action: "tasks.completed", kind: "complete", subjectType: "task", subject: removed, ago: 6 });
	await audit({
		actor: owner,
		action: "launch.changed",
		kind: "edit",
		subjectType: "launch",
		subject: P,
		ago: 5,
		after: { status: "scheduled", targetDate: "2026-11-10" },
		metadata: { event: "moved" },
	});
	await audit({
		actor: owner,
		action: "phase.transitioned",
		kind: "edit",
		subjectType: "plant",
		subject: P,
		ago: 4,
		after: { phase: 2 },
	});
	// Attendance on the held meeting corrected later: a correction of that meeting, not a new meeting.
	await audit({
		actor: actors.admin.id,
		action: "meetings.finalized",
		kind: "reconcile",
		subjectType: "meeting",
		subject: vision,
		ago: 3,
		metadata: { event: "attendance_reconciled" },
	});
	// Noise the feed never shows: a no-op and a seat change.
	await audit({ actor: owner, action: "people.created", kind: "noop", subjectType: "person", subject: maria, ago: 2 });
	await audit({ actor: owner, action: "settings.changed", kind: "edit", subjectType: "plant", subject: P, ago: 1 });

	const feed = ok(await dashboardReader.readActivity(db, await authority(actors.owner)));
	assert.equal(feed.timeZone, "America/Chicago");
	assert.equal(feed.entries.length, 20);
	assert.equal(feed.more, true);
	assert.deepEqual(
		feed.entries.slice(0, 6).map((e) => e.change),
		[
			{ kind: "attendance_corrected", meetingId: vision, title: "Vision night #12", meetingType: "vision_meeting" },
			{ kind: "phase_changed", phase: 2 },
			{ kind: "launch_date", event: "moved", date: "2026-11-10" },
			{ kind: "task_completed", taskId: done, title: "Call James" },
			{ kind: "meeting_held", meetingId: vision, title: "Vision night #12", meetingType: "vision_meeting" },
			{ kind: "person_added", personId: maria, name: "Maria Santos" },
		],
	);
	assert.deepEqual(feed.entries[0].actor, { accountId: actors.admin.id, displayName: "Synthetic" });
	const times = feed.entries.map((e) => Date.parse(e.at));
	assert.deepEqual(times, [...times].sort((a, b) => b - a));

	// A Member sees the same feed without the phase change, which only Owners and Admins can open.
	const members = ok(await dashboardReader.readActivity(db, await authority(actors.member)));
	assert.deepEqual(
		members.entries.slice(0, 5).map((e) => e.change.kind),
		["attendance_corrected", "launch_date", "task_completed", "meeting_held", "person_added"],
	);
	assert.ok(!members.entries.some((e) => e.change.kind === "phase_changed"));
});

test("AC:CASE-ADM-005 a dismissed prompt stays dismissed for that person and changes no number or setup step", async () => {
	const w = await database.plant({ name: "Fresh", timezone: "America/Chicago" });
	const owner = await database.actor(w, "owner");
	const other = await database.actor(w, "admin");
	const member = await database.actor(w, "member");
	await person(w.id, { stage: "core_group", linked: owner.id });
	// A church created today is in its first week.
	await run(sql`INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id)
		VALUES(${w.id},${owner.id},'plant.created','create','plant',${w.id})`);
	const before = ok(await dashboardReader.readAvailableActions(db, await authority(owner)));
	assert.equal(before.firstWeek, true);
	assert.equal(before.createdOn, before.today);
	assert.deepEqual(before.setup, {
		setupComplete: false,
		gaps: ["add_people", "plan_vision_meeting", "set_launch_date"],
	});
	assert.deepEqual(before.prompts, ["import_people"]);
	// Only the church's own login is a Person: the first-week numbers are real zeros.
	const metrics = ok(await dashboardReader.readMetrics(db, await authority(owner)));
	assert.deepEqual(metrics, { recruited: 0, people: 1, myOverdueTasks: 0, visionMeetings: 0 });

	const dismissed = ok(await dashboardWriter.dismissPrompt(db, await authority(owner), { prompt: "import_people" }));
	assert.deepEqual(dismissed, { outcome: "changed", prompt: "import_people" });
	// Saved on the server: a second dismissal writes nothing, and every later read (any browser) still hides it.
	assert.deepEqual(ok(await dashboardWriter.dismissPrompt(db, await authority(owner), { prompt: "import_people" })), {
		outcome: "noop",
		prompt: "import_people",
	});
	const after = ok(await dashboardReader.readAvailableActions(db, await authority(owner)));
	assert.deepEqual(after.prompts, []);
	assert.deepEqual(after.setup, before.setup);
	assert.deepEqual(ok(await dashboardReader.readMetrics(db, await authority(owner))), metrics);
	assert.deepEqual(ok(await dashboardReader.readPromptState(db, await authority(owner))), {
		dismissed: ["import_people"],
	});
	assert.deepEqual(ok(await dashboardReader.readSetupGaps(db, await authority(owner))), before.setup);
	// The dismissal is this person's: another Admin still sees the prompt.
	assert.deepEqual(ok(await dashboardReader.readAvailableActions(db, await authority(other))).prompts, [
		"import_people",
	]);
	assert.deepEqual(ok(await dashboardReader.readPromptState(db, await authority(member))), { dismissed: [] });
	refused(await dashboardWriter.dismissPrompt(db, await authority(owner), { prompt: "anything" }), "invalid_input");
	// The audit row names the field and the prompt only.
	const row = await one(sql`SELECT action,kind,subject_type,before_value,after_value,metadata FROM audit_event
		WHERE tenant_id=${w.id} AND action='settings.changed'`);
	assert.deepEqual(row, {
		action: "settings.changed",
		kind: "edit",
		subject_type: "seat",
		before_value: null,
		after_value: null,
		metadata: { section: "overview_prompts", fields: ["dismissedPrompts"], prompt: "import_people" },
	});
});
