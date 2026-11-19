import "../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { communicationWriter, withCommunicationWrite } from "../../../packages/domain/src/communication/index.ts";
import { readSwitches } from "../../../packages/domain/src/flags/index.ts";
import { outcomeText } from "../../../apps/web/src/features/communication/model.ts";
import { ok } from "../../support/fixture.mts";
import { heldAtProvider } from "./scheduled-support.mts";
import { capturedLines, withSwitchOff } from "../../support/flags.mts";

let f, plant, owner;
const keys = {
	encryptionKey: Buffer.alloc(32, 7),
	addressKey: Buffer.alloc(32, 9),
	from: "news@example.test",
	origin: "https://app.example.test",
};
const key = () => randomUUID();
const rows = async (query) => (await f.admin.execute(query)).rows;

function emailService() {
	const calls = { send: [], cancel: [], reschedule: [] };
	const transport = (paused) => ({
		paused,
		async send(batch) {
			calls.send.push(batch);
			return { outcome: "ids", ids: batch.messages.map(() => "re_" + randomUUID()) };
		},
		async cancel(ids) {
			calls.cancel.push([...ids]);
			return ids.map(() => ({ outcome: "done" }));
		},
		async reschedule(ids, at) {
			calls.reschedule.push({ ids: [...ids], at });
			return ids.map(() => ({ outcome: "done" }));
		},
	});
	return { calls, transport: async () => transport(!(await readSwitches(f.db))["outbound-mail"]) };
}

async function reviewed(days = 3) {
	const people = [];
	for (const name of ["Ana", "Ben"]) {
		const id = randomUUID();
		await f.admin
			.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
			commitment_state,pipeline_position,state,created_at)
			VALUES(${id},${plant.id},${plant.id},${name},${`${name.toLowerCase()}-${key().slice(0, 8)}@example.test`},'other','prospect','unknown','unknown',0,'live',clock_timestamp())`);
		people.push(id);
	}
	const at = new Date(Date.now() + days * 86_400_000).toISOString();
	const value = ok(
		await withCommunicationWrite(f.db, owner.actor, async (tx, ctx) => {
			const saved = await communicationWriter.saveDraft(tx, ctx, {
				requestKey: key(),
				input: {
					subject: "Friday gathering",
					bodyHtml: "<p>Hello {{name}}.</p>",
					audience: { groups: [], teamIds: [], personIds: people },
				},
			});
			if (saved.status !== "ok") return saved;
			return communicationWriter.scheduleReviewed(tx, ctx, {
				requestKey: key(),
				expectedRevision: saved.value.revision,
				input: { communicationId: saved.value.communicationId, scheduledAt: at },
			});
		}),
	);
	return { id: value.communicationId };
}
const record = async (message) =>
	(
		await rows(sql`SELECT c.state, c.revision::text AS revision,
			(SELECT count(*)::int FROM mail m WHERE m.logical_key LIKE ${"communication/" + message.id + "/%"}) AS mail,
			(SELECT count(*)::int FROM audit_event a WHERE a.subject_id = c.id) AS audits
			FROM communication c WHERE c.id = ${message.id}`)
	)[0];
const deliver = (op, message, transport, revision) =>
	communicationWriter[op](
		f.db,
		owner.actor,
		{ requestKey: key(), expectedRevision: revision, input: { communicationId: message.id } },
		transport,
		keys,
	);

before(async () => {
	f = await fixture();
	plant = await f.workspace();
	const account = await f.account();
	await f.seat(account, plant, "owner");
	owner = { ...account, actor: await f.actor(account.session) };
});
after(() => f?.close());

test("with outbound-mail off, sending now and handing off a scheduled email are refused before any write or provider call; back on, the same send goes out", async () => {
	const service = emailService();
	const now = await reviewed();
	const held = await reviewed();
	const before = [await record(now), await record(held)];
	const { value: replies, lines } = await capturedLines(() =>
		withSwitchOff(f.db, { flag: "outbound-mail", operator: owner.id }, async () => {
			const transport = await service.transport();
			return [
				await deliver("sendReviewed", now, transport, before[0].revision),
				await deliver("handOffScheduled", held, transport, before[1].revision),
			];
		}),
	);
	for (const reply of replies) {
		assert.equal(reply.status, "refused");
		assert.equal(reply.error.code, "mail_paused");
		assert.deepEqual(reply.error.details, { providerCalls: 0 });
	}
	assert.deepEqual([await record(now), await record(held)], before, "state, revision, mail rows and audits unchanged");
	assert.deepEqual(service.calls, { send: [], cancel: [], reschedule: [] }, "the email service got no call");
	assert.deepEqual(
		lines.map((l) => [l.switch, l.action]),
		[
			["outbound-mail", "communication.sendReviewed"],
			["outbound-mail", "communication.handOffScheduled"],
		],
	);
	assert.equal(
		outcomeText({ status: "refused", code: "mail_paused" }),
		"Sending email is paused for now. Nothing was sent, and this message did not change. Try again later.",
	);

	const sent = ok(await deliver("sendReviewed", now, await service.transport(), before[0].revision));
	assert.equal(sent.acceptedCount, 2, "back on, with no restart or deploy");
	assert.equal(service.calls.send.length, 1);
	ok(await deliver("handOffScheduled", held, await service.transport(), before[1].revision));
});

test("with outbound-mail off, cancelling or moving mail already handed to the email service still goes through", async () => {
	const service = emailService();
	const first = await reviewed();
	const second = await reviewed();
	for (const message of [first, second]) {
		const transport = await service.transport();
		ok(await deliver("handOffScheduled", message, transport, (await record(message)).revision));
		assert.equal((await heldAtProvider(f.admin, message.id, transport, keys)).accepted, 2);
	}
	assert.equal(service.calls.send.length, 2);
	await withSwitchOff(f.db, { flag: "outbound-mail", operator: owner.id }, async () => {
		const transport = await service.transport();
		assert.equal(transport.paused, true);
		const cancelled = ok(
			await communicationWriter.cancelScheduledReviewed(
				f.db,
				owner.actor,
				{ requestKey: key(), expectedRevision: (await record(first)).revision, input: { communicationId: first.id } },
				transport,
			),
		);
		assert.equal(cancelled.scheduledCancel, "confirmed");
		const at = new Date(Date.now() + 5 * 86_400_000).toISOString();
		const moved = ok(
			await communicationWriter.rescheduleDispatched(
				f.db,
				owner.actor,
				{
					requestKey: key(),
					expectedRevision: (await record(second)).revision,
					input: { communicationId: second.id, scheduledAt: at },
				},
				transport,
			),
		);
		assert.equal(moved.rescheduleStatus, "accepted");
	});
	assert.equal(service.calls.cancel.length, 1);
	assert.equal(service.calls.reschedule.length, 1);
	assert.equal(service.calls.send.length, 2, "no new send");
});
