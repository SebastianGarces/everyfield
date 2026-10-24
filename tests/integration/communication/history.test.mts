import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { communicationWriter, withCommunicationWrite } from "../../../packages/domain/src/communication/index.ts";
import { addressAad, mailAddressHash, sealText } from "../../../packages/domain/src/communication/delivery.ts";

let f, plant, other, owner, member, stranger, foreign;
const keys = {
	encryptionKey: Buffer.alloc(32, 7),
	addressKey: Buffer.alloc(32, 9),
	from: "news@example.test",
};
const ok = (result) => {
	assert.equal(result.status, "ok", JSON.stringify(result));
	return result.value;
};
const refused = (result, code) => {
	assert.equal(result.status, "refused", JSON.stringify(result));
	assert.equal(result.error.code, code, JSON.stringify(result.error));
	return result.error;
};
const key = () => randomUUID();
const rows = async (query) => (await f.admin.execute(query)).rows;
const write = (who, op, input) =>
	withCommunicationWrite(f.db, who.actor, (tx, ctx) => communicationWriter[op](tx, ctx, input));
const read = (who, op, input, deliveryKeys) =>
	f.db.transaction((tx) => communicationWriter[op](tx, who.actor, input, deliveryKeys));
const countOf = async (query) => Number((await rows(query))[0].n);
const hidden = (value, ...needles) => {
	const text = JSON.stringify(value);
	for (const needle of needles) assert.equal(text.includes(needle), false, needle);
};

async function person(name, fields = {}) {
	const id = randomUUID();
	await f.admin
		.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at,notes)
		VALUES(${id},${fields.plant ?? plant.id},${fields.plant ?? plant.id},${name},${fields.email ?? null},'other',
		'prospect','unknown','unknown',0,${fields.state ?? "live"},clock_timestamp(),${fields.notes ?? null})`);
	return id;
}
async function message(fields = {}) {
	const id = randomUUID();
	const audience = fields.audience ?? { groups: [], teamIds: [], personIds: [] };
	await f.admin
		.execute(sql`INSERT INTO communication (id, plant_id, author_id, revision, state, subject, body_html, body_text, meeting_id, audience, created_at)
		VALUES(${id},${fields.plant ?? plant.id},${owner.id},1,${fields.state ?? "reviewed"},${fields.subject ?? "Hello"},
		${fields.bodyHtml ?? "<p>Hello</p>"},${fields.bodyText ?? "Hello"},${fields.meeting ?? null}::uuid,
		${JSON.stringify(audience)}::jsonb, coalesce(${fields.createdAt ?? null}::timestamptz, clock_timestamp()))`);
	return id;
}
async function meeting(title, target = plant) {
	const id = randomUUID();
	await f.admin
		.execute(sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision)
		VALUES(${id},${target.id},'vision_meeting',${title},'2026-11-01','18:00','America/Chicago','2026-11-01T23:00:00Z','1','completed',1)`);
	return id;
}
async function mail(communicationId, personId, address, patch = {}) {
	const id = randomUUID();
	const tenant = patch.plant ?? plant.id;
	const sealed = sealText(keys.encryptionKey, address, addressAad(tenant, id));
	const addressHash = mailAddressHash(keys.addressKey, address);
	const hours = patch.sentHours ?? null;
	await f.admin
		.execute(sql`INSERT INTO mail (id, tenant_id, recipient_person_id, recipient_address_encrypted, purpose, logical_key,
		payload_hash, audience_hash, frozen_payload, state, address_hash, created_at, sent_at, delivered_at, opened_at, clicked_at, accepted_at)
		SELECT ${id}, ${tenant}, ${personId}, ${sealed}, 'communication', ${`communication/${communicationId}/${personId}`},
			'payload', 'audience', ${JSON.stringify({ v: 1, sealed: "x" })}::jsonb, ${patch.state ?? "sent"}, ${addressHash},
			clock_timestamp(),
			CASE WHEN ${hours}::int IS NULL THEN NULL ELSE clock_timestamp() - make_interval(hours => ${hours}::int) END,
			CASE WHEN ${Boolean(patch.delivered)} THEN clock_timestamp() - make_interval(hours => coalesce(${hours}::int, 0)) END,
			CASE WHEN ${Boolean(patch.opened)} THEN clock_timestamp() END,
			CASE WHEN ${Boolean(patch.clicked)} THEN clock_timestamp() END,
			CASE WHEN ${Boolean(patch.accepted)} THEN clock_timestamp() END`);
	return { id, sealed };
}
async function task(personId, assigneeId) {
	const id = randomUUID();
	await f.admin
		.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,person_id,assignee_id,completed_at)
		VALUES(${id},${plant.id},'Call','follow_up','medium','complete',clock_timestamp(),'undated',${personId},${assigneeId},clock_timestamp())`);
	return id;
}
async function outcome(taskId, personId, name, future = false) {
	const id = randomUUID();
	await f.admin
		.execute(sql`INSERT INTO contact_outcome (id, plant_id, person_id, task_id, outcome, occurred_at, recorded_at, completes_task)
		SELECT ${id}, ${plant.id}, ${personId}, ${taskId}, ${name},
			CASE WHEN ${future} THEN clock_timestamp() + interval '2 days' ELSE ${name === "contacted" ? "2026-10-01T12:00:00Z" : "2026-10-01T12:00:00Z"}::timestamptz END,
			CASE WHEN ${future} THEN clock_timestamp() + interval '2 days' ELSE clock_timestamp() END,
			false`);
	return id;
}

before(async () => {
	f = await fixture();
	plant = await f.workspace();
	other = await f.workspace();
	const seated = async (workspace, roleName) => {
		const account = await f.account();
		await f.seat(account, workspace, roleName);
		return { ...account, actor: await f.actor(account.session) };
	};
	owner = await seated(plant, "owner");
	member = await seated(plant, "member");
	stranger = await seated(plant, "member");
	foreign = await seated(other, "owner");
});
after(() => f?.close());

test("AC:CASE-COM-001 AC:MAIL51-008 history keeps a zero rate and hides private text", async () => {
	const noted = await person("Noted", { email: "noted@example.test", notes: "TOKEN-CANARY" });
	await f.admin
		.execute(sql`INSERT INTO person_note(id,tenant_id,plant_id,person_id,author_id,body,occurred_at,recorded_at)
		VALUES(${randomUUID()},${plant.id},${plant.id},${noted},${owner.id},'CARE-CANARY',clock_timestamp(),clock_timestamp())`);
	const foreignId = await message({
		plant: other.id,
		subject: "SECRET-BODY",
		bodyHtml: "<p>SECRET-BODY</p>",
		bodyText: "SECRET-BODY",
	});
	const draftId = await message({ state: "draft", subject: "COM001-HUB draft", bodyHtml: null, bodyText: null });
	const unknownId = await message({ state: "reviewed", subject: "COM001-HUB unknown", bodyHtml: null, bodyText: null });
	const older = await message({ subject: "CURSOR-PAGE older", createdAt: "2026-10-01T00:00:00Z" });
	const newer = await message({ subject: "CURSOR-PAGE newer", createdAt: "2026-10-02T00:00:00Z" });

	const page = ok(
		await read(owner, "listHistory", {
			query: "COM001-HUB",
			state: "partial_accepted",
			meetingId: "not-an-id",
			limit: 500,
		}),
	);
	assert.equal(page.limit, 100);
	assert.equal(page.rate, null);
	assert.equal(page.draftCountsAsSent, false);
	assert.equal(page.unknownCountsAsSent, false);
	assert.deepEqual(page.foreignRows, []);
	const draft = page.items.find((item) => item.id === draftId);
	const unknown = page.items.find((item) => item.id === unknownId);
	assert.equal(draft.state, "draft");
	assert.equal(draft.countsAsSent, false);
	assert.equal(draft.rate, null);
	assert.equal(draft.reachable, 0);
	assert.equal(unknown.state, "unknown");
	assert.equal(unknown.countsAsSent, false);
	assert.equal(unknown.rate, null);
	assert.equal(
		page.items.some((item) => item.id === foreignId),
		false,
	);
	hidden(page, "TOKEN-CANARY", "CARE-CANARY", "SECRET-BODY");

	const empty = ok(await read(member, "listHistory", { query: "COM001-HUB", channel: "sms" }));
	assert.deepEqual(empty.items, []);
	assert.equal(empty.rate, null);
	const totals = ok(await read(owner, "getDeliveryTotals", { communicationId: draftId }));
	assert.equal(totals.state, "draft");
	assert.equal(totals.reachable, 0);
	assert.equal(totals.rate, null);
	assert.equal(totals.sentForAll, false);
	hidden(totals, "TOKEN-CANARY", "CARE-CANARY", "SECRET-BODY");
	refused(await read(owner, "getDetail", { id: foreignId }, keys), "not_found");
	refused(await read(foreign, "getDeliveryTotals", { communicationId: draftId }), "not_found");

	const first = ok(await read(owner, "listHistory", { query: "CURSOR-PAGE", limit: 1 }));
	assert.equal(first.items[0].id, newer);
	assert.equal(first.complete, false);
	assert.ok(first.nextCursor);
	const second = ok(await read(owner, "listHistory", { query: "CURSOR-PAGE", limit: 1, cursor: first.nextCursor }));
	assert.equal(second.items[0].id, older);
	assert.equal(second.complete, true);
	const fallback = ok(await read(owner, "listHistory", { query: "CURSOR-PAGE", limit: "nope" }));
	assert.equal(fallback.limit, 50);
	assert.equal(fallback.visibleCount, 2);
});

test("AC:CASE-COM-002 detail keeps the sealed delivery address", async () => {
	const alex = await person("Alex Detail", { email: "old@example.test" });
	const meet = await meeting("Vision");
	const emptyMeeting = await meeting("Empty vision");
	const id = await message({
		subject: "Welcome",
		bodyHtml: "<p>Welcome Alex.</p>",
		bodyText: "Welcome Alex.",
		meeting: meet,
		audience: { groups: [], teamIds: [], personIds: [alex] },
	});
	const sent = await mail(id, alex, "old@example.test", { state: "sent", sentHours: 25, delivered: true });
	await f.admin.execute(sql`UPDATE person SET email = 'new@example.test', notes = 'TOKEN-CANARY' WHERE id = ${alex}`);
	await f.admin
		.execute(sql`INSERT INTO person_note(id,tenant_id,plant_id,person_id,author_id,body,occurred_at,recorded_at)
		VALUES(${randomUUID()},${plant.id},${plant.id},${alex},${owner.id},'CARE-CANARY',clock_timestamp(),clock_timestamp())`);
	const detail = ok(await read(owner, "getDetail", { id }, keys));
	assert.equal(detail.subject, "Welcome");
	assert.equal(detail.deliveryAddress, "old@example.test");
	assert.equal(detail.currentPersonAddress, "new@example.test");
	assert.equal(detail.deliveryStatus, "delivered");
	assert.equal(detail.recipients[0].currentPersonAddress, "new@example.test");
	const stored = (await rows(sql`SELECT recipient_address_encrypted AS sealed FROM mail WHERE id = ${sent.id}`))[0]
		.sealed;
	hidden(detail, stored, "TOKEN-CANARY", "CARE-CANARY", "SECRET-BODY");
	const recipients = ok(await read(member, "listHistoryRecipients", { communicationId: id }, keys));
	assert.equal(recipients.items[0].deliveryAddress, "old@example.test");
	assert.equal(recipients.items[0].name, "Alex Detail");
	const tracked = ok(await read(owner, "listMeetingTracking", { meetingId: meet }));
	assert.equal(tracked.complete, true);
	assert.equal(tracked.items[0].personId, alex);
	assert.equal(tracked.items[0].deliveryStatus, "delivered");
	const meetingPage = ok(await read(owner, "listForMeeting", { meetingId: meet }));
	assert.equal(
		meetingPage.items.some((item) => item.id === id),
		true,
	);
	const quiet = ok(await read(owner, "listMeetingTracking", { meetingId: emptyMeeting }));
	assert.deepEqual(quiet.items, []);
	refused(await read(owner, "listForMeeting", { meetingId: randomUUID() }), "not_found");
	refused(await read(owner, "listForPerson", { personId: randomUUID() }), "not_found");
	refused(await read(owner, "getDetail", { id: randomUUID() }, keys), "not_found");
});

test("AC:CASE-COM-006 AC:MAIL51-006 totals and execution stay partial until every recipient is sent", async () => {
	const people = {
		accepted: await person("R1", { email: "r1@example.test" }),
		unknown: await person("R2", { email: "r2@example.test" }),
		rejected: await person("R3", { email: "r3@example.test" }),
	};
	const mixed = await message({ subject: "MAIL51 mixed" });
	await mail(mixed, people.accepted, "r1@example.test", { state: "accepted", accepted: true });
	await mail(mixed, people.unknown, "r2@example.test", { state: "unknown" });
	await mail(mixed, people.rejected, "r3@example.test", { state: "refused" });
	const totals = ok(await read(owner, "getDeliveryTotals", { communicationId: mixed }));
	assert.deepEqual(totals.outcomes, ["accepted", "unknown", "rejected"]);
	assert.equal(totals.sentForAll, false);

	const failed = await message({ subject: "All refused" });
	await mail(failed, await person("Fail A", { email: "fa@example.test" }), "fa@example.test", { state: "refused" });
	await mail(failed, await person("Fail B", { email: "fb@example.test" }), "fb@example.test", { state: "failed" });
	const failure = ok(await read(member, "getExecutionResult", { communicationId: failed }));
	assert.deepEqual([failure.status, failure.accepted, failure.refused, failure.unknown], ["failed", 0, 2, 0]);

	const unknown = await message({ subject: "All unknown" });
	await mail(unknown, await person("Unk A", { email: "ua@example.test" }), "ua@example.test", { state: "unknown" });
	await mail(unknown, await person("Unk B", { email: "ub@example.test" }), "ub@example.test", { state: "unknown" });
	const pending = ok(await read(owner, "getExecutionResult", { communicationId: unknown }));
	assert.deepEqual([pending.status, pending.accepted, pending.refused, pending.unknown], ["unknown", 0, 0, 2]);

	const partialId = await message({ subject: "Partial" });
	await mail(partialId, await person("Part A", { email: "pa@example.test" }), "pa@example.test", {
		state: "sent",
		sentHours: 2,
		delivered: true,
	});
	await mail(partialId, await person("Part B", { email: "pb@example.test" }), "pb@example.test", { state: "unknown" });
	const partial = ok(await read(owner, "getExecutionResult", { communicationId: partialId }));
	assert.equal(partial.status, "partial");
	const quiet = await message({ subject: "No mail yet" });
	const none = ok(await read(owner, "getExecutionResult", { communicationId: quiet }));
	assert.deepEqual([none.status, none.accepted, none.refused, none.unknown], ["unknown", 0, 0, 0]);
	refused(await read(owner, "getExecutionResult", { communicationId: randomUUID() }), "not_found");
});

test("AC:CASE-COM-009 reviewed resend keeps delivered non-openers and one replay", async () => {
	const alex = await person("Alex", { email: "alex@example.test" });
	const casey = await person("Casey", { email: "casey@example.test" });
	const jamie = await person("Jamie", { email: "jamie@example.test" });
	const riley = await person("Riley");
	const sam = await person("Sam", { email: "sam@example.test", state: "retired" });
	const pat = await person("Pat", { email: "pat@example.test" });
	const drew = await person("Drew", { email: "drew@example.test" });
	const id = await message({
		subject: "Please read",
		bodyHtml: "<p>Please read</p>",
		bodyText: "Please read",
		audience: { groups: [], teamIds: [], personIds: [alex, casey, jamie, riley, sam, pat, drew] },
	});
	await mail(id, alex, "alex@example.test", { state: "sent", sentHours: 25, delivered: true });
	await mail(id, casey, "casey@example.test", { state: "sent", sentHours: 25, delivered: true, clicked: true });
	await mail(id, jamie, "jamie@example.test", { state: "unknown" });
	await mail(id, riley, "riley@example.test", { state: "sent", sentHours: 25, delivered: true });
	await mail(id, sam, "sam@example.test", { state: "sent", sentHours: 25, delivered: true });
	await mail(id, pat, "pat@example.test", { state: "sent", sentHours: 1, delivered: true });
	await mail(id, drew, "drew@example.test", { state: "refused" });
	const before = await rows(
		sql`SELECT state, subject, revision::text AS revision, template_source FROM communication WHERE id = ${id}`,
	);

	refused(await read(member, "listResendCandidates", { communicationId: id }), "access_denied");
	refused(await write(member, "executeResend", { requestKey: key(), input: { communicationId: id } }), "access_denied");
	const candidates = ok(await read(owner, "listResendCandidates", { communicationId: id }));
	assert.equal(candidates.openTrackingIsCertain, false);
	assert.equal(candidates.confirmedDelivery, true);
	assert.deepEqual(candidates.eligibleNames, ["Alex"]);
	assert.deepEqual(candidates.eligibleIds, [alex]);
	assert.deepEqual(candidates.excludedNames, ["Casey", "Drew", "Jamie", "Pat", "Riley", "Sam"]);
	const failedOnly = ok(await read(owner, "listResendCandidates", { communicationId: id, selection: "proven_failed" }));
	assert.deepEqual(failedOnly.eligibleNames, ["Drew"]);

	const requestKey = key();
	const input = { communicationId: id, selection: "delivered_nonopeners" };
	const created = ok(await write(owner, "executeResend", { requestKey, input }));
	assert.equal(created.newCommunications, 1);
	assert.equal(created.originalMutated, false);
	assert.equal(created.replayNewIntents, 0);
	assert.equal(created.openTrackingIsCertain, false);
	assert.deepEqual(created.eligibleNames, ["Alex"]);
	const copy = (
		await rows(
			sql`SELECT state, subject, body_html, template_source, audience, meeting_id FROM communication WHERE id = ${created.communicationId}`,
		)
	)[0];
	assert.equal(copy.state, "reviewed");
	assert.equal(copy.subject, "Please read");
	assert.equal(copy.body_html, "<p>Please read</p>");
	assert.equal(copy.template_source, `lineage:${id}`);
	assert.deepEqual(copy.audience.personIds, [alex]);
	assert.equal(
		await countOf(
			sql`SELECT count(*)::int AS n FROM mail WHERE tenant_id = ${plant.id} AND logical_key LIKE ${"communication/" + created.communicationId + "/%"}`,
		),
		0,
	);
	const after = await rows(
		sql`SELECT state, subject, revision::text AS revision, template_source FROM communication WHERE id = ${id}`,
	);
	assert.deepEqual(after, before);
	const replay = ok(await write(owner, "executeResend", { requestKey, input }));
	assert.equal(replay.communicationId, created.communicationId);
	assert.equal(
		await countOf(
			sql`SELECT count(*)::int AS n FROM communication WHERE plant_id = ${plant.id} AND template_source = ${"lineage:" + id}`,
		),
		1,
	);

	const unknownOnly = await message({ subject: "Unknown only" });
	await mail(unknownOnly, jamie, "jamie-again@example.test", { state: "unknown" });
	const unchanged = await countOf(sql`SELECT count(*)::int AS n FROM communication WHERE plant_id = ${plant.id}`);
	refused(
		await write(owner, "executeResend", { requestKey: key(), input: { communicationId: unknownOnly } }),
		"invalid_subject",
	);
	assert.equal(
		await countOf(sql`SELECT count(*)::int AS n FROM communication WHERE plant_id = ${plant.id}`),
		unchanged,
	);
	refused(await read(owner, "listResendCandidates", { communicationId: randomUUID() }), "not_found");
});

test("AC:CASE-COM-011 AC:TARGET-PPL-021 contact freshness follows effective contact only", async () => {
	const nora = await person("Nora", { email: "nora@example.test" });
	const owen = await person("Owen", { email: "owen@example.test" });
	const sent = await message({
		subject: "Owen note",
		audience: { groups: [], teamIds: [], personIds: [owen] },
	});
	await mail(sent, owen, "owen@example.test", { state: "sent", sentHours: 3, delivered: true });
	const owenPage = ok(await read(member, "listForPerson", { personId: owen }));
	assert.equal(owenPage.lastConfirmedContactAt, null);
	assert.equal(owenPage.items.find((item) => item.id === sent).state, "sent");

	const adminTask = await task(nora, member.id);
	await outcome(adminTask, nora, "administrative_completion");
	const beforeOutcomes = await countOf(
		sql`SELECT count(*)::int AS n FROM contact_outcome WHERE plant_id = ${plant.id} AND person_id = ${nora}`,
	);
	refused(
		await write(member, "recordContactFromTask", { requestKey: key(), input: { taskId: adminTask } }),
		"invalid_subject",
	);
	assert.equal(
		await countOf(
			sql`SELECT count(*)::int AS n FROM contact_outcome WHERE plant_id = ${plant.id} AND person_id = ${nora}`,
		),
		beforeOutcomes,
	);
	assert.equal(ok(await read(owner, "listForPerson", { personId: nora })).lastConfirmedContactAt, null);

	const callTask = await task(nora, member.id);
	const callOutcome = await outcome(callTask, nora, "contacted");
	const requestKey = key();
	const recorded = ok(await write(member, "recordContactFromTask", { requestKey, input: { taskId: callTask } }));
	assert.equal(recorded.outcome, "contacted");
	assert.equal(recorded.outcomeId, callOutcome);
	assert.equal(recorded.lastConfirmedContactAt, "2026-10-01T12:00:00.000Z");
	const replay = ok(await write(member, "recordContactFromTask", { requestKey, input: { taskId: callTask } }));
	assert.equal(replay.outcomeId, recorded.outcomeId);
	assert.equal(
		await countOf(
			sql`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id = ${plant.id} AND subject_id = ${callOutcome} AND action = 'followup.recorded'`,
		),
		1,
	);
	const contacted = ok(await read(owner, "listForPerson", { personId: nora }));
	assert.equal(contacted.lastConfirmedContactAt, "2026-10-01T12:00:00.000Z");
	assert.equal(
		contacted.contacts.some((row) => row.outcomeId === callOutcome && row.voided === false),
		true,
	);

	const mailBefore = await countOf(sql`SELECT count(*)::int AS n FROM mail WHERE tenant_id = ${plant.id}`);
	const corrected = ok(
		await write(owner, "correctContactLog", {
			requestKey: key(),
			expectedRevision: recorded.projectionRevision,
			input: {
				outcomeId: callOutcome,
				outcome: "contacted",
				occurredAt: "2026-10-20T15:00:00.000Z",
				reason: "The visit was later",
			},
		}),
	);
	assert.equal(corrected.status, "corrected");
	assert.equal(corrected.affected, 1);
	assert.equal(corrected.lastConfirmedContactAt, "2026-10-20T15:00:00.000Z");
	assert.equal(corrected.correction.supersedesId, callOutcome);
	const kept = await rows(
		sql`SELECT id, voided_at IS NOT NULL AS voided FROM contact_outcome WHERE person_id = ${nora} AND id = ${callOutcome}`,
	);
	assert.equal(kept[0].voided, true);
	assert.equal(await countOf(sql`SELECT count(*)::int AS n FROM contact_outcome WHERE id = ${callOutcome}`), 1);
	assert.equal((await rows(sql`SELECT status FROM task WHERE id = ${callTask}`))[0].status, "complete");
	assert.equal(await countOf(sql`SELECT count(*)::int AS n FROM mail WHERE tenant_id = ${plant.id}`), mailBefore);
	assert.equal(
		ok(await read(owner, "listForPerson", { personId: nora })).lastConfirmedContactAt,
		"2026-10-20T15:00:00.000Z",
	);

	const cleared = ok(
		await write(owner, "correctContactLog", {
			requestKey: key(),
			expectedRevision: "1",
			input: {
				outcomeId: corrected.correction.outcomeId,
				outcome: "administrative_completion",
				reason: "The visit did not happen",
			},
		}),
	);
	assert.equal(cleared.lastConfirmedContactAt, null);
	assert.equal(ok(await read(member, "listForPerson", { personId: nora })).lastConfirmedContactAt, null);

	const futurePerson = await person("Future", { email: "future@example.test" });
	const futureTask = await task(futurePerson, member.id);
	await outcome(futureTask, futurePerson, "contacted", true);
	refused(
		await write(member, "recordContactFromTask", { requestKey: key(), input: { taskId: futureTask } }),
		"invalid_input",
	);
	const mina = await person("Mina", { email: "mina@example.test" });
	const pastTask = await task(mina, member.id);
	const pastOutcome = await outcome(pastTask, mina, "contacted");
	const pastRecord = ok(
		await write(member, "recordContactFromTask", { requestKey: key(), input: { taskId: pastTask } }),
	);
	refused(
		await write(owner, "correctContactLog", {
			requestKey: key(),
			expectedRevision: pastRecord.projectionRevision,
			input: {
				outcomeId: pastOutcome,
				outcome: "contacted",
				occurredAt: "2099-01-01T00:00:00.000Z",
				reason: "That date is ahead",
			},
		}),
		"invalid_input",
	);
	assert.equal(
		(await rows(sql`SELECT voided_at IS NOT NULL AS voided FROM contact_outcome WHERE id = ${pastOutcome}`))[0].voided,
		false,
	);
	refused(
		await write(stranger, "correctContactLog", {
			requestKey: key(),
			expectedRevision: pastRecord.projectionRevision,
			input: {
				outcomeId: pastOutcome,
				outcome: "contacted",
				occurredAt: "2026-10-02T12:00:00.000Z",
				reason: "Not my entry",
			},
		}),
		"access_denied",
	);
	const own = ok(
		await write(member, "correctContactLog", {
			requestKey: key(),
			expectedRevision: pastRecord.projectionRevision,
			input: {
				outcomeId: pastOutcome,
				outcome: "contacted",
				occurredAt: "2026-10-02T12:00:00.000Z",
				reason: "I had the day wrong",
			},
		}),
	);
	assert.equal(own.lastConfirmedContactAt, "2026-10-02T12:00:00.000Z");
	refused(
		await write(member, "recordContactFromTask", { requestKey: key(), input: { taskId: randomUUID() } }),
		"not_found",
	);
	refused(
		await write(owner, "correctContactLog", {
			requestKey: key(),
			expectedRevision: "1",
			input: {
				outcomeId: randomUUID(),
				outcome: "contacted",
				occurredAt: "2026-10-02T12:00:00.000Z",
				reason: "Missing",
			},
		}),
		"not_found",
	);
});
