import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { communicationWriter, withCommunicationWrite } from "../../../packages/domain/src/communication/index.ts";
import { attendanceReader, meetingsReader } from "../../../packages/domain/src/meetings/index.ts";
import { resendWebhook } from "../../../apps/web/src/app/api/webhooks/resend/route.ts";

// REQ-COM-010 (WP-028): the meeting guest list shows when a guest opened the meeting's email, in its own place. An
// open is an email-service notice: it changes no RSVP, attendance or count, and no open claims nothing.

let f, plant, owner, member;
const keys = {
	encryptionKey: Buffer.alloc(32, 7),
	addressKey: Buffer.alloc(32, 9),
	from: "news@example.test",
	origin: "https://app.example.test",
};
const secret = "whsec_" + randomBytes(32).toString("base64");
const ok = (result) => {
	assert.equal(result.status, "ok", JSON.stringify(result));
	return result.value;
};
const rows = async (query) => (await f.admin.execute(query)).rows;

async function person(name) {
	const id = randomUUID();
	await f.admin
		.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at)
		VALUES(${id},${plant.id},${plant.id},${name},${`${name.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`},
		'other','prospect','unknown','unknown',0,'live',clock_timestamp())`);
	return id;
}
function opened(messageId, at) {
	const raw = JSON.stringify({ type: "email.opened", created_at: at, data: { email_id: messageId } });
	const eventKey = randomUUID();
	const stamp = String(Math.floor(Date.now() / 1000));
	const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
		.update(eventKey + "." + stamp + "." + raw)
		.digest("base64");
	return new Request("https://example.test/api/webhooks/resend", {
		method: "POST",
		body: raw,
		headers: { "svix-id": eventKey, "svix-timestamp": stamp, "svix-signature": "v1," + signature },
	});
}
const guests = async (who, meetingId) =>
	ok(await f.db.transaction((tx) => meetingsReader.listGuests(tx, who.actor, { meetingId })));
/** Everything an open must not touch: the guest rows, the attendance read and the meeting's analytics. */
async function untouched(meetingId) {
	const list = await guests(owner, meetingId);
	const counts = { yes: 0, no: 0, pending: 0 };
	for (const g of list.guests) counts[{ confirmed: "yes", declined: "no", pending: "pending" }[g.rsvp]] += 1;
	return {
		guests: list.guests,
		rsvpCounts: counts,
		attendedCount: list.guests.filter((g) => g.presence === "attended").length,
		attendance: ok(
			await f.db.transaction((tx) => attendanceReader.listAttendance(tx, owner.actor, { meetingId, limit: 500 })),
		),
		analytics: ok(await f.db.transaction((tx) => attendanceReader.readAnalytics(tx, owner.actor, { meetingId }))),
		participation: await rows(sql`SELECT person_id, rsvp, rsvp_source, presence, revision FROM participation
			WHERE meeting_id = ${meetingId} ORDER BY person_id`),
		meeting: await rows(sql`SELECT attendance_revision, revision FROM meeting WHERE id = ${meetingId}`),
	};
}

before(async () => {
	f = await fixture();
	plant = await f.workspace();
	const account = await f.account();
	await f.seat(account, plant, "owner");
	owner = { ...account, actor: await f.actor(account.session) };
	const seatMember = await f.account();
	await f.seat(seatMember, plant, "member");
	member = { ...seatMember, actor: await f.actor(seatMember.session) };
});
after(() => f?.close());

test("AC:CASE-COM-010 a guest who opened the meeting email shows Email opened with the time, apart from RSVP and attendance", async () => {
	const meetingId = randomUUID();
	const startsAt = new Date(Date.now() + 5 * 86_400_000);
	await f.admin
		.execute(sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision)
		VALUES(${meetingId},${plant.id},'vision_meeting',NULL,${startsAt.toISOString().slice(0, 10)},'18:00','America/Chicago',
		${startsAt.toISOString()},'1','planning',1)`);
	const alex = await person("Alex");
	const bo = await person("Bo");
	for (const id of [alex, bo])
		await f.admin.execute(sql`INSERT INTO participation(id,plant_id,meeting_id,person_id,roster_member,rsvp,presence)
			VALUES(${randomUUID()},${plant.id},${meetingId},${id},false,'pending','absent')`);
	const scheduled = ok(
		await withCommunicationWrite(f.db, owner.actor, async (tx, ctx) => {
			const saved = await communicationWriter.saveDraft(tx, ctx, {
				requestKey: randomUUID(),
				input: {
					subject: "Vision night",
					bodyHtml: "<p>Hi {{name}}, join us.</p>",
					audience: { groups: [], teamIds: [], personIds: [alex, bo] },
					meetingId,
				},
			});
			if (saved.status !== "ok") return saved;
			return communicationWriter.scheduleReviewed(tx, ctx, {
				requestKey: randomUUID(),
				expectedRevision: saved.value.revision,
				input: {
					communicationId: saved.value.communicationId,
					scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
				},
			});
		}),
	);
	ok(
		await communicationWriter.sendReviewed(
			f.db,
			owner.actor,
			{
				requestKey: randomUUID(),
				expectedRevision: scheduled.revision,
				input: { communicationId: scheduled.communicationId },
			},
			{
				async send(batch) {
					return { outcome: "ids", ids: batch.messages.map((_, i) => `prov-open-${scheduled.communicationId}-${i}`) };
				},
				async lookup() {
					return { outcome: "unknown" };
				},
				async cancel(ids) {
					return ids.map(() => ({ outcome: "unknown" }));
				},
				async reschedule(ids) {
					return ids.map(() => ({ outcome: "unknown" }));
				},
			},
			keys,
		),
	);
	const [alexMail] = await rows(sql`SELECT provider_message_id AS id FROM mail
		WHERE logical_key = ${`communication/${scheduled.communicationId}/${alex}`}`);
	assert.equal((await guests(owner, meetingId)).emailOpens.length, 0);
	const before = await untouched(meetingId);

	const at = new Date(Date.now() - 60_000).toISOString();
	const response = await resendWebhook(opened(alexMail.id, at), () => f.db, secret);
	assert.equal(response.status, 200);

	const list = await guests(owner, meetingId);
	assert.deepEqual(list.emailOpens, [{ personId: alex, openedAt: at }]);
	assert.ok(!list.emailOpens.some((row) => row.personId === bo), "a guest with no open shows no open");
	assert.deepEqual(await untouched(meetingId), before);
	// A Member reads the guest list without email opens.
	assert.deepEqual((await guests(member, meetingId)).emailOpens, []);
});
