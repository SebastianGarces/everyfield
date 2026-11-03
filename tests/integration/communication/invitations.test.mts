import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { notificationCategory } from "../../../packages/contracts/src/settings/values.ts";
import { fixture } from "../identity/invitations-support.mts";

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
		await f.admin.execute(sql`INSERT INTO notification_preference (id, account_id, category, channel, enabled, unsubscribe_revision)
			VALUES (${randomUUID()}, ${accountId}, ${category}, 'email', false, 1)`);
}
const sentTo = (address) => f.effects.filter((effect) => effect.to === address);

test("AC:CASE-NTF-013 a seat and a residency invitation still go to the email service when the invitee turned off update emails", async () => {
	for (const kind of ["plant", "sending_church"]) {
		const s = await f.setup(kind);
		await updatesOff(s.recipient.id);
		const before = sentTo(s.recipient.email).length;
		const resident = kind === "plant" ? undefined : await f.resident(s.w);
		const made = await f.invitation(s, resident);
		const sent = sentTo(s.recipient.email);
		assert.equal(sent.length, before + 1, `${kind}: one invitation email`);
		assert.match(sent.at(-1).text, kind === "plant" ? /invited you to join/ : /invited you to link your account/);
		const [mail] = await rows(sql`SELECT purpose, state FROM mail
			WHERE logical_key = ${`invitation/${made.result.invitation.invitationId}/1`}`);
		assert.deepEqual(mail, {
			purpose: kind === "plant" ? "seat_invitation" : "relationship_invitation",
			state: "accepted",
		});
	}
});

test("AC:CASE-NTF-011 an invitation to an address blocked after a bounce is not sent, not queued and names the reason", async () => {
	for (const kind of ["plant", "sending_church"]) {
		const s = await f.setup(kind);
		const eventId = randomUUID();
		await f.admin.execute(sql`INSERT INTO provider_event(id,event_key,message_id,kind,occurred_at,received_at,payload_hash,safe_payload)
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
			await rows(sql`SELECT id FROM mail WHERE tenant_id = ${s.w.id} AND purpose IN ('seat_invitation', 'relationship_invitation')`),
			[],
		);
		const pending = await f.invitations.list(actor, { workspace: s.w });
		assert.deepEqual(pending.items, []);
	}
});
