import { RESPONSIBILITY_LINES } from "../../../../packages/contracts/src/teams/responsibilities/index.ts";
import { createDatabase, closeDatabase } from "../../../../packages/db/src/client.ts";
import { sql } from "../../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { migrate } from "../../../../packages/db/src/schema/migrate.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import {
	responsibilityReader,
	responsibilityWriter,
	teamsWriter,
} from "../../../../packages/domain/src/teams/index.ts";

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
	throw new Error("Only approved shared development or disposable CI endpoint allowed");
if (!localCi) source.searchParams.set("sslmode", "verify-full");
const schema = "wp018_" + randomUUID().replaceAll("-", "");
const roleName = "wp018_" + randomBytes(8).toString("hex");
const GLOBAL = "00000000-0000-0000-0000-000000000000";
const admin = createDatabase({
	connectionString: source.href,
	max: 4,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
let db;
const P = randomUUID();
const Q = randomUUID();
const actors = Array.from({ length: 4 }, () => ({ id: randomUUID(), user: randomUUID(), session: randomUUID() }));
const releaseId = randomUUID();
const itemId = randomUUID();
const ctx = (who = 0) => ({ session: actors[who].session, selected: { kind: "plant", id: who === 3 ? Q : P } });
const ok = (result) => {
	assert.equal(result.status, "ok", JSON.stringify(result));
	return result.value;
};
const refused = (result, code) => {
	assert.equal(result.status, "refused", JSON.stringify(result));
	assert.equal(result.error.code, code, JSON.stringify(result.error));
};
const tx = (body) => db.transaction(body);
const run = (op, input, who = 0) => tx((t) => op(t, ctx(who), input));
const key = () => randomUUID();
const viewer = async (who = 0) => {
	const actor = await RequestActor.resolve(db, actors[who].session);
	assert.equal(actor.status, "active");
	return actor;
};
const count = async (query) => Number((await admin.execute(query)).rows[0].n);
const linesOf = async (teamId) =>
	(
		await admin.execute(sql`SELECT id, source_line, text, (removed_at IS NOT NULL) AS removed,
			completed_on::text AS completed_on, revision::text AS revision
			FROM responsibility WHERE team_id=${teamId} ORDER BY sort_order, source_line`)
	).rows;
const offerOf = async (teamId) =>
	(
		await admin.execute(sql`SELECT responsibility_offer AS offer, responsibility_offer_version_id::text AS version,
			revision::text AS revision FROM team WHERE id=${teamId}`)
	).rows[0];
const audits = (requestKey) => count(sql`SELECT count(*)::int AS n FROM audit_event WHERE request_key=${requestKey}`);
const phase = async () => Number((await admin.execute(sql`SELECT phase FROM plant WHERE id=${P}`)).rows[0].phase);
const marks = async () => ({
	rows: await count(sql`SELECT count(*)::int AS n FROM responsibility`),
	audits: await count(sql`SELECT count(*)::int AS n FROM audit_event`),
});
const catalogPreview = RESPONSIBILITY_LINES.map((line) => ({
	key: line.key,
	text: line.text,
	sortOrder: line.sortOrder,
}));

async function person(name, account) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,
		pipeline_position,state,created_at,linked_account_id) VALUES(${id},${P},${P},${name},'other','launch_team','unknown','unknown',0,'live',clock_timestamp(),${account})`);
	return id;
}
async function makeTeam(name) {
	return ok(await run(teamsWriter.create, { requestKey: key(), input: { name } })).team;
}
function offerInput(teamId, decision, selected, revision, requestKey = key()) {
	return { requestKey, expectedRevision: revision, input: { teamId, decision, selected } };
}
async function addVersion() {
	const version = randomUUID();
	const token = randomUUID().replaceAll("-", "");
	const number = Number(
		(
			await admin.execute(
				sql`SELECT coalesce(max(version_number), 0) + 1 AS n FROM reference_version WHERE item_id=${itemId}`,
			)
		).rows[0].n,
	);
	await admin.execute(sql`INSERT INTO reference_version(id,item_id,release_id,version_number,artifact_path,content_hash,source_credit)
		VALUES(${version},${itemId},${releaseId},${number},'lines',${token},'test')`);
	return version;
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
	])
		await admin.execute(
			sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${actors[i].id},${plant},${seatRole},clock_timestamp())`,
		);
	const token = randomUUID().replaceAll("-", "");
	await admin.execute(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,chunker_version,embedding_profile,embedding_dimensions,tenant_id,expected_passages)
		VALUES(${releaseId},${token},'memory',${token},'validated','0','none',1,${GLOBAL},0)`);
	await admin.execute(
		sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${itemId},'playbook','responsibilities',${GLOBAL})`,
	);
	await addVersion();
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

test("AC:B01-028 preview stores nothing and one selected line stays the only active line", async () => {
	const team = await makeTeam("Welcome");
	const beforeRead = await marks();
	const preview = ok(await responsibilityReader.previewResponsibilities(db, await viewer(), { teamId: team.id }));
	assert.deepEqual(preview.lines, catalogPreview);
	assert.equal(preview.offer, null);
	const listed = ok(await responsibilityReader.listResponsibilities(db, await viewer(), { teamId: team.id }));
	assert.deepEqual(listed.items, []);
	assert.equal(listed.offer, null);
	const nextPage = ok(
		await responsibilityReader.listResponsibilities(db, await viewer(), { teamId: team.id, page: 2 }),
	);
	assert.deepEqual(nextPage.items, []);
	refused(
		await responsibilityReader.listResponsibilities(db, await viewer(), { teamId: team.id, page: 0 }),
		"invalid_input",
	);
	assert.deepEqual(await marks(), beforeRead);

	const input = offerInput(team.id, "accept", ["invite"], team.revision);
	const accepted = ok(await run(responsibilityWriter.offerResponsibilities, input));
	assert.equal(accepted.outcome, "changed");
	assert.equal(accepted.decision, "accept");
	assert.equal(accepted.createdIds.length, 3);
	const replay = ok(await run(responsibilityWriter.offerResponsibilities, input));
	assert.equal(replay.receiptId, accepted.receiptId);
	assert.deepEqual(replay.createdIds, accepted.createdIds);
	assert.equal(await audits(input.requestKey), 1);
	const stored = await linesOf(team.id);
	assert.equal(stored.filter((row) => row.removed).length, 2);
	assert.deepEqual(
		stored.filter((row) => !row.removed).map((row) => row.source_line),
		["invite"],
	);
	const page = ok(await responsibilityReader.listResponsibilities(db, await viewer(), { teamId: team.id }));
	assert.equal(page.offer, "accepted");
	assert.equal(page.items.length, 1);
	assert.equal(page.items[0].sourceLine, "invite");
	assert.equal(page.items[0].text, "Invite new people each week");
	const again = offerInput(team.id, "accept", ["invite", "follow-up", "train"], (await offerOf(team.id)).revision);
	const repeat = ok(await run(responsibilityWriter.offerResponsibilities, again));
	assert.equal(repeat.outcome, "noop");
	assert.deepEqual(repeat.createdIds, []);
	assert.equal((await linesOf(team.id)).filter((row) => !row.removed).length, 1);
	const quiet = ok(await responsibilityReader.previewResponsibilities(db, await viewer(), { teamId: team.id }));
	assert.deepEqual(quiet.lines, []);
});

test("AC:TARGET-TEAM-007 chosen lines commit once and deleted, edited, or declined lines do not return", async () => {
	const team = await makeTeam("Launch");
	const started = await phase();
	assert.equal(
		(await responsibilityReader.previewResponsibilities(db, await viewer(), { teamId: team.id })).status,
		"ok",
	);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM responsibility WHERE team_id=${team.id}`), 0);
	const input = offerInput(team.id, "accept", ["invite", "follow-up"], team.revision);
	await assert.rejects(
		tx(async (t) => {
			const result = await responsibilityWriter.offerResponsibilities(t, ctx(), input);
			assert.equal(result.status, "ok", JSON.stringify(result));
			throw new Error("crash");
		}),
		/crash/,
	);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM responsibility WHERE team_id=${team.id}`), 0);
	assert.equal(await audits(input.requestKey), 0);
	const accepted = ok(await run(responsibilityWriter.offerResponsibilities, input));
	assert.equal(accepted.createdIds.length, 3);
	const replay = ok(await run(responsibilityWriter.offerResponsibilities, input));
	assert.equal(replay.receiptId, accepted.receiptId);
	assert.equal(await audits(input.requestKey), 1);
	let stored = await linesOf(team.id);
	assert.equal(stored.filter((row) => !row.removed).length, 2);
	assert.equal(
		stored
			.filter((row) => row.removed)
			.map((row) => row.source_line)
			.join(),
		"train",
	);

	const invite = stored.find((row) => row.source_line === "invite");
	const follow = stored.find((row) => row.source_line === "follow-up");
	const removed = ok(
		await run(responsibilityWriter.deleteResponsibility, {
			requestKey: key(),
			expectedRevision: invite.revision,
			input: { responsibilityId: invite.id },
		}),
	);
	assert.equal(removed.outcome, "changed");
	assert.equal((await linesOf(team.id)).find((row) => row.id === invite.id).removed, true);
	const edited = ok(
		await run(responsibilityWriter.editResponsibility, {
			requestKey: key(),
			expectedRevision: follow.revision,
			input: { responsibilityId: follow.id, text: "Follow up within two days" },
		}),
	);
	assert.equal(edited.text, "Follow up within two days");
	const same = ok(
		await run(responsibilityWriter.editResponsibility, {
			requestKey: key(),
			expectedRevision: edited.revision,
			input: { responsibilityId: follow.id, text: "Follow up within two days" },
		}),
	);
	assert.equal(same.outcome, "noop");
	assert.equal(same.revision, edited.revision);
	refused(
		await run(responsibilityWriter.editResponsibility, {
			requestKey: key(),
			expectedRevision: "999",
			input: { responsibilityId: follow.id, text: "Replaced" },
		}),
		"conflict",
	);
	assert.equal((await linesOf(team.id)).find((row) => row.id === follow.id).text, "Follow up within two days");
	const today = (await admin.execute(sql`SELECT (clock_timestamp() AT TIME ZONE 'America/Chicago')::date::text AS d`))
		.rows[0].d;
	const tickInput = {
		requestKey: key(),
		expectedRevision: edited.revision,
		input: { responsibilityId: follow.id, done: true },
	};
	const ticked = ok(await run(responsibilityWriter.completeResponsibility, tickInput));
	assert.equal(ticked.completedOn, today);
	assert.equal((await linesOf(team.id)).find((row) => row.id === follow.id).completed_on, today);
	const tickReplay = ok(await run(responsibilityWriter.completeResponsibility, tickInput));
	assert.equal(tickReplay.receiptId, ticked.receiptId);
	assert.equal(await audits(tickInput.requestKey), 1);
	const retick = ok(
		await run(responsibilityWriter.completeResponsibility, {
			requestKey: key(),
			expectedRevision: ticked.revision,
			input: { responsibilityId: follow.id, done: true },
		}),
	);
	assert.equal(retick.outcome, "noop");
	assert.equal(retick.completedOn, today);
	const cleared = ok(
		await run(responsibilityWriter.completeResponsibility, {
			requestKey: key(),
			expectedRevision: retick.revision,
			input: { responsibilityId: follow.id, done: false },
		}),
	);
	assert.equal(cleared.completedOn, null);
	assert.equal((await linesOf(team.id)).find((row) => row.id === follow.id).completed_on, null);
	const tickedAgain = ok(
		await run(responsibilityWriter.completeResponsibility, {
			requestKey: key(),
			expectedRevision: cleared.revision,
			input: { responsibilityId: follow.id, done: true },
		}),
	);
	assert.equal(tickedAgain.completedOn, today);
	const added = ok(
		await run(responsibilityWriter.addResponsibility, {
			requestKey: key(),
			expectedRevision: (await offerOf(team.id)).revision,
			input: { teamId: team.id, text: "Bring the keys" },
		}),
	);
	assert.equal(added.sourceLine, `custom:${added.id}`);
	assert.equal((await linesOf(team.id)).find((row) => row.id === added.id).removed, false);
	assert.equal(await phase(), started);

	const declinedTeam = await makeTeam("Passed");
	const declinedInput = offerInput(declinedTeam.id, "decline", ["invite"], declinedTeam.revision);
	const declined = ok(await run(responsibilityWriter.offerResponsibilities, declinedInput));
	assert.equal(declined.decision, "decline");
	assert.equal((await linesOf(declinedTeam.id)).filter((row) => !row.removed).length, 0);
	assert.equal((await linesOf(declinedTeam.id)).length, 3);
	const declinedPreview = ok(
		await responsibilityReader.previewResponsibilities(db, await viewer(), { teamId: declinedTeam.id }),
	);
	assert.deepEqual(declinedPreview.lines, []);
	const version = await addVersion();
	const blocked = ok(
		await run(
			responsibilityWriter.offerResponsibilities,
			offerInput(
				declinedTeam.id,
				"accept",
				["invite", "follow-up", "train"],
				(await offerOf(declinedTeam.id)).revision,
			),
		),
	);
	assert.equal(blocked.outcome, "noop");
	assert.equal(blocked.decision, "decline");
	assert.deepEqual(blocked.createdIds, []);
	assert.equal((await offerOf(declinedTeam.id)).version === version, false);
	assert.equal((await linesOf(declinedTeam.id)).filter((row) => !row.removed).length, 0);

	const moved = ok(
		await run(
			responsibilityWriter.offerResponsibilities,
			offerInput(team.id, "accept", ["invite", "follow-up", "train"], (await offerOf(team.id)).revision),
		),
	);
	assert.equal(moved.outcome, "changed");
	assert.deepEqual(moved.createdIds, []);
	assert.equal((await offerOf(team.id)).version, version);
	stored = await linesOf(team.id);
	assert.equal(stored.find((row) => row.id === follow.id).text, "Follow up within two days");
	assert.equal(stored.find((row) => row.id === invite.id).removed, true);
	assert.equal(stored.find((row) => row.source_line === "train").removed, true);
	assert.equal(stored.find((row) => row.id === added.id).text, "Bring the keys");
	const beforeDecline = await linesOf(team.id);
	refused(
		await run(
			responsibilityWriter.offerResponsibilities,
			offerInput(team.id, "decline", [], (await offerOf(team.id)).revision),
		),
		"conflict",
	);
	assert.deepEqual(await linesOf(team.id), beforeDecline);

	const blank = await makeTeam("None");
	const empty = ok(
		await run(responsibilityWriter.offerResponsibilities, offerInput(blank.id, "accept", [], blank.revision)),
	);
	assert.equal(empty.outcome, "changed");
	assert.equal((await linesOf(blank.id)).filter((row) => !row.removed).length, 0);
	assert.equal((await linesOf(blank.id)).length, 3);
	assert.equal(await phase(), started);
	refused(
		await run(responsibilityWriter.deleteResponsibility, {
			requestKey: key(),
			expectedRevision: removed.revision,
			input: { responsibilityId: invite.id },
		}),
		"conflict",
	);
});

test("INV-tenancy a forged session, a stale role, and a non-leader cannot change responsibilities", async () => {
	const team = await makeTeam("Guarded");
	const accepted = ok(
		await run(responsibilityWriter.offerResponsibilities, offerInput(team.id, "accept", ["train"], team.revision)),
	);
	assert.equal(accepted.createdIds.length, 3);
	const row = (await linesOf(team.id)).find((item) => item.source_line === "train");
	const before = await marks();
	const memberPreview = ok(
		await responsibilityReader.previewResponsibilities(db, await viewer(1), { teamId: team.id }),
	);
	assert.deepEqual(memberPreview.lines, []);
	const memberList = ok(await responsibilityReader.listResponsibilities(db, await viewer(1), { teamId: team.id }));
	assert.equal(memberList.items.length, 1);
	assert.deepEqual(await marks(), before);
	refused(
		await run(
			responsibilityWriter.offerResponsibilities,
			offerInput(team.id, "accept", ["invite"], (await offerOf(team.id)).revision),
			1,
		),
		"access_denied",
	);
	refused(
		await run(
			responsibilityWriter.completeResponsibility,
			{
				requestKey: key(),
				expectedRevision: row.revision,
				input: { responsibilityId: row.id, done: true },
			},
			1,
		),
		"access_denied",
	);
	assert.equal((await linesOf(team.id)).find((item) => item.id === row.id).completed_on, null);

	const forgedInput = offerInput(team.id, "decline", [], (await offerOf(team.id)).revision);
	const forgedBefore = await count(sql`SELECT count(*)::int AS n FROM responsibility WHERE team_id=${team.id}`);
	refused(
		await tx((t) =>
			responsibilityWriter.offerResponsibilities(
				t,
				{ session: actors[3].session, selected: { kind: "plant", id: P } },
				forgedInput,
			),
		),
		"unavailable",
	);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM responsibility WHERE team_id=${team.id}`), forgedBefore);
	const owner = await viewer(0);
	const forgedReader = RequestActor.of(actors[3].session, owner.actor);
	refused(await responsibilityReader.listResponsibilities(db, forgedReader, { teamId: team.id }), "unavailable");
	refused(await responsibilityReader.previewResponsibilities(db, forgedReader, { teamId: team.id }), "unavailable");
	refused(
		await run(
			responsibilityWriter.offerResponsibilities,
			offerInput(team.id, "accept", ["missing-line"], (await offerOf(team.id)).revision),
		),
		"access_denied",
	);
	refused(
		await run(
			responsibilityWriter.offerResponsibilities,
			offerInput(randomUUID(), "accept", ["invite"], team.revision),
		),
		"access_denied",
	);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM responsibility WHERE team_id=${team.id}`), forgedBefore);

	const lead = await person("Team Lead", actors[1].id);
	ok(
		await run(teamsWriter.appointLeader, {
			requestKey: key(),
			expectedRevision: (await offerOf(team.id)).revision,
			input: { teamId: team.id, personId: lead },
		}),
	);
	const custom = ok(
		await run(
			responsibilityWriter.addResponsibility,
			{
				requestKey: key(),
				expectedRevision: (await offerOf(team.id)).revision,
				input: { teamId: team.id, text: "Lock the doors" },
			},
			1,
		),
	);
	const edited = ok(
		await run(
			responsibilityWriter.editResponsibility,
			{
				requestKey: key(),
				expectedRevision: custom.revision,
				input: { responsibilityId: custom.id, text: "Lock both doors" },
			},
			1,
		),
	);
	const done = ok(
		await run(
			responsibilityWriter.completeResponsibility,
			{
				requestKey: key(),
				expectedRevision: row.revision,
				input: { responsibilityId: row.id, done: true },
			},
			1,
		),
	);
	assert.ok(done.completedOn);
	ok(
		await run(
			responsibilityWriter.deleteResponsibility,
			{
				requestKey: key(),
				expectedRevision: edited.revision,
				input: { responsibilityId: custom.id },
			},
			1,
		),
	);
	assert.equal((await linesOf(team.id)).find((item) => item.id === custom.id).removed, true);
	refused(
		await run(
			responsibilityWriter.offerResponsibilities,
			offerInput(team.id, "accept", ["invite"], (await offerOf(team.id)).revision),
			1,
		),
		"access_denied",
	);

	const seat = actors[0].id;
	const resolved = await viewer(0);
	try {
		await admin.execute(sql`UPDATE seat SET role='member' WHERE account_id=${seat} AND plant_id=${P}`);
		refused(await responsibilityReader.listResponsibilities(db, resolved, { teamId: team.id }), "unavailable");
	} finally {
		await admin.execute(sql`UPDATE seat SET role='owner' WHERE account_id=${seat} AND plant_id=${P}`);
	}
	const adminActor = await viewer(2);
	try {
		await admin.execute(
			sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${actors[2].id} AND plant_id=${P}`,
		);
		refused(await responsibilityReader.listResponsibilities(db, adminActor, { teamId: team.id }), "unavailable");
	} finally {
		await admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${actors[2].id} AND plant_id=${P}`);
	}
	ok(
		await run(teamsWriter.archive, {
			requestKey: key(),
			expectedRevision: (await offerOf(team.id)).revision,
			input: { teamId: team.id },
		}),
	);
	const visible = ok(await responsibilityReader.listResponsibilities(db, await viewer(), { teamId: team.id }));
	assert.equal(
		visible.items.some((item) => item.id === row.id),
		true,
	);
	refused(
		await run(
			responsibilityWriter.offerResponsibilities,
			offerInput(team.id, "accept", [], (await offerOf(team.id)).revision),
		),
		"access_denied",
	);
	refused(
		await run(responsibilityWriter.completeResponsibility, {
			requestKey: key(),
			expectedRevision: done.revision,
			input: { responsibilityId: row.id, done: false },
		}),
		"access_denied",
	);
});
