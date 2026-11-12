import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import * as S from "../organizations/support.mts";
import * as Q from "../../../packages/contracts/src/organizations/index.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createNotificationProducer } from "../../../packages/domain/src/notifications/index.ts";
import { createMailService } from "../../../apps/web/src/server/jobs/mail.ts";
import {
	authorizeNotificationMail,
	createNotificationWorker,
} from "../../../apps/web/src/server/jobs/notification-worker.ts";
import { scheduledJobs } from "../../../apps/web/src/server/jobs/scheduled.ts";

// Connection and sharing milestones (T-267, REQ-NTF-009): approving, ending and changing what a church shares each
// queue a `notification` job, and the scheduled tick writes one notice per current plant Owner and Admin, in the bell
// and by email, while the occurrence still holds. The organization's seat holders are never told (D-795).

after(S.teardown);
const db = S.runtime;
type Identity = Awaited<ReturnType<typeof S.identity>>;

function service(authorize = authorizeNotificationMail) {
	return createMailService({
		db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "milestones@example.test",
		authorize,
		transport: {
			async send() {
				return { kind: "refused", retryable: true };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
}
const secret = "cron-" + randomUUID();
const tick = scheduledJobs({
	secret,
	db,
	storage: null,
	cleanup: null,
	reminders: null,
	digests: null,
	mail: null,
	notifications: createNotificationWorker({ mail: service() }),
	now: () => new Date(),
});
async function runTick() {
	const response = await tick(
		new Request("http://localhost/api/cron/jobs", { headers: { authorization: `Bearer ${secret}` } }),
	);
	const body = await response.json();
	assert.equal(response.status, 200, JSON.stringify(body));
	return body;
}

/** A plant with an Owner, an Admin, a Member and an Admin who turned the in-app or email choice off. */
async function church() {
	const p = await S.tenant("plant", "Harvest");
	const [owner, adminSeat, member, quiet] = [
		await S.identity(p),
		await S.identity(p, "admin"),
		await S.identity(p, "member"),
		await S.identity(p, "admin"),
	];
	// The quiet Admin keeps connection notices out of the bell and sharing notices out of email.
	await S.db.execute(sql`INSERT INTO notification_preference(account_id,category,channel,enabled,unsubscribe_revision)
		VALUES(${sql.param(quiet.account)},'relationship_milestone','in_app',false,0),
			(${sql.param(quiet.account)},'sharing_milestone','email',false,0)`);
	return { p, owner, admin: adminSeat, member, quiet };
}
async function connect(c: Awaited<ReturnType<typeof church>>, name: string) {
	const o = await S.tenant("sending_network", name),
		oa = await S.identity(o);
	const pair = { kind: "plant", subject: c.p, organization: o };
	const i = Q.invitationResult.parse(
		await S.call("associations.invite", c.owner, S.command({ pair, recipientEmail: oa.email })),
	);
	const accepted = Q.acceptedInvitationResult.parse(
		await S.call(
			"associations.acceptInvitation",
			oa,
			S.command({ invitationId: i.invitationId, proof: S.proofs.get(i.invitationId), decision: "accept" }),
		),
	);
	if (accepted.status !== "accepted") throw Error("not accepted");
	return { o, oa, pair, id: accepted.relationship.id };
}
/** Stops sharing the Wiki on a connection just approved (revision and consent revision 1). */
const share = (c: Awaited<ReturnType<typeof church>>, link: Awaited<ReturnType<typeof connect>>) =>
	S.call(
		"privacy.setSharing",
		c.owner,
		S.command({
			plant: c.p,
			organization: link.o,
			relationshipId: link.id,
			category: "wiki",
			enabled: false,
			expectedConsentRevision: "1",
		}),
	);
const end = (c: Awaited<ReturnType<typeof church>>, link: Awaited<ReturnType<typeof connect>>, revision: string) =>
	S.call(
		"associations.end",
		c.owner,
		S.command({ relationshipId: link.id, pair: link.pair, confirmed: true, reason: null }, revision),
	);

/** Each notice of one connection: [recipient, category, occurrence, title, in the bell, email state]. */
const notices = async (affiliation: string) =>
	(
		await S.db.execute(sql`SELECT n.recipient_id AS recipient, split_part(n.logical_key,'/',2) AS category,
			split_part(n.logical_key,'/',5) AS occurrence, n.title, n.safe_body AS body, n.tenant_id AS owner,
			n.archived_at IS NULL AS bell, m.state AS mail
			FROM notice n LEFT JOIN mail m ON m.notice_id=n.id WHERE n.source_record_id=${sql.param(affiliation)}
			ORDER BY n.source_revision, n.recipient_id`)
	).rows;
const jobs = async (affiliation: string) =>
	(
		await S.db.execute(sql`SELECT producer_key, state, error_code FROM job
			WHERE kind='notification' AND subject_record_id=${sql.param(affiliation)} ORDER BY source_revision`)
	).rows.map((r) => [r.producer_key, r.state, r.error_code]);
const feed = createNotificationProducer({ optOutKey: randomBytes(32), now: () => new Date() });
/** The account's bell entries in the two milestone categories, oldest first, as [category, title]. */
async function bell(who: Identity) {
	const reader = await RequestActor.resolve(db, who.session);
	const result = await feed.readFeed(db, reader, {});
	assert.equal(result.status, "ok", JSON.stringify(result));
	return result.value.items
		.filter((i) => i.category === "relationship_milestone" || i.category === "sharing_milestone")
		.map((i) => [i.category, i.title])
		.reverse();
}

test("AC:CASE-NTF-009 AC:NOTIFY47-005 the scheduled tick tells the plant's Owners and Admins of an approval, a sharing change and an end, in the bell and by email", async () => {
	const c = await church();
	const link = await connect(c, "North Network");
	const told = [c.owner, c.admin, c.quiet].map((a) => a.account).sort();

	// Approved: each current Owner and Admin gets one notice and one email; the quiet Admin's stays out of the bell.
	assert.equal((await runTick()).steps.notification.status, "ok");
	const approved = {
		category: "relationship_milestone",
		occurrence: "approved",
		title: "Connection approved: North Network",
		body: "North Network is now connected with your church.",
		owner: c.p.id,
		mail: "pending",
	};
	assert.deepEqual(
		await notices(link.id),
		told.map((recipient) => ({ ...approved, recipient, bell: recipient !== c.quiet.account })),
	);

	// Sharing changed: the quiet Admin sees it in the bell but gets no email.
	assert.equal(Q.mutationResult.parse(await share(c, link)).status, "committed");
	await runTick();
	const sharing = {
		category: "sharing_milestone",
		occurrence: "sharing",
		title: "Sharing changed: North Network",
		body: "What your church shares with North Network changed.",
		owner: c.p.id,
		bell: true,
	};
	assert.deepEqual(
		(await notices(link.id)).slice(3),
		told.map((recipient) => ({ ...sharing, recipient, mail: recipient === c.quiet.account ? null : "pending" })),
	);

	// Ended: the notice states only the plant's own event, and goes to the plant alone.
	await end(c, link, "2");
	await runTick();
	const ended = {
		category: "relationship_milestone",
		occurrence: "ended",
		title: "Connection ended: North Network",
		body: "Your church's connection with North Network has ended.",
		owner: c.p.id,
		mail: "pending",
	};
	assert.deepEqual(
		(await notices(link.id)).slice(6),
		told.map((recipient) => ({ ...ended, recipient, bell: recipient !== c.quiet.account })),
	);
	assert.deepEqual(await jobs(link.id), [
		["affiliation/approved/1", "succeeded", null],
		["affiliation/sharing/2", "succeeded", null],
		["affiliation/ended/3", "succeeded", null],
	]);

	const all = [
		["relationship_milestone", "Connection approved: North Network"],
		["sharing_milestone", "Sharing changed: North Network"],
		["relationship_milestone", "Connection ended: North Network"],
	];
	assert.deepEqual(await bell(c.owner), all);
	assert.deepEqual(await bell(c.admin), all);
	assert.deepEqual(await bell(c.quiet), [all[1]]);
	// A Member and the organization's Owner get neither a notice nor an email.
	assert.deepEqual(await bell(c.member), []);
	assert.deepEqual(await bell(link.oa), []);
	const outside = await S.db.execute(sql`SELECT count(*)::int AS n FROM notice n
		WHERE n.source_record_id=${sql.param(link.id)} AND n.recipient_id IN (${sql.param(c.member.account)},${sql.param(link.oa.account)})`);
	assert.equal(outside.rows[0].n, 0);
	const mailed = await S.db.execute(sql`SELECT count(*)::int AS n FROM mail
		WHERE recipient_account_id IN (${sql.param(c.member.account)},${sql.param(link.oa.account)}) AND purpose='notification'`);
	assert.equal(mailed.rows[0].n, 0);
});

test("AC:CASE-NTF-009 an occurrence is sent while its fact holds: a sharing change keeps an earlier approval, an end stops it", async () => {
	const c = await church();
	const told = [c.owner, c.admin, c.quiet].map((a) => a.account).sort();
	// Approved, then sharing changed, before the tick: both are sent.
	const kept = await connect(c, "Kept Network");
	await share(c, kept);
	await runTick();
	assert.deepEqual(
		(await notices(kept.id)).map((n) => [n.recipient, n.occurrence]),
		[...told.map((r) => [r, "approved"]), ...told.map((r) => [r, "sharing"])],
	);
	// Approved, then ended, before the tick: only the end is sent; the approval finishes without a notice or mail.
	const gone = await connect(c, "Gone Network");
	await end(c, gone, "1");
	await runTick();
	assert.deepEqual(
		(await notices(gone.id)).map((n) => [n.recipient, n.occurrence]),
		told.map((r) => [r, "ended"]),
	);
	assert.deepEqual(await jobs(gone.id), [
		["affiliation/approved/1", "cancelled", "suppressed"],
		["affiliation/ended/2", "succeeded", null],
	]);
});

test("INV-notification-worker: a milestone is sent once when its job fails and retries, or two runs race for it", async () => {
	const c = await church();
	const failing = createNotificationWorker({
		mail: service(async () => {
			throw Error("synthetic mail outage");
		}),
	});
	const link = await connect(c, "Retry Network");
	const error = console.error;
	console.error = () => {};
	try {
		assert.equal(await failing.run(db, new Date().toISOString()), 0);
	} finally {
		console.error = error;
	}
	assert.deepEqual(await jobs(link.id), [["affiliation/approved/1", "retry_wait", "notification_failed"]]);
	assert.deepEqual(await notices(link.id), []);

	// Due again: two workers run at once; the job is claimed by one and its notices are written once.
	await S.db.execute(sql`UPDATE job SET next_attempt_at=clock_timestamp()-interval '1 second', eligible_at=clock_timestamp()-interval '1 second'
		WHERE kind='notification' AND subject_record_id=${sql.param(link.id)}`);
	const [a, b] = [createNotificationWorker({ mail: service() }), createNotificationWorker({ mail: service() })];
	const sent = await Promise.all([a.run(db, new Date().toISOString()), b.run(db, new Date().toISOString())]);
	assert.equal(
		sent.reduce((x, y) => x + y, 0),
		1,
	);
	assert.deepEqual(await jobs(link.id), [["affiliation/approved/1", "succeeded", null]]);
	assert.equal((await notices(link.id)).length, 3);
	await runTick();
	assert.equal((await notices(link.id)).length, 3);
});

test("INV-notification-mail: milestone mail goes out only while the recipient holds an Owner or Admin seat and the occurrence holds", async () => {
	const c = await church();
	const link = await connect(c, "Mail Network");
	await runTick();
	const rows = async () =>
		(
			await S.db.execute(sql`SELECT m.id, m.recipient_account_id AS recipient, m.notice_id AS notice FROM mail m
				JOIN notice n ON n.id=m.notice_id WHERE n.source_record_id=${sql.param(link.id)} ORDER BY n.source_revision, m.recipient_account_id`)
		).rows as { id: string; recipient: string; notice: string }[];
	const allowed = async () => {
		const mail = await rows();
		const granted = await S.tx((t) => authorizeNotificationMail(t, mail));
		return mail.filter((m) => granted.has(m.id)).map((m) => m.recipient);
	};
	const approvedMail = [c.owner, c.admin, c.quiet].map((a) => a.account).sort();
	assert.deepEqual(await allowed(), approvedMail);

	// The Admin's seat ends before the mail is handed off: theirs no longer goes out.
	await S.db.execute(
		sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${sql.param(c.admin.account)} AND plant_id=${sql.param(c.p.id)}`,
	);
	assert.deepEqual(
		await allowed(),
		approvedMail.filter((r) => r !== c.admin.account),
	);
	// A seat moved to Member counts as gone too.
	await S.db.execute(
		sql`UPDATE seat SET role='member' WHERE account_id=${sql.param(c.quiet.account)} AND plant_id=${sql.param(c.p.id)}`,
	);
	assert.deepEqual(await allowed(), [c.owner.account]);

	// Ended before the approval mail is handed off: the approval mail stops; the end's goes out.
	await end(c, link, "1");
	await runTick();
	const mail = await rows();
	const granted = await S.tx((t) => authorizeNotificationMail(t, mail));
	const notice = await S.db.execute(
		sql`SELECT id, split_part(logical_key,'/',5) AS occurrence FROM notice WHERE source_record_id=${sql.param(link.id)}`,
	);
	const occurrence = new Map(notice.rows.map((n) => [n.id, n.occurrence]));
	assert.deepEqual(
		mail.filter((m) => granted.has(m.id)).map((m) => [m.recipient, occurrence.get(m.notice)]),
		[[c.owner.account, "ended"]],
	);
});
