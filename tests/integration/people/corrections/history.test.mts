import { fixture, ok, refused } from "../../../support/fixture.mts";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import { authorityOf, church, type Row } from "../people-support.mts";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { owner } from "../../../../packages/contracts/src/common/index.ts";
import type { WriteTx } from "../../../../packages/domain/src/access/session.ts";
import { peopleMerge, peopleUnmerge, peopleWriter as people } from "../../../../packages/domain/src/people/index.ts";
import { followUpReader } from "../../../../packages/domain/src/followups/index.ts";
import { communicationWriter } from "../../../../packages/domain/src/communication/index.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";

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
type Who = keyof typeof actors;
const ctx = (who: Who = "owner") => ({
	session: actors[who].session,
	selected: who === "stranger" ? church(other) : who === "orgAdmin" ? owner.parse(org) : church(plant),
});
const tx = <T,>(body: (t: WriteTx) => Promise<T>) => gatedTransaction(db, body);
const key = () => randomUUID();
const rows = async <T extends Row>(query: SQL) => (await admin.execute<T>(query)).rows;
const authority = (who: Who = "owner") => gatedTransaction(db, (t) => authorityOf(t, actors[who]));
after(() => database.close());

async function person(name: string) {
	return ok(
		await tx((t) =>
			people.createPerson(t, ctx(), {
				requestKey: key(),
				input: { displayName: name, adultClassification: "adult" },
			}),
		),
	).person.id;
}
async function meeting(title: string, day: string) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,
 resolver_version,status,attendance_revision) VALUES(${id},${plant},'vision_meeting',${title},${day}::date,'18:00',
 'America/Chicago',(${day}||'T23:00:00Z')::timestamptz,'1','completed',1)`);
	return id;
}
async function followUp(personId: string, title: string, day: string, due: string) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO obligation(id,plant_id,meeting_id,person_id,kind,origin_at,origin_date,timezone,
 formula_version,due_date) VALUES(${id},${plant},${await meeting(title, day)},${personId},'follow_up',
 (${day}||'T23:00:00Z')::timestamptz,${day}::date,'America/Chicago','1',${due}::date)`);
	return id;
}
async function outcome(personId: string, obligationId: string | null = null) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO contact_outcome(id,plant_id,person_id,obligation_id,outcome,occurred_at,recorded_at,
 contact_channel) VALUES(${id},${plant},${personId},${obligationId}::uuid,'contacted',clock_timestamp()-interval '1 day',
 clock_timestamp(),'phone')`);
	return id;
}
async function sentEmail(personId: string, subject = "Welcome to Synthetic") {
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
const HISTORY = [
	["obligation", "person_id"],
	["contact_outcome", "person_id"],
	["mail", "recipient_person_id"],
] as const;
type Moved = { row: { id: string; plant_id?: string; tenant_id?: string } };
type History = Record<(typeof HISTORY)[number][0], Moved[]>;
async function historyOf(...ids: string[]) {
	const out: History = { obligation: [], contact_outcome: [], mail: [] };
	for (const [table, column] of HISTORY)
		out[table] = await rows<Moved>(sql`SELECT to_jsonb(x) AS row FROM ${sql.identifier(table)} x
 WHERE x.${sql.identifier(column)}=ANY(${sql.param(ids)}::uuid[]) ORDER BY x.id`);
	return out;
}
const idsOn = async (personId: string) => {
	const h = await historyOf(personId);
	return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, v.map((r) => r.row.id)]));
};
const people_ = async (...ids: string[]) =>
	rows(sql`SELECT id,state,revision::text,merged_into_person_id FROM person WHERE id=ANY(${sql.param(ids)}::uuid[])
 ORDER BY id`);
const review = (sourceId: string, survivorId: string, who: Who = "owner") =>
	tx((t) => peopleMerge.getMergeReview(t, ctx(who), { sourceId, survivorId }));
const mergeWith = (
	sourceId: string,
	survivorId: string,
	reviewDigest: string,
	requestKey: string = key(),
	who: Who = "owner",
) => tx((t) => peopleMerge.mergePeople(t, ctx(who), { requestKey, input: { sourceId, survivorId, reviewDigest } }));
const preview = (mergeId: string, who: Who = "owner") =>
	tx((t) => peopleUnmerge.previewUnmerge(t, ctx(who), { mergeId }));
const unmerge = (mergeId: string, expectedRevision: string, who: Who = "owner", requestKey: string = key()) =>
	tx((t) => peopleUnmerge.unmergePeople(t, ctx(who), { requestKey, expectedRevision, input: { mergeId } }));
const moving = (r: { references: { kind: string; count: number; treatment: string }[] }) =>
	r.references
		.filter((x) => ["obligation", "contact_outcome", "mail"].includes(x.kind))
		.map((x) => [x.kind, x.count, x.treatment]);

test("AC:TARGET-PPL-025 a merge carries the source's follow-up and its outcome to the survivor, keeps the sent email on its recipient and shows it on the survivor, refuses a stale review and repeats as the earlier result", async () => {
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
		["obligation", 1, "move"],
	]);
	assert.deepEqual(r.blockers, { causes: [], leadership: [], invitations: [] });
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
			{ kind: "obligation", count: 1 },
		],
	);
	assert.deepEqual(await idsOn(brooks), { obligation: [], contact_outcome: [], mail: [mailId] });
	assert.deepEqual(await idsOn(morgan), {
		obligation: [obligation],
		contact_outcome: [contacted, later].sort(),
		mail: [],
	});
	const after = await historyOf(brooks, morgan);
	for (const [table] of HISTORY) {
		assert.equal(after[table].length, before[table].length + (table === "contact_outcome" ? 1 : 0), table);
		assert.ok(
			after[table].every((x) => (x.row.plant_id ?? x.row.tenant_id) === plant),
			table,
		);
	}

	const viewer = await authority();
	const obligations = ok(await tx((t) => followUpReader.readObligations(t, viewer, { personId: morgan, limit: 10 })));
	assert.deepEqual(
		obligations.items.map((o) => [o.id, o.person?.id, o.state]),
		[[obligation, morgan, "open"]],
	);
	const contacts = ok(await tx((t) => followUpReader.listContactHistory(t, viewer, { personId: morgan, limit: 10 })));
	assert.deepEqual(contacts.items.map((x) => x.id).sort(), [contacted, later].sort());
	const sent = ok(await tx((t) => communicationWriter.listHistory(t, viewer, { personId: morgan })));
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
	const viewer = await authority();
	const items = ok(await tx((t) => followUpReader.readObligations(t, viewer, { personId: b, limit: 10 }))).items;
	assert.deepEqual(
		items.map((o) => [o.id, o.state]).sort(),
		[
			[mine, "open"],
			[theirs, "open"],
		].sort(),
	);
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
	const without = (h: History) =>
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

test("AC:TARGET-PPL-025 a merge whose source had been emailed unmerges with every email byte-equal, and a merge recorded with moved email gives it back to its recipient", async () => {
	for (const legacy of [false, true]) {
		const s = await person("Avery Fox"),
			k = await person("Avery Fox Keep");
		await followUp(s, "Fox night", "2026-11-01", "2026-11-04");
		const mine = await sentEmail(s),
			theirs = await sentEmail(k);
		const mailRows = () =>
			rows(
				sql`SELECT to_jsonb(m)-'revision' AS row FROM mail m WHERE id IN (${mine}::uuid,${theirs}::uuid) ORDER BY id`,
			);
		const effects = () =>
			rows(sql`SELECT (SELECT count(*)::int FROM mail) AS mail,(SELECT count(*)::int FROM mail_attempt) AS attempts,
 (SELECT count(*)::int FROM job) AS jobs`);
		const before = await mailRows(),
			sends = await effects();
		const merged = ok(await mergeWith(s, k, ok(await review(s, k)).reviewDigest));
		if (legacy) {
			await admin.execute(sql`UPDATE mail SET recipient_person_id=${k},revision=revision+1 WHERE id=${mine}`);
			await admin.execute(sql`UPDATE person_merge SET moved=moved||${JSON.stringify({ mail: [mine] })}::jsonb,
 prior=jsonb_set(prior,'{references}',prior->'references'||${JSON.stringify([["mail", mine, "2"]])}::jsonb)
 WHERE id=${merged.mergeId}`);
		} else assert.deepEqual(await mailRows(), before);
		const p = ok(await preview(merged.mergeId));
		assert.deepEqual(
			[p.conflicts, p.stays, p.restores.find((x) => x.kind === "mail")?.count],
			[[], [], legacy ? 1 : undefined],
		);
		assert.equal(ok(await unmerge(merged.mergeId, p.reviewRevision)).outcome, "changed");
		assert.deepEqual(await mailRows(), before);
		assert.deepEqual([(await idsOn(s)).mail, (await idsOn(k)).mail], [[mine], [theirs]]);
		assert.deepEqual(await effects(), sends);
	}
});

test("AC:TARGET-PPL-025 a Member, another church and an organization seat cannot review, merge or unmerge, and learn nothing of the follow-ups or email", async () => {
	const s = await person("Quinn Park"),
		k = await person("Quinn Park Keep");
	await followUp(s, "Park night", "2026-11-01", "2026-11-04");
	await sentEmail(s, "Private welcome");
	const digest = ok(await review(s, k)).reviewDigest;
	const state = { people: await people_(s, k), history: await historyOf(s, k) };
	for (const who of ["member", "stranger", "orgAdmin"] as const) {
		const r = await review(s, k, who);
		refused(r);
		assert.ok(!JSON.stringify(r).match(/Park night|Private welcome|obligation|mail/), who);
		refused(await mergeWith(s, k, digest, key(), who));
	}
	assert.deepEqual({ people: await people_(s, k), history: await historyOf(s, k) }, state);
	const merged = ok(await mergeWith(s, k, digest));
	const revision = ok(await preview(merged.mergeId)).reviewRevision;
	for (const who of ["member", "stranger", "orgAdmin"] as const) {
		const p = await preview(merged.mergeId, who);
		refused(p);
		assert.ok(!JSON.stringify(p).match(/obligation/), who);
		refused(await unmerge(merged.mergeId, revision, who));
	}
	const moved = await historyOf(s, k);
	assert.ok(moved.obligation.every((x) => x.row.plant_id === plant));
	assert.ok(moved.mail.every((x) => x.row.tenant_id === plant));
});
