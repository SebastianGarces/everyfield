import { fixture, ok, refused } from "../../../support/fixture.mts";
import { sql } from "../../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { peopleMerge, peopleUnmerge, peopleWriter as people } from "../../../../packages/domain/src/people/index.ts";
import { followUpReader } from "../../../../packages/domain/src/followups/index.ts";
import { communicationWriter } from "../../../../packages/domain/src/communication/index.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import { mergeBlockedText, unmergeBlockedText } from "../../../../packages/contracts/src/people/merge/copy.ts";

const database = await fixture({ prefix: "t336" });
const { admin } = database;
const db = database.pools.runtime;
const plant = database.tenant.id;
const other = (await database.plant()).id;
const org = await database.organization();
const actors = {
	owner: database.actors.owner,
	member: database.actors.member,
	stranger: await database.actor({ kind: "plant", id: other }, "admin"),
	orgAdmin: await database.actor(org, "admin"),
};
const ctx = (who = "owner") => ({
	session: actors[who].session,
	selected: who === "stranger" ? { kind: "plant", id: other } : who === "orgAdmin" ? org : { kind: "plant", id: plant },
});
const tx = (body) => gatedTransaction(db, body);
const key = () => randomUUID();
const rows = async (query) => (await admin.execute(query)).rows;
const authority = (who = "owner") => tx((t) => RequestActor.resolve(t, actors[who].session));
after(() => database.close());

async function person(name) {
	return ok(
		await tx((t) =>
			people.createPerson(t, ctx(), {
				requestKey: key(),
				input: { displayName: name, adultClassification: "adult" },
			}),
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
async function followUp(personId, title, day, due) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO obligation(id,plant_id,meeting_id,person_id,kind,origin_at,origin_date,timezone,
 formula_version,due_date) VALUES(${id},${plant},${await meeting(title, day)},${personId},'follow_up',
 (${day}||'T23:00:00Z')::timestamptz,${day}::date,'America/Chicago','1',${due}::date)`);
	return id;
}
async function outcome(personId, obligationId = null) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO contact_outcome(id,plant_id,person_id,obligation_id,outcome,occurred_at,recorded_at,
 contact_channel) VALUES(${id},${plant},${personId},${obligationId}::uuid,'contacted',clock_timestamp()-interval '1 day',
 clock_timestamp(),'phone')`);
	return id;
}
async function sentEmail(personId, subject = "Welcome to Synthetic") {
	const communication = randomUUID(),
		id = randomUUID();
	await admin.execute(sql`INSERT INTO communication(id,plant_id,author_id,revision,state,subject,body_html,body_text,
 audience,scheduled_at,created_at) VALUES(${communication},${plant},${actors.owner.id},2,'scheduled',${subject},
 '<p>Hi</p>','Hi',${JSON.stringify({ groups: [], teamIds: [], personIds: [personId] })}::jsonb,
 clock_timestamp()-interval '2 days',clock_timestamp()-interval '3 days')`);
	await admin.execute(sql`INSERT INTO mail(id,tenant_id,purpose,communication_id,recipient_person_id,logical_key,
 payload_hash,audience_hash,state,sent_at,created_at) VALUES(${id},${plant},'communication',${communication},${personId},
 ${`communication/${communication}/${personId}`},'p','a','sent',clock_timestamp()-interval '2 days',
 clock_timestamp()-interval '2 days')`);
	return id;
}
async function openTask(personId) {
	await admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,person_id)
 VALUES(${randomUUID()},${plant},'Call','general','medium','not_started',clock_timestamp(),'undated',${personId})`);
}

const HISTORY = [
	["obligation", "person_id"],
	["contact_outcome", "person_id"],
	["mail", "recipient_person_id"],
];
async function historyOf(...ids) {
	const out = {};
	for (const [table, column] of HISTORY)
		out[table] = await rows(sql`SELECT to_jsonb(x) AS row FROM ${sql.identifier(table)} x
 WHERE x.${sql.identifier(column)}=ANY(${sql.param(ids)}::uuid[]) ORDER BY x.id`);
	return out;
}
const idsOn = async (personId) => {
	const h = await historyOf(personId);
	return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, v.map((r) => r.row.id)]));
};
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
const moving = (r) =>
	r.references
		.filter((x) => ["obligation", "contact_outcome", "mail"].includes(x.kind))
		.map((x) => [x.kind, x.count, x.treatment]);

test("AC:TARGET-PPL-025 a merge carries the source's follow-up, its outcome and the sent email to the survivor, refuses a stale review and repeats as the earlier result", async () => {
	const brooks = await person("Casey Brooks"),
		morgan = await person("Casey Morgan");
	const obligation = await followUp(brooks, "Vision night", "2026-11-01", "2026-11-04");
	const contacted = await outcome(brooks, obligation);
	const mailId = await sentEmail(brooks);
	const before = await historyOf(brooks, morgan);

	const r = ok(await review(brooks, morgan));
	assert.deepEqual([r.survivor.personId, r.source.personId], [morgan, brooks]);
	assert.deepEqual(moving(r), [
		["contact_outcome", 1, "move"],
		["mail", 1, "move"],
		["obligation", 1, "move"],
	]);
	assert.deepEqual(r.blockers, { causes: [], references: [] });
	assert.deepEqual(r.openFollowUps, [{ personId: brooks, meeting: "Vision night", dueDate: "2026-11-04" }]);

	const later = await outcome(brooks);
	const stale = await people_(brooks, morgan);
	refused(await mergeWith(brooks, morgan, r.reviewDigest), "conflict");
	assert.deepEqual(await people_(brooks, morgan), stale);
	assert.deepEqual((await idsOn(brooks)).contact_outcome, [contacted, later].sort());

	const fresh = ok(await review(brooks, morgan));
	const requestKey = key();
	const merged = ok(await mergeWith(brooks, morgan, fresh.reviewDigest, requestKey));
	assert.deepEqual(
		merged.moved.filter((m) => ["obligation", "contact_outcome", "mail"].includes(m.kind)),
		[
			{ kind: "contact_outcome", count: 2 },
			{ kind: "mail", count: 1 },
			{ kind: "obligation", count: 1 },
		],
	);
	assert.deepEqual(await idsOn(brooks), { obligation: [], contact_outcome: [], mail: [] });
	assert.deepEqual(await idsOn(morgan), {
		obligation: [obligation],
		contact_outcome: [contacted, later].sort(),
		mail: [mailId],
	});
	const after = await historyOf(brooks, morgan);
	for (const [table] of HISTORY) {
		assert.equal(after[table].length, before[table].length + (table === "contact_outcome" ? 1 : 0), table);
		assert.ok(
			after[table].every((x) => (x.row.plant_id ?? x.row.tenant_id) === plant),
			table,
		);
	}

	const owner = await authority();
	const obligations = ok(await tx((t) => followUpReader.readObligations(t, owner, { personId: morgan, limit: 10 })));
	assert.deepEqual(
		obligations.items.map((o) => [o.id, o.person.id, o.state]),
		[[obligation, morgan, "open"]],
	);
	const contacts = ok(await tx((t) => followUpReader.listContactHistory(t, owner, { personId: morgan, limit: 10 })));
	assert.deepEqual(contacts.items.map((x) => x.id).sort(), [contacted, later].sort());
	const sent = ok(await tx((t) => communicationWriter.listHistory(t, owner, { personId: morgan })));
	assert.deepEqual(
		sent.items.map((x) => x.subject),
		["Welcome to Synthetic"],
	);
	assert.deepEqual(ok(await tx((t) => peopleMerge.mergedPersonDestination(t, ctx(), { personId: brooks }))), {
		personId: brooks,
		status: "merged",
		destinationId: morgan,
		mergeId: merged.mergeId,
	});

	const settled = { people: await people_(brooks, morgan), history: await historyOf(brooks, morgan) };
	assert.deepEqual(ok(await mergeWith(brooks, morgan, fresh.reviewDigest, requestKey)), merged);
	assert.deepEqual({ people: await people_(brooks, morgan), history: await historyOf(brooks, morgan) }, settled);
	refused(await mergeWith(brooks, morgan, fresh.reviewDigest));
	assert.deepEqual({ people: await people_(brooks, morgan), history: await historyOf(brooks, morgan) }, settled);
});

test("AC:TARGET-PPL-025 a review names both people's distinct open follow-ups, and the merge keeps both open on the survivor", async () => {
	const a = await person("Jordan Hale"),
		b = await person("Jordan Hale Jr");
	const mine = await followUp(a, "Orientation night", "2026-11-02", "2026-11-05");
	const theirs = await followUp(b, "Vision night two", "2026-11-03", "2026-11-06");
	const r = ok(await review(a, b));
	assert.deepEqual(r.openFollowUps, [
		{ personId: b, meeting: "Vision night two", dueDate: "2026-11-06" },
		{ personId: a, meeting: "Orientation night", dueDate: "2026-11-05" },
	]);
	ok(await mergeWith(a, b, r.reviewDigest));
	const owner = await authority();
	const items = ok(await tx((t) => followUpReader.readObligations(t, owner, { personId: b, limit: 10 }))).items;
	assert.deepEqual(
		items.map((o) => [o.id, o.state]).sort(),
		[
			[mine, "open"],
			[theirs, "open"],
		].sort(),
	);
});

test("AC:TARGET-PPL-017 history another domain owns still blocks the review and the confirm with the People copy, naming only what still blocks", async () => {
	const s = await person("Riley Stone"),
		k = await person("Riley Stone Keep");
	await followUp(s, "Blocked night", "2026-11-01", "2026-11-04");
	await outcome(s);
	await sentEmail(s);
	await openTask(s);
	const state = { people: await people_(s, k), history: await historyOf(s, k) };
	const r = ok(await review(s, k));
	assert.deepEqual(r.blockers, { causes: ["unregistered_reference"], references: ["task"] });
	assert.equal(
		mergeBlockedText(r.blockers, { source: "Riley Stone", survivor: "Riley Stone Keep" }),
		"This merge cannot run. Riley Stone has tasks on record. Merging people with this history is not available in Everyfield yet.",
	);
	const error = refused(await mergeWith(s, k, r.reviewDigest), "merge_blocked");
	assert.deepEqual(error.details, { causes: ["unregistered_reference"], references: ["task"] });
	assert.deepEqual({ people: await people_(s, k), history: await historyOf(s, k) }, state);
});

test("AC:TARGET-PPL-025 Unmerge returns moved follow-ups and outcomes exactly, and keeps the merge and the Unmerge in history", async () => {
	const s = await person("Morgan Lee"),
		k = await person("Morgan Lee Keep");
	const obligation = await followUp(s, "Lee night", "2026-11-01", "2026-11-04");
	await outcome(s, obligation);
	const snapshot = await historyOf(s);
	const merged = ok(await mergeWith(s, k, ok(await review(s, k)).reviewDigest));
	const p = ok(await preview(merged.mergeId));
	assert.deepEqual(
		[p.state, p.conflicts, p.restores.map((x) => [x.kind, x.count]).sort()],
		[
			"merged",
			[],
			[
				["contact_outcome", 1],
				["obligation", 1],
			],
		],
	);
	assert.equal(ok(await unmerge(merged.mergeId, p.reviewRevision)).outcome, "changed");
	const back = await historyOf(s);
	const without = (h) =>
		Object.fromEntries(
			Object.entries(h).map(([t, list]) => [t, list.map(({ row }) => ({ ...row, revision: undefined }))]),
		);
	assert.deepEqual(without(back), without(snapshot));
	assert.deepEqual(await idsOn(k), { obligation: [], contact_outcome: [], mail: [] });
	const events = await rows(sql`SELECT action FROM audit_event WHERE tenant_id=${plant}::uuid AND subject_id=${k}::uuid
 AND action IN ('people.merged','people.unmerged') ORDER BY occurred_at,id`);
	assert.deepEqual(
		events.map((e) => e.action),
		["people.merged", "people.unmerged"],
	);
	assert.equal(ok(await preview(merged.mergeId)).state, "unmerged");
});

test("AC:TARGET-PPL-025 Unmerge after a merge that moved sent email names the email and changes nothing", async () => {
	const s = await person("Avery Fox"),
		k = await person("Avery Fox Keep");
	await followUp(s, "Fox night", "2026-11-01", "2026-11-04");
	await sentEmail(s);
	const merged = ok(await mergeWith(s, k, ok(await review(s, k)).reviewDigest));
	const p = ok(await preview(merged.mergeId));
	assert.deepEqual(p.conflicts, ["mail_sent"]);
	assert.equal(
		unmergeBlockedText(p.conflicts, { source: "Avery Fox", survivor: "Avery Fox Keep" }),
		"Cannot unmerge. The merge moved email sent to Avery Fox into Avery Fox Keep's communication history, and sent email is never unsent. An Unmerge cannot take back sent email, so Everyfield will not run it. Correct Avery’s details by hand instead; each change is kept in the history.",
	);
	const state = { people: await people_(s, k), history: await historyOf(s, k) };
	const error = refused(await unmerge(merged.mergeId, p.reviewRevision), "inverse_conflict");
	assert.deepEqual(error.details.causes, ["mail_sent"]);
	assert.deepEqual({ people: await people_(s, k), history: await historyOf(s, k) }, state);
});

test("AC:TARGET-PPL-025 a Member, another church and an organization seat cannot review, merge or unmerge, and learn nothing of the follow-ups or email", async () => {
	const s = await person("Quinn Park"),
		k = await person("Quinn Park Keep");
	await followUp(s, "Park night", "2026-11-01", "2026-11-04");
	await sentEmail(s, "Private welcome");
	const digest = ok(await review(s, k)).reviewDigest;
	const state = { people: await people_(s, k), history: await historyOf(s, k) };
	for (const who of ["member", "stranger", "orgAdmin"]) {
		const r = await review(s, k, who);
		refused(r);
		assert.ok(!JSON.stringify(r).match(/Park night|Private welcome|obligation|mail/), who);
		refused(await mergeWith(s, k, digest, key(), who));
	}
	assert.deepEqual({ people: await people_(s, k), history: await historyOf(s, k) }, state);
	const merged = ok(await mergeWith(s, k, digest));
	const revision = ok(await preview(merged.mergeId)).reviewRevision;
	for (const who of ["member", "stranger", "orgAdmin"]) {
		const p = await preview(merged.mergeId, who);
		refused(p);
		assert.ok(!JSON.stringify(p).match(/mail_sent|obligation/), who);
		refused(await unmerge(merged.mergeId, revision, who));
	}
	const moved = await historyOf(k);
	assert.ok(moved.obligation.every((x) => x.row.plant_id === plant));
	assert.ok(moved.mail.every((x) => x.row.tenant_id === plant));
});
