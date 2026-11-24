import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { ok } from "../../support/fixture.mts";
import { communicationWriter } from "../../../packages/domain/src/communication/index.ts";
import {
	applyMessagesOptOut,
	messagesOptOutToken,
	undoMessagesOptOut,
} from "../../../packages/domain/src/communication/opt-out.ts";
import { createNotificationProducer } from "../../../packages/domain/src/notifications/index.ts";
import { hubLabel } from "../../../apps/web/src/features/communication/model.ts";
import { resendRecorder } from "./resend-recorder.mts";
import { atSendTime, heldAtProvider } from "./scheduled-support.mts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { MAILING } from "./church-address.mts";
import {
	firstRow,
	rowsFrom,
	writeAs,
	type Church,
	type Fixture,
	type Row,
	type Staff,
	type WriteOp,
} from "./communication-support.mts";

let f: Fixture;
const ring = { current: randomBytes(32), previous: [] };
const keys = {
	encryptionKey: Buffer.alloc(32, 7),
	addressKey: Buffer.alloc(32, 9),
	from: "news@example.test",
	origin: "https://app.example.test",
	optOutKeys: ring,
};
const notifications = createNotificationProducer({ optOutKey: randomBytes(32) });
const PRODUCTION = { VERCEL_ENV: "production" };
const ZONE = "America/Chicago";
const key = () => randomUUID();
const now = () => new Date();
const rows = <R extends Row = Row>(query: SQL) => rowsFrom<R>(f, query);

async function church() {
	const w = await f.workspace("plant", MAILING);
	await f.admin.execute(sql`UPDATE plant SET timezone = ${ZONE} WHERE id = ${w.id}::uuid`);
	return w;
}
async function staff(w: Church, role: "owner" | "admin" | "member" = "owner") {
	const a = await f.account();
	const seatId = await f.seat(a, w, role);
	return { ...a, seatId, actor: await f.actor(a.session) };
}
async function person(w: Church, name: string) {
	const id = randomUUID();
	const email = `${name.toLowerCase()}-${key().slice(0, 8)}@example.test`;
	await f.admin
		.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at)
		VALUES(${id},${w.id},${w.id},${name},${email},'other','prospect','unknown','unknown',0,'live',clock_timestamp())`);
	return { id, email, name, plantId: w.id };
}

type Person = Awaited<ReturnType<typeof person>>;
function nextWeek() {
	const at = new Date(Date.now() + 7 * 86_400_000);
	at.setUTCHours(15, 30, 0, 0);
	return at.toISOString();
}
const churchTime = (iso: string) =>
	new Intl.DateTimeFormat("en-US", {
		timeZone: ZONE,
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	})
		.format(new Date(iso))
		.replace(/ /g, " ");

const write = <K extends WriteOp>(who: Staff, op: K, input: unknown) => writeAs(f.db, who.actor, op, input);
async function draft(who: Staff, people: Person[], subject = "Next Sunday") {
	return ok(
		await write(who, "saveDraft", {
			requestKey: key(),
			input: {
				subject,
				bodyHtml: "<p>Hello {{name}}.</p>",
				audience: { groups: [], teamIds: [], personIds: people.map((p) => p.id) },
			},
		}),
	);
}
async function schedule(who: Staff, people: Person[], { subject = "Next Sunday", at = nextWeek() } = {}) {
	const resend = resendRecorder(PRODUCTION);
	const saved = await draft(who, people, subject);
	const scheduled = ok(
		await write(who, "scheduleReviewed", {
			requestKey: key(),
			expectedRevision: saved.revision,
			input: { communicationId: saved.communicationId, scheduledAt: at },
		}),
	);
	ok(
		await communicationWriter.handOffScheduled(
			f.db,
			who.actor,
			{ requestKey: key(), expectedRevision: scheduled.revision, input: { communicationId: saved.communicationId } },
			resend.transport,
			keys,
		),
	);
	return { id: saved.communicationId, at, resend };
}

const unsubscribe = (who: Person) =>
	applyMessagesOptOut(f.db, ring, now, {
		token: messagesOptOutToken(ring, { plantId: who.plantId, personId: who.id }),
	});

const feed = async (who: Staff) => ok(await notifications.readFeed(f.db, who.actor, {})).items;
const bell = async (who: Staff) => ok(await notifications.readUnreadCount(f.db, who.actor, {})).count;
const ours = async (who: Staff) => (await feed(who)).filter((item) => item.category === "scheduled_email_unsubscribe");
const stored = (who: Staff) =>
	rows(sql`SELECT n.source_record_id AS email, n.tenant_id AS church, n.title, n.safe_body AS body
		FROM notice n WHERE n.recipient_id = ${who.id}::uuid AND split_part(n.logical_key, '/', 2) = 'scheduled_email_unsubscribe'
		ORDER BY n.created_at`);

before(async () => {
	f = await fixture();
});
after(() => f?.close());

test("AC:CASE-NTF-016 Ana unsubscribes and Sam, who scheduled the email, has one new notice in the bell and the feed as the answer returns", async () => {
	const w = await church();
	const sam = await staff(w);
	const ana = await person(w, "Ana Ruiz");
	const ben = await person(w, "Ben Ode");
	const email = await schedule(sam, [ana, ben]);
	const bellBefore = await bell(sam);
	const jobsBefore = (await rows(sql`SELECT count(*)::int AS n FROM job`))[0]!.n;

	const answer = ok(await unsubscribe(ana));
	assert.equal(answer.changed, true);

	assert.equal((await rows(sql`SELECT count(*)::int AS n FROM job`))[0]!.n, jobsBefore, "no job was queued");
	assert.equal(await bell(sam), bellBefore + 1);
	const newest = firstRow(await feed(sam));
	const expected = {
		category: "scheduled_email_unsubscribe",
		title: "Ana Ruiz unsubscribed from a scheduled email",
		body: `Ana Ruiz will not get “Next Sunday”, scheduled for ${churchTime(email.at)}.`,
		read: false,
	};
	assert.deepEqual({ category: newest.category, title: newest.title, body: newest.body, read: newest.read }, expected);
	assert.match(expected.body, /Next Sunday”, scheduled for [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:30 (AM|PM)\.$/);
	assert.equal(JSON.stringify(newest).includes(ana.email), false, "the notice never shows Ana's address");
	assert.deepEqual(await stored(sam), [{ email: email.id, church: w.id, title: expected.title, body: expected.body }]);
	assert.deepEqual(newest.subject, { kind: "communication", id: email.id });
});

test("AC:CASE-NTF-016 a refused opt-out, from a forged or tampered token, writes no notice", async () => {
	const w = await church();
	const sam = await staff(w);
	const ana = await person(w, "Ana");
	const email = await schedule(sam, [ana]);
	const real = messagesOptOutToken(ring, { plantId: w.id, personId: ana.id });
	const middle = real.length >> 1;
	const tampered = real.slice(0, middle) + (real[middle] === "A" ? "B" : "A") + real.slice(middle + 1);
	assert.notDeepEqual(Buffer.from(tampered, "base64url"), Buffer.from(real, "base64url"));
	const forged = messagesOptOutToken({ current: randomBytes(32), previous: [] }, { plantId: w.id, personId: ana.id });
	for (const token of [tampered, forged]) {
		const outcome = await applyMessagesOptOut(f.db, ring, now, { token });
		assert.equal(outcome.status, "refused");
	}
	assert.deepEqual(await stored(sam), []);
	assert.deepEqual(await ours(sam), []);
	assert.equal(
		(
			await rows(sql`SELECT count(*)::int AS n FROM mail WHERE logical_key LIKE ${"communication/" + email.id + "/%"}
			AND state = 'scheduled'`)
		)[0]!.n,
		1,
		"the email still waits for Ana",
	);
});

test("AC:CASE-NTF-016 when Ana was the only recipient the notice says the email will not go out, as its Not sent: unsubscribed state says", async () => {
	const w = await church();
	const sam = await staff(w);
	const ana = await person(w, "Ana Ruiz");
	const email = await schedule(sam, [ana], { subject: "Picnic" });
	ok(await unsubscribe(ana));
	const newest = firstRow(await ours(sam));
	assert.deepEqual(
		{ title: newest.title, body: newest.body },
		{
			title: "Not sent: Ana Ruiz unsubscribed",
			body: `“Picnic”, scheduled for ${churchTime(email.at)}, will not go out because its only recipient unsubscribed from this church's email.`,
		},
	);
	const history = ok(
		await gatedTransaction(f.db, (tx) => communicationWriter.listHistory(tx, sam.actor, { limit: 100 })),
	);
	const state = history.items.find((row) => row.id === email.id)!.state;
	assert.equal(hubLabel[state], "Not sent: unsubscribed", "the email itself reads the same");
});

test("AC:CASE-NTF-016 an email whose other recipient already unsubscribed counts as all-unsubscribed", async () => {
	const w = await church();
	const sam = await staff(w);
	const ana = await person(w, "Ana");
	const ben = await person(w, "Ben");
	await schedule(sam, [ana, ben], { subject: "Picnic" });
	ok(await unsubscribe(ben));
	ok(await unsubscribe(ana));
	const titles = (await ours(sam)).map((item) => item.title);
	assert.deepEqual(titles, ["Not sent: Ana unsubscribed", "Ben unsubscribed from a scheduled email"]);
});

test("AC:CASE-NTF-016 Ana is on Sam's and Lee's scheduled emails; each scheduler gets one notice, for their own email only", async () => {
	const w = await church();
	const sam = await staff(w);
	const lee = await staff(w, "admin");
	const ana = await person(w, "Ana");
	const ben = await person(w, "Ben");
	const bySam = await schedule(sam, [ana, ben], { subject: "From Sam" });
	const byLee = await schedule(lee, [ana, ben], { subject: "From Lee" });
	ok(await unsubscribe(ana));
	assert.deepEqual(
		(await stored(sam)).map((row) => row.email),
		[bySam.id],
	);
	assert.deepEqual(
		(await stored(lee)).map((row) => row.email),
		[byLee.id],
	);
	assert.deepEqual(
		(await ours(sam)).map((item) => item.body),
		[`Ana will not get “From Sam”, scheduled for ${churchTime(bySam.at)}.`],
	);
	assert.deepEqual(
		(await ours(lee)).map((item) => item.body),
		[`Ana will not get “From Lee”, scheduled for ${churchTime(byLee.at)}.`],
	);
});

test("AC:CASE-NTF-016 a second click, a retried one-click POST, and an undo then a new unsubscribe still leave one notice per email", async () => {
	const w = await church();
	const sam = await staff(w);
	const ana = await person(w, "Ana");
	const ben = await person(w, "Ben");
	const first = await schedule(sam, [ana, ben], { subject: "One" });
	const second = await schedule(sam, [ana, ben], { subject: "Two" });
	const done = ok(await unsubscribe(ana));
	const again = await Promise.all([unsubscribe(ana), unsubscribe(ana)]);
	assert.deepEqual(
		again.map((r) => ok(r).changed),
		[false, false],
	);
	assert.deepEqual(ok(await undoMessagesOptOut(f.db, ring, now, { token: done.undoToken })).changed, true);
	assert.equal(ok(await unsubscribe(ana)).changed, true, "a new opt-out is recorded");
	assert.deepEqual((await stored(sam)).map((row) => row.email).sort(), [first.id, second.id].sort());
	assert.equal((await ours(sam)).length, 2);
});

test("AC:CASE-NTF-016 Ana's opt-out from church A tells no one in church B, and church A's notice never shows in a church B seat", async () => {
	const a = await church();
	const b = await church();
	const sam = await staff(a);
	const bea = await staff(b);
	const inA = await person(a, "Ana");
	const inB = await person(b, "Ana");
	const ben = await person(a, "Ben");
	const benB = await person(b, "Ben");
	const fromA = await schedule(sam, [inA, ben]);
	const fromB = await schedule(bea, [inB, benB]);
	ok(await unsubscribe(inA));

	assert.deepEqual(
		(await stored(sam)).map((row) => [row.email, row.church]),
		[[fromA.id, a.id]],
	);
	assert.deepEqual(await stored(bea), [], "church B's scheduler is told nothing");
	assert.deepEqual(await ours(bea), []);
	assert.equal((await feed(bea)).length, 0, "church B's seat shows no church A entry");
	assert.equal(
		(await rows(sql`SELECT state FROM mail WHERE logical_key = ${"communication/" + fromB.id + "/" + inB.id}`))[0]!
			.state,
		"scheduled",
	);
	await f.admin.execute(sql`UPDATE notice SET recipient_id = ${bea.id}::uuid
		WHERE recipient_id = ${sam.id}::uuid AND split_part(logical_key, '/', 2) = 'scheduled_email_unsubscribe'`);
	assert.deepEqual(await ours(bea), []);
});

test("AC:CASE-NTF-016 no notice when Ana is on no waiting scheduled email", async () => {
	const w = await church();
	const sam = await staff(w);
	const ana = await person(w, "Ana");
	const ben = await person(w, "Ben");
	const went = await schedule(sam, [ana, ben]);
	await atSendTime(f.admin, f.db, went.id, went.resend.transport, keys);
	await draft(sam, [ana, ben]);
	const cancelled = await schedule(sam, [ana, ben]);
	const { revision } = firstRow(
		await rows(sql`SELECT revision::text AS revision FROM communication WHERE id = ${cancelled.id}::uuid`),
	);
	ok(
		await communicationWriter.cancelScheduledReviewed(
			f.db,
			sam.actor,
			{ requestKey: key(), expectedRevision: revision, input: { communicationId: cancelled.id } },
			cancelled.resend.transport,
		),
	);
	await schedule(sam, [ben]);
	const held = await schedule(sam, [ana, ben]);
	await heldAtProvider(f.admin, held.id, held.resend.transport, keys);

	assert.equal(ok(await unsubscribe(ana)).changed, true);
	assert.deepEqual(await stored(sam), []);
	assert.deepEqual(await ours(sam), []);
});

test("AC:CASE-NTF-016 Sam's seat in the church has ended, so Sam sees nothing and nobody gets the notice instead", async () => {
	const w = await church();
	const sam = await staff(w);
	const lee = await staff(w, "admin");
	const ana = await person(w, "Ana");
	const ben = await person(w, "Ben");
	await schedule(sam, [ana, ben]);
	await f.admin.execute(sql`UPDATE seat SET ended_at = clock_timestamp() WHERE id = ${sam.seatId}::uuid`);
	ok(await unsubscribe(ana));
	assert.deepEqual(await stored(sam), []);
	assert.deepEqual(await ours(sam), []);
	assert.deepEqual(await stored(lee), [], "no other Owner or Admin is told instead");
	assert.equal((await rows(sql`SELECT count(*)::int AS n FROM notice WHERE tenant_id = ${w.id}::uuid`))[0]!.n, 0);
});

test("AC:CASE-NTF-016 the category is in-app only and on by default; turning it off hides these notices and on shows them again", async () => {
	const w = await church();
	const sam = await staff(w);
	const prefs = ok(await notifications.getPreferences(f.db, sam.actor));
	assert.deepEqual(
		prefs.choices.filter((choice) => choice.category === "scheduled_email_unsubscribe"),
		[{ category: "scheduled_email_unsubscribe", channel: "in_app", enabled: true }],
	);
	const emailChoice = await notifications.setPreference(f.db, sam.actor, {
		requestKey: key(),
		expectedRevision: prefs.revision,
		input: { choice: { category: "scheduled_email_unsubscribe", channel: "email", enabled: true } },
	});
	assert.equal(emailChoice.status, "refused");
	assert.equal(emailChoice.error.code, "invalid_input");
	await assert.rejects(
		f.admin
			.execute(sql`INSERT INTO notification_preference (account_id, category, channel, enabled, unsubscribe_revision)
			VALUES (${sam.id}::uuid, 'scheduled_email_unsubscribe', 'email', true, 1)`),
		(error) => /notification_preference_ck_6/.test(String((error instanceof Error && error.cause) || error)),
	);

	const set = async (enabled: boolean) => {
		const current = ok(await notifications.getPreferences(f.db, sam.actor));
		ok(
			await notifications.setPreference(f.db, sam.actor, {
				requestKey: key(),
				expectedRevision: current.revision,
				input: { choice: { category: "scheduled_email_unsubscribe", channel: "in_app", enabled } },
			}),
		);
	};
	const ana = await person(w, "Ana");
	const ben = await person(w, "Ben");
	await schedule(sam, [ana, ben]);
	await set(false);
	const bellBefore = await bell(sam);
	ok(await unsubscribe(ana));
	assert.equal(await bell(sam), bellBefore);
	assert.deepEqual(await ours(sam), []);
	await set(true);
	assert.deepEqual(
		(await ours(sam)).map((item) => item.title),
		["Ana unsubscribed from a scheduled email"],
	);
	assert.equal(await bell(sam), bellBefore + 1);
});

test("AC:CASE-NTF-016 filtering the feed by the category shows only these notices", async () => {
	const w = await church();
	const sam = await staff(w);
	const ana = await person(w, "Ana");
	const ben = await person(w, "Ben");
	await schedule(sam, [ana, ben]);
	ok(await unsubscribe(ana));
	await f.admin
		.execute(sql`INSERT INTO notice (tenant_id, recipient_id, category, purpose, logical_key, source_record_id,
		source_revision, title, eligible_at, created_at)
		VALUES (${w.id}::uuid, ${sam.id}::uuid, 'task', 'task_due', ${w.id + "/task_due/" + key() + "/1/due"}, ${w.id}::uuid, 1,
			'A task is due', clock_timestamp(), clock_timestamp())`);
	assert.deepEqual((await feed(sam)).map((item) => item.category).sort(), ["scheduled_email_unsubscribe", "task_due"]);
	const filtered = ok(await notifications.readFeed(f.db, sam.actor, { category: "scheduled_email_unsubscribe" })).items;
	assert.deepEqual(
		filtered.map((item) => item.title),
		["Ana unsubscribed from a scheduled email"],
	);
});

const markChild = (who: Person) =>
	f.admin.execute(sql`UPDATE person SET adult_classification = 'child' WHERE id = ${who.id}`);
async function guardianOf(w: Church, child: Person, name: string) {
	const adult = await person(w, name);
	const home = randomUUID();
	await f.admin.execute(sql`INSERT INTO household(id,plant_id,name) VALUES(${home},${w.id},'Home')`);
	await f.admin.execute(sql`UPDATE person SET household_id = ${home}::uuid, household_role = 'other'
		WHERE id IN (${child.id}, ${adult.id})`);
	await f.admin.execute(sql`UPDATE person SET adult_classification = 'adult' WHERE id = ${adult.id}`);
	await f.admin.execute(sql`INSERT INTO guardian_contact(plant_id,child_person_id,guardian_person_id,household_id)
		VALUES(${w.id},${child.id},${adult.id},${home})`);
	return adult;
}

test("AC:CASE-NTF-016-CHILD a child's opt-out tells the scheduler whether the email still goes to a parent or guardian, as its only recipient and among others", async () => {
	for (const routed of [true, false])
		for (const only of [true, false]) {
			const w = await church();
			const sam = await staff(w);
			const kit = await person(w, "Kit Fox");
			const ben = await person(w, "Ben Ode");
			if (routed) {
				await markChild(kit);
				await guardianOf(w, kit, "Ida Fox");
			}
			const email = await schedule(sam, only ? [kit] : [kit, ben]);
			if (!routed) await markChild(kit);
			const jobsBefore = (await rows(sql`SELECT count(*)::int AS n FROM job`))[0]!.n;
			const done = ok(await unsubscribe(kit));
			assert.equal((await rows(sql`SELECT count(*)::int AS n FROM job`))[0]!.n, jobsBefore, "no job was queued");
			const at = `“Next Sunday”, scheduled for ${churchTime(email.at)}`;
			const left = !routed && only;
			const expected = [
				{
					email: email.id,
					church: w.id,
					title: left ? "Not sent: Kit Fox is marked as a child" : "Kit Fox unsubscribed from this church's email",
					body: routed
						? `${at}, still goes to the parent or guardian of Kit Fox.`
						: left
							? `${at}, will not go out because Kit Fox is marked as a child.`
							: `Kit Fox is marked as a child and left out of ${at}.`,
				},
			];
			assert.deepEqual(await stored(sam), expected);
			assert.equal((await ours(sam)).length, 1);
			assert.equal(JSON.stringify(await ours(sam)).includes("@"), false, "the notice shows no address");

			await Promise.all([unsubscribe(kit), unsubscribe(kit)]);
			assert.equal(ok(await undoMessagesOptOut(f.db, ring, now, { token: done.undoToken })).changed, true);
			assert.equal(ok(await unsubscribe(kit)).changed, true);
			assert.deepEqual(await stored(sam), expected, "one notice");
		}
});

test("AC:CASE-NTF-016-CHILD a child whose guardian's own copy was already refused is told as left out", async () => {
	const w = await church();
	const sam = await staff(w);
	const kit = await person(w, "Kit Fox");
	await markChild(kit);
	const ida = await guardianOf(w, kit, "Ida Fox");
	const email = await schedule(sam, [kit, ida]);
	const done = ok(await unsubscribe(ida));
	ok(await undoMessagesOptOut(f.db, ring, now, { token: done.undoToken }));
	ok(await unsubscribe(kit));
	assert.equal(
		(await stored(sam))[1]!.body,
		`“Next Sunday”, scheduled for ${churchTime(email.at)}, will not go out because Kit Fox is marked as a child.`,
	);
	await atSendTime(f.admin, f.db, email.id, email.resend.transport, keys);
	assert.deepEqual(
		email.resend.requests.filter((r) => r.path === "/emails/batch"),
		[],
	);
});

test("AC:CASE-NTF-016-CHILD a child unsubscribed before the email was scheduled who uses the link again is still marked as a child and adds no notice", async () => {
	const w = await church();
	const sam = await staff(w);
	const kit = await person(w, "Kit");
	const ben = await person(w, "Ben");
	await markChild(kit);
	ok(await unsubscribe(kit));
	const email = await schedule(sam, [kit, ben]);
	assert.equal(ok(await unsubscribe(kit)).changed, false);
	assert.deepEqual(await stored(sam), []);
	const row = () =>
		rows(sql`SELECT state, refusal FROM mail WHERE logical_key = ${"communication/" + email.id + "/" + kit.id}`);
	assert.deepEqual(await row(), [{ state: "scheduled", refusal: null }]);
	await atSendTime(f.admin, f.db, email.id, email.resend.transport, keys);
	assert.deepEqual(await row(), [{ state: "refused", refusal: "child" }]);
});

test("AC:CASE-NTF-016-CHILD an opt-out that reaches a child through a merge leaves one notice about the child, beside the adult's unchanged notice", async () => {
	const w = await church();
	const sam = await staff(w);
	const kit = await person(w, "Kit");
	const old = await person(w, "Kit old");
	const ben = await person(w, "Ben");
	const ana = await person(w, "Ana");
	await markChild(kit);
	const email = await schedule(sam, [kit, ben, ana]);
	await f.admin.execute(
		sql`UPDATE person SET merged_into_person_id = ${kit.id}, state = 'merged' WHERE id = ${old.id}`,
	);
	ok(await unsubscribe(old));
	ok(await unsubscribe(old));
	ok(await unsubscribe(ana));
	const at = `“Next Sunday”, scheduled for ${churchTime(email.at)}`;
	assert.deepEqual(
		(await stored(sam)).map(({ title, body }) => ({ title, body })),
		[
			{ title: "Kit unsubscribed from this church's email", body: `Kit is marked as a child and left out of ${at}.` },
			{ title: "Ana unsubscribed from a scheduled email", body: `Ana will not get ${at}.` },
		],
	);
});
