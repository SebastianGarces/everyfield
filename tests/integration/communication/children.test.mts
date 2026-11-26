import test, { after, before, mock } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { communicationWriter } from "../../../packages/domain/src/communication/index.ts";
import {
	applyMessagesOptOut,
	messagesOptOutToken,
	undoMessagesOptOut,
} from "../../../packages/domain/src/communication/opt-out.ts";
import { hubLabel } from "../../../apps/web/src/features/communication/model.ts";
import { emailsIn, resendRecorder, type Recorder } from "./resend-recorder.mts";
import { atSendTime, minuteRunner } from "./scheduled-support.mts";
import { ok, refused } from "../../support/fixture.mts";
import { MAILING } from "./church-address.mts";
import {
	caseOf,
	deliverAs,
	pinnedDate,
	readAs,
	rowsFrom,
	writeAs,
	type Church,
	type Fixture,
	type ReadOp,
	type Rest,
	type Row,
	type Staff,
	type Value,
	type WriteOp,
} from "./communication-support.mts";

let f: Fixture;
let church: Church;
let owner: Staff;
const keys = {
	encryptionKey: Buffer.alloc(32, 7),
	addressKey: Buffer.alloc(32, 9),
	from: "news@example.test",
	origin: "https://app.example.test",
};
const PRODUCTION = { VERCEL_ENV: "production" };
const DAY = 86_400_000;
const key = () => randomUUID();
const rows = <R extends Row = Row>(query: SQL) => rowsFrom<R>(f, query);
const yearsAgo = (years: number) => {
	const at = new Date();
	return `${at.getUTCFullYear() - years}-06-15`;
};

async function person(
	name: string,
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
type Person = Awaited<ReturnType<typeof person>>;
const mark = (who: Person, as: "adult" | "child") =>
	f.admin.execute(sql`UPDATE person SET adult_classification = ${as} WHERE id = ${who.id}`);
const bornOn = (who: Person, born: string) =>
	f.admin.execute(sql`UPDATE person SET birth_date = ${born}::date WHERE id = ${who.id}`);

const write = <K extends WriteOp>(op: K, input: unknown) => writeAs(f.db, owner.actor, op, input);
async function draft(people: Person[]) {
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
const scheduleAt = (saved: Value<"saveDraft">, at = new Date(Date.now() + 7 * DAY).toISOString()) =>
	write("scheduleReviewed", {
		requestKey: key(),
		expectedRevision: saved.revision,
		input: { communicationId: saved.communicationId, scheduledAt: at },
	});

async function schedule(people: Person[], resend: Recorder, leftOut?: string[]) {
	const saved = await draft(people);
	const scheduled = ok(await scheduleAt(saved));
	const report = ok(
		await communicationWriter.handOffScheduled(
			f.db,
			owner.actor,
			{
				requestKey: key(),
				expectedRevision: scheduled.revision,
				input: { communicationId: saved.communicationId, leftOut },
			},
			resend.transport,
			keys,
		),
	);
	return { id: saved.communicationId, report };
}

async function sendNow(people: Person[], resend: Recorder) {
	const saved = await draft(people);
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
	return { id: saved.communicationId, report };
}
async function block(who: Person) {
	const eventId = randomUUID();
	await f.admin
		.execute(sql`INSERT INTO provider_event(id,event_key,message_id,kind,occurred_at,received_at,payload_hash,safe_payload)
		VALUES(${eventId},${"seed-" + eventId},${"seed-" + eventId},'bounced',clock_timestamp(),clock_timestamp(),'x','{"hard_bounce":true}'::jsonb)`);
	await f.admin.execute(sql`INSERT INTO suppression(address_hash,reason,source_event_id,suppressed_at)
		VALUES(${createHmac("sha256", keys.addressKey).update(who.email).digest("hex")},'hard_bounce',${eventId},clock_timestamp())`);
}

const optOut = (who: Person) =>
	f.admin.execute(sql`INSERT INTO person_email_opt_out (plant_id, person_id) VALUES (${church.id}, ${who.id})`);
const ring = { current: randomBytes(32), previous: [] };
const now = () => new Date();
const clickUnsubscribe = async (who: Person) =>
	ok(
		await applyMessagesOptOut(f.db, ring, now, {
			token: messagesOptOutToken(ring, { plantId: church.id, personId: who.id }),
		}),
	);
const undo = async (done: { undoToken: string | null }) =>
	ok(await undoMessagesOptOut(f.db, ring, now, { token: done.undoToken }));

const explained = ({ totals }: { totals: Value<"getDeliveryTotals"> }) => ({
	child: totals.child,
	guardian: totals.guardian,
	unsubscribed: totals.unsubscribed,
	failed: totals.failed,
	suppressed: totals.suppressed,
});

const sentTo = (resend: Recorder) =>
	resend.requests
		.filter((r) => r.path === "/emails/batch" && r.method === "POST")
		.flatMap((r) => emailsIn(r).map((m) => m.to[0]));
const read = <K extends ReadOp>(op: K, ...rest: Rest<K>) => readAs(f.db, owner.actor, op, ...rest);
async function shown(id: string) {
	const page = ok(await read("listHistory", { limit: 100 }));
	return {
		item: page.items.find((row) => row.id === id)!,
		totals: ok(await read("getDeliveryTotals", { communicationId: id })),
		recipients: ok(await read("listHistoryRecipients", { communicationId: id, limit: 100 })).items,
	};
}
const statusOf = (view: Awaited<ReturnType<typeof shown>>, who: Person) =>
	view.recipients.find((row) => row.personId === who.id)?.deliveryStatus;
const mailOf = async (id: string, who: Person) =>
	rows(sql`SELECT state, refusal, provider_message_id AS provider, accepted_at::text AS accepted
		FROM mail WHERE logical_key = ${"communication/" + id + "/" + who.id}`);

before(async () => {
	f = await fixture({ clock: pinnedDate(caseOf("CASE-NTF-016-CHILD").clock.now) });
	church = await f.workspace("plant", MAILING);
	const a = await f.account();
	await f.seat(a, church, "owner");
	owner = { ...a, actor: await f.actor(a.session) };
});
after(() => f?.close().finally(() => mock.timers.reset()));

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
	assert.equal(went[0]!.state, "accepted");
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

test("AC:CASE-NTF-016-CHILD a person marked as a child whose address is blocked after a bounce reads as marked as a child, not refused, whether sent now or scheduled", async () => {
	for (const mode of ["now", "scheduled"] as const) {
		const ana = await person("Ana", { as: "adult" });
		const bad = await person("Bad", { as: "adult" });
		const kid = await person("Kid", { as: "child" });
		await block(bad);
		await block(kid);
		const resend = resendRecorder(PRODUCTION);
		const message = await (mode === "now" ? sendNow : schedule)([ana, bad, kid], resend);
		assert.equal(message.report.childCount, 1, mode);
		if (mode === "scheduled") await atSendTime(f.admin, f.db, message.id, resend.transport, keys);
		assert.deepEqual(sentTo(resend), [ana.email], mode);
		assert.deepEqual(
			await mailOf(message.id, kid),
			[{ state: "refused", refusal: "child", provider: null, accepted: null }],
			mode,
		);
		assert.deepEqual(
			await mailOf(message.id, bad),
			[{ state: "refused", refusal: null, provider: null, accepted: null }],
			mode,
		);
		const view = await shown(message.id);
		assert.deepEqual(
			[statusOf(view, kid), statusOf(view, bad), statusOf(view, ana)],
			["child", "refused", "accepted"],
			mode,
		);
		assert.deepEqual(
			{ child: view.totals.child, failed: view.totals.failed, suppressed: view.totals.suppressed },
			{ child: 1, failed: 1, suppressed: 1 },
			mode,
		);
	}
});

test("AC:CASE-NTF-016-CHILD a person marked as a child who had already unsubscribed reads as marked as a child, whether sent now or scheduled, while an unsubscribed adult reads as unsubscribed", async () => {
	for (const mode of ["now", "scheduled"] as const) {
		const ana = await person("Ana", { as: "adult" });
		const uri = await person("Uri", { as: "adult" });
		const kid = await person("Kid", { as: "child" });
		await optOut(uri);
		await optOut(kid);
		const resend = resendRecorder(PRODUCTION);
		const message = await (mode === "now" ? sendNow : schedule)([ana, uri, kid], resend);
		const { acceptedCount, childCount, guardianCount, unsubscribedCount, rejectedCount } = message.report;
		assert.deepEqual(
			{ acceptedCount, childCount, guardianCount, unsubscribedCount, rejectedCount },
			{ acceptedCount: 1, childCount: 1, guardianCount: 0, unsubscribedCount: 1, rejectedCount: 0 },
			mode,
		);
		const unsubscribed = [{ state: "refused", refusal: "unsubscribed", provider: null, accepted: null }];
		const totals = { child: 1, guardian: 0, unsubscribed: 1, failed: 0, suppressed: 0 };
		if (mode === "scheduled") {
			assert.deepEqual(await mailOf(message.id, uri), unsubscribed, "refused when scheduled");
			const waiting = await shown(message.id);
			assert.deepEqual([statusOf(waiting, kid), statusOf(waiting, uri)], ["child", "unsubscribed"]);
			assert.deepEqual(explained(waiting), totals);
			await atSendTime(f.admin, f.db, message.id, resend.transport, keys);
		}
		assert.deepEqual(sentTo(resend), [ana.email], mode);
		assert.deepEqual(
			await mailOf(message.id, kid),
			[{ state: "refused", refusal: "child", provider: null, accepted: null }],
			mode,
		);
		assert.deepEqual(await mailOf(message.id, uri), unsubscribed, mode);
		const view = await shown(message.id);
		assert.deepEqual(
			[statusOf(view, kid), statusOf(view, uri), statusOf(view, ana)],
			["child", "unsubscribed", "accepted"],
			mode,
		);
		assert.deepEqual(explained(view), totals, mode);
	}
});

test("AC:CASE-NTF-016-CHILD a person unsubscribed and marked as a child when scheduled, then marked as an adult, gets nothing and reads as unsubscribed", async () => {
	const ana = await person("Ana", { as: "adult" });
	const kid = await person("Kid", { as: "child" });
	await optOut(kid);
	const resend = resendRecorder(PRODUCTION);
	const message = await schedule([ana, kid], resend);
	await mark(kid, "adult");
	await atSendTime(f.admin, f.db, message.id, resend.transport, keys);
	assert.deepEqual(sentTo(resend), [ana.email]);
	assert.deepEqual(await mailOf(message.id, kid), [
		{ state: "refused", refusal: "unsubscribed", provider: null, accepted: null },
	]);
	const view = await shown(message.id);
	assert.equal(statusOf(view, kid), "unsubscribed");
	assert.deepEqual(explained(view), { child: 0, guardian: 0, unsubscribed: 1, failed: 0, suppressed: 0 });
});

test("AC:CASE-NTF-016-CHILD an unsubscribed child named as left out of a scheduled email reads as marked as a child, and the others named stay refused", async () => {
	const ana = await person("Ana", { as: "adult" });
	const out = await person("Out", { as: "adult" });
	const uri = await person("Uri", { as: "adult" });
	const kid = await person("Kid", { as: "child" });
	await optOut(uri);
	await optOut(kid);
	const resend = resendRecorder(PRODUCTION);
	const message = await schedule([ana, out, uri, kid], resend, [out.id, uri.id, kid.id]);
	assert.deepEqual(
		[message.report.childCount, message.report.unsubscribedCount, message.report.rejectedCount],
		[1, 1, 1],
	);
	const statuses = { kid: "child", out: "refused", uri: "unsubscribed" };
	const totals = { child: 1, guardian: 0, unsubscribed: 1, failed: 1, suppressed: 0 };
	const check = async () => {
		const view = await shown(message.id);
		assert.deepEqual({ kid: statusOf(view, kid), out: statusOf(view, out), uri: statusOf(view, uri) }, statuses);
		assert.deepEqual(explained(view), totals);
	};
	await check();
	assert.equal((await mailOf(message.id, out))[0]!.state, "refused", "refused when scheduled");
	await atSendTime(f.admin, f.db, message.id, resend.transport, keys);
	assert.deepEqual(sentTo(resend), [ana.email]);
	assert.deepEqual(await mailOf(message.id, kid), [
		{ state: "refused", refusal: "child", provider: null, accepted: null },
	]);
	assert.deepEqual(await mailOf(message.id, out), [
		{ state: "refused", refusal: null, provider: null, accepted: null },
	]);
	await check();
});

test("AC:CASE-NTF-016-CHILD a person marked as a child who unsubscribes after the email is scheduled, with or without an undo, reads as marked as a child, while an adult and a person not recorded read as unsubscribed at once", async () => {
	for (const undone of [false, true]) {
		const ana = await person("Ana", { as: "adult" });
		const uri = await person("Uri", { as: "adult" });
		const nan = await person("Nan");
		const kid = await person("Kid", { as: "child" });
		const resend = resendRecorder(PRODUCTION);
		const message = await schedule([ana, uri, nan, kid], resend);
		for (const who of [uri, nan, kid]) {
			const done = await clickUnsubscribe(who);
			assert.equal(done.changed, true);
			if (undone) assert.equal((await undo(done)).changed, true);
		}
		const statuses = { kid: "child", uri: "unsubscribed", nan: "unsubscribed" };
		const totals = { child: 1, guardian: 0, unsubscribed: 2, failed: 0, suppressed: 0 };
		const check = async () => {
			for (const who of [uri, nan])
				assert.deepEqual(await mailOf(message.id, who), [
					{ state: "refused", refusal: "unsubscribed", provider: null, accepted: null },
				]);
			const view = await shown(message.id);
			assert.deepEqual({ kid: statusOf(view, kid), uri: statusOf(view, uri), nan: statusOf(view, nan) }, statuses);
			assert.deepEqual(explained(view), totals);
		};
		await check();
		await atSendTime(f.admin, f.db, message.id, resend.transport, keys);
		assert.deepEqual(sentTo(resend), [ana.email]);
		assert.deepEqual(await mailOf(message.id, kid), [
			{ state: "refused", refusal: "child", provider: null, accepted: null },
		]);
		await check();
	}
});

test("AC:CASE-NTF-016-CHILD a person marked as a child who unsubscribes after the email is scheduled and is then marked as an adult gets nothing and reads as unsubscribed, even when the opt-out was undone", async () => {
	for (const undone of [false, true]) {
		const ana = await person("Ana", { as: "adult" });
		const kid = await person("Kid", { as: "child" });
		const resend = resendRecorder(PRODUCTION);
		const message = await schedule([ana, kid], resend);
		const done = await clickUnsubscribe(kid);
		if (undone) assert.equal((await undo(done)).changed, true);
		await mark(kid, "adult");
		await atSendTime(f.admin, f.db, message.id, resend.transport, keys);
		assert.deepEqual(sentTo(resend), [ana.email]);
		assert.deepEqual(await mailOf(message.id, kid), [
			{ state: "refused", refusal: "unsubscribed", provider: null, accepted: null },
		]);
		const view = await shown(message.id);
		assert.equal(statusOf(view, kid), "unsubscribed");
		assert.deepEqual(explained(view), { child: 0, guardian: 0, unsubscribed: 1, failed: 0, suppressed: 0 });
	}
});

test("AC:CASE-NTF-016-CHILD an opt-out that reaches a child through a merge leaves the child marked as a child, and its undo does not bring the email back once they are marked as an adult", async () => {
	for (const grown of [false, true]) {
		const ana = await person("Ana", { as: "adult" });
		const kid = await person("Kid", { as: "child" });
		const old = await person("Kid old");
		const resend = resendRecorder(PRODUCTION);
		const message = await schedule([ana, kid], resend);
		await f.admin.execute(
			sql`UPDATE person SET merged_into_person_id = ${kid.id}, state = 'merged' WHERE id = ${old.id}`,
		);
		const done = await clickUnsubscribe(old);
		const waiting = await shown(message.id);
		assert.equal(statusOf(waiting, kid), "child");
		assert.deepEqual(explained(waiting), { child: 1, guardian: 0, unsubscribed: 0, failed: 0, suppressed: 0 });
		if (grown) {
			assert.equal((await undo(done)).changed, true);
			await mark(kid, "adult");
		}
		await atSendTime(f.admin, f.db, message.id, resend.transport, keys);
		assert.deepEqual(sentTo(resend), [ana.email]);
		assert.deepEqual(await mailOf(message.id, kid), [
			{ state: "refused", refusal: grown ? "unsubscribed" : "child", provider: null, accepted: null },
		]);
	}
});

test("AC:CASE-NTF-016-CHILD an Admin's sends and schedules follow each person's marking up to the send time, with no override", async () => {
	const { result } = caseOf("CASE-NTF-016-CHILD").expected;
	const account = await f.account();
	await f.seat(account, church, "admin");
	const admin = { ...account, actor: await f.actor(account.session) };
	const started = owner;
	owner = admin;
	try {
		const ana = await person("Ana", { as: "adult" });
		const kid = await person("Kid", { as: "child" });
		const tia = await person("Tia", { born: yearsAgo(9) });
		const una = await person("Una");
		const hal = await person("Hal", { as: "adult", householdChild: true });
		const others = [ana, una, hal];
		const reasons = ok(
			await read("readAudience", { groups: [], teamIds: [], personIds: [ana, kid, tia, una, hal].map((p) => p.id) }),
		).childExclusions.map((p) => p.id);
		for (const how of [sendNow, schedule]) {
			const resend = resendRecorder(PRODUCTION);
			const message = await how([ana, kid, tia, una, hal], resend);
			await atSendTime(f.admin, f.db, message.id, resend.transport, keys);
			const view = await shown(message.id);
			const to = sentTo(resend);
			assert.equal(
				reasons.join() === [kid.id, tia.id].join() &&
					statusOf(view, kid) === "child" &&
					statusOf(view, tia) === "child",
				result.child_left_out_with_reason,
			);
			assert.equal(
				others.every((p) => to.includes(p.email)) && to.length === others.length,
				result.other_recipients_sent,
			);
			assert.equal(
				[una, hal].some((p) => !to.includes(p.email)),
				result.not_recorded_or_household_child_blocked,
			);
			assert.deepEqual(explained(view), { child: 2, guardian: 0, unsubscribed: 0, failed: 0, suppressed: 0 });
			assert.equal(view.totals.child === 2 && message.report.childCount === 2, result.child_counted_separately);
		}

		const alone = await draft([kid, tia]);
		const refusedAlone = await scheduleAt(alone);
		const queued = await rows(sql`SELECT id FROM mail WHERE communication_id = ${alone.communicationId}`);
		assert.equal(
			refusedAlone.status === "refused" && refusedAlone.error.code === "children_only" && queued.length === 0,
			result.only_children_refused_nothing_queued,
		);

		const ben = await person("Ben", { as: "adult" });
		const ida = await person("Ida", { as: "child" });
		const changed = resendRecorder(PRODUCTION);
		const waiting = await schedule([ana, ben, ida], changed);
		await mark(ben, "child");
		await mark(ida, "adult");
		await atSendTime(f.admin, f.db, waiting.id, changed.transport, keys);
		assert.equal(!sentTo(changed).includes(ben.email), result.marked_child_before_send_time_skipped);
		assert.equal(sentTo(changed).includes(ida.email), result.marked_adult_before_send_time_sent);
		const next = resendRecorder(PRODUCTION);
		const fresh = await sendNow([ida, ana], next);
		assert.equal(
			sentTo(next).includes(ida.email) && fresh.report.childCount === 0,
			result.marked_adult_included_in_new_send,
		);

		const went = async () => [await mailOf(waiting.id, ana), statusOf(await shown(waiting.id), ana)];
		const before_ = await went();
		changed.take();
		await mark(ana, "child");
		await minuteRunner(f.db, changed.transport, keys);
		assert.deepEqual(await went(), before_);
		assert.equal(changed.take().length === 0, result.sent_email_unchanged_by_later_marking);

		const forced = await draft([kid, una]);
		const planned = ok(await scheduleAt(forced));
		const port = resendRecorder(PRODUCTION);
		for (const override of [{ override: true }, { includeChildren: [kid.id] }])
			for (const op of ["sendReviewed", "handOffScheduled"] as const)
				assert.equal(
					refused(
						await deliverAs(
							f.db,
							admin.actor,
							op,
							{
								requestKey: key(),
								expectedRevision: planned.revision,
								input: { communicationId: forced.communicationId, ...override },
							},
							port.transport,
							keys,
						),
						"invalid_input",
					).code,
					"invalid_input",
				);
		ok(
			await deliverAs(
				f.db,
				admin.actor,
				"sendReviewed",
				{
					requestKey: key(),
					expectedRevision: planned.revision,
					input: { communicationId: forced.communicationId, leftOut: [] },
				},
				port.transport,
				keys,
			),
		);
		const again = ok(
			await write("executeResend", {
				requestKey: key(),
				input: { communicationId: forced.communicationId, selection: "proven_failed" },
			}),
		);
		assert.deepEqual(again.eligibleIds, [kid.id]);
		const retry = await scheduleAt({ ...forced, communicationId: again.communicationId, revision: forced.revision });
		assert.equal(
			retry.status === "refused" && retry.error.code,
			"children_only",
			"a retry of the left-out child is refused too",
		);
		assert.equal(sentTo(port).includes(kid.email), result.staff_override);
		assert.deepEqual(sentTo(port), [una.email]);
	} finally {
		owner = started;
	}
});
