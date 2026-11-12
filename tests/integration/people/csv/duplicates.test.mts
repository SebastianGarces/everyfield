// T-263 (D-789, D-790): "Not a duplicate" on a pair the CSV import flagged with "Add, review later". An Owner or Admin
// dismisses it, it leaves the list and shows in the Dismissed view, each dismiss and restore writes one audit row, a
// repeat writes nothing and a stale pair is refused with nothing written. Through the public operations, on a scratch
// schema, the way the web mount runs them (withPeopleWrite with the request's resolved actor).
import { fixture, ok, refused } from "../../../support/fixture.mts";
import { sql } from "../../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { runDueImports } from "../../../../apps/web/src/server/people/run-imports.ts";
import {
	dismissDuplicatePair,
	executeBulkImport,
	listDismissedDuplicatePairs,
	listDuplicatePairs,
	peopleCsv as csv,
	peopleMerge,
	peopleReader,
	peopleWriter as people,
	restoreDuplicatePair,
	withPeopleWrite,
} from "../../../../packages/domain/src/people/index.ts";

const noReminders = async () => {
	throw Error("unexpected task reminder replan");
};

const database = await fixture({ prefix: "t263" });
const { admin } = database;
const db = database.pools.runtime;
const plants = [database.tenant.id, (await database.plant()).id];
const actors = [
	await database.actor({ kind: "plant", id: plants[0] }, "admin", { user: { name: "Ada Admin" } }),
	database.actors.member,
	await database.actor({ kind: "plant", id: plants[1] }, "admin"),
	database.actors.owner,
];
// 0: church A admin, 1: church A member, 2: church B admin, 3: church A owner.
const ctx = (who = 0) => ({ session: actors[who].session, selected: { kind: "plant", id: plants[who === 2 ? 1 : 0] } });
const rows = async (query) => (await admin.execute(query)).rows;
const read = (who, body) => db.transaction((t) => body(t, ctx(who)));
const actor = async (who = 0) => db.transaction((t) => RequestActor.resolve(t, actors[who].session));
const write = async (who, body) => withPeopleWrite(db, await actor(who), body);
const dismiss = (pair, who = 0) => write(who, (t, c) => dismissDuplicatePair(t, c, pair));
const restore = (pair, who = 0) => write(who, (t, c) => restoreDuplicatePair(t, c, pair));
const listed = async (who = 0) => ok(await read(who, (t, c) => listDuplicatePairs(t, c))).items;
const dismissedList = async (who = 0) => ok(await read(who, (t, c) => listDismissedDuplicatePairs(t, c))).items;
const ids = (items) => items.map((x) => ({ personId: x.person.id, withPersonId: x.with.id }));
const bytes = (text) => new TextEncoder().encode(text);

async function person(name, input = {}) {
	return ok(
		await write(3, (t, c) =>
			people.createPerson(t, c, { requestKey: randomUUID(), input: { displayName: name, ...input } }),
		),
	).person;
}
/** Imports `names` with "Add, review later", each against an existing person with the same email: one pair each. */
async function flaggedPairs(names) {
	const tag = randomUUID().slice(0, 8);
	const existing = [];
	for (const n of names)
		existing.push(await person(`${n} Existing`, { email: `${n.toLowerCase()}-${tag}@example.test` }));
	const text =
		"first_name,last_name,email\r\n" +
		names.map((n) => `${n},Imported,${n.toLowerCase()}-${tag}@example.test\r\n`).join("");
	const preview = ok(await read(3, (t, c) => csv.previewImport(t, c, { file: bytes(text) })));
	const requestKey = randomUUID();
	ok(
		await executeBulkImport(db, await actor(3), {
			requestKey,
			file: bytes(text),
			fileDigest: preview.fileDigest,
			reviewDigest: preview.reviewDigest,
			choices: preview.rows.map((r) => ({ row: r.row, choice: "create_and_review" })),
		}),
	);
	await runDueImports(db, 10);
	const receipt = ok(await read(3, (t, c) => csv.getImportReceipt(t, c, { requestKey })));
	return names.map((_, i) => ({
		personId: receipt.rows.find((r) => r.row === i + 1).personId,
		withPersonId: existing[i].id,
	}));
}
const mine = (pairs) => (items) => ids(items).filter((x) => pairs.some((p) => p.personId === x.personId));
const audits = async (pair) =>
	rows(sql`SELECT tenant_id::text,actor_id::text,action,kind,subject_type,subject_id::text,metadata FROM audit_event
 WHERE subject_id=${sql.param(pair.personId)}::uuid AND action IN ('people.duplicate_dismissed','people.duplicate_restored')
 ORDER BY occurred_at,id`);
const dismissals = async (pair) =>
	(
		await rows(
			sql`SELECT count(*)::int n FROM person_duplicate_dismissal WHERE person_id=${sql.param(pair.personId)}::uuid`,
		)
	)[0].n;

after(async () => {
	await database.close();
});

test("AC:TARGET-PPL-016 T-263 a dismissed pair leaves the list for the Dismissed view, and Restore puts it back in its import order, each with its audit row", async () => {
	const [first, second] = await flaggedPairs(["Iris", "Jude"]);
	const ours = mine([first, second]);
	assert.deepEqual(ours(await listed()), [first, second]);
	assert.deepEqual(ours(await dismissedList()), []);

	assert.deepEqual(ok(await dismiss(first)), { outcome: "changed" });
	assert.deepEqual(ours(await listed()), [second]);
	const [shown] = (await dismissedList()).filter((x) => x.person.id === first.personId);
	assert.equal(shown.person.displayName, "Iris Imported");
	assert.equal(shown.with.displayName, "Iris Existing");
	assert.equal(shown.dismissedBy, "Ada Admin");
	const [{ at }] = await rows(
		sql`SELECT to_char(dismissed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at FROM person_duplicate_dismissal
 WHERE person_id=${sql.param(first.personId)}::uuid`,
	);
	assert.equal(shown.dismissedAt, at, "when it was dismissed");

	assert.deepEqual(ok(await restore(first)), { outcome: "changed" });
	assert.deepEqual(ours(await listed()), [first, second], "back in its import order");
	assert.deepEqual(ours(await dismissedList()), []);

	const audit = { tenant_id: plants[0], actor_id: actors[0].id, subject_type: "person", subject_id: first.personId };
	assert.deepEqual(await audits(first), [
		{ ...audit, action: "people.duplicate_dismissed", kind: "hide", metadata: { withPersonId: first.withPersonId } },
		{ ...audit, action: "people.duplicate_restored", kind: "restore", metadata: { withPersonId: first.withPersonId } },
	]);
});

test("AC:TARGET-PPL-016 T-263 a repeated dismiss or restore, or a double click, ends in the same state and writes once", async () => {
	const [pair] = await flaggedPairs(["Kai"]);
	assert.deepEqual(ok(await dismiss(pair)), { outcome: "changed" });
	assert.deepEqual(ok(await dismiss(pair)), { outcome: "noop" });
	assert.equal(await dismissals(pair), 1);
	assert.equal((await audits(pair)).length, 1);

	assert.deepEqual(ok(await restore(pair)), { outcome: "changed" });
	assert.deepEqual(ok(await restore(pair)), { outcome: "noop" });
	assert.equal(await dismissals(pair), 0);
	assert.deepEqual(
		(await audits(pair)).map((a) => a.action),
		["people.duplicate_dismissed", "people.duplicate_restored"],
	);

	// A double click: both requests race, one writes and the other answers that nothing changed.
	const both = await Promise.all([dismiss(pair), dismiss(pair)]);
	assert.deepEqual(both.map((r) => ok(r).outcome).sort(), ["changed", "noop"]);
	assert.equal(await dismissals(pair), 1);
	assert.equal((await audits(pair)).length, 3);
});

test("AC:TARGET-PPL-016 T-263 a merged, retired or never-flagged pair is refused with nothing written, and the Dismissed view shows only live pairs", async () => {
	const [merged, retired, kept] = await flaggedPairs(["Lev", "Mae", "Ned"]);
	const before = async () => [
		(await rows(sql`SELECT count(*)::int n FROM person_duplicate_dismissal`))[0].n,
		(await rows(sql`SELECT count(*)::int n FROM audit_event WHERE action LIKE 'people.duplicate_%'`))[0].n,
	];

	// Merge one side of a listed pair, then try to dismiss it.
	const review = ok(
		await read(3, (t, c) =>
			peopleMerge.getMergeReview(t, c, { sourceId: merged.personId, survivorId: merged.withPersonId }),
		),
	);
	ok(
		await write(3, (t, c) =>
			peopleMerge.mergePeople(t, c, {
				requestKey: randomUUID(),
				input: {
					sourceId: merged.personId,
					survivorId: merged.withPersonId,
					reviewDigest: review.reviewDigest,
					fieldChoices: {},
				},
			}),
		),
	);
	const counts = await before();
	refused(await dismiss(merged), "pair_unavailable");
	refused(await restore(merged), "pair_unavailable");
	// Two live people the import never paired, and a flagged person with someone else.
	const a = await person("Ola Unpaired");
	const b = await person("Pim Unpaired");
	refused(await dismiss({ personId: a.id, withPersonId: b.id }), "pair_unavailable");
	refused(await dismiss({ personId: kept.personId, withPersonId: b.id }), "pair_unavailable");
	assert.deepEqual(await before(), counts, "a refused dismiss or restore writes nothing");

	// Retire one side of a dismissed pair: it leaves the Dismissed view, and Restore is refused.
	ok(await dismiss(retired));
	ok(await dismiss(kept));
	const [{ revision }] = await rows(sql`SELECT revision::text FROM person WHERE id=${sql.param(retired.withPersonId)}`);
	const { reviewRevision } = ok(
		await read(3, (t, c) => peopleReader.getStatusWarnings(t, c, { personId: retired.withPersonId })),
	);
	ok(
		await write(3, (t, c) =>
			people.retirePerson(
				t,
				c,
				{
					requestKey: randomUUID(),
					expectedRevision: revision,
					input: { personId: retired.withPersonId, reason: "Moved away", reviewRevision, handoffs: [] },
				},
				noReminders,
			),
		),
	);
	const ours = mine([merged, retired, kept]);
	assert.deepEqual(ours(await dismissedList()), [kept]);
	refused(await restore(retired), "pair_unavailable");
	assert.deepEqual(ours(await listed()), []);
});

test("AC:TARGET-PPL-016 INV-tenancy T-263 only the church's Owners and Admins dismiss, restore or see dismissed pairs", async () => {
	const [pair] = await flaggedPairs(["Quin"]);
	// A Member is refused by the domain write and read, not only by the page.
	refused(await dismiss(pair, 1));
	refused(await read(1, (t, c) => listDismissedDuplicatePairs(t, c)));
	assert.equal(await dismissals(pair), 0);

	// Another church's Admin can neither dismiss this church's pair nor see it once it is dismissed.
	refused(await dismiss(pair, 2), "pair_unavailable");
	assert.equal(await dismissals(pair), 0);
	ok(await dismiss(pair, 3));
	assert.deepEqual(await dismissedList(2), []);
	refused(await restore(pair, 2), "pair_unavailable");
	refused(await restore(pair, 1));
	assert.equal(await dismissals(pair), 1);
	assert.deepEqual(mine([pair])(await dismissedList(0)), [pair]);
});

// T-269 (D-844, D-845): each dismiss and restore shows in the Activity of both people in the pair, naming the other one
// by their current name.
const feed = async (personId, who = 3) =>
	ok(await read(who, (t, c) => peopleReader.getActivities(t, c, { personId, kinds: ["activity"], limit: 24 }))).items;
const reviews = (items) =>
	items
		.filter((i) => i.action === "duplicate_dismissed" || i.action === "duplicate_restored")
		.map((i) => ({ action: i.action, actor: i.actor, with: i.withPerson }));
const by = (who) => ({ kind: "current_account", accountId: actors[who].id });
async function retire(personId) {
	const [{ revision }] = await rows(sql`SELECT revision::text FROM person WHERE id=${sql.param(personId)}`);
	const { reviewRevision } = ok(await read(3, (t, c) => peopleReader.getStatusWarnings(t, c, { personId })));
	ok(
		await write(3, (t, c) =>
			people.retirePerson(
				t,
				c,
				{
					requestKey: randomUUID(),
					expectedRevision: revision,
					input: { personId, reason: "Moved away", reviewRevision, handoffs: [] },
				},
				noReminders,
			),
		),
	);
}

test("AC:TARGET-PPL-008 T-269 a dismiss and its restore show in both people's Activity, newest first, naming the other person", async () => {
	const [pair] = await flaggedPairs(["Rue"]);
	ok(await dismiss(pair, 0));
	assert.deepEqual(ok(await dismiss(pair, 0)), { outcome: "noop" }, "a repeat writes nothing");
	ok(await restore(pair, 3));
	const imported = { id: pair.personId, displayName: "Rue Imported" };
	const existing = { id: pair.withPersonId, displayName: "Rue Existing" };
	assert.deepEqual(reviews(await feed(pair.personId)), [
		{ action: "duplicate_restored", actor: by(3), with: existing },
		{ action: "duplicate_dismissed", actor: by(0), with: existing },
	]);
	assert.deepEqual(reviews(await feed(pair.withPersonId)), [
		{ action: "duplicate_restored", actor: by(3), with: imported },
		{ action: "duplicate_dismissed", actor: by(0), with: imported },
	]);
	// The entries hold their place in the person's one time-and-ID order, after the import's "Added to People".
	const items = await feed(pair.personId);
	assert.deepEqual(
		items.map((i) => i.action),
		["duplicate_restored", "duplicate_dismissed", "created"],
	);
	const ordered = [...items].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));
	assert.deepEqual(items, ordered);
});

test("AC:TARGET-PPL-008 T-269 the entry names the other person as they are now: renamed, retired or merged away", async () => {
	const [renamed, merged] = await flaggedPairs(["Sol", "Tam"]);
	ok(await dismiss(renamed));
	ok(await dismiss(merged));
	const [{ revision }] = await rows(sql`SELECT revision::text FROM person WHERE id=${sql.param(renamed.withPersonId)}`);
	ok(
		await write(3, (t, c) =>
			people.updatePerson(t, c, {
				requestKey: randomUUID(),
				expectedRevision: revision,
				input: { personId: renamed.withPersonId, patch: { displayName: "Sol Renamed" } },
			}),
		),
	);
	const named = async () => reviews(await feed(renamed.personId)).map((r) => r.with);
	assert.deepEqual(await named(), [{ id: renamed.withPersonId, displayName: "Sol Renamed" }]);
	await retire(renamed.withPersonId);
	assert.deepEqual(
		await named(),
		[{ id: renamed.withPersonId, displayName: "Sol Renamed" }],
		"still named once retired",
	);

	// Restore puts the pair back on the list, then a merge of the imported person into the other one: the survivor's
	// feed shows the merged person's history too, and the entries still name them.
	ok(await restore(merged));
	const review = ok(
		await read(3, (t, c) =>
			peopleMerge.getMergeReview(t, c, { sourceId: merged.personId, survivorId: merged.withPersonId }),
		),
	);
	ok(
		await write(3, (t, c) =>
			peopleMerge.mergePeople(t, c, {
				requestKey: randomUUID(),
				input: {
					sourceId: merged.personId,
					survivorId: merged.withPersonId,
					reviewDigest: review.reviewDigest,
					fieldChoices: {},
				},
			}),
		),
	);
	const gone = { id: merged.personId, displayName: "Tam Imported" };
	assert.deepEqual(
		reviews(await feed(merged.withPersonId)).map((r) => [r.action, r.with]),
		[
			["duplicate_restored", gone],
			["duplicate_dismissed", gone],
		],
		"once each, though both sides of the pair are in the survivor's feed",
	);
});

test("AC:TARGET-PPL-008 INV-tenancy T-269 the feed never shows or names another church's duplicate review", async () => {
	const [pair] = await flaggedPairs(["Uma"]);
	ok(await dismiss(pair));
	const theirs = ok(
		await write(2, (t, c) =>
			people.createPerson(t, c, { requestKey: randomUUID(), input: { displayName: "Vic Other" } }),
		),
	).person;
	// Another church's dismissal that names this church's person, and this church's row that names theirs.
	const [mine] = await rows(sql`SELECT id FROM audit_event WHERE subject_id=${sql.param(pair.personId)}::uuid
 AND action='people.duplicate_dismissed'`);
	await admin.execute(sql`INSERT INTO audit_event (tenant_id,actor_id,actor_token,action,kind,subject_type,subject_id,metadata)
 SELECT ${sql.param(plants[1])}::uuid,${sql.param(actors[2].id)}::uuid,actor_token,action,kind,subject_type,${sql.param(theirs.id)}::uuid,
  jsonb_build_object('withPersonId',${sql.param(pair.withPersonId)}::text) FROM audit_event WHERE id=${sql.param(mine.id)}::uuid`);
	await admin.execute(sql`INSERT INTO audit_event (tenant_id,actor_id,actor_token,action,kind,subject_type,subject_id,metadata)
 SELECT tenant_id,actor_id,actor_token,action,kind,subject_type,subject_id,jsonb_build_object('withPersonId',${sql.param(theirs.id)}::text)
 FROM audit_event WHERE id=${sql.param(mine.id)}::uuid`);
	assert.deepEqual(
		reviews(await feed(pair.withPersonId)).map((r) => r.with),
		[{ id: pair.personId, displayName: "Uma Imported" }],
	);
	assert.deepEqual(
		reviews(await feed(pair.personId)).map((r) => r.with),
		[{ id: pair.withPersonId, displayName: "Uma Existing" }],
	);
	assert.deepEqual(reviews(await feed(theirs.id, 2)), []);
});
