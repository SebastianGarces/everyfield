import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { migrate } from "../../../packages/db/src/schema/migrate.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createSeatService } from "../../../packages/domain/src/identity/index.ts";
import { teamsReader, teamsWriter, trainingReader, trainingWriter } from "../../../packages/domain/src/teams/index.ts";
import {
	createRsvpToken,
	describeRsvpToken,
	guestsWriter,
	meetingsReader,
	meetingsWriter,
	rosterReader,
	rosterWriter,
} from "../../../packages/domain/src/meetings/index.ts";
import { executeWrites } from "../../../packages/domain/src/operations/writes.ts";

const noReminders = async () => {
	throw Error("unexpected task reminder replan");
};
const source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
const localCi =
	process.env.CI === "true" &&
	process.env.EARLY_ACCESS_TEST_DATABASE === "1" &&
	["localhost", "127.0.0.1"].includes(source.hostname) &&
	source.pathname === "/everyfield_ci";
if (
	(!localCi && source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech") ||
	process.env.NODE_ENV === "production"
)
	throw Error("Only approved shared development or disposable CI endpoint allowed");
if (!localCi) source.searchParams.set("sslmode", "verify-full");
const schema = "wp017m_" + randomUUID().replaceAll("-", "");
const roleName = "wp017m_" + randomBytes(8).toString("hex");
const admin = createDatabase({
	connectionString: source.href,
	max: 4,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
let db;
const P = randomUUID();
const Q = randomUUID();
const actors = Array.from({ length: 5 }, () => ({ id: randomUUID(), user: randomUUID(), session: randomUUID() }));
const ctx = (who = 0) => ({ session: actors[who].session, selected: { kind: "plant", id: who === 3 ? Q : P } });
const ok = (result) => {
	assert.equal(result.status, "ok", JSON.stringify(result));
	return result.value;
};
const refused = (result, code = "unavailable") => {
	assert.equal(result.status, "refused", JSON.stringify(result));
	assert.equal(result.error.code, code, JSON.stringify(result.error));
	return result.error;
};
const tx = (body) => db.transaction(body);
const run = (op, input, who = 0) => tx((t) => op(t, ctx(who), input));
const key = () => randomUUID();
const viewer = async (who = 0) => RequestActor.resolve(db, actors[who].session);
const count = async (query) => Number((await admin.execute(query)).rows[0].n);
const rev = async (table, id) =>
	(await admin.execute(sql.raw(`SELECT revision::text AS r FROM ${table} WHERE id='${id}'`))).rows[0].r;

async function person(name, fields = {}) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,
		pipeline_position,state,created_at,linked_account_id) VALUES(${id},${fields.plant ?? P},${fields.plant ?? P},${name},'other',
		${fields.stage ?? "prospect"},'unknown','unknown',0,'live',clock_timestamp(),${fields.account ?? null})`);
	return id;
}
async function makeTeam(name, who = 0) {
	const team = ok(await run(teamsWriter.create, { requestKey: key(), input: { name } }, who)).team;
	const stored = Number((await admin.execute(sql`SELECT sort_order FROM team WHERE id=${team.id}`)).rows[0].sort_order);
	assert.equal(team.sortOrder, stored);
	return team;
}
async function makeRole(teamId, name, fields = {}) {
	return ok(
		await run(teamsWriter.createRole, {
			requestKey: key(),
			input: { teamId, name, ...fields },
		}),
	).role;
}
before(async () => {
	await admin.execute(sql.raw(`CREATE SCHEMA ${schema}`));
	await migrate(admin, schema);
	const password = randomBytes(32).toString("hex");
	await admin.execute(
		sql.raw(
			`CREATE ROLE ${roleName} LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
		),
	);
	await admin.execute(sql.raw(`GRANT everyfield_runtime TO ${roleName}`));
	const url = new URL(source);
	url.username = roleName;
	url.password = password;
	db = createDatabase({ connectionString: url.href, max: 6, options: `-c search_path=${schema},pg_catalog,pg_temp` });
	for (const a of actors) {
		await admin.execute(
			sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${a.user},${a.id + "@example.test"},true,'Synthetic')`,
		);
		await admin.execute(
			sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${a.id},${a.user},'active','planter')`,
		);
		await admin.execute(
			sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${a.session},${a.user},${randomUUID()},clock_timestamp()+interval '1 day')`,
		);
	}
	for (const [id, zone] of [
		[P, "America/Chicago"],
		[Q, "America/New_York"],
	])
		await admin.execute(
			sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${id},'Synthetic',${zone},7,14,1,8,1,1)`,
		);
	for (const [i, plant, seatRole] of [
		[0, P, "owner"],
		[1, P, "member"],
		[2, P, "admin"],
		[3, Q, "admin"],
		[4, P, "member"],
	])
		await admin.execute(
			sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${actors[i].id},${plant},${seatRole},clock_timestamp())`,
		);
});
after(async () => {
	if (db) await closeDatabase(db);
	try {
		await admin.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
		await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${roleName}`));
	} finally {
		await closeDatabase(admin);
	}
});

// WP-017 remaining work: team meetings and their guest list from a ministry (REQ-MTG-007), the ministry's meetings,
// seat removal from the Owner's side (REQ-IDN-019) and role date corrections from the People side (REQ-TEAM-006).

/** A local date `days` from today. */
const day = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
async function assign(team, role, personId) {
	return ok(
		await run(teamsWriter.assignRole, {
			requestKey: key(),
			expectedRevision: await rev("team_role", role.id),
			input: { roleId: role.id, teamId: team.id, personId },
		}),
	);
}
async function leave(team, personId) {
	return ok(
		await run(teamsWriter.endMembership, {
			requestKey: key(),
			expectedRevision: await rev("team", team.id),
			input: { teamId: team.id, personId },
		}),
	);
}
const plan = (fields, who = 0) =>
	run(
		meetingsWriter.schedule,
		{ requestKey: key(), input: { type: "team_meeting", date: day(7), time: "19:00", ...fields } },
		who,
	);
const guestsOf = async (meetingId, who = 0) =>
	ok(await meetingsReader.listGuests(db, await viewer(who), { meetingId })).guests;
/** The live Person linked to an actor's account, made once. */
async function own(who, name, fields = {}) {
	const found = await admin.execute(
		sql`SELECT id FROM person WHERE linked_account_id=${actors[who].id} AND plant_id=${P}`,
	);
	return found.rows[0]?.id ?? person(name, { ...fields, account: actors[who].id });
}
const names = (list) => list.map((g) => g.person?.displayName ?? g.displayName).sort();

/**
 * A ministry with six people serving now (the first in two roles), one whose role ended and one who is no longer live.
 */
async function worship(label) {
	const team = await makeTeam(`Worship ${label}`);
	const lead = await makeRole(team.id, "Worship lead", { leadership: true });
	const people = [];
	for (let i = 1; i <= 6; i++) people.push(await person(`${label} Singer ${i}`));
	await assign(team, lead, people[0]);
	await assign(team, await makeRole(team.id, "Keys"), people[0]);
	for (let i = 1; i < 6; i++) await assign(team, await makeRole(team.id, `Seat ${i}`), people[i]);
	const former = await person(`${label} Former`);
	await assign(team, await makeRole(team.id, "Former seat"), former);
	await leave(team, former);
	const gone = await person(`${label} Gone`);
	await assign(team, await makeRole(team.id, "Gone seat"), gone);
	await admin.execute(sql`UPDATE person SET state='retired', retired_at=clock_timestamp() WHERE id=${gone}`);
	return { team, people, former, gone };
}

test("AC:TARGET-MTG-007 a team meeting needs one current ministry and an Owner or Admin", async () => {
	const team = await makeTeam("Hospitality planning");
	// A Member who leads the ministry still plans no meeting.
	const lead = await own(1, "Member Lead", { stage: "launch_team" });
	await assign(team, await makeRole(team.id, "Host lead", { leadership: true }), lead);
	refused(await plan({ teamId: team.id }, 1));
	const missing = refused(await plan({}), "invalid_input");
	assert.deepEqual(
		missing.details.issues.map((i) => [i.path, i.problem]),
		[["input.teamId", "team_meeting_needs_one_team"]],
	);
	refused(await plan({ type: "orientation", teamId: team.id }), "invalid_input");
	const other = ok(await run(teamsWriter.create, { requestKey: key(), input: { name: "Other church" } }, 3)).team;
	refused(await plan({ teamId: other.id }), "team_unavailable");
	const archived = await makeTeam("Archived ministry");
	ok(
		await run(teamsWriter.archive, {
			requestKey: key(),
			expectedRevision: await rev("team", archived.id),
			input: { teamId: archived.id },
		}),
	);
	refused(await plan({ teamId: archived.id }), "team_unavailable");
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM meeting WHERE type='team_meeting'`), 0);
	const made = ok(await plan({ teamId: team.id }, 2)).meeting;
	assert.equal(made.type, "team_meeting");
	assert.deepEqual(made.team, { id: team.id, name: "Hospitality planning" });
});

test("AC:TARGET-MTG-007 a team meeting's guest list is each person serving now, once, invited and absent", async () => {
	const w = await worship("Copy");
	const made = ok(await plan({ teamId: w.team.id })).meeting;
	assert.equal(made.guestCount, 6);
	const guests = await guestsOf(made.id);
	assert.deepEqual(
		names(guests),
		w.people.map((_, i) => `Copy Singer ${i + 1}`),
	);
	assert.equal(new Set(guests.map((g) => g.person.personId)).size, 6);
	assert.deepEqual([...new Set(guests.map((g) => `${g.rsvp}/${g.presence}/${g.inviter}`))], ["pending/absent/null"]);
	// The same meeting id in the global list and in the ministry's list, which a Member reads too.
	const all = ok(await meetingsReader.list(db, await viewer(), { types: ["team_meeting"] }));
	assert.ok(all.items.some((m) => m.id === made.id && m.team?.id === w.team.id));
	const mine = ok(await meetingsReader.list(db, await viewer(1), { teamId: w.team.id }));
	assert.deepEqual(
		mine.items.map((m) => m.id),
		[made.id],
	);
});

test("AC:TARGET-MTG-007 the guest list changes only through a reviewed update from the ministry", async () => {
	const w = await worship("Sync");
	const made = ok(await plan({ teamId: w.team.id })).meeting;
	const byHand = await person("Sync Visitor");
	ok(
		await run(guestsWriter.inviteGuest, {
			requestKey: key(),
			input: { meetingId: made.id, personId: byHand, inviterPersonId: null },
		}),
	);
	const departed = w.people[5],
		present = w.people[4];
	const token = await tx(async (t) => {
		const writes = [];
		const issued = await createRsvpToken(t, ctx(), { meetingId: made.id, personId: departed }, writes);
		await executeWrites(t, writes);
		return issued;
	});
	await admin.execute(
		sql`UPDATE participation SET presence='attended' WHERE meeting_id=${made.id} AND person_id=${present}`,
	);
	const joined = await person("Sync Newcomer");
	await assign(w.team, await makeRole(w.team.id, "Newcomer seat"), joined);
	await leave(w.team, departed);
	await leave(w.team, present);
	const listed = names(await guestsOf(made.id));
	// Opening the meeting shows the copy as it was.
	assert.equal(listed.length, 7);
	assert.ok(listed.includes("Sync Singer 6") && !listed.includes("Sync Newcomer"));

	const preview = ok(await rosterReader.previewRosterImport(db, await viewer(), { meetingId: made.id }));
	assert.deepEqual(preview.team, { id: w.team.id, name: w.team.name });
	assert.deepEqual(names(preview.add), ["Sync Newcomer"]);
	assert.deepEqual(names(preview.remove), ["Sync Singer 6"]);
	assert.deepEqual(names(preview.kept), ["Sync Singer 5"]);
	// Looking is not changing: the list after the preview (and a reload) is the same.
	assert.deepEqual(names(await guestsOf(made.id)), listed);
	refused(await rosterReader.previewRosterImport(db, await viewer(1), { meetingId: made.id }));

	// A review that no longer matches the ministry changes nothing.
	refused(
		await run(rosterWriter.copyTeamRoster, {
			requestKey: key(),
			input: { meetingId: made.id, add: [joined], remove: [] },
		}),
		"conflict",
	);
	refused(
		await run(
			rosterWriter.copyTeamRoster,
			{ requestKey: key(), input: { meetingId: made.id, add: [joined], remove: [departed] } },
			1,
		),
	);
	assert.deepEqual(names(await guestsOf(made.id)), listed);

	const audits = await count(sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${made.id}`);
	const request = { requestKey: key(), input: { meetingId: made.id, add: [joined], remove: [departed] } };
	const updated = ok(await run(rosterWriter.copyTeamRoster, request));
	assert.equal(updated.outcome, "changed");
	assert.deepEqual(names(updated.added), ["Sync Newcomer"]);
	assert.deepEqual([updated.added[0].rsvp, updated.added[0].presence], ["pending", "absent"]);
	assert.deepEqual(updated.removedPersonIds, [departed]);
	const after = names(await guestsOf(made.id));
	assert.deepEqual(after, [...listed.filter((n) => n !== "Sync Singer 6"), "Sync Newcomer"].sort());
	assert.ok(after.includes("Sync Visitor") && after.includes("Sync Singer 5"));
	// Removed as by hand: off the current list, its link closed, its row and history kept.
	const row = (
		await admin.execute(
			sql`SELECT removed_at IS NOT NULL AS removed, rsvp_token_open FROM participation WHERE meeting_id=${made.id} AND person_id=${departed}`,
		)
	).rows[0];
	assert.deepEqual(row, { removed: true, rsvp_token_open: false });
	assert.deepEqual(await describeRsvpToken(db, { token: token.token }), { state: "unavailable" });
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${made.id}`), audits + 1);

	// The same request again returns the first answer and writes nothing.
	assert.deepEqual(ok(await run(rosterWriter.copyTeamRoster, request)), updated);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${made.id}`), audits + 1);
	assert.deepEqual(names(await guestsOf(made.id)), after);

	// Up to date: nothing to add or remove, the present guest still named as kept, and an empty update changes nothing.
	const fresh = ok(await rosterReader.previewRosterImport(db, await viewer(), { meetingId: made.id }));
	assert.deepEqual([fresh.add, fresh.remove, names(fresh.kept)], [[], [], ["Sync Singer 5"]]);
	const none = ok(
		await run(rosterWriter.copyTeamRoster, {
			requestKey: key(),
			input: { meetingId: made.id, add: [], remove: [] },
		}),
	);
	assert.deepEqual([none.outcome, none.added, none.removedPersonIds], ["noop", [], []]);

	// A person who rejoins comes back as the same guest row.
	await assign(w.team, await makeRole(w.team.id, "Return seat"), departed);
	const back = ok(await rosterReader.previewRosterImport(db, await viewer(), { meetingId: made.id }));
	assert.deepEqual(names(back.add), ["Sync Singer 6"]);
	const again = ok(
		await run(rosterWriter.copyTeamRoster, {
			requestKey: key(),
			input: { meetingId: made.id, add: [departed], remove: [] },
		}),
	);
	assert.equal(
		again.added[0].id,
		(await admin.execute(sql`SELECT id FROM participation WHERE meeting_id=${made.id} AND person_id=${departed}`))
			.rows[0].id,
	);
	assert.equal(
		await count(
			sql`SELECT count(*)::int AS n FROM participation WHERE meeting_id=${made.id} AND person_id=${departed}`,
		),
		1,
	);

	// A meeting that is not a team meeting has no ministry to update from.
	const vision = ok(
		await run(meetingsWriter.schedule, {
			requestKey: key(),
			input: { type: "vision_meeting", date: day(9), time: "18:30" },
		}),
	).meeting;
	refused(await rosterReader.previewRosterImport(db, await viewer(), { meetingId: vision.id }), "wrong_meeting_type");
});

test("AC:TARGET-TEAM-001 a ministry lists its meetings, upcoming first, then past newest first", async () => {
	const team = await makeTeam("Worship meetings");
	const member = await own(1, "Worship Member");
	await assign(team, await makeRole(team.id, "Vocals"), member);
	const older = ok(await plan({ teamId: team.id, date: day(-21) })).meeting;
	const newer = ok(await plan({ teamId: team.id, date: day(-7) })).meeting;
	const upcoming = ok(await plan({ teamId: team.id, date: day(14) })).meeting;
	const other = await makeTeam("Quiet ministry");
	await plan({ teamId: other.id, date: day(3) });
	const list = async (teamId, who) =>
		ok(await meetingsReader.list(db, await viewer(who), { teamId })).items.map((m) => [
			m.id,
			m.localDate,
			m.localTime,
			m.status,
		]);
	const expected = [
		[upcoming.id, day(14), "19:00", "planning"],
		[newer.id, day(-7), "19:00", "planning"],
		[older.id, day(-21), "19:00", "planning"],
	];
	assert.deepEqual(await list(team.id, 1), expected);
	ok(
		await run(teamsWriter.archive, {
			requestKey: key(),
			expectedRevision: await rev("team", team.id),
			input: { teamId: team.id },
		}),
	);
	assert.deepEqual(await list(team.id, 1), expected);
	const empty = await makeTeam("No meetings yet");
	assert.deepEqual(await list(empty.id, 1), []);
});

test("AC:TARGET-IDN-019 removing a leader's seat leaves the ministry without a leader and keeps their history", async () => {
	const team = await makeTeam("Hospitality");
	const role = await makeRole(team.id, "Hospitality lead", { leadership: true });
	const host = await person("Hosting Member", { account: actors[4].id, stage: "launch_team" });
	const filled = await assign(team, role, host);
	assert.equal(
		(await admin.execute(sql`SELECT leader_person_id FROM team WHERE id=${team.id}`)).rows[0].leader_person_id,
		host,
	);
	const seat = (
		await admin.execute(
			sql`SELECT id, revision::text AS r FROM seat WHERE account_id=${actors[4].id} AND plant_id=${P}`,
		)
	).rows[0];
	await createSeatService(db).remove(
		await viewer(0),
		{ kind: "plant", id: P },
		{ requestKey: key(), expectedRevision: seat.r, input: { seatId: seat.id, expectedRole: "member", handoffs: [] } },
		noReminders,
	);
	const teams = ok(await teamsReader.list(db, await viewer(), {})).items;
	assert.equal(teams.find((t) => t.id === team.id).leaderPersonId, null);
	const chart = ok(await teamsReader.readOrgChart(db, await viewer(), {})).nodes;
	assert.equal(chart.find((n) => n.id === team.id).leaderName, null);
	// The ministry's history records the leader leaving with the seat, after the role was filled.
	const history = ok(await teamsReader.listHistory(db, await viewer(), { teamId: team.id })).entries;
	assert.deepEqual(
		history.map((e) => [e.kind, e.after]),
		[["leader_change", null], ...history.slice(1).map((e) => [e.kind, e.after])],
	);
	assert.equal(history[0].actorName, "Synthetic");
	const members = ok(await teamsReader.listMembers(db, await viewer(), { teamId: team.id })).members;
	const started = members.find((m) => m.personId === host)?.startedOn;
	assert.equal(
		started,
		filled.tenureId
			? (await admin.execute(sql`SELECT started_on::text AS d FROM team_tenure WHERE id=${filled.tenureId}`)).rows[0].d
			: null,
	);
	const roles = ok(await teamsReader.listPersonAssignments(db, await viewer(), { personId: host })).assignments;
	assert.deepEqual(
		roles.map((r) => [r.teamName, r.roleName, r.startedOn, r.endedOn]),
		[["Hospitality", "Hospitality lead", started, null]],
	);
});

test("AC:TARGET-TEAM-006 an Owner or Admin corrects a role's dates with a reason, and the history names it", async () => {
	const team = await makeTeam("Dates ministry");
	const role = await makeRole(team.id, "Greeter");
	const alex = await person("Alex Dates");
	await assign(team, role, alex);
	await leave(team, alex);
	const [held] = ok(await teamsReader.listPersonAssignments(db, await viewer(), { personId: alex })).assignments;
	const correct = (input, who = 0, revision = held.revision) =>
		run(
			teamsWriter.correctTenure,
			{ requestKey: key(), expectedRevision: revision, input: { tenureId: held.tenureId, ...input } },
			who,
		);
	const dates = { startedOn: "2026-01-04", endedOn: "2026-03-01" };
	const blank = refused(await correct({ ...dates, reason: "  " }), "invalid_input");
	assert.deepEqual(
		blank.details.issues.map((i) => [i.path, i.problem]),
		[["input.reason", "reason_required"]],
	);
	const backwards = refused(
		await correct({ startedOn: "2026-03-01", endedOn: "2026-01-04", reason: "Typo" }),
		"invalid_input",
	);
	assert.deepEqual(
		backwards.details.issues.map((i) => [i.path, i.problem]),
		[["input.endedOn", "before_start"]],
	);
	refused(await correct({ ...dates, reason: "Typo" }, 1), "access_denied");
	refused(await correct({ ...dates, reason: "Typo" }, 3), "unavailable");
	const stored = async () =>
		(
			await admin.execute(
				sql`SELECT started_on::text AS s, ended_on::text AS e, revision::text AS r FROM team_tenure WHERE id=${held.tenureId}`,
			)
		).rows[0];
	assert.deepEqual(await stored(), { s: held.startedOn, e: held.endedOn, r: held.revision });

	const done = ok(await correct({ ...dates, reason: "Entered the wrong month" }, 2));
	assert.deepEqual(
		[done.outcome, done.assignment.startedOn, done.assignment.endedOn, done.assignment.active],
		["changed", "2026-01-04", "2026-03-01", false],
	);
	assert.deepEqual(await stored(), { s: "2026-01-04", e: "2026-03-01", r: done.assignment.revision });
	// The person's record and the ministry page read the new dates.
	const [now] = ok(await teamsReader.listPersonAssignments(db, await viewer(), { personId: alex })).assignments;
	assert.deepEqual([now.startedOn, now.endedOn], ["2026-01-04", "2026-03-01"]);
	const past = ok(await teamsReader.listMembers(db, await viewer(), { teamId: team.id })).history;
	assert.deepEqual(
		past.filter((m) => m.personId === alex).map((m) => [m.startedOn, m.endedOn]),
		[["2026-01-04", "2026-03-01"]],
	);
	const [entry] = ok(await teamsReader.listHistory(db, await viewer(), { teamId: team.id })).entries;
	assert.deepEqual(
		{
			kind: entry.kind,
			reason: entry.reason,
			before: entry.before,
			after: entry.after,
			about: entry.about,
			by: entry.actorName,
		},
		{
			kind: "correct",
			reason: "Entered the wrong month",
			before: { startedOn: held.startedOn, endedOn: held.endedOn },
			after: { startedOn: "2026-01-04", endedOn: "2026-03-01" },
			about: { personName: "Alex Dates", roleName: "Greeter" },
			by: "Synthetic",
		},
	);
	// A stale revision is a conflict, and a role held now keeps no end date.
	refused(await correct({ ...dates, reason: "Again" }), "conflict");
	const now2 = await person("Casey Dates");
	await assign(team, await makeRole(team.id, "Usher"), now2);
	const [open] = ok(await teamsReader.listPersonAssignments(db, await viewer(), { personId: now2 })).assignments;
	const openRefusal = refused(
		await run(teamsWriter.correctTenure, {
			requestKey: key(),
			expectedRevision: open.revision,
			input: { tenureId: open.tenureId, startedOn: "2026-02-01", endedOn: "2026-02-02", reason: "No" },
		}),
		"invalid_input",
	);
	assert.deepEqual(openRefusal.details.issues, [{ path: "endedOn", problem: "held_now_has_no_end" }]);
});

test("AC:TARGET-TEAM-002 the old correction path is gone and Edit details changes a ministry's own facts", async () => {
	assert.equal("correct" in teamsWriter, false);
	const team = await makeTeam("Edit only");
	// A Corrected entry recorded before the path was retired still reads in the history.
	await admin.execute(sql`INSERT INTO audit_event(id,tenant_id,actor_id,subject_type,subject_id,action,kind,before_value,after_value,reason)
		VALUES(${randomUUID()},${P},${actors[0].id},'team',${team.id},'teams.changed','correct','{"name":"Edit onl"}','{"name":"Edit only"}','Spelling')`);
	const [old] = ok(await teamsReader.listHistory(db, await viewer(), { teamId: team.id })).entries.filter(
		(e) => e.kind === "correct",
	);
	assert.deepEqual(
		[old.before, old.after, old.reason, old.about],
		[{ name: "Edit onl" }, { name: "Edit only" }, "Spelling", null],
	);
	const edited = ok(
		await run(teamsWriter.edit, {
			requestKey: key(),
			expectedRevision: await rev("team", team.id),
			input: { teamId: team.id, name: "Edit only now", reason: "Clearer name" },
		}),
	);
	assert.equal(edited.team.name, "Edit only now");
});

// T-45 (Nora QA 2026-11-04): a ministry's history shows its roles being added, edited, filled, refilled and retired.
// The commands file those changes under the role or the person's time in it, so the read finds them there: events
// written before the read changed appear too, and no stored audit row is rewritten.
test("a ministry's history shows its own role changes, and no other ministry's or church's", async () => {
	const team = await makeTeam("Role history");
	const role = await makeRole(team.id, "Greeter");
	const alex = await person("Alex Roles");
	const casey = await person("Casey Roles");
	await assign(team, role, alex);
	ok(
		await run(teamsWriter.editRole, {
			requestKey: key(),
			expectedRevision: await rev("team_role", role.id),
			input: { roleId: role.id, name: "Lead greeter" },
		}),
	);
	await leave(team, alex);
	ok(
		await run(teamsWriter.reactivateMembership, {
			requestKey: key(),
			expectedRevision: await rev("team_role", role.id),
			input: { roleId: role.id, personId: alex },
		}),
	);
	await leave(team, alex);
	await assign(team, role, casey);
	ok(
		await run(teamsWriter.retireRole, {
			requestKey: key(),
			expectedRevision: await rev("team_role", role.id),
			input: { roleId: role.id },
		}),
	);

	// Another ministry in the same church, and a ministry in another church, change their own roles.
	const other = await makeTeam("Role history elsewhere");
	const door = await makeRole(other.id, "Door");
	await assign(other, door, await person("Drew Elsewhere"));
	ok(
		await run(teamsWriter.retireRole, {
			requestKey: key(),
			expectedRevision: await rev("team_role", door.id),
			input: { roleId: door.id },
		}),
	);
	const away = await makeTeam("Role history away", 3);
	ok(await run(teamsWriter.createRole, { requestKey: key(), input: { teamId: away.id, name: "Away seat" } }, 3));

	const stored = sql`SELECT id, kind, subject_type, subject_id, before_value, after_value, metadata FROM audit_event
		WHERE tenant_id IN (${P}, ${Q}) ORDER BY id`;
	const rows = (await admin.execute(stored)).rows;
	const entries = ok(await teamsReader.listHistory(db, await viewer(), { teamId: team.id })).entries;
	assert.deepEqual(
		entries.map((e) => [e.kind, e.subject, e.about, e.actorName]),
		[
			["retire", "role", { personName: null, roleName: "Lead greeter" }, "Synthetic"],
			["assign", "tenure", { personName: "Casey Roles", roleName: "Lead greeter" }, "Synthetic"],
			["remove", "ministry", null, "Synthetic"],
			["assign", "tenure", { personName: "Alex Roles", roleName: "Lead greeter" }, "Synthetic"],
			["remove", "ministry", null, "Synthetic"],
			["edit", "role", { personName: null, roleName: "Lead greeter" }, "Synthetic"],
			["assign", "tenure", { personName: "Alex Roles", roleName: "Lead greeter" }, "Synthetic"],
			["create", "role", { personName: null, roleName: "Greeter" }, "Synthetic"],
			["create", "ministry", null, "Synthetic"],
		],
	);
	const [retired, , , , , edited, , added] = entries;
	assert.deepEqual([edited.before, edited.after], [{ name: "Greeter" }, { name: "Lead greeter" }]);
	assert.deepEqual(added.after, { name: "Greeter", desiredSkills: null, leadership: false });
	assert.deepEqual(retired.after, { retired: true, occupantPersonId: null });
	for (const e of entries) assert.equal(Number.isNaN(Date.parse(e.occurredAt)), false);
	// The other ministries' role changes stay in their own histories.
	const elsewhere = ok(await teamsReader.listHistory(db, await viewer(), { teamId: other.id })).entries;
	assert.deepEqual(
		elsewhere.map((e) => [e.kind, e.about?.roleName ?? null]),
		[
			["retire", "Door"],
			["assign", "Door"],
			["create", "Door"],
			["create", null],
		],
	);
	const awayEntries = ok(await teamsReader.listHistory(db, await viewer(3), { teamId: away.id })).entries;
	assert.deepEqual(
		awayEntries.map((e) => [e.kind, e.about?.roleName ?? null]),
		[
			["create", "Away seat"],
			["create", null],
		],
	);
	refused(await teamsReader.listHistory(db, await viewer(3), { teamId: team.id }), "access_denied");
	// Reading the history rewrites no stored audit row.
	assert.deepEqual((await admin.execute(stored)).rows, rows);
});

test("training filed under a ministry never shows in that ministry's history", async () => {
	const team = await makeTeam("Training history");
	const role = await makeRole(team.id, "Usher");
	const pat = await person("Pat Training", { stage: "launch_team" });
	await assign(team, role, pat);
	const history = async () => ok(await teamsReader.listHistory(db, await viewer(), { teamId: team.id })).entries;
	const shown = (entries) => entries.map((e) => [e.kind, e.subject, e.about]);
	const before = await history();
	assert.deepEqual(shown(before), [
		["assign", "tenure", { personName: "Pat Training", roleName: "Usher" }],
		["create", "role", { personName: null, roleName: "Usher" }],
		["create", "ministry", null],
	]);
	// A program and its roster (assignments) are filed under the ministry's id; the credit is filed under the person.
	const program = ok(
		await run(trainingWriter.createProgram, {
			requestKey: key(),
			input: { name: "Usher basics", required: true, teamId: team.id },
		}),
	).program;
	const seen = ok(
		await trainingReader.readRequiredTrainingPreview(db, await viewer(), { programId: program.id, personIds: [pat] }),
	);
	ok(
		await run(trainingWriter.setRequiredTrainingParticipants, {
			requestKey: key(),
			expectedRevision: seen.revision,
			input: { programId: program.id, personIds: [pat], rosterDigest: seen.rosterDigest },
		}),
	);
	ok(
		await run(trainingWriter.attestCompletion, {
			requestKey: key(),
			expectedRevision: await rev("training_program", program.id),
			input: { kind: "program", personId: pat, programId: program.id, earnedOn: day(0) },
		}),
	);
	const filed = (
		await admin.execute(
			sql`SELECT DISTINCT subject_type FROM audit_event WHERE subject_id=${team.id} AND subject_type LIKE 'training%'
				ORDER BY subject_type`,
		)
	).rows.map((r) => r.subject_type);
	assert.deepEqual(filed, ["training_assignment", "training_program"]);
	const after = await history();
	assert.deepEqual(
		after.map((e) => e.id),
		before.map((e) => e.id),
	);
	assert.deepEqual(shown(after), shown(before));
});

test("turning leadership off a role clears only the leader that role made, and the history names it", async () => {
	const leaderOf = async (teamId) =>
		(
			await admin.execute(
				sql`SELECT leader_person_id AS "personId", leader_source AS source, leader_role_id AS "roleId",
					revision::text AS revision FROM team WHERE id=${teamId}`,
			)
		).rows[0];
	const editRole = async (role, fields) =>
		ok(
			await run(teamsWriter.editRole, {
				requestKey: key(),
				expectedRevision: await rev("team_role", role.id),
				input: { roleId: role.id, ...fields },
			}),
		);

	// Role-derived from this role: the leader steps down with the role.
	const derived = await makeTeam("Derived leader");
	const lead = await makeRole(derived.id, "Derived lead", { leadership: true });
	const holder = await person("Derived Holder");
	await assign(derived, lead, holder);
	const held = await leaderOf(derived.id);
	assert.deepEqual([held.personId, held.source, held.roleId], [holder, "role_derived", lead.id]);
	const edited = await editRole(lead, { leadership: false });
	assert.equal(edited.role.leadership, false);
	const cleared = await leaderOf(derived.id);
	assert.deepEqual([cleared.personId, cleared.source, cleared.roleId], [null, null, null]);
	assert.equal(BigInt(cleared.revision), BigInt(held.revision) + 1n);
	const event = (
		await admin.execute(
			sql`SELECT before_value AS before, after_value AS after FROM audit_event
				WHERE subject_id=${lead.id} AND subject_type='team_role' AND kind='edit' ORDER BY occurred_at DESC LIMIT 1`,
		)
	).rows[0];
	assert.deepEqual([event.before, event.after], [{ leadership: true }, { leadership: false }]);

	// An explicit leader stays.
	const explicit = await makeTeam("Explicit leader");
	const chosen = await person("Explicit Leader");
	ok(
		await run(teamsWriter.appointLeader, {
			requestKey: key(),
			expectedRevision: await rev("team", explicit.id),
			input: { teamId: explicit.id, personId: chosen },
		}),
	);
	const explicitRole = await makeRole(explicit.id, "Explicit lead", { leadership: true });
	const appointed = await leaderOf(explicit.id);
	await editRole(explicitRole, { leadership: false });
	assert.deepEqual(await leaderOf(explicit.id), appointed);
	assert.equal(appointed.source, "explicit");

	// A leader derived from another role stays.
	const shared = await makeTeam("Two leadership roles");
	const first = await makeRole(shared.id, "First lead", { leadership: true });
	const second = await makeRole(shared.id, "Second lead", { leadership: true });
	const firstHolder = await person("First Holder");
	await assign(shared, first, firstHolder);
	const kept = await leaderOf(shared.id);
	assert.deepEqual([kept.personId, kept.source, kept.roleId], [firstHolder, "role_derived", first.id]);
	await editRole(second, { leadership: false });
	assert.deepEqual(await leaderOf(shared.id), kept);
});

test("REQ-IDN-005 an unknown or another church's team, role or tenure is unavailable to the teams writer", async () => {
	const foreignTeam = await makeTeam("Foreign ministry", 3);
	const foreignRole = ok(
		await run(
			teamsWriter.createRole,
			{ requestKey: key(), input: { teamId: foreignTeam.id, name: "Foreign role" } },
			3,
		),
	).role;
	const foreignHolder = await person("Foreign Holder", { plant: Q });
	const foreignTenure = ok(
		await run(
			teamsWriter.assignRole,
			{
				requestKey: key(),
				expectedRevision: foreignRole.revision,
				input: { roleId: foreignRole.id, teamId: foreignTeam.id, personId: foreignHolder },
			},
			3,
		),
	).tenureId;
	for (const [teamId, roleId, tenureId] of [
		[randomUUID(), randomUUID(), randomUUID()],
		[foreignTeam.id, foreignRole.id, foreignTenure],
	]) {
		refused(
			await run(teamsWriter.edit, {
				requestKey: key(),
				expectedRevision: foreignTeam.revision,
				input: { teamId, name: "Probe" },
			}),
		);
		refused(await run(teamsWriter.createRole, { requestKey: key(), input: { teamId, name: "Probe" } }));
		refused(
			await run(teamsWriter.editRole, {
				requestKey: key(),
				expectedRevision: foreignRole.revision,
				input: { roleId, name: "Probe" },
			}),
		);
		refused(
			await run(teamsWriter.correctTenure, {
				requestKey: key(),
				expectedRevision: "1",
				input: { tenureId, startedOn: "2026-01-04", endedOn: null, reason: "Probe" },
			}),
		);
	}
	assert.equal(
		(await admin.execute(sql`SELECT name FROM team WHERE id=${foreignTeam.id}`)).rows[0].name,
		"Foreign ministry",
	);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM team_role WHERE name='Probe'`), 0);
	// Without a seat that may change the ministry, the refusal is still about permission.
	refused(
		await run(
			teamsWriter.editRole,
			{ requestKey: key(), expectedRevision: "1", input: { roleId: randomUUID(), name: "Probe" } },
			1,
		),
		"access_denied",
	);
});
