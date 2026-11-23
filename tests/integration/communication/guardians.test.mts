import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { communicationWriter, withCommunicationWrite } from "../../../packages/domain/src/communication/index.ts";
import { resendRecorder } from "./resend-recorder.mts";
import { atSendTime, minuteRunner } from "./scheduled-support.mts";
import { ok } from "../../support/fixture.mts";
import { MAILING } from "./church-address.mts";
import { personFields, withPeopleWrite } from "../../../packages/domain/src/people/index.ts";

let f, church, owner;
const origin = "https://app.example.test";
const keys = {
	encryptionKey: Buffer.alloc(32, 7),
	addressKey: Buffer.alloc(32, 9),
	from: "news@example.test",
	origin,
	optOutKeys: { current: randomBytes(32), previous: [] },
};
const PRODUCTION = { VERCEL_ENV: "production" };
const DAY = 86_400_000;
const key = () => randomUUID();
const rows = async (query) => (await f.admin.execute(query)).rows;

type Who = { id: string; name: string; email: string | null };
async function person(name: string, as: "adult" | "child" | "unknown", household: string | null, email = true) {
	const id = randomUUID();
	const address = email ? `${name.toLowerCase().replace(/\s+/g, ".")}-${key().slice(0, 6)}@example.test` : null;
	await f.admin
		.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
		household_id,household_role,commitment_state,pipeline_position,state,created_at)
		VALUES(${id},${church.id},${church.id},${name},${address},'other','prospect',${as},${household}::uuid,
		${household ? "other" : null},'unknown',0,'live',clock_timestamp())`);
	return { id, name, email: address } satisfies Who;
}
async function household(name: string) {
	const id = randomUUID();
	await f.admin.execute(sql`INSERT INTO household(id,plant_id,name) VALUES(${id},${church.id},${name})`);
	return id;
}
const link = (child: Who, guardian: Who, home: string) =>
	f.admin.execute(sql`INSERT INTO guardian_contact(plant_id,child_person_id,guardian_person_id,household_id)
		VALUES(${church.id},${child.id},${guardian.id},${home})`);
const unlink = (child: Who, guardian: Who) =>
	f.admin.execute(
		sql`DELETE FROM guardian_contact WHERE child_person_id=${child.id} AND guardian_person_id=${guardian.id}`,
	);
const optOut = (who: Who) =>
	f.admin.execute(sql`INSERT INTO person_email_opt_out (plant_id, person_id) VALUES (${church.id}, ${who.id})`);
const set = (who: Who, change: ReturnType<typeof sql>) =>
	f.admin.execute(sql`UPDATE person SET ${change} WHERE id = ${who.id}`);

const write = (op, input) =>
	withCommunicationWrite(f.db, owner.actor, (tx, ctx) => communicationWriter[op](tx, ctx, input));
const read = (op, input, extra?) => f.db.transaction((tx) => communicationWriter[op](tx, owner.actor, input, extra));
const audienceOf = async (people: Who[]) =>
	ok(await read("readAudience", { groups: [], teamIds: [], personIds: people.map((p) => p.id) }));

async function draft(people: Who[], extra: Record<string, unknown> = {}, body = "<p>Hello {{name}}.</p>") {
	return ok(
		await write("saveDraft", {
			requestKey: key(),
			input: {
				subject: "Next Sunday",
				bodyHtml: body,
				audience: { groups: [], teamIds: [], personIds: people.map((p) => p.id) },
				...extra,
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
async function handOff(people: Who[], mode: "now" | "scheduled", extra = {}, body?: string) {
	const resend = resendRecorder(PRODUCTION);
	const saved = await draft(people, extra, body);
	const scheduled = ok(await scheduleAt(saved));
	const report = ok(
		await communicationWriter[mode === "now" ? "sendReviewed" : "handOffScheduled"](
			f.db,
			owner.actor,
			{ requestKey: key(), expectedRevision: scheduled.revision, input: { communicationId: saved.communicationId } },
			resend.transport,
			keys,
		),
	);
	return { id: saved.communicationId, report, resend };
}
const emails = (resend) =>
	resend.requests.filter((r) => r.path === "/emails/batch" && r.method === "POST").flatMap((r) => r.body);
const sentTo = (resend) => emails(resend).map((m) => m.to[0]);
const emailFor = (resend, who: Who) => emails(resend).find((m) => m.to[0] === who.email);
const mailOf = async (id: string, who: Who) =>
	rows(sql`SELECT m.state, m.refusal, (SELECT array_agg(g.recipient_person_id::text ORDER BY g.recipient_person_id)
		FROM mail g WHERE g.id = ANY(m.guardian_mail_ids)) AS guardians
		FROM mail m WHERE m.logical_key = ${"communication/" + id + "/" + who.id}`);
const copiesPerAddress = async (id: string) =>
	rows(sql`SELECT m.recipient_person_id::text AS person, count(*)::int AS n FROM mail m
		WHERE m.communication_id = ${id} AND m.frozen_payload IS NOT NULL GROUP BY 1 ORDER BY 1`);
async function shown(id: string) {
	const detail = ok(await read("getDetail", { id }));
	return {
		totals: ok(await read("getDeliveryTotals", { communicationId: id })),
		recipients: detail.recipients,
	};
}
const rowOf = (view, who: Who) => view.recipients.find((row) => row.personId === who.id);

before(async () => {
	f = await fixture();
	church = await f.workspace("plant", MAILING);
	const a = await f.account();
	await f.seat(a, church, "owner");
	owner = { ...a, actor: await f.actor(a.session) };
});
after(() => f?.close());

test("AC:CASE-NTF-016-GUARDIAN a group email goes to each child's parent or guardian contact instead of the child, one copy per adult", async () => {
	const home = await household("Lopez household");
	const ana = await person("Ana Cruz", "adult", null);
	const maria = await person("Maria Lopez", "adult", home);
	const pete = await person("Pete Lopez", "adult", home);
	const ava = await person("Ava Lopez", "child", home, false);
	const ben = await person("Ben Lopez", "child", home);
	const cal = await person("Cal Ortiz", "child", null);
	await link(ava, maria, home);
	await link(ben, maria, home);
	await link(ben, pete, home);
	const audience = [ana, maria, ava, ben, cal];

	const resolved = await audienceOf(audience);
	assert.deepEqual(resolved.guardianRoutes, [
		{ id: ava.id, displayName: "Ava Lopez", guardians: [{ id: maria.id, displayName: "Maria Lopez" }] },
		{
			id: ben.id,
			displayName: "Ben Lopez",
			guardians: [
				{ id: maria.id, displayName: "Maria Lopez" },
				{ id: pete.id, displayName: "Pete Lopez" },
			],
		},
	]);
	assert.deepEqual(resolved.childExclusions, [{ id: cal.id, displayName: "Cal Ortiz" }]);
	assert.equal(resolved.eligibleRecipients, 3);
	assert.deepEqual(resolved.eligibleEmails, [ana.email, maria.email, pete.email].sort());
	assert.deepEqual(
		resolved.recipients.map((r) => [r.displayName, r.guardianOf]),
		[
			["Ana Cruz", []],
			["Maria Lopez", []],
			["Pete Lopez", ["Ben Lopez"]],
		],
	);

	const sent = await handOff(audience, "now");
	assert.deepEqual(
		[sent.report.acceptedCount, sent.report.guardianCount, sent.report.childCount, sent.report.rejectedCount],
		[3, 2, 1, 0],
	);
	assert.deepEqual(sentTo(sent.resend).sort(), [ana.email, maria.email, pete.email].sort());
	assert.deepEqual(
		await copiesPerAddress(sent.id),
		[ana, maria, pete].map((p) => ({ person: p.id, n: 1 })).sort((a, b) => a.person.localeCompare(b.person)),
	);
	assert.deepEqual(await mailOf(sent.id, ava), [{ state: "refused", refusal: "guardian", guardians: [maria.id] }]);
	assert.deepEqual(await mailOf(sent.id, ben), [
		{ state: "refused", refusal: "guardian", guardians: [maria.id, pete.id].sort() },
	]);
	assert.deepEqual(await mailOf(sent.id, cal), [{ state: "refused", refusal: "child", guardians: null }]);

	const own = emailFor(sent.resend, maria);
	assert.ok(own.html.includes("Hello Maria Lopez."));
	assert.equal(own.html.includes("parent or guardian"), false, "an adult in the audience gets their own copy");
	const view = await shown(sent.id);
	assert.deepEqual(
		[rowOf(view, ava), rowOf(view, ben), rowOf(view, cal)].map((row) => [row.deliveryStatus, row.sentTo]),
		[
			["guardian", "Maria Lopez"],
			["guardian", "Maria Lopez, Pete Lopez"],
			["child", null],
		],
	);
	assert.deepEqual([view.totals.guardian, view.totals.child, view.totals.reachable], [2, 1, 3]);
	assert.equal(view.totals.selected, audience.length, "Pete's copy as a guardian is not a selected person");
});

test("the recipient search names a child's usable parent or guardian contacts, so a child with no email can be picked", async () => {
	const home = await household("Quinn household");
	const jo = await person("Jo Quinn", "adult", home);
	const kay = await person("Kay Quinn", "adult", home, false);
	const zed = await person("Zed Quinn", "child", home, false);
	const lee = await person("Lee Quinn", "child", home, false);
	await link(zed, jo, home);
	await link(zed, kay, home);
	await link(lee, kay, home);
	const found = ok(await read("readRecipients", { query: "quinn" })).people;
	assert.deepEqual(
		found.map((p) => [p.displayName, p.email, p.guardians]),
		[
			["Jo Quinn", jo.email, []],
			["Kay Quinn", null, []],
			["Lee Quinn", null, []],
			["Zed Quinn", null, ["Jo Quinn"]],
		],
	);
});

test("AC:CASE-NTF-016-GUARDIAN the copy sent only as a parent or guardian names the child, greets the adult, has no RSVP link and has the adult's own Unsubscribe link", async () => {
	const home = await household("Reyes household");
	const rosa = await person("Rosa Reyes", "adult", home);
	const tim = await person("Tim Reyes", "child", home);
	await link(tim, rosa, home);
	const meetingId = randomUUID();
	const startsAt = new Date(Date.now() + 3 * DAY);
	await f.admin
		.execute(sql`INSERT INTO meeting(id,plant_id,type,title,team_id,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision)
		VALUES(${meetingId},${church.id},'orientation',null,null,${startsAt.toISOString().slice(0, 10)},'18:00','America/Chicago',${startsAt.toISOString()},'1','planning',1)`);
	await f.admin.execute(sql`INSERT INTO participation(id,plant_id,meeting_id,person_id,roster_member,rsvp,presence)
		VALUES(${randomUUID()},${church.id},${meetingId},${tim.id},false,'pending','absent')`);

	const scheduled = ok(await scheduleAt(await draft([tim], { meetingId }, "<p>Hi {{name}},</p><p>{{rsvp_link}}</p>")));
	assert.equal(scheduled.state, "scheduled", "a send only to a child with a contact is not refused");
	const sent = await handOff([tim], "now", { meetingId }, "<p>Hi {{name}},</p><p>{{rsvp_link}}</p>");
	assert.deepEqual(sentTo(sent.resend), [rosa.email]);
	const email = emailFor(sent.resend, rosa);
	assert.ok(email.html.includes("as the parent or guardian of Tim Reyes."), email.html);
	assert.ok(
		email.text.startsWith("We are sending you this email as the parent or guardian of Tim Reyes.\n\nHi Rosa Reyes,"),
	);
	assert.ok(email.html.includes("Hi Rosa Reyes,"));
	assert.equal(/\/rsvp\//.test(email.html) || /\/rsvp\//.test(email.text), false, "no RSVP link for the child");
	const unsubscribe = email.html.match(/href="(https:\/\/app\.example\.test\/unsubscribe\/([A-Za-z0-9_-]+))"/);
	assert.ok(unsubscribe);
	assert.deepEqual(email.headers, {
		"List-Unsubscribe": `<${unsubscribe[1]}/one-click>`,
		"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
	});
	const [token] = await rows(
		sql`SELECT rsvp_token_hash FROM participation WHERE meeting_id = ${meetingId} AND person_id = ${tim.id}`,
	);
	assert.equal(token.rsvp_token_hash, null, "no RSVP link is minted for the child");
	assert.deepEqual(await mailOf(sent.id, tim), [{ state: "refused", refusal: "guardian", guardians: [rosa.id] }]);
});

test("AC:CASE-NTF-016-GUARDIAN a child whose contacts cannot be emailed is left out as a child, and a send to only such children is refused", async () => {
	const home = await household("Stone household");
	const other = await household("Other household");
	const noMail = await person("Nia Stone", "adult", home, false);
	const unsub = await person("Uri Stone", "adult", home);
	const retired = await person("Rex Stone", "adult", home);
	const moved = await person("Mia Stone", "adult", home);
	const nowChild = await person("Lu Stone", "adult", home);
	const kids = [];
	for (const [i, guardian] of [noMail, unsub, retired, moved, nowChild].entries()) {
		const kid = await person(`Kid${i} Stone`, "child", home);
		await link(kid, guardian, home);
		kids.push(kid);
	}
	const bare = await person("Zed Stone", "child", home);
	kids.push(bare);
	await optOut(unsub);
	await set(retired, sql`state = 'retired'`);
	await set(moved, sql`household_id = ${other}::uuid`);
	await set(nowChild, sql`adult_classification = 'child'`);

	const resolved = await audienceOf(kids);
	assert.deepEqual(resolved.guardianRoutes, []);
	assert.deepEqual(resolved.childExclusions.map((p) => p.id).sort(), kids.map((k) => k.id).sort());
	assert.equal(resolved.eligibleRecipients, 0);
	const refused = await scheduleAt(await draft(kids));
	assert.equal(refused.status, "refused");
	assert.equal(refused.error.code, "children_only");

	const ana = await person("Ana Stone", "adult", null);
	const sent = await handOff([ana, ...kids], "now");
	assert.deepEqual(sentTo(sent.resend), [ana.email]);
	assert.deepEqual([sent.report.childCount, sent.report.guardianCount], [kids.length, 0]);
});

test("AC:CASE-NTF-016-GUARDIAN a scheduled email follows the contacts as they are when it goes out", async () => {
	const home = await household("Ng household");
	const other = await household("Elsewhere");
	const amy = await person("Amy Ng", "adult", home);
	const bob = await person("Bob Ng", "adult", home);
	const cat = await person("Cat Ng", "adult", home);
	const dee = await person("Dee Ng", "adult", home);
	const eli = await person("Eli Ng", "adult", home);
	const kidAdded = await person("Kim Ng", "child", home, false);
	const kidRemoved = await person("Lee Ng", "child", home);
	const kidMoved = await person("Max Ng", "child", home);
	const kidUnsub = await person("Ned Ng", "child", home);
	const kidMarked = await person("Oli Ng", "child", home);
	await link(kidRemoved, bob, home);
	await link(kidMoved, cat, home);
	await link(kidUnsub, dee, home);
	await link(kidMarked, eli, home);
	const kids = [kidAdded, kidRemoved, kidMoved, kidUnsub, kidMarked];
	const ana = await person("Ana Ng", "adult", null);

	const message = await handOff([ana, ...kids], "scheduled");
	assert.deepEqual([message.report.guardianCount, message.report.childCount], [4, 1]);
	const waiting = await shown(message.id);
	assert.deepEqual(
		[
			rowOf(waiting, kidAdded).deliveryStatus,
			rowOf(waiting, kidRemoved).deliveryStatus,
			rowOf(waiting, kidRemoved).sentTo,
		],
		["child", "guardian", "Bob Ng"],
	);
	assert.deepEqual([waiting.totals.reachable, waiting.totals.guardian, waiting.totals.child], [5, 4, 1]);

	await link(kidAdded, amy, home);
	await unlink(kidRemoved, bob);
	await set(cat, sql`household_id = ${other}::uuid`);
	await optOut(dee);
	await set(eli, sql`adult_classification = 'child'`);

	await atSendTime(f.admin, f.db, message.id, message.resend.transport, keys);
	assert.deepEqual(sentTo(message.resend).sort(), [ana.email, amy.email].sort());
	const added = emailFor(message.resend, amy);
	assert.ok(added.html.includes("as the parent or guardian of Kim Ng."));
	assert.deepEqual(await mailOf(message.id, kidAdded), [
		{ state: "refused", refusal: "guardian", guardians: [amy.id] },
	]);
	for (const kid of [kidRemoved, kidMoved, kidUnsub, kidMarked])
		assert.deepEqual(await mailOf(message.id, kid), [{ state: "refused", refusal: "child", guardians: null }]);
	const after_ = await shown(message.id);
	assert.deepEqual([after_.totals.guardian, after_.totals.child], [1, 4]);
	assert.equal(after_.totals.selected, kids.length + 1, "Amy's copy as a guardian is not a selected person");
	assert.deepEqual([rowOf(after_, kidAdded).deliveryStatus, rowOf(after_, kidAdded).sentTo], ["guardian", "Amy Ng"]);
});

test("AC:CASE-NTF-016-GUARDIAN an adult who left the child's household no longer gets the child's email", async () => {
	const home = await household("Park household");
	const jo = await person("Jo Park", "adult", home);
	const kit = await person("Kit Park", "child", home);
	await link(kit, jo, home);
	const [{ revision }] = await rows(sql`SELECT revision::text AS revision FROM person WHERE id = ${jo.id}`);
	ok(
		await withPeopleWrite(f.db, owner.actor, (t, c) =>
			personFields.removeFromHousehold(t, c, {
				requestKey: key(),
				expectedRevision: revision,
				input: { personId: jo.id },
			}),
		),
	);
	assert.deepEqual(await rows(sql`SELECT id FROM guardian_contact WHERE child_person_id = ${kit.id}`), []);
	const ana = await person("Ana Park", "adult", null);
	const sent = await handOff([ana, kit], "now");
	assert.deepEqual(sentTo(sent.resend), [ana.email]);
	assert.deepEqual(await mailOf(sent.id, kit), [{ state: "refused", refusal: "child", guardians: null }]);
});

test("AC:CASE-NTF-016-GUARDIAN removing the contact or changing a marking after the email went to the adult does not change it", async () => {
	const home = await household("Quinn household");
	const val = await person("Val Quinn", "adult", home);
	const wes = await person("Wes Quinn", "child", home);
	await link(wes, val, home);
	const message = await handOff([wes], "scheduled");
	await atSendTime(f.admin, f.db, message.id, message.resend.transport, keys);
	assert.deepEqual(sentTo(message.resend), [val.email]);
	const went = await rows(sql`SELECT id, state, refusal, guardian_mail_ids::text[] AS ids, provider_message_id
		FROM mail WHERE communication_id = ${message.id} ORDER BY id`);
	message.resend.take();

	await unlink(wes, val);
	await set(wes, sql`adult_classification = 'adult'`);
	await set(val, sql`adult_classification = 'child'`);
	await minuteRunner(f.db, message.resend.transport, keys);
	assert.deepEqual(message.resend.take(), [], "no cancel or new send");
	assert.deepEqual(
		await rows(sql`SELECT id, state, refusal, guardian_mail_ids::text[] AS ids, provider_message_id
			FROM mail WHERE communication_id = ${message.id} ORDER BY id`),
		went,
	);
	const view = await shown(message.id);
	assert.deepEqual([rowOf(view, wes).deliveryStatus, rowOf(view, wes).sentTo], ["guardian", "Val Quinn"]);
	assert.equal(rowOf(view, val).deliveryStatus, "accepted");
});
