import { readFileSync } from "node:fs";
import { sql } from "../../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import {
	responsibilityReader,
	responsibilityWriter,
	teamsWriter,
} from "../../../../packages/domain/src/teams/index.ts";
import {
	NO_PLAYBOOK_TEAM_KEY,
	REFERENCE_TEAM_KEY,
	linesForTemplate,
	referenceTeamKey,
} from "../../../../packages/domain/src/teams/responsibilities/playbook.ts";
import { TEMPLATES, reviewDigest } from "../../../../packages/domain/src/teams/templates.ts";
import { playbookTeam } from "../../../../packages/reference/src/playbook.ts";
import { fixture, ok, refused } from "../../../support/fixture.mts";

const GLOBAL = "00000000-0000-0000-0000-000000000000";
const database = await fixture({ prefix: "wp018", max: 6 });
const { admin } = database;
const db = database.pools.runtime;
const P = database.tenant.id;
const Q = (await database.plant({ timezone: "America/New_York" })).id;
const actors = [
	database.actors.owner,
	database.actors.member,
	database.actors.admin,
	await database.actor({ kind: "plant", id: Q }, "admin"),
];
const releaseId = randomUUID();
const itemIds = new Map();
const freeze = JSON.parse(
	readFileSync(new URL("../../../../packages/reference/src/freeze.json", import.meta.url), "utf8"),
);
const referenceKeys = [...new Set(Object.values(REFERENCE_TEAM_KEY))];
const ctx = (who = 0) => ({ session: actors[who].session, selected: { kind: "plant", id: who === 3 ? Q : P } });
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
async function expectedLines(referenceKey) {
	const described = await playbookTeam(referenceKey);
	if (typeof described.description !== "string" || described.description.length === 0) {
		throw new Error("missing catalog team " + referenceKey);
	}
	return described.description
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0)
		.map((item, index) => {
			const line = item.charAt(0).toUpperCase() + item.slice(1);
			return { key: line, text: line, sortOrder: index + 1 };
		});
}
function flipHex(value) {
	const last = value.at(-1);
	return value.slice(0, -1) + (last === "0" ? "1" : "0");
}

async function person(name, account) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,
		pipeline_position,state,created_at,linked_account_id) VALUES(${id},${P},${P},${name},'other','launch_team','unknown','unknown',0,'live',clock_timestamp(),${account})`);
	return id;
}
async function makeTemplateTeam(name, templateKey) {
	const team = ok(await run(teamsWriter.create, { requestKey: key(), input: { name } })).team;
	if (templateKey) {
		await admin.execute(sql`UPDATE team SET template_key=${templateKey} WHERE id=${team.id}`);
	}
	return team;
}
async function offerInput(teamId, decision, selected, revision, requestKey = key()) {
	const preview = ok(await responsibilityReader.previewResponsibilities(db, await viewer(), { teamId }));
	return {
		requestKey,
		expectedRevision: revision,
		input: {
			teamId,
			decision,
			selected,
			expectedVersion: preview.templateVersion,
			reviewDigest: preview.reviewDigest,
		},
	};
}
async function addVersion(referenceKey) {
	const itemId = itemIds.get(referenceKey);
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
	const token = randomUUID().replaceAll("-", "");
	await admin.execute(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,chunker_version,embedding_profile,embedding_dimensions,tenant_id,expected_passages)
		VALUES(${releaseId},${token},'memory',${token},'validated','0','none',1,${GLOBAL},0)`);
	for (const referenceKey of referenceKeys) {
		const itemId = randomUUID();
		itemIds.set(referenceKey, itemId);
		await admin.execute(
			sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${itemId},'ministry_template',${referenceKey},${GLOBAL})`,
		);
		await addVersion(referenceKey);
	}
});
after(async () => {
	await database.close();
});

test("AC:B01-028 preview stores nothing and one selected line stays the only active line", async () => {
	const lines = await expectedLines("senior_pastor");
	const team = await makeTemplateTeam("Welcome", "leadership");
	const beforeRead = await marks();
	const preview = ok(await responsibilityReader.previewResponsibilities(db, await viewer(), { teamId: team.id }));
	assert.deepEqual(preview.lines, lines);
	assert.equal(preview.offer, null);
	assert.equal(preview.proposedCount, lines.length);
	assert.deepEqual(preview.customizations, []);
	assert.equal(preview.templateVersion, freeze.artifactSha256);
	assert.equal(
		preview.reviewDigest,
		reviewDigest({
			expectedVersion: preview.templateVersion,
			mode: "responsibilities",
			selections: preview.customizations,
			lines: preview.lines,
		}),
	);
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

	const staleVersion = await offerInput(team.id, "accept", [lines[0].key], team.revision);
	staleVersion.input.expectedVersion = flipHex(staleVersion.input.expectedVersion);
	refused(await run(responsibilityWriter.offerResponsibilities, staleVersion), "stale_template_version");
	const staleDigest = await offerInput(team.id, "accept", [lines[0].key], team.revision);
	staleDigest.input.reviewDigest = flipHex(staleDigest.input.reviewDigest);
	refused(await run(responsibilityWriter.offerResponsibilities, staleDigest), "stale_review");
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM responsibility WHERE team_id=${team.id}`), 0);

	const input = await offerInput(team.id, "accept", [lines[0].key], team.revision);
	const accepted = ok(await run(responsibilityWriter.offerResponsibilities, input));
	assert.equal(accepted.outcome, "changed");
	assert.equal(accepted.decision, "accept");
	assert.equal(accepted.createdIds.length, lines.length);
	const replay = ok(await run(responsibilityWriter.offerResponsibilities, input));
	assert.equal(replay.receiptId, accepted.receiptId);
	assert.deepEqual(replay.createdIds, accepted.createdIds);
	assert.equal(await audits(input.requestKey), 1);
	const stored = await linesOf(team.id);
	assert.equal(stored.filter((row) => row.removed).length, lines.length - 1);
	assert.deepEqual(
		stored.filter((row) => !row.removed).map((row) => row.source_line),
		[lines[0].key],
	);
	const page = ok(await responsibilityReader.listResponsibilities(db, await viewer(), { teamId: team.id }));
	assert.equal(page.offer, "accepted");
	assert.equal(page.items.length, 1);
	assert.equal(page.items[0].sourceLine, lines[0].key);
	assert.equal(page.items[0].text, lines[0].text);
	const again = await offerInput(
		team.id,
		"accept",
		lines.map((line) => line.key),
		(await offerOf(team.id)).revision,
	);
	const repeat = ok(await run(responsibilityWriter.offerResponsibilities, again));
	assert.equal(repeat.outcome, "noop");
	assert.deepEqual(repeat.createdIds, []);
	assert.equal((await linesOf(team.id)).filter((row) => !row.removed).length, 1);
	const quiet = ok(await responsibilityReader.previewResponsibilities(db, await viewer(), { teamId: team.id }));
	assert.deepEqual(quiet.lines, []);
	assert.equal(quiet.proposedCount, 0);
	assert.equal(quiet.offer, "accepted");
	assert.equal(quiet.customizations.length, lines.length);
});

test("AC:TARGET-TEAM-007 chosen lines commit once and deleted, edited, or declined lines do not return", async () => {
	const worship = await expectedLines("worship");
	const team = await makeTemplateTeam("Launch", "worship");
	const started = await phase();
	assert.equal(
		(await responsibilityReader.previewResponsibilities(db, await viewer(), { teamId: team.id })).status,
		"ok",
	);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM responsibility WHERE team_id=${team.id}`), 0);
	const picked = worship.slice(0, 2).map((line) => line.key);
	const input = await offerInput(team.id, "accept", picked, team.revision);
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
	assert.equal(accepted.createdIds.length, worship.length);
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
		worship
			.slice(2)
			.map((line) => line.key)
			.join(),
	);

	const first = stored.find((row) => row.source_line === worship[0].key);
	const second = stored.find((row) => row.source_line === worship[1].key);
	const removed = ok(
		await run(responsibilityWriter.deleteResponsibility, {
			requestKey: key(),
			expectedRevision: first.revision,
			input: { responsibilityId: first.id },
		}),
	);
	assert.equal(removed.outcome, "changed");
	assert.equal((await linesOf(team.id)).find((row) => row.id === first.id).removed, true);
	const edited = ok(
		await run(responsibilityWriter.editResponsibility, {
			requestKey: key(),
			expectedRevision: second.revision,
			input: { responsibilityId: second.id, text: "Follow up within two days" },
		}),
	);
	assert.equal(edited.text, "Follow up within two days");
	const same = ok(
		await run(responsibilityWriter.editResponsibility, {
			requestKey: key(),
			expectedRevision: edited.revision,
			input: { responsibilityId: second.id, text: "Follow up within two days" },
		}),
	);
	assert.equal(same.outcome, "noop");
	assert.equal(same.revision, edited.revision);
	refused(
		await run(responsibilityWriter.editResponsibility, {
			requestKey: key(),
			expectedRevision: "999",
			input: { responsibilityId: second.id, text: "Replaced" },
		}),
		"conflict",
	);
	assert.equal((await linesOf(team.id)).find((row) => row.id === second.id).text, "Follow up within two days");
	const today = (await admin.execute(sql`SELECT (clock_timestamp() AT TIME ZONE 'America/Chicago')::date::text AS d`))
		.rows[0].d;
	const tickInput = {
		requestKey: key(),
		expectedRevision: edited.revision,
		input: { responsibilityId: second.id, done: true },
	};
	const ticked = ok(await run(responsibilityWriter.completeResponsibility, tickInput));
	assert.equal(ticked.completedOn, today);
	assert.equal((await linesOf(team.id)).find((row) => row.id === second.id).completed_on, today);
	const tickReplay = ok(await run(responsibilityWriter.completeResponsibility, tickInput));
	assert.equal(tickReplay.receiptId, ticked.receiptId);
	assert.equal(await audits(tickInput.requestKey), 1);
	const retick = ok(
		await run(responsibilityWriter.completeResponsibility, {
			requestKey: key(),
			expectedRevision: ticked.revision,
			input: { responsibilityId: second.id, done: true },
		}),
	);
	assert.equal(retick.outcome, "noop");
	assert.equal(retick.completedOn, today);
	const cleared = ok(
		await run(responsibilityWriter.completeResponsibility, {
			requestKey: key(),
			expectedRevision: retick.revision,
			input: { responsibilityId: second.id, done: false },
		}),
	);
	assert.equal(cleared.completedOn, null);
	assert.equal((await linesOf(team.id)).find((row) => row.id === second.id).completed_on, null);
	const tickedAgain = ok(
		await run(responsibilityWriter.completeResponsibility, {
			requestKey: key(),
			expectedRevision: cleared.revision,
			input: { responsibilityId: second.id, done: true },
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
	assert.equal(added.revision, (await linesOf(team.id)).find((row) => row.id === added.id).revision);
	const columnDefault = (
		await admin.execute(sql`SELECT pg_get_expr(d.adbin, d.adrelid) AS value
			FROM pg_attribute a
			JOIN pg_class c ON c.oid = a.attrelid
			JOIN pg_namespace n ON n.oid = c.relnamespace
			LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
			WHERE c.relname = 'responsibility' AND a.attname = 'revision' AND n.nspname = current_schema()`)
	).rows[0].value;
	assert.equal(added.revision, columnDefault);
	assert.equal((await linesOf(team.id)).find((row) => row.id === added.id).removed, false);
	assert.equal(await phase(), started);

	const facilities = await expectedLines("facilities");
	const declinedTeam = await makeTemplateTeam("Passed", "facilities");
	const declinedInput = await offerInput(declinedTeam.id, "decline", [facilities[0].key], declinedTeam.revision);
	const declined = ok(await run(responsibilityWriter.offerResponsibilities, declinedInput));
	assert.equal(declined.decision, "decline");
	assert.equal((await linesOf(declinedTeam.id)).filter((row) => !row.removed).length, 0);
	assert.equal((await linesOf(declinedTeam.id)).length, facilities.length);
	const declinedPreview = ok(
		await responsibilityReader.previewResponsibilities(db, await viewer(), { teamId: declinedTeam.id }),
	);
	assert.deepEqual(declinedPreview.lines, []);
	assert.equal(declinedPreview.proposedCount, 0);
	const held = (await offerOf(declinedTeam.id)).version;
	const facilitiesVersion = await addVersion("facilities");
	const blocked = ok(
		await run(
			responsibilityWriter.offerResponsibilities,
			await offerInput(
				declinedTeam.id,
				"accept",
				facilities.map((line) => line.key),
				(await offerOf(declinedTeam.id)).revision,
			),
		),
	);
	assert.equal(blocked.outcome, "noop");
	assert.equal(blocked.decision, "decline");
	assert.deepEqual(blocked.createdIds, []);
	assert.equal((await offerOf(declinedTeam.id)).version, held);
	assert.notEqual(held, facilitiesVersion);
	assert.equal((await linesOf(declinedTeam.id)).filter((row) => !row.removed).length, 0);

	const worshipVersion = await addVersion("worship");
	const moved = ok(
		await run(
			responsibilityWriter.offerResponsibilities,
			await offerInput(
				team.id,
				"accept",
				worship.map((line) => line.key),
				(await offerOf(team.id)).revision,
			),
		),
	);
	assert.equal(moved.outcome, "changed");
	assert.deepEqual(moved.createdIds, []);
	assert.equal((await offerOf(team.id)).version, worshipVersion);
	stored = await linesOf(team.id);
	assert.equal(stored.find((row) => row.id === second.id).text, "Follow up within two days");
	assert.equal(stored.find((row) => row.id === first.id).removed, true);
	assert.equal(stored.find((row) => row.source_line === worship[2].key).removed, true);
	assert.equal(stored.find((row) => row.id === added.id).text, "Bring the keys");
	const beforeDecline = await linesOf(team.id);
	refused(
		await run(
			responsibilityWriter.offerResponsibilities,
			await offerInput(team.id, "decline", [], (await offerOf(team.id)).revision),
		),
		"conflict",
	);
	assert.deepEqual(await linesOf(team.id), beforeDecline);

	const assimilation = await expectedLines("assimilation");
	const blank = await makeTemplateTeam("None", "assimilation");
	const empty = ok(
		await run(responsibilityWriter.offerResponsibilities, await offerInput(blank.id, "accept", [], blank.revision)),
	);
	assert.equal(empty.outcome, "changed");
	assert.equal((await linesOf(blank.id)).filter((row) => !row.removed).length, 0);
	assert.equal((await linesOf(blank.id)).length, assimilation.length);
	assert.equal(await phase(), started);
	refused(
		await run(responsibilityWriter.deleteResponsibility, {
			requestKey: key(),
			expectedRevision: removed.revision,
			input: { responsibilityId: first.id },
		}),
		"conflict",
	);
});

test("INV-tenancy a forged session, a stale role, and a non-leader cannot change responsibilities", async () => {
	const technology = await expectedLines("technology");
	const team = await makeTemplateTeam("Guarded", "technology");
	const accepted = ok(
		await run(
			responsibilityWriter.offerResponsibilities,
			await offerInput(team.id, "accept", [technology[0].key], team.revision),
		),
	);
	assert.equal(accepted.createdIds.length, technology.length);
	const row = (await linesOf(team.id)).find((item) => item.source_line === technology[0].key);
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
			await offerInput(team.id, "accept", [technology[1].key], (await offerOf(team.id)).revision),
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

	const forgedInput = await offerInput(team.id, "decline", [], (await offerOf(team.id)).revision);
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
			await offerInput(team.id, "accept", ["missing-line"], (await offerOf(team.id)).revision),
		),
		"access_denied",
	);
	const missing = await offerInput(team.id, "accept", [technology[0].key], (await offerOf(team.id)).revision);
	missing.input.teamId = randomUUID();
	refused(await run(responsibilityWriter.offerResponsibilities, missing), "unavailable");
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
			await offerInput(team.id, "accept", [technology[0].key], (await offerOf(team.id)).revision),
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
			await offerInput(team.id, "accept", [], (await offerOf(team.id)).revision),
		),
		"unavailable",
	);
	refused(
		await run(responsibilityWriter.completeResponsibility, {
			requestKey: key(),
			expectedRevision: done.revision,
			input: { responsibilityId: row.id, done: false },
		}),
		"unavailable",
	);
	refused(
		await run(responsibilityWriter.addResponsibility, {
			requestKey: key(),
			expectedRevision: (await offerOf(team.id)).revision,
			input: { teamId: team.id, text: "After archive" },
		}),
		"unavailable",
	);
});

test("AC:REQ-IDN-005 an unknown or another church's team or line is unavailable to responsibilities", async () => {
	const gone = (result) => refused(result, "unavailable");
	const foreign = ok(await run(teamsWriter.create, { requestKey: key(), input: { name: "Foreign duties" } }, 3)).team;
	// Another church's line, written directly: the writer is not under test for that church.
	const foreignLine = { id: randomUUID(), revision: "1" };
	await admin.execute(sql`INSERT INTO responsibility (id, plant_id, team_id, source_version_id, source_line, text, sort_order)
		VALUES (${foreignLine.id}, ${Q}, ${foreign.id}, (SELECT id FROM reference_version ORDER BY id LIMIT 1),
			${"custom:" + foreignLine.id}, 'Foreign line', 1)`);
	const foreignRevision = (await admin.execute(sql`SELECT revision::text AS r FROM team WHERE id=${foreign.id}`))
		.rows[0].r;
	for (const [teamId, responsibilityId] of [
		[randomUUID(), randomUUID()],
		[foreign.id, foreignLine.id],
	]) {
		gone(await responsibilityReader.listResponsibilities(db, await viewer(), { teamId }));
		gone(await responsibilityReader.previewResponsibilities(db, await viewer(), { teamId }));
		gone(
			await run(responsibilityWriter.offerResponsibilities, {
				requestKey: key(),
				expectedRevision: foreignRevision,
				input: {
					teamId,
					decision: "decline",
					selected: [],
					expectedVersion: freeze.artifactSha256,
					reviewDigest: "0".repeat(64),
				},
			}),
		);
		gone(
			await run(responsibilityWriter.addResponsibility, {
				requestKey: key(),
				expectedRevision: foreignRevision,
				input: { teamId, text: "Probe" },
			}),
		);
		for (const [op, input] of [
			[responsibilityWriter.editResponsibility, { responsibilityId, text: "Probe" }],
			[responsibilityWriter.completeResponsibility, { responsibilityId, done: true }],
			[responsibilityWriter.deleteResponsibility, { responsibilityId }],
		])
			gone(await run(op, { requestKey: key(), expectedRevision: foreignLine.revision, input }));
	}
	const stored = (
		await admin.execute(sql`SELECT text, completed_on, removed_at FROM responsibility WHERE id=${foreignLine.id}`)
	).rows[0];
	assert.deepEqual([stored.text, stored.completed_on, stored.removed_at], ["Foreign line", null, null]);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM responsibility WHERE text='Probe'`), 0);
});

test("AC:TARGET-TEAM-007 a custom team and administration have no Playbook lines", async () => {
	for (const [name, templateKey] of [
		["Office", "administration"],
		["Custom", null],
	]) {
		const team = await makeTemplateTeam(name, templateKey);
		const preview = ok(await responsibilityReader.previewResponsibilities(db, await viewer(), { teamId: team.id }));
		assert.deepEqual(preview.lines, []);
		assert.equal(preview.proposedCount, 0);
		assert.equal(preview.templateVersion, freeze.artifactSha256);
		const before = await count(sql`SELECT count(*)::int AS n FROM responsibility WHERE team_id=${team.id}`);
		refused(
			await run(
				responsibilityWriter.offerResponsibilities,
				await offerInput(team.id, "accept", ["Overall leadership"], team.revision),
			),
			"access_denied",
		);
		refused(
			await run(responsibilityWriter.offerResponsibilities, await offerInput(team.id, "accept", [], team.revision)),
			"unavailable",
		);
		assert.equal(await count(sql`SELECT count(*)::int AS n FROM responsibility WHERE team_id=${team.id}`), before);
	}
});

test("AC:TARGET-TEAM-007 every template key maps to a frozen catalog team or the no-lines key", async () => {
	const templateKeys = new Set(TEMPLATES.map((team) => team.key));
	for (const key of Object.keys(REFERENCE_TEAM_KEY)) assert.equal(templateKeys.has(key), true);
	for (const team of TEMPLATES) {
		const referenceKey = referenceTeamKey(team.key);
		if (referenceKey === null) {
			assert.equal(team.key, NO_PLAYBOOK_TEAM_KEY);
			assert.deepEqual(await linesForTemplate(team.key), []);
			continue;
		}
		assert.equal(typeof (await playbookTeam(referenceKey)).description, "string");
		assert.deepEqual(await linesForTemplate(team.key), await expectedLines(referenceKey));
	}
	assert.equal(referenceTeamKey("leadership"), "senior_pastor");
	assert.equal(referenceTeamKey(null), null);
	assert.deepEqual(
		(await linesForTemplate("leadership")).map((line) => line.text),
		["Overall leadership", "Vision casting", "Preaching calendar", "Shepherding", "Leader development"],
	);
	assert.equal((await playbookTeam("senior_pastor")).version, freeze.artifactSha256);
	assert.equal((await playbookTeam("not-a-team")).description, null);
});
