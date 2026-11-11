import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { notificationCategory } from "../../../packages/contracts/src/settings/values.ts";
import { fixture } from "../identity/invitations-support.mts";
import { resendRecorder } from "./resend-recorder.mts";
import { queuedMailTransport } from "../../../apps/web/src/features/communication/mail.ts";
import { createMailService, runDueMail } from "../../../apps/web/src/server/jobs/mail.ts";
import { scheduledJobs } from "../../../apps/web/src/server/jobs/scheduled.ts";
import { INVITATION_MAIL } from "../../../apps/web/src/server/invitations/index.ts";

// REQ-NTF-013 (WP-028): church invitation mail is required mail. An invitee's email preferences never stop it, and an
// address blocked after a bounce stops it before anything is queued, with a plain reason for the Admin.

let f;
const rows = async (query) => (await f.admin.execute(query)).rows;

before(async () => {
	f = await fixture();
});
after(() => f?.close());

/** The invitee turned off every update email they can turn off (Wiki upstream review has no email to turn off). */
async function updatesOff(accountId) {
	for (const category of notificationCategory.options.filter((name) => name !== "wiki_upstream_review"))
		await f.admin
			.execute(sql`INSERT INTO notification_preference (id, account_id, category, channel, enabled, unsubscribe_revision)
			VALUES (${randomUUID()}, ${accountId}, ${category}, 'email', false, 1)`);
}
const sentTo = (address) => f.effects.filter((effect) => effect.to === address);

test("AC:CASE-NTF-013 the scheduled runner hands a seat and a residency invitation to the email service when the invitee turned off update emails", async () => {
	const resend = resendRecorder();
	f.setTransport(
		queuedMailTransport(
			{
				keys: {
					encryptionKey: Buffer.alloc(32, 7),
					addressKey: Buffer.alloc(32, 9),
					from: "church@resend.dev",
					origin: "https://app.example.test",
				},
				apiKey: "re_test_key",
			},
			resend.fetch,
			{ VERCEL_ENV: "production" },
		),
	);
	const secret = "cron-" + randomUUID();
	const tick = scheduledJobs({
		secret,
		db: f.db,
		storage: null,
		cleanup: null,
		reminders: null,
		digests: null,
		mail: (limit, until) => runDueMail(f.db, f.mail, INVITATION_MAIL, limit, until),
	});
	try {
		for (const kind of ["plant", "sending_church"]) {
			const s = await f.setup(kind);
			await updatesOff(s.recipient.id);
			const resident = kind === "plant" ? undefined : await f.resident(s.w);
			const actor = await f.actor(s.sender.session);
			const command = {
				requestKey: randomUUID(),
				expectedRevision: "1",
				input: resident
					? { organization: s.w, personId: resident, recipientEmail: s.recipient.email }
					: { workspace: s.w, role: "member", recipientEmail: s.recipient.email },
			};
			const made = await (resident
				? f.invitations.inviteResident(actor, command)
				: f.invitations.invite(actor, command));
			resend.take();
			const response = await tick(
				new Request("http://localhost/api/cron/jobs", { headers: { authorization: `Bearer ${secret}` } }),
			);
			assert.equal(response.status, 200);
			assert.equal((await response.json()).mailed, 1, `${kind}: the runner claimed one invitation`);
			const calls = resend.take();
			assert.equal(calls.length, 1, `${kind}: one call to the email service`);
			const [call] = calls;
			assert.equal(call.method, "POST");
			assert.equal(call.path, "/emails");
			assert.equal(call.body.to, s.recipient.email);
			assert.match(call.body.text, kind === "plant" ? /invited you to join/ : /invited you to link your account/);
			const [mail] = await rows(sql`SELECT m.purpose, m.state, m.provider_message_id, r.provider_key FROM mail m
				JOIN mail_request_member mm ON mm.mail_id = m.id JOIN mail_request r ON r.id = mm.request_id
				WHERE m.logical_key = ${`invitation/${made.invitation.invitationId}/1`}`);
			assert.equal(call.idempotencyKey, mail.provider_key);
			assert.deepEqual(
				{ purpose: mail.purpose, state: mail.state, id: mail.provider_message_id },
				{
					purpose: kind === "plant" ? "seat_invitation" : "relationship_invitation",
					state: "accepted",
					id: [...resend.emails.keys()].at(-1),
				},
			);
		}
		// Mail another mount owns is never claimed by the invitation worker: its authorizer would cancel it.
		const s = await f.setup("plant");
		await f.admin.execute(
			sql`UPDATE job SET state = 'succeeded' WHERE kind = 'mail' AND state IN ('ready', 'retry_wait')`,
		);
		const organizationMail = createMailService({
			db: f.db,
			encryptionKey: randomBytes(32),
			addressKey: randomBytes(32),
			from: "connections@example.test",
			authorize: async (_tx, list) => new Set(list.map((m) => m.id)),
			transport: {
				send: async () => ({ kind: "refused", retryable: true }),
				lookup: async () => ({ kind: "unknown" }),
			},
		});
		const other = await f.db.transaction((tx) =>
			organizationMail.enqueue(tx, {
				owner: { kind: "plant", id: s.w.id },
				purpose: "relationship_invitation",
				logicalKey: `relationship/${randomUUID()}/${randomUUID()}`,
				recipient: null,
				address: s.recipient.email,
				content: { subject: "Connect", text: "Connect" },
				operation: null,
				notice: null,
				eligibleAt: new Date().toISOString(),
			}),
		);
		const response = await tick(
			new Request("http://localhost/api/cron/jobs", { headers: { authorization: `Bearer ${secret}` } }),
		);
		assert.equal((await response.json()).mailed, 0);
		assert.deepEqual(resend.take(), []);
		assert.deepEqual(await rows(sql`SELECT state FROM mail WHERE id = ${other}`), [{ state: "pending" }]);
	} finally {
		f.setTransport(null);
	}
});

test("AC:CASE-NTF-011 an invitation to an address blocked after a bounce is not sent, not queued and names the reason", async () => {
	for (const kind of ["plant", "sending_church"]) {
		const s = await f.setup(kind);
		const eventId = randomUUID();
		await f.admin
			.execute(sql`INSERT INTO provider_event(id,event_key,message_id,kind,occurred_at,received_at,payload_hash,safe_payload)
			VALUES(${eventId},${"seed-" + eventId},${"seed-" + eventId},'bounced',clock_timestamp(),clock_timestamp(),'x','{"hard_bounce":true}'::jsonb)`);
		await f.admin.execute(sql`INSERT INTO suppression(address_hash,reason,source_event_id,suppressed_at)
			VALUES(${f.addressHash(s.recipient.email)},'hard_bounce',${eventId},clock_timestamp())`);
		const resident = kind === "plant" ? undefined : await f.resident(s.w);
		const actor = await f.actor(s.sender.session);
		const command = {
			requestKey: randomUUID(),
			expectedRevision: "1",
			input: resident
				? { organization: s.w, personId: resident, recipientEmail: s.recipient.email }
				: { workspace: s.w, role: "member", recipientEmail: s.recipient.email },
		};
		await assert.rejects(
			resident ? f.invitations.inviteResident(actor, command) : f.invitations.invite(actor, command),
			(error) => {
				assert.equal(error.value?.code, "address_blocked");
				return true;
			},
		);
		await f.dispatch();
		assert.deepEqual(sentTo(s.recipient.email), []);
		assert.deepEqual(
			await rows(sql`SELECT id FROM invitation WHERE tenant_id = ${s.w.id} AND recipient_email = ${s.recipient.email}`),
			[],
		);
		assert.deepEqual(
			await rows(
				sql`SELECT id FROM mail WHERE tenant_id = ${s.w.id} AND purpose IN ('seat_invitation', 'relationship_invitation')`,
			),
			[],
		);
		const pending = await f.invitations.list(actor, { workspace: s.w });
		assert.deepEqual(pending.items, []);
	}
});
