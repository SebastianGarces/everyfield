import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { communicationWriter, withCommunicationWrite } from "../../../packages/domain/src/communication/index.ts";
import { hubLabel } from "../../../apps/web/src/features/communication/model.ts";
import { resendRecorder } from "./resend-recorder.mts";
import { atSendTime, minuteRunner } from "./scheduled-support.mts";
import { ok } from "../../support/fixture.mts";

let f, church, owner;
const keys = {
	encryptionKey: Buffer.alloc(32, 7),
	addressKey: Buffer.alloc(32, 9),
	from: "news@example.test",
	origin: "https://app.example.test",
};
const PRODUCTION = { VERCEL_ENV: "production" };
const DAY = 86_400_000;
const key = () => randomUUID();
const rows = async (query) => (await f.admin.execute(query)).rows;
const yearsAgo = (years: number) => {
	const at = new Date();
	return `${at.getUTCFullYear() - years}-06-15`;
};

async function person(
	name,
	marking: { as?: "adult" | "child" | "unknown"; born?: string; householdChild?: boolean } = {},
) {
	const id = randomUUID();
	const email = `${name.toLowerCase()}-${key().slice(0, 8)}@example.test`;
	let household = null;
	if (marking.householdChild) {
		household = randomUUID();
		await f.admin.execute(
			sql`INSERT INTO household(id,plant_id,name) VALUES(${household},${church.id},${name + " home"})`,
		);
	}
	await f.admin
		.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
		birth_date,household_id,household_role,commitment_state,pipeline_position,state,created_at)
		VALUES(${id},${church.id},${church.id},${name},${email},'other','prospect',${marking.as ?? "unknown"},
		${marking.born ?? null}::date,${household}::uuid,${household ? "child" : null},'unknown',0,'live',clock_timestamp())`);
	return { id, email, name };
}
const mark = (who, as: "adult" | "child") =>
	f.admin.execute(sql`UPDATE person SET adult_classification = ${as} WHERE id = ${who.id}`);
const bornOn = (who, born: string) =>
	f.admin.execute(sql`UPDATE person SET birth_date = ${born}::date WHERE id = ${who.id}`);

const write = (op, input) =>
	withCommunicationWrite(f.db, owner.actor, (tx, ctx) => communicationWriter[op](tx, ctx, input));
async function draft(people) {
	return ok(
		await write("saveDraft", {
			requestKey: key(),
			input: {
				subject: "Next Sunday",
				bodyHtml: "<p>Hello {{name}}.</p>",
				audience: { groups: [], teamIds: [], personIds: people.map((p) => p.id) },
			},
		}),
	);
}
const scheduleAt = (saved, at = new Date(Date.now() + 7 * DAY).toISOString()) =>
	write("scheduleReviewed", {
		requestKey: key(),
		expectedRevision: saved.revision,
		input: { communicationId: saved.communicationId, scheduledAt: at },
	});

async function schedule(people, resend) {
	const saved = await draft(people);
	const scheduled = ok(await scheduleAt(saved));
	const report = ok(
		await communicationWriter.handOffScheduled(
			f.db,
			owner.actor,
			{ requestKey: key(), expectedRevision: scheduled.revision, input: { communicationId: saved.communicationId } },
			resend.transport,
			keys,
		),
	);
	return { id: saved.communicationId, report };
}

const sentTo = (resend) =>
	resend.requests
		.filter((r) => r.path === "/emails/batch" && r.method === "POST")
		.flatMap((r) => r.body.map((m) => m.to[0]));
const read = (op, input, extra?) => f.db.transaction((tx) => communicationWriter[op](tx, owner.actor, input, extra));
async function shown(id) {
	const page = ok(await read("listHistory", { limit: 100 }));
	return {
		item: page.items.find((row) => row.id === id),
		totals: ok(await read("getDeliveryTotals", { communicationId: id })),
		recipients: ok(await read("listHistoryRecipients", { communicationId: id, limit: 100 })).items,
	};
}
const statusOf = (view, who) => view.recipients.find((row) => row.personId === who.id)?.deliveryStatus;
const mailOf = async (id, who) =>
	rows(sql`SELECT state, refusal, provider_message_id AS provider, accepted_at::text AS accepted
		FROM mail WHERE logical_key = ${"communication/" + id + "/" + who.id}`);

before(async () => {
	f = await fixture();
	church = await f.workspace();
	const a = await f.account();
	await f.seat(a, church, "owner");
	owner = { ...a, actor: await f.actor(a.session) };
});
after(() => f?.close());

test("AC:CASE-NTF-016-CHILD a group email leaves out the people marked as a child with that reason, and everyone else still gets it at the send time", async () => {
	const ana = await person("Ana", { as: "adult" });
	const kid = await person("Kid", { as: "child" });
	const tia = await person("Tia", { born: yearsAgo(9) });
	const una = await person("Una");
	const hal = await person("Hal", { as: "adult", householdChild: true });

	const audience = ok(
		await read("readAudience", { groups: [], teamIds: [], personIds: [ana, kid, tia, una, hal].map((p) => p.id) }),
	);
	assert.deepEqual(
		audience.childExclusions,
		[kid, tia].map((p) => ({ id: p.id, displayName: p.name })),
	);
	assert.equal(audience.eligibleRecipients, 3, "not recorded and household role child are still included");
	assert.deepEqual(audience.unsubscribedExclusions, []);
	assert.deepEqual(audience.missingEmailExclusions, []);
	assert.equal(audience.eligibleEmails.includes(kid.email), false);

	const resend = resendRecorder(PRODUCTION);
	const message = await schedule([ana, kid, tia, una, hal], resend);
	assert.deepEqual(
		[message.report.acceptedCount, message.report.childCount, message.report.unsubscribedCount],
		[3, 2, 0],
	);
	const waiting = await shown(message.id);
	assert.equal(waiting.item.state, "scheduled");
	assert.deepEqual(
		[statusOf(waiting, kid), statusOf(waiting, tia), statusOf(waiting, ana)],
		["child", "child", "scheduled"],
	);
	assert.deepEqual([waiting.totals.child, waiting.totals.reachable], [2, 3]);

	await atSendTime(f.admin, f.db, message.id, resend.transport, keys);
	assert.deepEqual(sentTo(resend).sort(), [ana.email, una.email, hal.email].sort());
	assert.deepEqual(await mailOf(message.id, kid), [
		{ state: "refused", refusal: "child", provider: null, accepted: null },
	]);
	const sent = await shown(message.id);
	assert.equal(sent.item.state, "sending");
	assert.deepEqual([statusOf(sent, kid), statusOf(sent, tia)], ["child", "child"]);
	assert.deepEqual(
		{
			child: sent.totals.child,
			unsubscribed: sent.totals.unsubscribed,
			failed: sent.totals.failed,
			suppressed: sent.totals.suppressed,
			accepted: sent.totals.accepted,
			reachable: sent.totals.reachable,
		},
		{ child: 2, unsubscribed: 0, failed: 0, suppressed: 0, accepted: 3, reachable: 3 },
	);
});

test("AC:CASE-NTF-016-CHILD a direct send now refuses the person marked as a child at once and hands only the others to the email service", async () => {
	const ana = await person("Ana", { as: "adult" });
	const kid = await person("Kid", { as: "child" });
	const resend = resendRecorder(PRODUCTION);
	const saved = await draft([ana, kid]);
	const scheduled = ok(await scheduleAt(saved));
	const report = ok(
		await communicationWriter.sendReviewed(
			f.db,
			owner.actor,
			{ requestKey: key(), expectedRevision: scheduled.revision, input: { communicationId: saved.communicationId } },
			resend.transport,
			keys,
		),
	);
	assert.deepEqual([report.acceptedCount, report.childCount, report.rejectedCount], [1, 1, 0]);
	assert.deepEqual(sentTo(resend), [ana.email]);
	assert.deepEqual(await mailOf(saved.communicationId, kid), [
		{ state: "refused", refusal: "child", provider: null, accepted: null },
	]);
});

test("AC:CASE-NTF-016-CHILD a send or schedule only to people marked as a child is refused with that reason, and no email is queued", async () => {
	const kid = await person("Kid", { as: "child" });
	const tia = await person("Tia", { born: yearsAgo(12) });
	for (const audience of [[kid], [kid, tia]]) {
		const saved = await draft(audience);
		const refused = await scheduleAt(saved);
		assert.equal(refused.status, "refused");
		assert.equal(refused.error.code, "children_only");
		assert.deepEqual(await rows(sql`SELECT id FROM mail WHERE communication_id = ${saved.communicationId}`), []);
		const still = ok(await read("getDraft", { id: saved.communicationId }));
		assert.notEqual(still.state, "scheduled");
	}
});

test("AC:CASE-NTF-016-CHILD a person marked as a child after the email is scheduled gets nothing at the send time, and staff see them left out as a child", async () => {
	const ana = await person("Ana", { as: "adult" });
	const ben = await person("Ben", { as: "adult" });
	const cy = await person("Cy");
	const resend = resendRecorder(PRODUCTION);
	const message = await schedule([ana, ben, cy], resend);
	assert.equal(message.report.childCount, 0);

	await mark(ben, "child");
	await bornOn(cy, yearsAgo(8));
	const before_ = await shown(message.id);
	assert.equal(before_.item.state, "scheduled");
	assert.deepEqual(
		[statusOf(before_, ben), statusOf(before_, cy), statusOf(before_, ana)],
		["child", "child", "scheduled"],
	);
	assert.deepEqual([before_.totals.child, before_.totals.reachable], [2, 1]);

	await atSendTime(f.admin, f.db, message.id, resend.transport, keys);
	assert.deepEqual(sentTo(resend), [ana.email]);
	for (const who of [ben, cy])
		assert.deepEqual(await mailOf(message.id, who), [
			{ state: "refused", refusal: "child", provider: null, accepted: null },
		]);
	const after_ = await shown(message.id);
	assert.deepEqual([statusOf(after_, ben), statusOf(after_, cy)], ["child", "child"]);
	assert.deepEqual([after_.totals.child, after_.totals.failed, after_.totals.unsubscribed], [2, 0, 0]);
});

test("AC:CASE-NTF-016-CHILD when every recipient is marked as a child by the send time, it does not go out and reads Not sent: marked as a child", async () => {
	const ana = await person("Ana", { as: "adult" });
	const resend = resendRecorder(PRODUCTION);
	const message = await schedule([ana], resend);
	await mark(ana, "child");
	let view = await shown(message.id);
	assert.equal(view.item.state, "child");
	assert.equal(hubLabel[view.item.state], "Not sent: marked as a child");
	await atSendTime(f.admin, f.db, message.id, resend.transport, keys);
	assert.deepEqual(resend.take(), [], "nothing reaches the email service");
	view = await shown(message.id);
	assert.equal(view.item.state, "child");
	assert.deepEqual([view.totals.failed, view.totals.cancelled, view.totals.child, view.totals.unknown], [0, 0, 1, 0]);
});

test("AC:CASE-NTF-016-CHILD a person marked as a child when the email was scheduled and marked as an adult before it goes out receives it, unless something else stops them", async () => {
	const ana = await person("Ana", { as: "adult" });
	const kid = await person("Kid", { as: "child" });
	const tia = await person("Tia", { born: yearsAgo(10) });
	const opt = await person("Opt", { as: "child" });
	const resend = resendRecorder(PRODUCTION);
	const message = await schedule([ana, kid, tia, opt], resend);
	assert.deepEqual([message.report.acceptedCount, message.report.childCount], [1, 3]);

	await mark(kid, "adult");
	await bornOn(tia, yearsAgo(30));
	await mark(opt, "adult");
	await f.admin.execute(sql`INSERT INTO person_email_opt_out (plant_id, person_id) VALUES (${church.id}, ${opt.id})`);
	await atSendTime(f.admin, f.db, message.id, resend.transport, keys);
	assert.deepEqual(sentTo(resend).sort(), [ana.email, kid.email, tia.email].sort());
	assert.deepEqual(await mailOf(message.id, opt), [
		{ state: "refused", refusal: "unsubscribed", provider: null, accepted: null },
	]);
	const view = await shown(message.id);
	assert.deepEqual([statusOf(view, kid), statusOf(view, tia)], ["accepted", "accepted"]);
	assert.deepEqual([view.totals.child, view.totals.unsubscribed, view.totals.accepted], [0, 1, 3]);
});

test("AC:CASE-NTF-016-CHILD a person later marked as an adult is not left out of a new email and receives it", async () => {
	const kid = await person("Kid", { as: "child" });
	const ana = await person("Ana", { as: "adult" });
	const first = ok(await read("readAudience", { groups: [], teamIds: [], personIds: [kid.id, ana.id] }));
	assert.equal(first.childExclusions.length, 1);
	await mark(kid, "adult");
	const now = ok(await read("readAudience", { groups: [], teamIds: [], personIds: [kid.id, ana.id] }));
	assert.deepEqual([now.childExclusions, now.eligibleRecipients], [[], 2]);
	const resend = resendRecorder(PRODUCTION);
	const message = await schedule([kid, ana], resend);
	assert.equal(message.report.childCount, 0);
	await atSendTime(f.admin, f.db, message.id, resend.transport, keys);
	assert.deepEqual(sentTo(resend).sort(), [kid.email, ana.email].sort());
});

test("AC:CASE-NTF-016-CHILD marking a person as a child after their email went out does not change or withdraw it", async () => {
	const ana = await person("Ana", { as: "adult" });
	const resend = resendRecorder(PRODUCTION);
	const message = await schedule([ana], resend);
	await atSendTime(f.admin, f.db, message.id, resend.transport, keys);
	assert.deepEqual(sentTo(resend), [ana.email]);
	const went = await mailOf(message.id, ana);
	assert.equal(went[0].state, "accepted");
	resend.take();

	await mark(ana, "child");
	await bornOn(ana, yearsAgo(7));
	await minuteRunner(f.db, resend.transport, keys);
	assert.deepEqual(resend.take(), [], "no cancel or new send");
	assert.deepEqual(await mailOf(message.id, ana), went);
	const view = await shown(message.id);
	assert.equal(statusOf(view, ana), "accepted");
	assert.deepEqual([view.totals.child, view.totals.accepted], [0, 1]);
});
