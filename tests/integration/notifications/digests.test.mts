import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { sessionId } from "../../../packages/contracts/src/common/index.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createNotificationProducer, issueEmailOptOutToken } from "../../../packages/domain/src/notifications/index.ts";
import { authorizeDigestMail, createDigestWorker, planDigests } from "../../../apps/web/src/server/jobs/digest.ts";
import { createMailService } from "../../../apps/web/src/server/jobs/mail.ts";
import { claimDue } from "../../../apps/web/src/server/jobs/queue.ts";
import { scheduledJobs } from "../../../apps/web/src/server/jobs/scheduled.ts";
import { closeDatabase, createDatabase } from "../../../packages/db/src/client.ts";
import { db as admin, runtime, runtimeSettings, setup, teardown } from "../jobs/support.mts";
import { seeds } from "../../support/fixture.mts";

// The church digest (NTF-007) and the oversight digest (NTF-008) as the scheduled runner delivers them: GET with the
// CRON_SECRET bearer and a clock the test moves, on a suite schema of the shared development database. Each scenario
// owns its own church or organization, so their digests never mix. The mail worker dispatches through a fake provider.

const secret = "cron-" + randomUUID();
const clock = { at: new Date() };
const sent: { to: string; subject: string; text: string; headers?: Readonly<Record<string, string>> }[] = [];
let mail: ReturnType<typeof createMailService>;
let worker: ReturnType<typeof createDigestWorker>;
let tick: (request: Request) => Promise<Response>;
const optOutKey = randomBytes(32);
const feedApi = createNotificationProducer({ optOutKey });
/** A second runtime pool whose statements the budget test counts. */
const counted = { db: null as unknown as typeof runtime, queries: [] as string[] };

/** One scheduled run at `at` (UTC). */
async function run(at: string) {
	clock.at = new Date(at);
	const response = await tick(
		new Request("http://localhost/api/cron/jobs", { headers: { authorization: `Bearer ${secret}` } }),
	);
	assert.equal(response.status, 200);
	return (await response.json()) as { digests: number; planned: { started: number; queued: number } };
}

before(async () => {
	await setup();
	mail = createMailService({
		db: runtime,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "digests@example.test",
		authorize: authorizeDigestMail,
		unsubscribe: { origin: "https://everyfield.test", keys: { current: optOutKey } },
		transport: {
			async send(payload) {
				sent.push({ to: payload.to, subject: payload.subject, text: payload.text, headers: payload.headers });
				return { kind: "accepted", id: randomUUID() };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
	worker = createDigestWorker({ mail, origin: "https://everyfield.test" });
	tick = scheduledJobs({
		secret,
		db: runtime,
		storage: null,
		cleanup: null,
		reminders: null,
		digests: worker,
		mail: null,
		now: () => clock.at,
	});
	counted.db = createDatabase(runtimeSettings);
	counted.db.$client.on("connect", (client) => {
		const query = client.query;
		client.query = function (...args: unknown[]) {
			counted.queries.push(typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text);
			return Reflect.apply(query, this, args);
		} as typeof client.query;
	});
});
after(async () => {
	await closeDatabase(counted.db);
	await teardown();
});

async function person(name: string, prefs: Record<string, boolean | "daily" | "weekly"> = {}) {
	const id = randomUUID(),
		user = randomUUID(),
		session = randomUUID(),
		email = `${name}-${id.slice(0, 8)}@example.test`;
	await admin.execute(sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${user},${email},true,${name})`);
	await admin.execute(sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind)
		VALUES(${id},${user},'active','planter')`);
	await admin.execute(
		sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${session},${user},${randomUUID()},clock_timestamp()+interval '1 day')`,
	);
	// prefs: "<category>:<channel>" → enabled, or "<category>:cadence" → daily/weekly.
	for (const [key, value] of Object.entries(prefs)) {
		const [category, channel] = key.split(":");
		if (channel === "cadence")
			await admin.execute(sql`INSERT INTO notification_preference(account_id,category,channel,enabled,cadence,unsubscribe_revision)
				VALUES (${id},${category},'email',${category === "planter_digest"},${value},1),(${id},${category},'in_app',${category === "oversight_digest"},${value},1)
				ON CONFLICT (account_id,category,channel) DO UPDATE SET cadence=excluded.cadence`);
		else
			await admin.execute(sql`INSERT INTO notification_preference(account_id,category,channel,enabled,unsubscribe_revision)
				VALUES (${id},${category},${channel},${value},1) ON CONFLICT (account_id,category,channel) DO UPDATE SET enabled=excluded.enabled`);
	}
	return { id, email, session };
}
async function church(name: string, zone: string, schedule: { weekday: number; hour: number; cadence?: string }) {
	const plant = await seeds(admin).plant({
		name,
		timezone: zone,
		digest_weekday: schedule.weekday,
		digest_hour: schedule.hour,
		digest_cadence: schedule.cadence ?? "weekly",
	});
	return plant.id;
}
async function organization(name: string, zone: string) {
	const id = randomUUID();
	await admin.execute(
		sql`INSERT INTO organization(id,kind,name,timezone,material_revision) VALUES(${id},'sending_network',${name},${zone},1)`,
	);
	return id;
}
async function seat(account: string, tenant: { plant?: string; organization?: string }, role = "owner") {
	await admin.execute(sql`INSERT INTO seat(account_id,plant_id,organization_id,role,accepted_at)
		VALUES(${account},${tenant.plant ?? null},${tenant.organization ?? null},${role},now())`);
}
async function link(organization: string, plant: string, shareActivity: boolean) {
	const r =
		await admin.execute(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${plant},${organization},now(),false,false,false,false,false,${shareActivity},false) RETURNING id`);
	return r.rows[0]!.id as string;
}
/** `n` audited changes in the plant at `at`, each carrying private text no digest may show. */
async function activity(plant: string, at: string, n = 1) {
	for (let i = 0; i < n; i++)
		await admin.execute(sql`INSERT INTO audit_event(tenant_id,actor_token,action,kind,subject_type,subject_id,occurred_at,reason,metadata)
			VALUES(${plant},'synthetic','people.updated','edit','record',${plant},${at}::timestamptz,'Maria Lopez private care note',
				jsonb_build_object('name','Maria Lopez','note','PRIVATE NOTE','message','Hello Maria','gift','$250'))`);
}
async function task(plant: string, assignees: string | string[], title: string, due: string, status = "not_started") {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,due_date,completed_at)
		VALUES(${id},${plant},${title},'general','medium',${status},now(),'date_only',${due}::date,${status === "complete" ? sql`now()` : null})`);
	for (const assignee of [assignees].flat())
		await admin.execute(sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${plant},${id},${assignee})`);
}
async function meeting(plant: string, title: string, date: string, startsAt: string, zone: string) {
	await admin.execute(sql`INSERT INTO meeting(plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision)
		VALUES(${plant},'orientation',${title},${date}::date,'19:00',${zone},${startsAt}::timestamptz,'v1','planning',1)`);
}
const notices = async (recipient: string) =>
	(
		await admin.execute(
			sql`SELECT title,safe_body,purpose,category,archived_at IS NOT NULL AS archived FROM notice WHERE recipient_id=${recipient} ORDER BY created_at`,
		)
	).rows as { title: string; safe_body: string; purpose: string; category: string; archived: boolean }[];
const mails = async (recipient: string) =>
	(
		await admin.execute(
			sql`SELECT id,purpose,state FROM mail WHERE recipient_account_id=${recipient} ORDER BY created_at`,
		)
	).rows as { id: string; purpose: string; state: string }[];
/** What the bell and the Notifications page read for the signed-in person, Digest entries only. */
async function feed(who: { session: string }, category: "planter_digest" | "oversight_digest") {
	const actor = await RequestActor.resolve(runtime, sessionId.parse(who.session));
	assert.ok(actor instanceof RequestActor);
	const r = await feedApi.readFeed(runtime, actor, { category });
	assert.equal(r.status, "ok", JSON.stringify(r));
	return (
		r as { value: { items: { title: string; body: string | null; category: string; dueLocalDate: string | null }[] } }
	).value.items;
}
/** Dispatch every due mail job through the fake provider, as the mail worker will. */
async function dispatchAll() {
	for (let claim = (await claimDue(runtime, ["mail"]))[0]; claim; claim = (await claimDue(runtime, ["mail"]))[0])
		await mail.dispatch(claim);
}
const PRIVATE = ["Maria", "Lopez", "PRIVATE", "Hello", "$250", "note"];

test("AC:NOTIFY47-004 the church digest reaches the bell and email at the church's Monday 08:00 in Sydney, not before, and an empty church gets nothing", async () => {
	// Sydney is ahead of the server's zone: Monday 2026-10-26 08:00 AEDT is Sunday 21:00 UTC.
	const zone = "Australia/Sydney";
	const harvest = await church("Harvest Church", zone, { weekday: 1, hour: 8 });
	const quiet = await church("Quiet Church", zone, { weekday: 1, hour: 8 });
	const both = await person("ana", { "planter_digest:cadence": "weekly", "planter_digest:in_app": true });
	const bellOnly = await person("ben", {
		"planter_digest:cadence": "weekly",
		"planter_digest:in_app": true,
		"planter_digest:email": false,
	});
	const empty = await person("cy", { "planter_digest:cadence": "weekly", "planter_digest:in_app": true });
	await seat(both.id, { plant: harvest });
	await seat(bellOnly.id, { plant: harvest }, "admin");
	await seat(empty.id, { plant: quiet });
	// Shared tasks: each assignee's digest lists them (F07b).
	const team = [both.id, bellOnly.id];
	await task(harvest, team, "Book the venue", "2026-10-24");
	await task(harvest, team, "Send the launch letter", "2026-10-30");
	await task(harvest, team, "Order chairs", "2026-11-20");
	await task(harvest, team, "Done already", "2026-10-25", "complete");
	await meeting(harvest, "Launch team dinner", "2026-10-29", "2026-10-29T08:00:00Z", zone);

	// 07:59 local: the planner starts coverage; nothing is sent.
	await run("2026-10-25T20:59:00Z");
	for (const who of [both, bellOnly, empty]) {
		assert.deepEqual(await notices(who.id), [], "nothing before 08:00 local");
		assert.deepEqual(await mails(who.id), []);
	}
	// 08:00 local: one digest each.
	const due = await run("2026-10-25T21:00:00Z");
	assert.equal(due.digests, 2);
	const expected = {
		title: "Church digest: 3 open items, Oct 20, 2026 to Oct 26, 2026",
		body: [
			"Overdue task, due Oct 24, 2026: Book the venue.",
			"Meeting on Oct 29, 2026: Launch team dinner.",
			"Task due Oct 30, 2026: Send the launch letter.",
		].join(" "),
	};
	for (const who of [both, bellOnly]) {
		const [entry] = await feed(who, "planter_digest");
		// A digest has no due date: the entry shows no "Due" label.
		assert.deepEqual(
			entry && { title: entry.title, body: entry.body, category: entry.category, due: entry.dueLocalDate },
			{ ...expected, category: "planter_digest", due: null },
		);
		assert.equal((await notices(who.id)).length, 1);
	}
	// Criterion 2: email on → one planter_digest intent with the same items; email off → none, the bell still shows it.
	assert.deepEqual(
		(await mails(both.id)).map((m) => m.purpose),
		["planter_digest"],
	);
	assert.deepEqual(await mails(bellOnly.id), []);
	await dispatchAll();
	const email = sent.find((m) => m.to === both.email);
	assert.equal(email?.subject, expected.title);
	for (const line of expected.body.split(/(?<=\.) /)) assert.ok(email?.text.includes(line), line);
	// Criterion 3: no open items → no bell entry and no email.
	assert.deepEqual(await notices(empty.id), []);
	assert.deepEqual(await mails(empty.id), []);
	// Criterion 9: the same slot again, and two overlapping runs, add nothing.
	await run("2026-10-25T21:05:00Z");
	await Promise.all([run("2026-10-25T21:06:00Z"), run("2026-10-25T21:06:00Z")]);
	assert.equal((await notices(both.id)).length, 1);
	assert.equal((await mails(both.id)).length, 1);
});

test("AC:CASE-NTF-008 AC:NOTIFY47-005 the 07:00 oversight digest shows the sharing plant's counts and dates only, in the bell by default and by email when chosen", async () => {
	const zone = "America/Chicago";
	const network = await organization("Prairie Network", zone);
	const sharing = await church("Riverbend Church", zone, { weekday: 0, hour: 16 });
	const private_ = await church("Hidden Hollow Church", zone, { weekday: 0, hour: 16 });
	await link(network, sharing, true);
	await link(network, private_, false);
	const owner = await person("olive"); // never saved an oversight choice
	const admin2 = await person("omar", { "oversight_digest:email": true });
	await seat(owner.id, { organization: network });
	await seat(admin2.id, { organization: network }, "admin");
	// 06:59 Chicago on Wednesday 2026-10-28: coverage starts at Monday the 26th.
	await run("2026-10-28T11:59:00Z");
	// Tuesday the 27th, local: two changes in the sharing plant, three in the other.
	await activity(sharing, "2026-10-27T15:00:00Z", 2);
	await activity(private_, "2026-10-27T16:00:00Z", 3);
	// Criterion 9: two overlapping runs at 07:00, then a third.
	await Promise.all([run("2026-10-28T12:00:00Z"), run("2026-10-28T12:00:00Z")]);
	await run("2026-10-28T12:01:00Z");
	const title = "Oversight digest: 2 activities, Oct 27, 2026";
	const body = "Riverbend Church: 2 activities on Oct 27, 2026.";
	for (const who of [owner, admin2]) {
		const items = await feed(who, "oversight_digest");
		assert.deepEqual(
			items.map((i) => [i.title, i.body]),
			[[title, body]],
		);
		assert.equal((await notices(who.id)).length, 1);
		for (const text of [items[0]!.title, items[0]!.body!])
			for (const word of [...PRIVATE, "Hidden Hollow", "3 activities"]) assert.ok(!text.includes(word), word);
	}
	// Criterion 8: no saved choice → bell only; email turned on → the email too. The opt-out page agrees.
	assert.deepEqual(await mails(owner.id), []);
	const token = issueEmailOptOutToken(optOutKey, {
		purpose: "disable",
		accountId: owner.id,
		category: "oversight_digest",
		unsubscribeRevision: "0",
	});
	const described = await feedApi.describeEmailOptOut(runtime, { token });
	assert.equal(described.status, "ok", JSON.stringify(described));
	const choice = (described as { value: { emailEnabled: boolean; inAppEnabled: boolean } }).value;
	assert.deepEqual([choice.inAppEnabled, choice.emailEnabled], [true, false]);
	assert.deepEqual(
		(await mails(admin2.id)).map((m) => m.purpose),
		["oversight_digest"],
	);
	await dispatchAll();
	const email = sent.find((m) => m.to === admin2.email);
	assert.equal(email?.subject, title);
	assert.ok(email?.text.includes(body));
	for (const word of [...PRIVATE, "Hidden Hollow"]) assert.ok(!email?.text.includes(word), word);
	assert.equal((await mails(admin2.id))[0]?.state, "accepted");
});

test("AC:CASE-NTF-008 an organization without a saved zone gets its digest at 07:00 UTC for the previous UTC day, and one with no shared activity gets nothing", async () => {
	const utc = await organization("Harbor Network", "UTC");
	const silent = await organization("Still Network", "UTC");
	const plant = await church("Dockside Church", "America/Los_Angeles", { weekday: 0, hour: 16 });
	const idle = await church("Idle Church", "UTC", { weekday: 0, hour: 16 });
	await link(utc, plant, true);
	await link(silent, idle, true);
	const lead = await person("una");
	const quiet = await person("quinn", { "oversight_digest:email": true });
	await seat(lead.id, { organization: utc });
	await seat(quiet.id, { organization: silent });
	await run("2026-10-27T12:00:00Z");
	// 23:30 UTC on the 27th is still the 27th in UTC (and the 27th in Los Angeles too: only the organization's zone counts).
	await activity(plant, "2026-10-27T23:30:00Z", 1);
	await activity(plant, "2026-10-28T00:30:00Z", 4); // the 28th in UTC: the next day's digest
	await run("2026-10-28T06:59:00Z");
	assert.deepEqual(await notices(lead.id), [], "nothing before 07:00 UTC");
	await run("2026-10-28T07:00:00Z");
	assert.deepEqual(
		(await notices(lead.id)).map((n) => [n.title, n.safe_body]),
		[["Oversight digest: 1 activity, Oct 27, 2026", "Dockside Church: 1 activity on Oct 27, 2026."]],
	);
	// Criterion 6: linked plants with no activity in the period → no bell entry, no email.
	assert.deepEqual(await notices(quiet.id), []);
	assert.deepEqual(await mails(quiet.id), []);
});

test("AC:CASE-NTF-008 a plant that stops sharing after the digest was queued contributes nothing; alone, nothing is delivered", async () => {
	const zone = "UTC";
	const solo = await organization("Solo Network", zone);
	const pair = await organization("Pair Network", zone);
	const alone = await church("Lone Pine Church", zone, { weekday: 0, hour: 16 });
	const leaving = await church("Leaving Church", zone, { weekday: 0, hour: 16 });
	const staying = await church("Staying Church", zone, { weekday: 0, hour: 16 });
	const aloneLink = await link(solo, alone, true);
	const leavingLink = await link(pair, leaving, true);
	await link(pair, staying, true);
	const s = await person("sam");
	const p = await person("pat", { "oversight_digest:email": true });
	await seat(s.id, { organization: solo });
	await seat(p.id, { organization: pair });
	await run("2026-10-29T12:00:00Z");
	for (const plant of [alone, leaving, staying]) await activity(plant, "2026-10-29T15:00:00Z", 2);
	// The planner queues the 07:00 digests; before the worker compiles them, two plants withdraw.
	await planDigests(runtime, "2026-10-30T07:00:00.000Z");
	const queued = await admin.execute(
		sql`SELECT count(*)::int AS n FROM job WHERE kind='digest' AND state='ready' AND subject_record_id IN (${s.id},${p.id})`,
	);
	assert.equal(queued.rows[0]!.n, 2);
	await admin.execute(sql`UPDATE affiliation SET share_activity=false,revision=revision+1 WHERE id=${aloneLink}`);
	await admin.execute(sql`UPDATE affiliation SET ended_at=now(),revision=revision+1 WHERE id=${leavingLink}`);
	await worker.run(runtime, "2026-10-30T07:00:00.000Z");
	assert.deepEqual(await notices(s.id), [], "the only contributor stopped sharing: nothing is delivered");
	assert.deepEqual(await mails(s.id), []);
	assert.deepEqual(
		(await notices(p.id)).map((n) => n.safe_body),
		["Staying Church: 2 activities on Oct 29, 2026."],
	);
	assert.equal((await mails(p.id)).length, 1);
});

test("AC:CASE-NTF-008 an oversight email queued before a plant stops sharing is withdrawn at dispatch", async () => {
	const network = await organization("Late Network", "UTC");
	const a = await church("Early Church", "UTC", { weekday: 0, hour: 16 });
	const b = await church("Withdrawn Church", "UTC", { weekday: 0, hour: 16 });
	await link(network, a, true);
	const bLink = await link(network, b, true);
	const reader = await person("lee", { "oversight_digest:email": true });
	await seat(reader.id, { organization: network });
	await run("2026-10-29T12:00:00Z");
	await activity(a, "2026-10-29T10:00:00Z");
	await activity(b, "2026-10-29T11:00:00Z");
	await run("2026-10-30T07:00:00Z");
	assert.match((await notices(reader.id))[0]!.safe_body, /Withdrawn Church/);
	await admin.execute(sql`UPDATE affiliation SET share_activity=false,revision=revision+1 WHERE id=${bLink}`);
	const before = sent.length;
	await dispatchAll();
	assert.equal(
		sent.slice(before).filter((m) => m.to === reader.email).length,
		0,
		"no email shows the withdrawn plant's counts",
	);
	assert.deepEqual(
		(await mails(reader.id)).map((m) => m.state),
		["cancelled"],
	);
});

test("AC:CASE-NTF-008 after three missed daily slots one catch-up digest covers every missed date and rechecks sharing", async () => {
	const zone = "America/Chicago";
	const network = await organization("Catch-up Network", zone);
	const open = await church("Open Door Church", zone, { weekday: 0, hour: 16 });
	const closed = await church("Closed Door Church", zone, { weekday: 0, hour: 16 });
	await link(network, open, true);
	const closedLink = await link(network, closed, true);
	const reader = await person("cam");
	await seat(reader.id, { organization: network });
	// Tuesday 2026-10-20 07:30 Chicago: coverage starts at Monday the 19th.
	await run("2026-10-20T12:30:00Z");
	for (const day of ["2026-10-20", "2026-10-21", "2026-10-22"]) {
		await activity(open, `${day}T15:00:00Z`);
		await activity(closed, `${day}T15:00:00Z`);
	}
	// The runner is down on the 21st, 22nd and 23rd. Meanwhile one plant stops sharing.
	await admin.execute(sql`UPDATE affiliation SET share_activity=false,revision=revision+1 WHERE id=${closedLink}`);
	await run("2026-10-23T12:30:00Z");
	assert.deepEqual(
		(await notices(reader.id)).map((n) => [n.title, n.safe_body]),
		[
			[
				"Oversight digest: 3 activities, Oct 20, 2026 to Oct 22, 2026",
				"Open Door Church: 1 activity on Oct 20, 2026. Open Door Church: 1 activity on Oct 21, 2026. Open Door Church: 1 activity on Oct 22, 2026.",
			],
		],
	);
	await run("2026-10-23T12:31:00Z");
	assert.equal((await notices(reader.id)).length, 1);
});

test("AC:CASE-NTF-008 a person who lost their seat or whose account is no longer active gets nothing", async () => {
	const network = await organization("Turnover Network", "UTC");
	const plant = await church("Turnover Church", "UTC", { weekday: 0, hour: 16 });
	await link(network, plant, true);
	const left = await person("lou", { "oversight_digest:email": true });
	const inactive = await person("ivy", { "oversight_digest:email": true });
	const late = await person("liz", { "oversight_digest:email": true });
	const stays = await person("sky");
	for (const [n, who] of [stays, left, inactive, late].entries())
		await seat(who.id, { organization: network }, n ? "admin" : "owner");
	await run("2026-10-29T12:00:00Z");
	await activity(plant, "2026-10-29T15:00:00Z");
	await admin.execute(sql`UPDATE seat SET ended_at=now() WHERE account_id=${left.id}`);
	await admin.execute(sql`UPDATE account SET registration_state='pending_domain' WHERE id=${inactive.id}`);
	// Liz's job is queued while she still holds her seat; it ends before the worker runs.
	await planDigests(runtime, "2026-10-30T07:00:00.000Z");
	await admin.execute(sql`UPDATE seat SET ended_at=now() WHERE account_id=${late.id}`);
	await worker.run(runtime, "2026-10-30T07:00:00.000Z");
	for (const who of [left, inactive, late]) {
		assert.deepEqual(await notices(who.id), [], who.email);
		assert.deepEqual(await mails(who.id), [], who.email);
	}
	assert.equal((await notices(stays.id)).length, 1);
});

test("INV-budget: one delivered digest sends a fixed number of statements, however many items it lists", async () => {
	const [before, at] = ["2026-10-30T08:00:00.000Z", "2026-10-31T09:00:00.000Z"];
	const counts: number[] = [];
	for (const items of [1, 12]) {
		// Deliver what other scenarios owe at this time first, so the measured run claims this church's job.
		await planDigests(runtime, at);
		await worker.run(runtime, at, 100);
		const plant = await church(`Budget ${items}`, "UTC", { weekday: 0, hour: 9, cadence: "daily" });
		const who = await person(`b${items}`, { "planter_digest:cadence": "daily", "planter_digest:in_app": true });
		await seat(who.id, { plant });
		for (let i = 0; i < items; i++) await task(plant, who.id, `Task ${i}`, "2026-10-31");
		await planDigests(runtime, before);
		assert.equal((await planDigests(runtime, at)).queued, 1);
		const start = counted.queries.length;
		assert.equal(await worker.run(counted.db, at, 1), 1);
		counts.push(counted.queries.length - start);
		assert.equal((await notices(who.id)).length, 1);
	}
	// claim 1; BEGIN, timeout, claim fence, recipient read, compile, write, finish, COMMIT 8.
	assert.deepEqual(counts, [9, 9]);
});

test("AC:CASE-NTF-007 AC:CASE-NTF-008 each digest email carries the Unsubscribe link and headers of its own digest, and unsubscribing stops that digest only", async () => {
	const plant = await church("Unsubscribe Church", "UTC", { weekday: 1, hour: 8 });
	const network = await organization("Unsubscribe Network", "UTC");
	const linked = await church("Linked Church", "UTC", { weekday: 0, hour: 16 });
	await link(network, linked, true);
	const planter = await person("uma", { "planter_digest:cadence": "daily", "planter_digest:in_app": true });
	const overseer = await person("ugo", { "oversight_digest:email": true });
	await seat(planter.id, { plant });
	await seat(overseer.id, { organization: network });
	await task(plant, planter.id, "Print the flyers", "2026-10-30");
	// 06:59 UTC on Monday 2026-11-02: coverage starts for both digests.
	await run("2026-11-02T06:59:00Z");
	await activity(linked, "2026-11-01T15:00:00Z", 2);
	await run("2026-11-02T08:00:00Z");
	await dispatchAll();
	const emails = (who: { email: string }) => sent.filter((m) => m.to === who.email);
	const token = (m: (typeof sent)[number] | undefined) => {
		const header = /^<https:\/\/everyfield\.test\/email-preferences\/([\w-]+)\/one-click>$/.exec(
			m?.headers?.["List-Unsubscribe"] ?? "",
		)?.[1];
		assert.ok(m && header, m?.subject);
		assert.equal(m.headers?.["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
		assert.ok(m.text.includes(`\nUnsubscribe: https://everyfield.test/email-preferences/${header}\n`), m.text);
		return header;
	};
	const [church_] = emails(planter);
	const [oversight] = emails(overseer);
	assert.match(church_?.subject ?? "", /^Church digest/);
	assert.match(oversight?.subject ?? "", /^Oversight digest/);
	for (const [m, who, category] of [
		[church_, planter, "planter_digest"],
		[oversight, overseer, "oversight_digest"],
	] as const) {
		const described = await feedApi.describeEmailOptOut(runtime, { token: token(m) });
		assert.equal(described.status, "ok", JSON.stringify(described));
		assert.equal((described as { value: { category: string } }).value.category, category, who.email);
	}
	// One-click from the church digest's header: the church digest stops emailing and its bell entry keeps coming. No
	// other category changes, and the oversight digest still emails.
	const off = await feedApi.applyEmailOptOut(runtime, { token: token(church_) });
	assert.equal(off.status, "ok", JSON.stringify(off));
	const prefs = await admin.execute(
		sql`SELECT category,channel,enabled FROM notification_preference WHERE account_id=${planter.id} AND channel='email' ORDER BY category`,
	);
	assert.deepEqual(
		prefs.rows.map((r) => [r.category, r.enabled]),
		[["planter_digest", false]],
	);
	await activity(linked, "2026-11-02T15:00:00Z", 1);
	await run("2026-11-03T08:00:00Z");
	await dispatchAll();
	assert.equal(emails(planter).length, 1);
	assert.equal((await notices(planter.id)).length, 2);
	assert.equal(emails(overseer).length, 2);
	// One-click from the latest oversight email stops that digest too; its bell entry keeps coming.
	const off2 = await feedApi.applyEmailOptOut(runtime, { token: token(emails(overseer).at(-1)) });
	assert.equal(off2.status, "ok", JSON.stringify(off2));
	await activity(linked, "2026-11-03T15:00:00Z", 1);
	await run("2026-11-04T08:00:00Z");
	await dispatchAll();
	assert.equal(emails(overseer).length, 2);
	assert.equal((await notices(overseer.id)).length, 3);
});
