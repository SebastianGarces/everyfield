import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { resendWebhook } from "../../../apps/web/src/server/jobs/webhook-route.ts";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { communicationWriter, type DeliveryTransport } from "../../../packages/domain/src/communication/index.ts";
import type { DeliveryBatch } from "../../../packages/domain/src/communication/delivery.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { peopleWriter } from "../../../packages/domain/src/people/index.ts";
import { fixture, ok, raced, refused, type Actor, type Workspace } from "../../support/fixture.mts";
import { untouched } from "../../support/recorded.mts";
import { pinSchemaClock } from "../../support/test-database.mts";
import { MAILING } from "./church-address.mts";
import {
	caseOf,
	deliverAs,
	firstRow,
	pinnedDate,
	readAs,
	rowsFrom,
	writeAs,
	type DeliveryOp,
	type ReadOp,
	type Rest,
	type Row,
	type WriteOp,
} from "./communication-support.mts";

const inputOf = (id: string, name = "case-input") => caseOf(id).given[name] ?? assert.fail(`no ${name} in ${id}`);

const NOW = caseOf("CASE-COM-001").clock.now;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();

const database = await fixture({ prefix: "messagecases", clock: pinnedDate(NOW), max: 8 });
const { admin, schema } = database;
const db = database.pools.runtime;
after(async () => {
	mock.timers.reset();
	await database.close();
});

const key = () => randomUUID();
const nobody = { groups: [] as string[], teamIds: [] as string[], personIds: [] as string[] };
const rows = <R extends Row = Row>(query: SQL) => rowsFrom<R>({ admin } as never, query);
const one = async <R extends Row = Row>(query: SQL) => firstRow(await rows<R>(query));
const clockAt = async (instant: string) => {
	await pinSchemaClock(admin, schema, new Date(instant));
	mock.timers.setTime(Date.parse(instant));
};
const keys = {
	encryptionKey: Buffer.alloc(32, 7),
	addressKey: Buffer.alloc(32, 9),
	from: "news@example.test",
	origin: "https://app.example.test",
	optOutKeys: { current: randomBytes(32), previous: [] },
};

type Plant = Workspace & { kind: "plant" };
type Staff = Actor & { actor: RequestActor };
async function staff(plant: Plant, role: "owner" | "admin" | "member" = "admin"): Promise<Staff> {
	const who = await database.actor(plant, role);
	await admin.execute(sql`UPDATE seat SET accepted_at = '2026-10-01T00:00:00Z' WHERE account_id = ${who.id}`);
	await admin.execute(sql`UPDATE auth_session SET expires_at = '2026-11-12T16:00:00Z' WHERE id = ${who.session}`);
	const actor = await RequestActor.resolve(db, who.session);
	assert.ok(actor instanceof RequestActor);
	return { ...who, actor };
}
async function church() {
	const P = await database.plant({ name: "Harvest Point", ...MAILING });
	const Q = await database.plant({ name: "Grace Hill", timezone: "America/New_York", ...MAILING });
	return { P, Q, A: await staff(P), member: await staff(P, "member"), B: await staff(Q) };
}
async function person(
	plant: Plant,
	name: string,
	{
		email = `${name.toLowerCase().replaceAll(" ", "-")}@example.test`,
		stage = "prospect",
		notes = null,
	}: {
		email?: string | null;
		stage?: string;
		notes?: string | null;
	} = {},
) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at,notes)
		VALUES(${id},${plant.id},${plant.id},${name},${email},'other',${stage},'unknown','unknown',0,'live',clock_timestamp(),${notes})`);
	return id;
}
async function meeting(plant: Plant, title: string) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision)
		VALUES(${id},${plant.id},'vision_meeting',${title},'2026-11-01','18:00','America/Chicago','2026-11-02T00:00:00Z','1','planning',1)`);
	return id;
}
async function team(plant: Plant, name: string, state = "active") {
	const id = randomUUID();
	await admin.execute(
		sql`INSERT INTO team(id,plant_id,name,state,sort_order) VALUES(${id},${plant.id},${name},${state},1)`,
	);
	return id;
}
async function role(plant: Plant, teamId: string, leadership = false) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO team_role(id,plant_id,team_id,name,leadership,sort_order)
		VALUES(${id},${plant.id},${teamId},${leadership ? "Lead" : "Member"},${leadership},1)`);
	return id;
}
const tenure = (plant: Plant, roleId: string, personId: string) =>
	admin.execute(sql`INSERT INTO team_tenure(id,plant_id,role_id,person_id,started_on)
		VALUES(${randomUUID()},${plant.id},${roleId},${personId},'2026-01-01')`);

const write = <K extends WriteOp>(who: Staff, op: K, input: unknown) => writeAs(db, who.actor, op, input);
const read = <K extends ReadOp>(who: Staff, op: K, ...rest: Rest<K>) => readAs(db, who.actor, op, ...rest);
const draft = (who: Staff, input: object) => write(who, "saveDraft", { requestKey: key(), input });
const schedule = (who: Staff, saved: { communicationId: string; revision: string }, input: object = {}) =>
	write(who, "scheduleReviewed", {
		requestKey: key(),
		expectedRevision: saved.revision,
		input: { communicationId: saved.communicationId, scheduledAt: new Date(Date.now() + DAY).toISOString(), ...input },
	});
function carrier(answer: (batch: Parameters<DeliveryTransport["send"]>[0]) => DeliveryBatch) {
	const calls: string[] = [];
	const sent: { to: string; html: string; text: string; headers?: Readonly<Record<string, string>> }[] = [];
	const transport: DeliveryTransport = {
		paused: false,
		async send(batch) {
			calls.push("send");
			sent.push(...batch.messages);
			return answer(batch);
		},
		async cancel(ids) {
			calls.push("cancel");
			return ids.map(() => ({ outcome: "done" as const }));
		},
		async reschedule(ids) {
			calls.push("reschedule");
			return ids.map(() => ({ outcome: "done" as const }));
		},
	};
	return { transport, calls, sent };
}
const accepting = () =>
	carrier((batch) => ({ outcome: "ids", ids: batch.messages.map((m) => `re-${m.to}-${randomUUID()}`) }));
const deliver = <K extends DeliveryOp>(
	who: Staff,
	op: K,
	saved: { communicationId: string; revision: string },
	transport: DeliveryTransport,
) =>
	deliverAs(
		db,
		who.actor,
		op,
		{ requestKey: key(), expectedRevision: saved.revision, input: { communicationId: saved.communicationId } },
		transport,
		keys,
	);
async function send(who: Staff, personIds: string[], port = accepting(), input: object = {}) {
	const saved = ok(
		await draft(who, {
			subject: "Welcome",
			bodyHtml: "<p>Welcome {{name}}.</p>",
			audience: { ...nobody, personIds },
			...input,
		}),
	);
	const planned = ok(await schedule(who, saved));
	const report = ok(await deliver(who, "sendReviewed", planned, port.transport));
	return { id: saved.communicationId, revision: planned.revision, report, port };
}
const mailOf = async (communicationId: string, personId: string) =>
	one<{ id: string; state: string; provider_message_id: string | null }>(
		sql`SELECT id, state, provider_message_id FROM mail WHERE communication_id = ${communicationId} AND recipient_person_id = ${personId}`,
	);
const secret = "whsec_" + randomBytes(32).toString("base64");
async function webhook(messageId: string | null, kind: string, bounce?: { type: string }) {
	assert.ok(messageId);
	const raw = JSON.stringify({
		type: `email.${kind}`,
		created_at: new Date().toISOString(),
		data: { email_id: messageId, ...(bounce ? { bounce } : {}) },
	});
	const eventKey = randomUUID();
	const stamp = String(Math.floor(Date.now() / 1000));
	const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
		.update(`${eventKey}.${stamp}.${raw}`)
		.digest("base64");
	const response = await resendWebhook(
		new Request("https://example.test/api/webhooks/resend", {
			method: "POST",
			body: raw,
			headers: { "svix-id": eventKey, "svix-timestamp": stamp, "svix-signature": `v1,${signature}` },
		}),
		() => db,
		secret,
	);
	assert.deepEqual([response.status, await response.json()], [200, { stored: true, result: "applied" }]);
}
async function updatePerson(who: Staff, plant: Plant, personId: string, patch: object) {
	const { revision } = await one(sql`SELECT revision::text AS revision FROM person WHERE id = ${personId}`);
	ok(
		await gatedTransaction(db, (tx) =>
			peopleWriter.updatePerson(
				tx,
				{ session: who.session, selected: { kind: "plant", id: plant.id } as never },
				{ requestKey: key(), expectedRevision: revision, input: { personId, patch } },
			),
		),
	);
}
const answered = (reply: object) =>
	JSON.stringify(reply, (field, value: unknown) => (field === "correlationId" ? undefined : value));
const mailRows = (communicationId: string) =>
	rows(sql`SELECT * FROM mail WHERE communication_id = ${communicationId} ORDER BY id`);
const communicationRow = (id: string) => one(sql`SELECT * FROM communication WHERE id = ${id}`);

async function lastStamp(plant: Plant) {
	return rows<{ id: string }>(
		sql`SELECT id FROM communication WHERE plant_id = ${plant.id} ORDER BY created_at DESC, id DESC`,
	);
}

test("AC:CASE-COM-001 history with a draft, a partly accepted, a sent and an unknown message that reach nobody has no rate, counts only the sent one, falls back from malformed filters and shows no other church", async () => {
	const { result } = caseOf("CASE-COM-001").expected;
	const { P, Q, A, B } = await church();
	const people = [];
	for (const name of ["Alex", "Casey"]) people.push(await person(P, name));
	const [alex, casey] = people as [string, string];
	const sent = await send(A, [alex], undefined, { subject: "Sent one" });
	for (const kind of ["sent", "delivered"]) await webhook((await mailOf(sent.id, alex)).provider_message_id, kind);
	const partial = await send(
		A,
		[alex, casey],
		carrier(() => ({ outcome: "ids", ids: ["re-partial", null] })),
		{ subject: "Partly accepted" },
	);
	const unknown = await send(
		A,
		[alex],
		carrier(() => ({ outcome: "unknown" })),
		{ subject: "Unknown attempt" },
	);
	const incomplete = ok(await draft(A, { subject: "Incomplete draft" }));
	const foreignPerson = await person(Q, "Foreign");
	const foreign = await send(B, [foreignPerson], undefined, { subject: "FOREIGN-SUBJECT" });
	const foreignMeeting = await meeting(Q, "Foreign night");
	for (const id of people) await updatePerson(A, P, id, { email: null });

	await untouched(admin, async () => {
		const page = ok(await read(A, "listHistory", {}));
		assert.deepEqual(
			Object.fromEntries(page.items.map((i) => [i.id, [i.state, i.countsAsSent, i.reachable, i.rate]])),
			{
				[incomplete.communicationId]: [
					"draft",
					result.draft_counts_as_sent,
					inputOf("CASE-COM-001").reachable_count,
					result.rate,
				],
				[partial.id]: ["sending", false, 0, result.rate],
				[sent.id]: ["sent", true, 0, result.rate],
				[unknown.id]: ["unknown", result.unknown_counts_as_sent, 0, result.rate],
			},
		);
		assert.equal(page.items.find((i) => i.id === sent.id)!.delivered, 1, "one delivered over nobody reachable");
		assert.deepEqual(
			[page.rate, page.draftCountsAsSent, page.unknownCountsAsSent, page.foreignRows],
			[result.rate, result.draft_counts_as_sent, result.unknown_counts_as_sent, result.foreign_rows],
		);
		const totals = async (id: string) => {
			const t = ok(await read(A, "getDeliveryTotals", { communicationId: id }));
			return [
				t.selected,
				t.reachable,
				t.attempted,
				t.accepted,
				t.sent,
				t.delivered,
				t.failed,
				t.unknown,
				t.rate,
				t.sentForAll,
			];
		};
		assert.deepEqual(await totals(incomplete.communicationId), [0, 0, 0, 0, 0, 0, 0, 0, null, false]);
		assert.deepEqual(await totals(partial.id), [2, 0, 2, 1, 0, 0, 0, 1, null, false]);
		assert.deepEqual(await totals(sent.id), [1, 0, 1, 1, 1, 1, 0, 0, null, true]);
		assert.deepEqual(await totals(unknown.id), [1, 0, 1, 0, 0, 0, 0, 1, null, false]);
		assert.equal(ok(await read(A, "getExecutionResult", { communicationId: partial.id })).status, "partial");
		assert.equal(ok(await read(A, "getExecutionResult", { communicationId: unknown.id })).status, "unknown");

		const all = (await lastStamp(P)).map((r) => r.id);
		const invalid = { id: "not-an-id", name: "   " };
		for (const [filter, limit] of [
			[{ limit: "nope" }, 50],
			[{ limit: 0 }, 50],
			[{ limit: -1 }, 50],
			[{ limit: 1.5 }, 50],
			[{ limit: {} }, 50],
			[{ limit: 500 }, 100],
			[{ limit: "101" }, 100],
			[{ state: "partial_accepted" }, 50],
			[{ meetingId: invalid.id, personId: invalid.id }, 50],
			[{ query: invalid.name }, 50],
			[{ cursor: invalid.id }, 50],
			[{ cursor: Buffer.from("1|not-a-uuid").toString("base64url") }, 50],
			[null, 50],
		] as const) {
			const got = ok(await read(A, "listHistory", filter));
			assert.deepEqual(
				[got.limit, got.items.map((i) => i.id), got.complete],
				[limit, all, true],
				JSON.stringify(filter),
			);
		}
		for (const [state, ids] of [
			["draft", [incomplete.communicationId]],
			["sending", [partial.id]],
			["sent", [sent.id]],
			["unknown", [unknown.id]],
			["failed", []],
		] as const)
			assert.deepEqual(
				ok(await read(A, "listHistory", { state })).items.map((i) => i.id),
				ids,
				state,
			);
		assert.deepEqual(ok(await read(A, "listHistory", { channel: "sms" })).items, []);
		for (const communicationId of [invalid.id, invalid.name])
			refused(await read(A, "getDeliveryTotals", { communicationId }), "invalid_input");

		for (const filter of [{ query: "FOREIGN-SUBJECT" }, { personId: foreignPerson }, { meetingId: foreignMeeting }])
			assert.deepEqual(ok(await read(A, "listHistory", filter)).items, result.foreign_rows);
		const seenByB = ok(await read(B, "listHistory", { personId: alex }));
		assert.deepEqual(seenByB.items, []);
		assert.deepEqual(
			ok(await read(B, "listHistory", {})).items.map((i) => i.id),
			[foreign.id],
		);
		for (const id of [sent.id, randomUUID()])
			refused(await read(B, "getDeliveryTotals", { communicationId: id }), "not_found");
	});
});

test("AC:CASE-COM-002 the detail keeps the address and subject the email was sent with beside the person's new address, takes a later delivered fact, and gives another church's guess nothing", async () => {
	const { result } = caseOf("CASE-COM-002").expected;
	const given = inputOf("CASE-COM-002");
	const { P, Q, A, member, B } = await church();
	const alex = await person(P, "Alex Rivera", { email: given.frozen_address as string });
	const night = await meeting(P, "Vision night");
	const message = await send(A, [alex], undefined, {
		subject: given.frozen_subject,
		bodyHtml: "<p>Welcome Alex.</p>",
		meetingId: night,
	});
	assert.deepEqual(
		message.port.sent.map((m) => m.to),
		[given.frozen_address],
	);
	const before_ = ok(await read(A, "getDetail", { id: message.id }, keys));
	assert.deepEqual([before_.deliveryStatus, before_.recipients[0]!.deliveredAt], ["accepted", null]);
	await updatePerson(A, P, alex, { email: given.current_address });
	const provider = (await mailOf(message.id, alex)).provider_message_id;
	await webhook(provider, "sent");
	await webhook(provider, given.provider_fact as string);

	await untouched(admin, async () => {
		const detail = ok(await read(A, "getDetail", { id: message.id }, keys));
		assert.deepEqual(
			{
				delivery_address: detail.deliveryAddress,
				current_person_address: detail.currentPersonAddress,
				subject: detail.subject,
				delivery_status: detail.deliveryStatus,
				body: detail.bodyHtml,
			},
			{
				delivery_address: result.delivery_address,
				current_person_address: result.current_person_address,
				subject: result.subject,
				delivery_status: result.delivery_status,
				body: "<p>Welcome Alex.</p>",
			},
		);
		assert.equal(typeof detail.recipients[0]!.deliveredAt, "string");
		const outcome = { personId: alex, name: "Alex Rivera", deliveryStatus: "delivered" };
		assert.deepEqual(ok(await read(member, "listHistoryRecipients", { communicationId: message.id }, keys)).items, [
			{ ...outcome, deliveryAddress: given.frozen_address },
		]);
		assert.deepEqual(ok(await read(A, "listMeetingTracking", { meetingId: night })).items, [outcome]);
		assert.deepEqual(
			ok(await read(A, "listForMeeting", { meetingId: night })).items.map((i) => i.id),
			[message.id],
		);
		assert.deepEqual(
			ok(await read(A, "listForPerson", { personId: alex })).items.map((i) => i.id),
			[message.id],
		);

		const answers = async (ids: { communication: string; person: string; meeting: string }) =>
			[
				await read(B, "getDetail", { id: ids.communication }, keys),
				await read(B, "getDraft", { id: ids.communication }),
				await read(B, "listHistoryRecipients", { communicationId: ids.communication }, keys),
				await read(B, "getDeliveryTotals", { communicationId: ids.communication }),
				await read(B, "getExecutionResult", { communicationId: ids.communication }),
				await read(B, "listForPerson", { personId: ids.person }),
				await read(B, "listForMeeting", { meetingId: ids.meeting }),
				await read(B, "listMeetingTracking", { meetingId: ids.meeting }),
			] as { status: string; value?: unknown; error?: { code: string } }[];
		const real = await answers({ communication: message.id, person: alex, meeting: night });
		assert.equal(
			answered(real),
			answered(await answers({ communication: randomUUID(), person: randomUUID(), meeting: randomUUID() })),
			"a real id answers exactly as a made-up one",
		);
		for (const answer of real) {
			refused(answer, "not_found");
			assert.equal(answer.value ?? null, result.foreign_child_body);
		}
		const own = ok(await read(A, "getDetail", { id: message.id }));
		assert.equal(own.deliveryAddress, null, "without the mail key no address is opened");
	});
	await untouched(admin, async () => {
		refused(await draft(B, { subject: "Guess", bodyHtml: "<p>Hi</p>", meetingId: night }), "invalid_subject");
		assert.equal(ok(await read(B, "readAudience", { ...nobody, personIds: [alex] })).resolvedDistinctPeople, 0);
	});
	assert.equal((await one(sql`SELECT count(*)::int AS n FROM communication WHERE plant_id = ${Q.id}`)).n, 0);
});

test("AC:CASE-COM-003 a preview merges the sanitized body, refuses malformed and foreign ids, and refuses as stale once the reviewed audience changed, with no write and no provider call", async () => {
	const { result } = caseOf("CASE-COM-003").expected;
	const given = inputOf("CASE-COM-003");
	const { P, Q, A, member, B } = await church();
	await person(P, "Alex", { email: "alex@example.test" });
	const bodyHtml = given.html as string;
	const merge = given.merge_fields as Record<string, string>;
	const audience = { ...nobody, groups: ["prospects"] };
	const saved = ok(await draft(A, { subject: "Welcome", bodyHtml, audience }));
	const planned = ok(await schedule(A, saved));
	assert.equal(planned.bodyHtml, "<p>Hello {{name}}</p>", "the stored body is sanitized");
	const night = await meeting(P, "Vision night");
	const foreignMeeting = await meeting(Q, "Quiet night");
	const foreignTemplate = ok(
		await write(B, "createTemplate", {
			requestKey: key(),
			input: { name: "Theirs", category: "announcement", subject: "Theirs", bodyHtml: "<p>Theirs</p>" },
		}),
	).templateId;

	await untouched(admin, async () => {
		const reviewed = ok(
			await read(A, "readPreview", { bodyHtml, merge, audience, communicationId: saved.communicationId }),
		);
		assert.deepEqual(
			[reviewed.previewBody, reviewed.scriptExecution, reviewed.providerCalls, reviewed.eligibleEmails],
			[result.preview_body, result.script_execution, result.provider_calls, ["alex@example.test"]],
		);
		const rich = ok(
			await read(A, "readPreview", {
				bodyHtml:
					'<p onclick="steal()">Hi {{name}}</p><p>{{rsvp_link}}</p><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a>',
				merge: { name: "<b>Alex</b>" },
				meetingId: night,
			}),
		);
		assert.match(rich.previewBody, /Hi &lt;b&gt;Alex&lt;\/b&gt;/);
		assert.match(rich.previewBody, /RSVP button appears here/, "the meeting's link has a place");
		assert.match(rich.previewHtml, /Harvest Point/, "the church's own name");
		assert.match(rich.previewHtml, /12 Mill Road/);
		assert.doesNotMatch(rich.previewBody + rich.previewHtml, /<script|onclick|onerror|javascript:|alert\(/i);
		const missing = refused(await read(A, "readPreview", { bodyHtml, merge: {} }), "missing_merge_variable");
		assert.deepEqual(missing.details, { missing: ["name"], providerCalls: 0 });
		for (const bad of [
			{ bodyHtml, merge, audience: "{not json" },
			{ bodyHtml, merge, audience: { personIds: ["not-an-id"] } },
			{ bodyHtml, merge, audience: { personIds: "   " } },
			{ bodyHtml, merge, audience: { groups: [["all"]] } },
			{ bodyHtml, merge, communicationId: "not-an-id" },
			{ bodyHtml, merge, meetingId: "not-an-id" },
			{ bodyHtml, merge, sms: true },
			{ bodyHtml: null, merge },
		])
			refused(await read(A, "readPreview", bad), "invalid_input");
		for (const bad of [
			{ audience: "{not json" },
			{ audience: { personIds: ["not-an-id"] } },
			{ meetingId: "not-an-id" },
		])
			refused(await draft(A, { subject: "Bad", bodyHtml, ...bad }), "invalid_input");
		for (const foreign of [
			{ meetingId: foreignMeeting },
			{ templateId: foreignTemplate },
			{ meetingId: randomUUID() },
		]) {
			refused(await read(A, "readPreview", { bodyHtml, merge, ...foreign }), "invalid_subject");
			refused(await draft(A, { subject: "Theirs", bodyHtml, ...foreign }), "invalid_subject");
		}
		const guess = await read(B, "readPreview", { bodyHtml, merge, communicationId: saved.communicationId });
		refused(guess, "invalid_subject");
		const madeUp = await read(B, "readPreview", { bodyHtml, merge, communicationId: randomUUID() });
		assert.equal(answered(guess), answered(madeUp), "a real id answers exactly as a made-up one");
		refused(await read(member, "readPreview", { bodyHtml, merge }), "access_denied");
	});

	await person(P, "Casey", { email: "casey@example.test" });
	const stale: { status: string }[] = [];
	await untouched(admin, async () => {
		stale.push(
			await read(A, "readPreview", { bodyHtml, merge, audience, communicationId: saved.communicationId }),
			await read(A, "readPreview", {
				bodyHtml,
				merge,
				audienceChangedAfterReview: given.audience_changed_after_review,
			}),
		);
	});
	for (const answer of stale) {
		const { code, details } = refused(answer, result.error_code as string);
		assert.deepEqual(
			{ code, ...details },
			{
				code: result.error_code,
				previewBody: result.preview_body,
				scriptExecution: result.script_execution,
				providerCalls: result.provider_calls,
			},
		);
	}
	const port = accepting();
	const late = refused(await deliver(A, "sendReviewed", planned, port.transport), "stale_review");
	assert.deepEqual(
		[late.details.providerCalls, port.calls],
		[result.provider_calls, []],
		"the same review cannot send",
	);
	assert.deepEqual(await mailRows(saved.communicationId), []);
});

test("AC:CASE-COM-004 a team of 25 with one person in two roles reaches all 24 with an address, names the one without, and the 20-row search never cuts the send", async () => {
	const { result } = caseOf("CASE-COM-004").expected;
	const given = inputOf("CASE-COM-004");
	const names = given.team_person_ids as string[];
	const { P, Q, A, B } = await church();
	const teamId = await team(P, "Hospitality");
	const ids = new Map<string, string>();
	for (const name of names) {
		const known = ids.get(name);
		const id =
			known ??
			(await person(P, name, {
				email: (given.missing_email_ids as string[]).includes(name) ? null : `${name}@example.test`,
			}));
		ids.set(name, id);
		await tenure(P, await role(P, teamId, known !== undefined), id);
	}
	const gone = await person(P, "person-gone");
	await tenure(P, await role(P, teamId), gone);
	await admin.execute(sql`UPDATE person SET state = 'retired' WHERE id = ${gone}`);
	const paused = await team(P, "Paused", "paused");
	await tenure(P, await role(P, paused), await person(P, "Paused guest"));
	const theirs = await team(Q, "Theirs");
	await tenure(Q, await role(Q, theirs), await person(Q, "Their guest"));
	const audience = { ...nobody, teamIds: [teamId] };

	await untouched(admin, async () => {
		const resolved = ok(await read(A, "readAudience", audience));
		const found = ok(await read(A, "readRecipients", { query: "person" }));
		assert.deepEqual(
			{
				resolved_distinct_people: resolved.resolvedDistinctPeople,
				eligible_recipients: resolved.eligibleRecipients,
				missing_email_exclusions: resolved.missingEmailExclusions,
				search_result_limit: found.people.length,
				search_limit_truncates_audience: resolved.searchLimitTruncatesAudience,
			},
			result,
		);
		assert.deepEqual([found.limit, resolved.searchResultLimit], [given.search_limit, given.search_limit]);
		assert.deepEqual(
			resolved.eligibleEmails,
			[...ids.keys()]
				.filter((n) => n !== "person-25")
				.map((n) => `${n}@example.test`)
				.sort(),
			"every address past the 20 rows of the search",
		);
		assert.equal(resolved.recipients.filter((r) => r.id === ids.get("person-1")).length, 1);
		const reached = async (who: Staff, selected: object) =>
			ok(await read(who, "readAudience", { ...nobody, ...selected })).resolvedDistinctPeople;
		assert.equal(await reached(A, { teamIds: [paused] }), 0);
		assert.equal(await reached(A, { personIds: [gone] }), 0);
		assert.equal(await reached(A, { groups: ["everybody"] }), 0);
		assert.equal(await reached(A, { groups: ["all"] }), 26, "only a live person, and the paused team's own person");
		assert.equal(await reached(A, { teamIds: [theirs] }), 0);
		assert.equal(await reached(B, { teamIds: [teamId], personIds: [...ids.values()] }), 0);
		assert.deepEqual(ok(await read(B, "readRecipients", { query: "person" })).people, []);
		assert.deepEqual(
			ok(await read(A, "listAudienceTeams")).teams.map((t) => t.id),
			[teamId],
		);
		refused(await read(A, "readAudience", { teamIds: ["not-an-id"] }), "invalid_input");
		refused(await read(A, "readRecipients", { query: "   " }), "invalid_input");
	});

	const port = accepting();
	const sent = await send(A, [], port, { audience });
	assert.equal(sent.report.acceptedCount, result.eligible_recipients);
	assert.equal(new Set(port.sent.map((m) => m.to)).size, result.eligible_recipients);
});

test("AC:CASE-COM-007 two forks at once make one church copy, the system original stays as it was, a used copy is archived not deleted, an unused one reveals the original, and another church edits nothing", async () => {
	const { result } = caseOf("CASE-COM-007").expected;
	const { concurrent_forks } = inputOf("CASE-COM-007");
	const { P, A, B } = await church();
	const second = await staff(P, "owner");
	const system = ok(await read(B, "listTemplates"));
	const sourceKey = "general-announcement";
	const fork = (who: Staff, source = sourceKey) =>
		write(who, "forkTemplate", { requestKey: key(), input: { sourceKey: source } });
	const forked = await raced(admin, db, sql`SELECT 1 FROM plant WHERE id = ${P.id} FOR UPDATE`, [
		() => fork(A),
		() => fork(second),
	]);
	assert.equal(forked.length, concurrent_forks);
	const [first, again] = [ok(forked[0]), ok(forked[1])];
	assert.deepEqual(again, first, "both name the same copy");
	assert.equal(
		(await one(sql`SELECT count(*)::int AS n FROM message_template WHERE plant_id = ${P.id}`)).n,
		result.plant_forks,
	);
	const templateId = first.templateId;
	const patch = {
		name: "Our note",
		description: null,
		category: "announcement",
		meetingType: null,
		subject: "Our subject",
		bodyHtml: "<p>Our words</p>",
	};
	const edited = ok(
		await write(A, "updateTemplate", {
			requestKey: key(),
			expectedRevision: first.revision,
			input: { templateId, patch },
		}),
	);
	assert.deepEqual([edited.subject, edited.origin], ["Our subject", "plant"]);
	const original = system.templates.find((t) => t.sourceKey === sourceKey)!;
	const systemNow = ok(await read(B, "listTemplates"));
	assert.equal(JSON.stringify(systemNow) !== JSON.stringify(system), result.system_template_mutated);

	await untouched(admin, async () => {
		for (const id of [templateId, randomUUID()]) {
			const answers = [
				await read(B, "getTemplate", { id }),
				await write(B, "updateTemplate", {
					requestKey: key(),
					expectedRevision: edited.revision,
					input: { templateId: id, patch: { ...patch, subject: "Foreign edit" } },
				}),
				await write(B, "archiveTemplate", {
					requestKey: key(),
					expectedRevision: edited.revision,
					input: { templateId: id },
				}),
				await write(B, "deleteTemplate", {
					requestKey: key(),
					expectedRevision: edited.revision,
					input: { templateId: id },
				}),
			];
			for (const answer of answers) refused(answer, "not_found");
			assert.equal(
				answers.some((a) => a.status === "ok"),
				result.foreign_edit_allowed,
			);
		}
		refused(
			await write(A, "updateTemplate", {
				requestKey: key(),
				expectedRevision: edited.revision,
				input: { templateId: original.templateId, patch: { ...patch, subject: "Rewritten original" } },
			}),
			"not_found",
		);
		refused(
			await write(A, "updateTemplate", {
				requestKey: key(),
				expectedRevision: first.revision,
				input: { templateId, patch: { ...patch, subject: "Stale edit" } },
			}),
			"conflict",
		);
	});

	const guest = await person(P, "Guest");
	const used = await send(A, [guest], undefined, { subject: "Our subject", bodyHtml: "<p>Our words</p>", templateId });
	const history = await communicationRow(used.id);
	const archived = ok(
		await write(A, "archiveTemplate", { requestKey: key(), expectedRevision: edited.revision, input: { templateId } }),
	);
	assert.equal(archived.archived, true);
	refused(
		await write(A, "deleteTemplate", { requestKey: key(), expectedRevision: archived.revision, input: { templateId } }),
		"referenced",
	);
	assert.equal(ok(await read(A, "getTemplate", { id: templateId })).name, "Our note");
	const detail = ok(await read(A, "getDetail", { id: used.id }, keys));
	const retained =
		JSON.stringify(await communicationRow(used.id)) === JSON.stringify(history) &&
		detail.subject === "Our subject" &&
		detail.bodyHtml === "<p>Our words</p>" &&
		ok(await read(A, "getDraft", { id: used.id })).templateId === templateId;
	assert.equal(retained, result.referenced_history_retained);

	const unused = ok(await fork(A, "orientation-invitation"));
	const shown = async () =>
		ok(await read(A, "listTemplates")).templates.find((t) => t.sourceKey === "orientation-invitation")!;
	assert.deepEqual([(await shown()).origin, (await shown()).templateId], ["plant", unused.templateId]);
	ok(
		await write(A, "deleteTemplate", {
			requestKey: key(),
			expectedRevision: unused.revision,
			input: { templateId: unused.templateId },
		}),
	);
	assert.deepEqual(
		await shown(),
		system.templates.find((t) => t.sourceKey === "orientation-invitation"),
	);
	assert.deepEqual(ok(await read(B, "listTemplates")), system, "the originals every other church sees are unchanged");
});

test("AC:CASE-COM-009 a resend 25 hours later goes to the one delivered non-opener, once for two replays, and leaves the original as it was", async () => {
	const { result } = caseOf("CASE-COM-009").expected;
	const given = inputOf("CASE-COM-009");
	const { P, A, member, B } = await church();
	const alex = await person(P, "Alex");
	const people: Record<string, string> = { Alex: alex };
	for (const name of ["Casey", "Jamie", "Riley", "Sam", "Pat"]) people[name] = await person(P, name);
	const sentAt = Date.parse(NOW) - Number(given.sent_hours_ago) * HOUR;
	await clockAt(new Date(sentAt).toISOString());
	const port = carrier((batch) => ({
		outcome: "ids",
		ids: batch.messages.map((m) => (m.to.startsWith("jamie") ? null : `re-${m.to}-${randomUUID()}`)),
	}));
	const original = await send(A, Object.values(people), port, {
		subject: "Please read",
		bodyHtml: "<p>Please read</p>",
	});
	const providerOf = async (name: string) => (await mailOf(original.id, people[name]!)).provider_message_id;
	for (const name of ["Alex", "Casey", "Riley", "Sam", "Pat"])
		for (const kind of ["sent", "delivered"]) await webhook(await providerOf(name), kind);
	await webhook(await providerOf("Casey"), "clicked");
	await updatePerson(A, P, people.Riley!, { email: null });
	await admin.execute(sql`UPDATE person SET state = 'retired' WHERE id = ${people.Sam!}`);
	await webhook(await providerOf("Pat"), "complained");

	const candidates = () => read(A, "listResendCandidates", { communicationId: original.id });
	await clockAt(new Date(sentAt + 23 * HOUR).toISOString());
	assert.deepEqual(ok(await candidates()).eligibleNames, [], "nobody before 24 hours");
	refused(
		await write(A, "executeResend", { requestKey: key(), input: { communicationId: original.id } }),
		"invalid_subject",
	);

	await clockAt(NOW);
	const frozen = { message: await communicationRow(original.id), mail: await mailRows(original.id) };
	await untouched(admin, async () => {
		const listed = ok(await candidates());
		assert.deepEqual(
			[
				listed.eligibleNames,
				listed.eligibleIds,
				listed.excludedNames,
				listed.openTrackingIsCertain,
				listed.confirmedDelivery,
			],
			[
				result.eligible_resend_ids,
				[alex],
				["Casey", "Jamie", "Pat", "Riley", "Sam"],
				result.open_tracking_is_certain,
				true,
			],
		);
		assert.deepEqual(
			ok(await read(A, "listResendCandidates", { communicationId: original.id, selection: "proven_failed" }))
				.eligibleNames,
			[],
			"an unknown send is never a proven failure",
		);
		for (const communicationId of [original.id, randomUUID()]) {
			refused(await read(B, "listResendCandidates", { communicationId }), "not_found");
			refused(await write(B, "executeResend", { requestKey: key(), input: { communicationId } }), "not_found");
		}
		refused(await read(member, "listResendCandidates", { communicationId: original.id }), "access_denied");
		refused(await read(A, "listResendCandidates", { communicationId: "not-an-id" }), "invalid_input");
	});
	const requestKey = "CASE-COM-009-request-1";
	const messages = () => rows(sql`SELECT id FROM communication WHERE plant_id = ${P.id} ORDER BY created_at, id`);
	const intents = () => rows(sql`SELECT id FROM mail WHERE tenant_id = ${P.id}`);
	const [messagesBefore, intentsBefore] = [await messages(), await intents()];
	const resend = () => write(A, "executeResend", { requestKey, input: { communicationId: original.id } });
	const runs = await Promise.all(Array.from({ length: Number(given.repeat) }, resend));
	const copy = ok(runs[0]!);
	for (const run of runs) assert.equal(ok(run).communicationId, copy.communicationId);
	assert.equal((await messages()).length - messagesBefore.length, result.new_communications);
	assert.equal((await intents()).length - intentsBefore.length, result.replay_new_intents);
	const stored = await communicationRow(copy.communicationId);
	assert.deepEqual(
		[stored.subject, stored.body_html, stored.template_source, stored.audience],
		["Please read", "<p>Please read</p>", `lineage:${original.id}`, { ...nobody, personIds: [alex] }],
	);
	const planned = ok(await schedule(A, { communicationId: copy.communicationId, revision: String(stored.revision) }));
	const second = accepting();
	assert.equal(ok(await deliver(A, "sendReviewed", planned, second.transport)).acceptedCount, 1);
	assert.deepEqual(
		second.sent.map((m) => m.to),
		["alex@example.test"],
	);
	const sentCopy = { intents: (await intents()).length, calls: second.calls.length };
	ok(await resend());
	ok(await deliver(A, "sendReviewed", planned, second.transport));
	assert.deepEqual(
		[(await intents()).length - sentCopy.intents, second.calls.length - sentCopy.calls],
		[result.replay_new_intents, 0],
		"a replay adds no email",
	);
	const same =
		JSON.stringify({ message: await communicationRow(original.id), mail: await mailRows(original.id) }) ===
		JSON.stringify(frozen);
	assert.equal(!same, result.original_mutated);
	assert.deepEqual(
		[copy.newCommunications, copy.originalMutated, copy.openTrackingIsCertain],
		[result.new_communications, result.original_mutated, result.open_tracking_is_certain],
	);
});

test("AC:MAIL51-001 an incomplete draft is saved, reloaded, edited once by one of two editors and deleted, and cancelling it makes no provider call or send", async () => {
	const { result } = caseOf("MAIL51-001").expected;
	const { recipients } = inputOf("MAIL51-001", "input");
	const { P, A, member, B } = await church();
	const second = await staff(P, "owner");
	const source = ok(
		await write(A, "forkTemplate", { requestKey: key(), input: { sourceKey: "general-announcement" } }),
	);
	const templateRow = await one(sql`SELECT * FROM message_template WHERE id = ${source.templateId}`);
	const saved = ok(
		await draft(A, {
			subject: null,
			bodyHtml: null,
			audience: { ...nobody, personIds: recipients as string[] },
			templateId: source.templateId,
		}),
	);
	const stored = async () =>
		rows(sql`SELECT id, state, subject, body_html, audience FROM communication WHERE plant_id = ${P.id}`);
	const empty = { id: saved.communicationId, state: "draft", subject: null, body_html: null, audience: nobody };
	assert.deepEqual(await stored(), [empty]);
	const port = accepting();
	const cancel = (who: Staff, communicationId: string, expectedRevision: string = saved.revision) =>
		communicationWriter.cancelScheduledReviewed(
			db,
			who.actor,
			{ requestKey: key(), expectedRevision, input: { communicationId } },
			port.transport,
		);
	await untouched(admin, async () => {
		const reloaded = ok(await read(A, "getDraft", { id: saved.communicationId }));
		assert.deepEqual(
			[reloaded.communicationId, reloaded.state, reloaded.subject, reloaded.bodyHtml, reloaded.audience],
			[saved.communicationId, "draft", null, null, nobody],
		);
		assert.deepEqual(
			ok(await read(A, "listDrafts")).drafts.map((d) => d.communicationId),
			[saved.communicationId],
		);
		const cancelled = ok(await cancel(A, saved.communicationId));
		assert.deepEqual(
			[cancelled.newHandoffs, cancelled.scheduledCancel, cancelled.cancelRequested, cancelled.newSend],
			[result.send_intents, "none", false, false],
		);
		refused(await cancel(A, saved.communicationId, "9"), "conflict");
		for (const id of [saved.communicationId, randomUUID()]) refused(await cancel(B, id), "not_found");
		refused(await cancel(member, saved.communicationId), "access_denied");
		refused(await cancel(A, "not-an-id"), "invalid_input");
		refused(await schedule(A, saved), "invalid_input");
		refused(await deliver(A, "sendReviewed", saved, port.transport), "conflict");
	});
	const saving = (who: Staff, subject: string, expectedRevision: string) =>
		write(who, "saveDraft", {
			requestKey: key(),
			expectedRevision,
			input: { communicationId: saved.communicationId, subject, bodyHtml: `<p>${subject}</p>` },
		});
	const edits = await raced(admin, db, sql`SELECT 1 FROM plant WHERE id = ${P.id} FOR UPDATE`, [
		() => saving(A, "First editor", saved.revision),
		() => saving(second, "Second editor", saved.revision),
	]);
	const won = edits.find((e) => e.status === "ok") ?? assert.fail("one editor saves");
	const kept = ok(won);
	refused(
		edits.find((e) => e !== won)!,
		"conflict",
	);
	assert.deepEqual(await stored(), [{ ...empty, subject: kept.subject, body_html: `<p>${kept.subject}</p>` }]);
	await untouched(admin, async () => {
		refused(await saving(second, "Too late", saved.revision), "conflict");
		refused(await saving(B, "Foreign", kept.revision), "not_found");
		refused(await saving(member, "Member", kept.revision), "access_denied");
		assert.equal(ok(await read(second, "getDraft", { id: saved.communicationId })).subject, kept.subject);
	});
	assert.deepEqual(
		await rows(
			sql`SELECT action FROM audit_event WHERE subject_id = ${saved.communicationId} ORDER BY recorded_at, id`,
		),
		[{ action: "communication.draft_saved" }, { action: "communication.draft_saved" }],
		"each saved version is in the history",
	);
	const deleting = (who: Staff, expectedRevision: string) =>
		write(who, "deleteDraft", {
			requestKey: key(),
			expectedRevision,
			input: { communicationId: saved.communicationId },
		});
	refused(await deleting(A, saved.revision), "conflict");
	refused(await deleting(B, kept.revision), "not_found");
	const labels = new Map([[saved.communicationId, inputOf("MAIL51-001", "input").draft]]);
	const { drafts } = ok(await read(A, "listDrafts"));
	assert.deepEqual(
		drafts.map((d) => labels.get(d.communicationId)),
		[result.saved_draft],
	);
	ok(await deleting(A, kept.revision));
	refused(await read(A, "getDraft", { id: saved.communicationId }), "not_found");
	assert.deepEqual(await stored(), []);
	assert.deepEqual(
		[port.calls.length, (await rows(sql`SELECT id FROM mail WHERE tenant_id = ${P.id}`)).length],
		[result.provider_calls, result.send_intents],
	);
	assert.deepEqual(await one(sql`SELECT * FROM message_template WHERE id = ${source.templateId}`), templateRow);
});

test("AC:MAIL51-002 a recipient's address, the words, the audience or the time changed after the exact review: the old review sends, schedules or cancels nothing", async () => {
	const { result } = caseOf("MAIL51-002").expected;
	const given = inputOf("MAIL51-002", "input");
	const { P, A, B, member } = await church();
	const alex = await person(P, "Alex", { email: given.review_address as string });
	const reviewed = async () => {
		const saved = ok(
			await draft(A, {
				subject: "Welcome",
				bodyHtml: "<p>Welcome {{name}}.</p>",
				audience: { ...nobody, groups: ["prospects"] },
			}),
		);
		const planned = ok(await schedule(A, saved, { scheduledAt: given.send_at }));
		assert.deepEqual(
			[planned.scheduleStatus, planned.scheduleSent, planned.scheduledAt],
			["accepted", false, "2026-10-14T16:00:00.000Z"],
		);
		return planned;
	};
	const cases: [string, (planned: { communicationId: string; revision: string }) => Promise<unknown>][] = [
		["address", () => updatePerson(A, P, alex, { email: given.live_address })],
		["audience", () => person(P, "Casey")],
		[
			"content",
			(planned) =>
				admin.execute(
					sql`UPDATE communication SET body_html = '<p>Other words</p>' WHERE id = ${planned.communicationId}`,
				),
		],
	];
	for (const [name, change] of cases) {
		const planned = await reviewed();
		await change(planned);
		for (const op of ["handOffScheduled", "sendReviewed", "dispatchAttempt"] as const) {
			const port = accepting();
			const stale = await untouched(admin, () => deliver(A, op, planned, port.transport));
			const { code, details } = refused(stale, result.error_code as string);
			assert.deepEqual(
				[code, details.providerCalls, port.calls.length],
				[result.error_code, result.provider_calls, 0],
				`${name} ${op}`,
			);
		}
		assert.deepEqual(await mailRows(planned.communicationId), []);
	}

	const timed = await reviewed();
	const moved = ok(
		await write(A, "rescheduleReviewed", {
			requestKey: key(),
			expectedRevision: timed.revision,
			input: { communicationId: timed.communicationId, scheduledAt: at(2 * DAY) },
		}),
	);
	const port = accepting();
	await untouched(admin, async () => {
		for (const op of ["handOffScheduled", "sendReviewed"] as const)
			refused(await deliver(A, op, timed, port.transport), "conflict");
		const cancel = (who: Staff, saved: { communicationId: string; revision: string }) =>
			communicationWriter.cancelScheduledReviewed(
				db,
				who.actor,
				{ requestKey: key(), expectedRevision: saved.revision, input: { communicationId: saved.communicationId } },
				port.transport,
			);
		refused(await cancel(A, timed), "conflict");
		refused(await cancel(member, moved), "access_denied");
		for (const communicationId of [moved.communicationId, randomUUID()])
			refused(await cancel(B, { ...moved, communicationId }), "not_found");
	});
	assert.equal(port.calls.length, result.provider_calls);

	const fresh = await reviewed();
	const ready = accepting();
	assert.equal(ok(await deliver(A, "sendReviewed", fresh, ready.transport)).acceptedCount, 2);
	assert.deepEqual(
		ready.sent.map((m) => m.to).sort(),
		["casey@example.test", given.live_address],
		"a new review of the current people sends to the current address",
	);
});

test("AC:MAIL51-006 a batch answered accepted, nothing and then rejected keeps one outcome per recipient under its own provider id, and late sent and delivered facts change only their own recipient", async () => {
	const { result } = caseOf("MAIL51-006").expected;
	const given = inputOf("MAIL51-006", "input");
	const { P, A, member, B } = await church();
	const people: string[] = [];
	for (const name of given.recipient_ids as string[]) people.push(await person(P, name));
	const ids = new Map<string, string | null>();
	const port = carrier((batch) => {
		const answers = batch.messages.map((m) => {
			const index = (given.recipient_ids as string[]).findIndex((r) => m.to === `${r.toLowerCase()}@example.test`);
			const id = (given.provider_ids as (string | null)[])[index] ?? null;
			ids.set(m.to, id);
			return id;
		});
		return { outcome: "ids", ids: answers };
	});
	const message = await send(A, people, port);
	const [r1, r2, r3] = people as [string, string, string];
	assert.deepEqual(
		[message.report.status, message.report.acceptedCount, message.report.unknownCount, port.calls.length],
		["partial", 2, 1, 1],
	);
	const stored = async () => {
		const all = [];
		for (const id of people) {
			const row = await mailOf(message.id, id);
			all.push([row.provider_message_id, row.state]);
		}
		return all;
	};
	assert.deepEqual(await stored(), [
		[(given.provider_ids as unknown[])[0], "accepted"],
		[(given.provider_ids as unknown[])[1], "unknown"],
		[(given.provider_ids as unknown[])[2], "accepted"],
	]);
	const frozen = () =>
		rows(sql`SELECT m.payload_hash, m.logical_key, m.frozen_payload, r.provider_key FROM mail m
			JOIN mail_request_member mem ON mem.mail_id = m.id JOIN mail_request r ON r.id = mem.request_id
			WHERE m.communication_id = ${message.id} ORDER BY m.id`);
	const payloads = await frozen();
	await webhook("mail-3", "bounced", { type: "Permanent" });
	const outcomeOf = async () => {
		const detail = ok(await read(A, "getDetail", { id: message.id }, keys));
		return people.map((id) => detail.recipients.find((r) => r.personId === id)!.deliveryStatus);
	};
	const totals = async (who = A) => ok(await read(who, "getDeliveryTotals", { communicationId: message.id }));
	assert.deepEqual([(await totals()).outcomes, (await totals()).sentForAll], [result.outcomes, result.sent_for_all]);
	const outcomes = async () => {
		const t = await totals();
		return [t.selected, t.attempted, t.accepted, t.sent, t.delivered, t.bounced, t.unknown];
	};
	assert.deepEqual(await outcomes(), [3, 3, 1, 0, 0, 1, 1]);
	await webhook("mail-1", "sent");
	await webhook("mail-1", "delivered");
	const after_ = await totals(member);
	assert.deepEqual([after_.outcomes, after_.sentForAll], [result.outcomes, result.sent_for_all]);
	assert.deepEqual(await outcomes(), [3, 3, 1, 1, 1, 1, 1]);
	assert.equal((await mailOf(message.id, r2)).state, "unknown");
	const [first, second, third] = await outcomeOf();
	assert.deepEqual([first, second], ["delivered", "unknown"]);
	assert.notEqual(third, "delivered");
	assert.equal((await mailOf(message.id, r3)).provider_message_id, "mail-3");
	assert.equal((await mailOf(message.id, r1)).provider_message_id, "mail-1");
	assert.deepEqual(await frozen(), payloads, "the request key and every frozen payload are kept");
	assert.equal(new Set(payloads.map((p) => p.provider_key)).size, 1);
	assert.equal(ok(await read(A, "getExecutionResult", { communicationId: message.id })).status, "partial");
	for (const communicationId of [message.id, randomUUID()])
		refused(await read(B, "getDeliveryTotals", { communicationId }), "not_found");
	refused(await read(A, "getDeliveryTotals", { communicationId: "not-an-id" }), "invalid_input");
});

test("AC:MAIL51-008 the church's staff read the draft's and the sent email's real status, and no read by them, another church, a departed seat or a signed-out session gives a private note or a token", async () => {
	const { result } = caseOf("MAIL51-008").expected;
	const given = inputOf("MAIL51-008", "input");
	const { P, A, member, B } = await church();
	const alex = await person(P, "Alex", { notes: given.token as string });
	await admin.execute(sql`INSERT INTO person_note(id,tenant_id,plant_id,person_id,author_id,body,occurred_at,recorded_at)
		VALUES(${randomUUID()},${P.id},${P.id},${alex},${A.id},${given.private_note as string},clock_timestamp(),clock_timestamp())`);
	const night = await meeting(P, "Vision night");
	await admin.execute(sql`INSERT INTO participation(id,plant_id,meeting_id,person_id,roster_member,rsvp,presence)
		VALUES(${randomUUID()},${P.id},${night},${alex},false,'pending','absent')`);
	const c1 = ok(
		await draft(A, {
			subject: "Draft words",
			bodyHtml: "<p>Draft words</p>",
			audience: { ...nobody, personIds: [alex] },
			meetingId: night,
		}),
	);
	const sent = await send(A, [alex], undefined, {
		bodyHtml: "<p>Hi {{name}}</p><p>{{rsvp_link}}</p>",
		meetingId: night,
	});
	const [email] = sent.port.sent;
	const tokens = [...email!.html.matchAll(/\/(?:rsvp|unsubscribe)\/([\w-]{20,})/g)].map((m) => m[1]!);
	assert.equal(new Set(tokens).size, 2, "the email itself carries an RSVP and an Unsubscribe token");
	const hashes = await rows<{ h: string }>(
		sql`SELECT rsvp_token_hash AS h FROM participation WHERE meeting_id = ${night}`,
	);
	const secrets = [given.private_note, given.token, ...tokens, ...hashes.map((r) => r.h)] as string[];

	const reads = (who: Staff, id: string) => [
		() => read(who, "getDeliveryTotals", { communicationId: id }),
		() => read(who, "getDetail", { id }, keys),
		() => read(who, "getDraft", { id }),
		() => read(who, "getExecutionResult", { communicationId: id }),
		() => read(who, "listHistoryRecipients", { communicationId: id }, keys),
		() => read(who, "listForPerson", { personId: alex }),
		() => read(who, "listForMeeting", { meetingId: night }),
		() => read(who, "listMeetingTracking", { meetingId: night }),
	];
	const lists = (who: Staff) => [
		() => read(who, "listHistory", {}),
		() => read(who, "listHistory", { personId: alex }),
		() => read(who, "listDrafts"),
	];
	const told = async (calls: (() => Promise<{ status: string; value?: unknown }>)[], who: string) => {
		const answers = [];
		for (const call of calls) answers.push(await call());
		const text = JSON.stringify(answers);
		const shown = (secret: unknown) => (text.includes(String(secret)) ? secret : null);
		assert.deepEqual([shown(given.private_note), shown(given.token)], [result.private_note, result.token], who);
		for (const needle of secrets) assert.equal(text.includes(needle), false, `${who}: ${needle}`);
		return answers;
	};
	await untouched(admin, async () => {
		for (const [who, name] of [
			[A, "admin"],
			[member, "member"],
		] as const) {
			for (const id of [c1.communicationId, sent.id])
				for (const answer of await told([...reads(who, id), ...lists(who)], name)) ok(answer);
			const totals = ok(await read(who, "getDeliveryTotals", { communicationId: c1.communicationId }));
			assert.equal(totals.state, result.P_status);
			assert.equal(ok(await read(who, "getDetail", { id: c1.communicationId }, keys)).state, result.P_status);
			const listed = ok(await read(who, "listHistory", { personId: alex }));
			assert.deepEqual(Object.fromEntries(listed.items.map((i) => [i.id, i.state])), {
				[c1.communicationId]: "draft",
				[sent.id]: "sending",
			});
		}
		for (const id of [c1.communicationId, sent.id, randomUUID()])
			for (const answer of await told(reads(B, id), "another church")) {
				refused(answer, "not_found");
				assert.equal(answer.value ?? null, result.Q_body);
			}
		for (const answer of await told(lists(B), "another church")) {
			const { items, drafts } = ok(answer) as { items?: unknown[]; drafts?: unknown[] };
			assert.deepEqual(items ?? drafts, []);
		}
	});
	const departed = await staff(P);
	await admin.execute(sql`UPDATE seat SET ended_at = clock_timestamp() WHERE account_id = ${departed.id}`);
	const signedOut = await staff(P);
	await admin.execute(sql`DELETE FROM auth_session WHERE id = ${signedOut.session}`);
	await untouched(admin, async () => {
		for (const [who, name] of [
			[departed, "departed"],
			[signedOut, "signed out"],
		] as const)
			for (const id of [c1.communicationId, sent.id])
				for (const answer of await told([...reads(who, id), ...lists(who)], name)) refused(answer, "access_denied");
	});
});
