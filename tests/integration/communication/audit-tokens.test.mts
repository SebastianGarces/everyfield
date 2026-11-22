import "../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { communicationWriter, withCommunicationWrite } from "../../../packages/domain/src/communication/index.ts";
import { applyMessagesOptOut, undoMessagesOptOut } from "../../../packages/domain/src/communication/opt-out.ts";
import { answerRsvpToken } from "../../../packages/domain/src/meetings/index.ts";
import { createNotificationProducer, issueEmailOptOutToken } from "../../../packages/domain/src/notifications/index.ts";
import { ok } from "../../support/fixture.mts";

let f, plant, owner;
const origin = "https://app.example.test";
const ring = { current: randomBytes(32), previous: [] };
const keys = { encryptionKey: Buffer.alloc(32, 7), addressKey: Buffer.alloc(32, 9), from: "news@example.test", origin };
const notifications = createNotificationProducer({ optOutKeys: ring });
const issued = new Map<string, string[]>();
const issue = (kind: string, token: string | null | undefined) => {
	assert.ok(token, `${kind} token issued`);
	issued.set(kind, [...(issued.get(kind) ?? []), token]);
	return token;
};
const now = () => new Date();

before(async () => {
	f = await fixture();
	plant = await f.workspace();
	const account = await f.account();
	await f.seat(account, plant, "owner");
	owner = { ...account, actor: await f.actor(account.session) };
});
after(() => f?.close());

async function guestOfMeeting() {
	const meeting = randomUUID(),
		person = randomUUID(),
		address = `${person}@example.test`;
	const startsAt = new Date(Date.now() + 3 * 86_400_000);
	await f.admin
		.execute(sql`INSERT INTO meeting(id,plant_id,type,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision)
		VALUES(${meeting},${plant.id},'orientation',${startsAt.toISOString().slice(0, 10)},'18:00','America/Chicago',${startsAt.toISOString()},'1','planning',1)`);
	await f.admin
		.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at)
		VALUES(${person},${plant.id},${plant.id},'Ann Lee',${address},'other','prospect','unknown','unknown',0,'live',clock_timestamp())`);
	await f.admin.execute(sql`INSERT INTO participation(id,plant_id,meeting_id,person_id,roster_member,rsvp,presence)
		VALUES(${randomUUID()},${plant.id},${meeting},${person},false,'pending','absent')`);
	return { meeting, person };
}

async function sendInvite(meeting: string, person: string) {
	const write = (op, input) =>
		withCommunicationWrite(f.db, owner.actor, (tx, ctx) => communicationWriter[op](tx, ctx, input));
	const saved = ok(
		await write("saveDraft", {
			requestKey: randomUUID(),
			input: {
				subject: "Join us",
				bodyHtml: "<p>Hi {{name}},</p><p>{{rsvp_link}}</p>",
				audience: { groups: [], teamIds: [], personIds: [person] },
				meetingId: meeting,
			},
		}),
	);
	const accepted = ok(
		await write("scheduleReviewed", {
			requestKey: randomUUID(),
			expectedRevision: saved.revision,
			input: { communicationId: saved.communicationId, scheduledAt: new Date(Date.now() + 3_600_000).toISOString() },
		}),
	);
	const sent = [];
	ok(
		await communicationWriter.dispatchAttempt(
			f.db,
			owner.actor,
			{
				requestKey: randomUUID(),
				expectedRevision: accepted.revision,
				input: { communicationId: saved.communicationId },
			},
			{
				async send(batch) {
					sent.push(...batch.messages);
					return { outcome: "ids", ids: batch.messages.map(() => randomUUID()) };
				},
				async lookup() {
					return { outcome: "unknown" };
				},
			},
			{ ...keys, optOutKeys: ring },
		),
	);
	assert.equal(sent.length, 1);
	return sent[0].html as string;
}

async function auditRowsHolding(token: string) {
	const { rows } = await f.admin.execute(
		sql`SELECT a.action FROM audit_event a WHERE strpos(a::text, ${token}) > 0 OR strpos(a::text, ${encodeURIComponent(token)}) > 0`,
	);
	return rows.map((r) => r.action);
}

test("no raw RSVP, unsubscribe, email-preference or invitation proof token issued in this run reaches an audit row", async () => {
	const { meeting, person } = await guestOfMeeting();
	const html = await sendInvite(meeting, person);
	const rsvp = issue("rsvp", html.match(/\/rsvp\/([A-Za-z0-9_-]{43})"/)?.[1]);
	const unsubscribe = issue("unsubscribe", html.match(/\/unsubscribe\/([A-Za-z0-9_-]+)/)?.[1]);
	assert.deepEqual(ok(await answerRsvpToken(f.db, { token: rsvp, rsvp: "confirmed" })), { rsvp: "confirmed" });
	const optedOut = ok(await applyMessagesOptOut(f.db, ring, now, { token: unsubscribe }));
	assert.equal(optedOut.changed, true);
	ok(await undoMessagesOptOut(f.db, ring, now, { token: issue("unsubscribe", optedOut.undoToken) }));

	const preference = issue(
		"email-preference",
		issueEmailOptOutToken(ring, {
			purpose: "disable",
			accountId: owner.id,
			category: "meeting_announcement",
			unsubscribeRevision: "0",
		}),
	);
	const disabled = ok(await notifications.applyEmailOptOut(f.db, { token: preference }));
	assert.equal(disabled.changed, true);
	ok(await notifications.undoEmailOptOut(f.db, { token: issue("email-preference", disabled.undoToken) }));

	const s = await f.setup();
	const invitation = await f.invitation(s);
	issue("invitation proof", invitation.proof);
	await f.invitations.accept(s.recipient.session, invitation.claim);

	const { rows: written } = await f.admin.execute(sql`SELECT DISTINCT action FROM audit_event ORDER BY action`);
	const actions = written.map((r) => r.action);
	for (const action of ["meetings.rsvp_recorded", "settings.changed", "communication.send_intended"])
		assert.ok(actions.includes(action), `${action} in ${actions.join(", ")}`);
	assert.ok(
		actions.some((a) => a.startsWith("identity.") || a.startsWith("seat")),
		actions.join(", "),
	);
	assert.deepEqual(
		[...issued].map(([kind, tokens]) => [kind, tokens.length]),
		[
			["rsvp", 1],
			["unsubscribe", 2],
			["email-preference", 2],
			["invitation proof", 1],
		],
	);
	for (const [kind, tokens] of issued)
		for (const token of tokens) assert.deepEqual(await auditRowsHolding(token), [], `${kind} token in an audit row`);
});
