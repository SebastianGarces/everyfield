import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { communicationWriter, withCommunicationWrite } from "../../../packages/domain/src/communication/index.ts";
import { answerRsvpToken, describeRsvpToken } from "../../../packages/domain/src/meetings/index.ts";
import { renderEmailHtml } from "../../../packages/contracts/src/communication/email.ts";
import { renderBody } from "../../../packages/contracts/src/communication/html.ts";

// REQ-COM-010, REQ-MTG-018: an invitation email carries each guest's own RSVP link, minted when the send is handed off.

let f, plant, owner;
const origin = "https://app.example.test";
const keys = { encryptionKey: Buffer.alloc(32, 7), addressKey: Buffer.alloc(32, 9), from: "news@example.test", origin };
const emptyAudience = { groups: [], teamIds: [], personIds: [] };
const day = 86_400_000;
const key = () => randomUUID();
const sha = (token) => createHash("sha256").update(token).digest("hex");
const ok = (result) => {
	assert.equal(result.status, "ok", JSON.stringify(result));
	return result.value;
};
const refused = (result, code) => {
	assert.equal(result.status, "refused", JSON.stringify(result));
	assert.equal(result.error.code, code, JSON.stringify(result.error));
	return result.error;
};
const rows = async (query) => (await f.admin.execute(query)).rows;
const write = (op, input) =>
	withCommunicationWrite(f.db, owner.actor, (tx, ctx) => communicationWriter[op](tx, ctx, input));
const read = (op, input) => f.db.transaction((tx) => communicationWriter[op](tx, owner.actor, input));

async function person(name, email = `${randomUUID()}@example.test`) {
	const id = randomUUID();
	await f.admin
		.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at)
		VALUES(${id},${plant.id},${plant.id},${name},${email},'other','prospect','unknown','unknown',0,'live',clock_timestamp())`);
	return id;
}
async function meeting(type, startsAt, status = "planning", title = null) {
	const id = randomUUID();
	let teamId = null;
	if (type === "team_meeting") {
		teamId = randomUUID();
		await f.admin.execute(
			sql`INSERT INTO team(id,plant_id,name,state,sort_order) VALUES(${teamId},${plant.id},'Hospitality',${"active"},1)`,
		);
	}
	await f.admin
		.execute(sql`INSERT INTO meeting(id,plant_id,type,title,team_id,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision)
		VALUES(${id},${plant.id},${type},${title},${teamId},${startsAt.toISOString().slice(0, 10)},'18:00','America/Chicago',${startsAt.toISOString()},'1',${status},1)`);
	return id;
}
async function guest(meetingId, personId) {
	await f.admin.execute(sql`INSERT INTO participation(id,plant_id,meeting_id,person_id,roster_member,rsvp,presence)
		VALUES(${randomUUID()},${plant.id},${meetingId},${personId},false,'pending','absent')`);
}
const guestRow = async (meetingId, personId) => {
	const [row] =
		await rows(sql`SELECT rsvp, rsvp_source, rsvp_token_hash, rsvp_token_expires_at, rsvp_token_open FROM participation
		WHERE meeting_id = ${meetingId} AND person_id = ${personId}`);
	return { ...row, rsvp_token_expires_at: row.rsvp_token_expires_at ? new Date(row.rsvp_token_expires_at) : null };
};

const BODY = "<p>Hi {{name}},</p><p>{{rsvp_link}}</p>";
async function scheduled(meetingId, personIds, bodyHtml = BODY) {
	const saved = ok(
		await write("saveDraft", {
			requestKey: key(),
			input: {
				subject: "Join us",
				bodyHtml,
				audience: { ...emptyAudience, personIds },
				...(meetingId ? { meetingId } : {}),
			},
		}),
	);
	return {
		saved,
		schedule: () =>
			write("scheduleReviewed", {
				requestKey: key(),
				expectedRevision: saved.revision,
				input: { communicationId: saved.communicationId, scheduledAt: new Date(Date.now() + 3_600_000).toISOString() },
			}),
	};
}
/** A transport that records every message and accepts it. */
function capture() {
	const sent = [];
	return {
		sent,
		async send(batch) {
			sent.push(...batch.messages);
			return { outcome: "ids", ids: batch.messages.map(() => randomUUID()) };
		},
		async lookup() {
			return { outcome: "unknown" };
		},
	};
}
async function send(meetingId, personIds, bodyHtml = BODY) {
	const draft = await scheduled(meetingId, personIds, bodyHtml);
	const accepted = ok(await draft.schedule());
	const transport = capture();
	const dispatch = () =>
		communicationWriter.dispatchAttempt(
			f.db,
			owner.actor,
			{
				requestKey: key(),
				expectedRevision: accepted.revision,
				input: { communicationId: draft.saved.communicationId },
			},
			transport,
			keys,
		);
	return { communicationId: draft.saved.communicationId, transport, dispatch, draft };
}
const tokenOf = (message) => {
	const found = message.html.match(/href="(https:\/\/[^"]+\/rsvp\/([A-Za-z0-9_-]{43}))"/);
	return found ? { url: found[1], token: found[2] } : null;
};
const messageFor = (sent, address) => sent.find((m) => m.to === address);

before(async () => {
	f = await fixture();
	plant = await f.workspace();
	const account = await f.account();
	await f.seat(account, plant, "owner");
	owner = { ...account, actor: await f.actor(account.session) };
});
after(() => f?.close());

test("AC:COM-010 AC:MTG-018 a send gives each guest their own link and no link to a non-guest", async () => {
	const orientation = await meeting("orientation", new Date(Date.now() + 3 * day));
	const ann = await person("Ann Lee", "ann@example.test");
	const ben = await person("Ben Ray", "ben@example.test");
	const cat = await person("Cat Fox", "cat@example.test");
	await guest(orientation, ann);
	await guest(orientation, ben);
	const s = await send(orientation, [ann, ben, cat]);
	const result = ok(await s.dispatch());
	const { sent } = s.transport;
	assert.equal(sent.length, 3);
	for (const message of sent) {
		assert.equal(message.html.includes("{{"), false);
		assert.equal(message.text.includes("{{"), false);
	}
	const annMail = messageFor(sent, "ann@example.test");
	const benMail = messageFor(sent, "ben@example.test");
	const catMail = messageFor(sent, "cat@example.test");
	assert.match(annMail.html, /Hi Ann Lee,/);
	assert.match(benMail.html, /Hi Ben Ray,/);
	assert.match(catMail.html, /Hi Cat Fox,/);
	const a = tokenOf(annMail);
	const b = tokenOf(benMail);
	assert.ok(a && b && a.token !== b.token);
	assert.ok(a.url.startsWith(origin + "/rsvp/"), a.url);
	assert.ok(annMail.text.includes(a.url));
	assert.equal(tokenOf(catMail), null);
	assert.equal(catMail.html.includes("/rsvp/"), false);
	assert.equal(catMail.html.includes("<p></p>"), false);
	assert.equal((await guestRow(orientation, ann)).rsvp_token_hash, sha(a.token));
	assert.equal((await guestRow(orientation, ben)).rsvp_token_hash, sha(b.token));
	assert.equal((await guestRow(orientation, ben)).rsvp_token_open, true);
	assert.equal((await rows(sql`SELECT 1 FROM participation WHERE person_id = ${cat}`)).length, 0);
	// No raw token reaches the audit row, the dispatch result or the stored mail rows.
	const audit = await rows(
		sql`SELECT after_value FROM audit_event WHERE action = 'communication.send_intended' AND subject_id = ${s.communicationId}`,
	);
	assert.equal(audit[0].after_value.rsvpLinks, 2);
	const stored = JSON.stringify([
		audit,
		result,
		await rows(sql`SELECT * FROM mail WHERE logical_key LIKE ${"communication/" + s.communicationId + "/%"}`),
	]);
	assert.equal(stored.includes(a.token) || stored.includes(b.token), false);
});

for (const [type, title] of [
	["vision_meeting", null],
	["orientation", "Spring orientation"],
	["team_meeting", "Welcome team huddle"],
]) {
	test(`AC:COM-010 AC:MTG-009 a ${type} guest answers through the emailed link`, async () => {
		const m = await meeting(type, new Date(Date.now() + 2 * day), "planning", title);
		const g = await person("Dee Moss", `dee-${type}@example.test`);
		await guest(m, g);
		const s = await send(m, [g]);
		ok(await s.dispatch());
		const link = tokenOf(s.transport.sent[0]);
		assert.ok(link);
		const view = await describeRsvpToken(f.db, { token: link.token });
		assert.equal(view.state, "pending");
		assert.ok(view.meeting.displayTitle.length > 0);
		if (title) assert.equal(view.meeting.displayTitle, title);
		const answered = await answerRsvpToken(f.db, { token: link.token, rsvp: "confirmed" });
		assert.equal(answered.status, "ok", JSON.stringify(answered));
		const row = await guestRow(m, g);
		assert.equal(row.rsvp, "confirmed");
		assert.equal(row.rsvp_source, "token");
		const [count] = await rows(
			sql`SELECT count(*)::int AS n FROM participation WHERE meeting_id = ${m} AND rsvp = 'confirmed' AND removed_at IS NULL`,
		);
		assert.equal(count.n, 1);
	});
}

test("AC:COM-010 a link lasts to the later of seven days and the meeting start", async () => {
	const far = await meeting("orientation", new Date(Date.now() + 20 * day));
	const near = await meeting("orientation", new Date(Date.now() + 2 * day));
	const [farGuest, nearGuest] = [await person("Far Guest"), await person("Near Guest")];
	await guest(far, farGuest);
	await guest(near, nearGuest);
	ok(await (await send(far, [farGuest])).dispatch());
	const before = Date.now();
	ok(await (await send(near, [nearGuest])).dispatch());
	const [farMeeting] = await rows(sql`SELECT starts_at FROM meeting WHERE id = ${far}`);
	const farExpiry = (await guestRow(far, farGuest)).rsvp_token_expires_at;
	assert.equal(farExpiry.getTime(), new Date(farMeeting.starts_at).getTime());
	const nearExpiry = (await guestRow(near, nearGuest)).rsvp_token_expires_at.getTime();
	assert.ok(Math.abs(nearExpiry - (before + 7 * day)) < 60_000, String(nearExpiry - before));
});

test("INV-idempotency: a repeated handoff mints nothing and a new send supersedes the older link", async () => {
	const m = await meeting("orientation", new Date(Date.now() + 5 * day));
	const g = await person("Eve Hart", "eve@example.test");
	await guest(m, g);
	const first = await send(m, [g]);
	ok(await first.dispatch());
	const before = await guestRow(m, g);
	const oldLink = tokenOf(first.transport.sent[0]);
	await first.dispatch().catch(() => undefined);
	const after = await guestRow(m, g);
	assert.equal(first.transport.sent.length, 1);
	assert.equal(after.rsvp_token_hash, before.rsvp_token_hash);
	assert.equal(after.rsvp_token_expires_at.getTime(), before.rsvp_token_expires_at.getTime());
	const second = await send(m, [g]);
	ok(await second.dispatch());
	const newLink = tokenOf(second.transport.sent[0]);
	assert.notEqual(newLink.token, oldLink.token);
	assert.deepEqual(await describeRsvpToken(f.db, { token: oldLink.token }), { state: "unavailable" });
	assert.equal((await describeRsvpToken(f.db, { token: newLink.token })).state, "pending");
});

test("AC:COM-010 a message with an RSVP link needs an open meeting", async () => {
	const g = await person("Fay Dunn", "fay@example.test");
	const nothing = await scheduled(null, [g]);
	refused(await nothing.schedule(), "rsvp_needs_meeting");
	const done = await meeting("orientation", new Date(Date.now() + day), "completed");
	const closed = await scheduled(done, [g]);
	refused(await closed.schedule(), "rsvp_needs_meeting");
	refused(await read("readPreview", { bodyHtml: BODY, merge: { name: "Fay" } }), "rsvp_needs_meeting");
	for (const id of [nothing.saved.communicationId, closed.saved.communicationId])
		assert.equal(
			(await rows(sql`SELECT 1 FROM mail WHERE logical_key LIKE ${"communication/" + id + "/%"}`)).length,
			0,
		);
	const [state] = await rows(sql`SELECT state FROM communication WHERE id = ${nothing.saved.communicationId}`);
	assert.equal(state.state, "draft");
});

test("AC:COM-010 the preview equals the sent message apart from the name and the token", async () => {
	const m = await meeting("vision_meeting", new Date(Date.now() + 4 * day));
	const g = await person("Gus Pike", "gus@example.test");
	await guest(m, g);
	const s = await send(m, [g]);
	ok(await s.dispatch());
	const sent = s.transport.sent[0];
	const link = tokenOf(sent);
	const preview = ok(
		await read("readPreview", {
			bodyHtml: BODY,
			meetingId: m,
			merge: { name: "Sample Person", rsvp_link: `${origin}/rsvp/preview` },
		}),
	);
	assert.equal(
		preview.previewHtml.replaceAll("Sample Person", "Gus Pike").replaceAll("/rsvp/preview", "/rsvp/" + link.token),
		sent.html,
	);
	// The sent HTML is the system layout around the rendered body.
	const [church] = await rows(sql`SELECT name FROM plant WHERE id = ${plant.id}`);
	assert.equal(
		sent.html,
		renderEmailHtml(BODY, { name: "Gus Pike", rsvp_link: link.url }, { churchName: church.name }),
	);
	assert.equal(preview.previewBody, renderBody(BODY, { name: "Sample Person", rsvp_link: `${origin}/rsvp/preview` }));
});

test("AC:COM-010 a send without the RSVP field mints no token", async () => {
	const m = await meeting("orientation", new Date(Date.now() + 2 * day));
	const g = await person("Hal Ross", "hal@example.test");
	await guest(m, g);
	const s = await send(m, [g], "<p>Hi {{name}}, see you soon.</p>");
	ok(await s.dispatch());
	const mail = s.transport.sent[0];
	assert.equal(mail.html.includes("/rsvp/"), false);
	assert.equal((await guestRow(m, g)).rsvp_token_hash, null);
	const [audit] = await rows(
		sql`SELECT after_value FROM audit_event WHERE action = 'communication.send_intended' AND subject_id = ${s.communicationId}`,
	);
	assert.equal(audit.after_value.rsvpLinks, 0);
});

test("AC:COM-010 an http app origin sends no link and mints no token", async () => {
	const m = await meeting("vision_meeting", new Date(Date.now() + 2 * day));
	const g = await person("Ivy Cole", "ivy@example.test");
	await guest(m, g);
	const draft = await scheduled(m, [g]);
	const accepted = ok(await draft.schedule());
	const transport = capture();
	ok(
		await communicationWriter.dispatchAttempt(
			f.db,
			owner.actor,
			{
				requestKey: key(),
				expectedRevision: accepted.revision,
				input: { communicationId: draft.saved.communicationId },
			},
			transport,
			{ ...keys, origin: "http://localhost:3000" },
		),
	);
	const mail = transport.sent[0];
	assert.equal(mail.html.includes("/rsvp/"), false);
	assert.equal(mail.html.includes("data-rsvp-placeholder"), false);
	assert.equal(mail.html.includes("RSVP button appears here"), false);
	assert.equal(mail.text.includes("RSVP button appears here"), false);
	assert.equal((await guestRow(m, g)).rsvp_token_hash, null);
});

test("AC:COM-010 the preview shows a labeled placeholder when no https link is possible, and a send never does", () => {
	const context = { churchName: "Grace" };
	for (const merge of [{ name: "Sam", rsvp_link: "http://localhost:3000/rsvp/preview" }, { name: "Sam" }]) {
		const preview = renderEmailHtml(BODY, merge, context, "preview");
		assert.ok(preview.includes("data-rsvp-placeholder"));
		assert.ok(preview.includes("RSVP button appears here (needs an https app origin)"));
		assert.equal(preview.includes("data-rsvp-button"), false);
		assert.equal(preview.includes("<p></p>"), false);
		const sent = renderEmailHtml(BODY, merge, context);
		assert.equal(sent.includes("data-rsvp-placeholder"), false);
		assert.equal(sent.includes("RSVP button appears here"), false);
		assert.equal(renderBody(BODY, merge).includes("RSVP button appears here"), false);
	}
	// A valid https link renders the button in both modes.
	const merge = { name: "Sam", rsvp_link: `${origin}/rsvp/preview` };
	assert.ok(renderEmailHtml(BODY, merge, context, "preview").includes("data-rsvp-button"));
	assert.equal(renderEmailHtml(BODY, merge, context, "preview").includes("data-rsvp-placeholder"), false);
});
