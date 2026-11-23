import "../../../platform/setup.mts";
import test, { after, before, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "../../../../../packages/db/src/query.ts";
import { S3Client } from "../../../../../packages/db/node_modules/@aws-sdk/client-s3/dist-es/index.js";
import { RequestActor } from "../../../../../packages/domain/src/access/session.ts";
import {
	cancelUnsubscribedHeld,
	communicationWriter,
	runDueScheduled,
	withCommunicationWrite,
} from "../../../../../packages/domain/src/communication/index.ts";
import { documentsWriter } from "../../../../../packages/domain/src/documents/index.ts";
import { deletionOperations } from "../../../../../packages/domain/src/settings/index.ts";
import { queueJobs } from "../../../../../packages/domain/src/jobs/queue.ts";
import { testDatabase } from "../../../../support/test-database.mts";
import { ok, refused, seeds } from "../../../../support/fixture.mts";
import { freezeClock } from "./support.mts";
import { gatedTransaction } from "../../../../../packages/domain/src/operations/writes.ts";
import { MAILING } from "../../../communication/church-address.mts";

const DELETE_AT = new Date("2026-10-13T16:00:00.000Z");
const SEND_AT = "2026-10-20T16:00:00.000Z";

const database = await testDatabase({ prefix: "wp092mail", max: 6, clock: new Date("2026-10-13T15:00:00.000Z") });
const { admin, schema } = database;
const db = database.pools.runtime;
const seed = seeds(admin);
const keys = {
	encryptionKey: Buffer.alloc(32, 7),
	addressKey: Buffer.alloc(32, 9),
	from: "news@example.test",
	origin: "https://app.example.test",
};
const rows = async (query) => (await admin.execute(query)).rows;
const key = () => randomUUID();

const transport = {
	calls: { send: 0, cancel: 0 },
	async send(batch) {
		this.calls.send += 1;
		return { outcome: "ids", ids: batch.messages.map(() => "prov-" + randomUUID()) };
	},
	async cancel(ids) {
		this.calls.cancel += 1;
		return ids.map(() => ({ outcome: "unknown" }));
	},
	async reschedule() {
		throw new Error("provider_timeout");
	},
};

class MemoryClient extends S3Client {
	objects = new Map();
	constructor() {
		super({
			region: "us-east-1",
			endpoint: "https://example.invalid",
			forcePathStyle: true,
			credentials: { accessKeyId: "test", secretAccessKey: "test" },
		});
	}
	async send(command) {
		if (command.constructor.name !== "GetObjectCommand") throw new Error(`unexpected ${command.constructor.name}`);
		const body = this.objects.get(command.input.Key);
		return { ContentLength: body.length, Body: { transformToByteArray: async () => body } };
	}
}
const storage = { bucket: "synthetic-only", client: new MemoryClient() };

let plant, owner, actor;
before(async () => {
	mock.timers.enable({ apis: ["Date"], now: DELETE_AT.getTime() });
	await freezeClock(admin, schema, DELETE_AT);
	plant = await seed.plant({ name: "Harvest Point", ...MAILING });
	owner = await seed.actor(plant, "owner");
	actor = await RequestActor.resolve(db, owner.session);
	assert.ok(actor instanceof RequestActor);
});
after(async () => {
	mock.timers.reset();
	await database.close();
});

async function person(name: string) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at)
		VALUES(${id},${plant.id},${plant.id},${name},${`${name.toLowerCase()}@example.test`},'other','prospect','unknown','unknown',0,
		'live',clock_timestamp())`);
	return id;
}
async function scheduled(name: string) {
	const write = (op, input) => withCommunicationWrite(db, actor, (tx, ctx) => communicationWriter[op](tx, ctx, input));
	const saved = ok(
		await write("saveDraft", {
			requestKey: key(),
			input: {
				subject: "Welcome",
				bodyHtml: "<p>Welcome Alex.</p>",
				audience: { groups: [], teamIds: [], personIds: [await person(name)] },
			},
		}),
	);
	const accepted = ok(
		await write("scheduleReviewed", {
			requestKey: key(),
			expectedRevision: saved.revision,
			input: { communicationId: saved.communicationId, scheduledAt: SEND_AT },
		}),
	);
	return { id: saved.communicationId, revision: accepted.revision };
}
const handoff = (op: string, m) =>
	communicationWriter[op](
		db,
		actor,
		{ requestKey: key(), expectedRevision: m.revision, input: { communicationId: m.id } },
		transport,
		keys,
	);
const mailOf = async (communicationId: string) =>
	(
		await rows(sql`SELECT state, provider_message_id, cancel_requested_at, cancel_confirmed_at, sent_at
			FROM mail WHERE logical_key LIKE ${"communication/" + communicationId + "/%"}`)
	)[0];

async function savedDocument() {
	const bytes = Buffer.from("%PDF-1.7 synthetic");
	const file = randomUUID(),
		opaque = `private/${plant.id}/${randomUUID()}`;
	await admin.execute(sql`INSERT INTO file_object (id, tenant_id, purpose, opaque_key, media_type, max_bytes, byte_count, sha256, state, upload_key, claim_generation)
		VALUES (${file}::uuid, ${plant.id}::uuid, 'generated', ${opaque}, 'application/pdf', 8388608, ${bytes.length},
			${createHash("sha256").update(bytes).digest("hex")}, 'ready', ${"saved-" + file}, 0)`);
	const [row] =
		await rows(sql`INSERT INTO generated_document (tenant_id, template_id, template_version, saved_template_name, renderer_version, format, object_id, inputs, download_name, generated_at)
		VALUES (${plant.id}::uuid, 'vision-meeting-agenda', ${"ef".repeat(32)}, 'Vision Meeting Agenda', 'synthetic', 'pdf', ${file}::uuid, '[]'::jsonb, 'agenda.pdf', clock_timestamp())
		RETURNING id`);
	storage.client.objects.set(opaque, bytes);
	return row.id as string;
}
function urlExpiry(url: string) {
	const q = new URL(url).searchParams;
	const [, y, mo, d, h, mi, s] = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/.exec(q.get("X-Amz-Date")!)!;
	return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) + Number(q.get("X-Amz-Expires")) * 1000).toISOString();
}

test("AC:DEL58-006 pending deletion hands off nothing new, leaves held mail to reconcile, recalls no sent mail and issues no new URL", async () => {
	const pending = await scheduled("Pat");
	ok(await handoff("handOffScheduled", pending));
	assert.equal((await mailOf(pending.id)).state, "scheduled");
	const held = await scheduled("Hana");
	ok(await handoff("dispatchAttempt", held));
	await admin.execute(
		sql`UPDATE mail SET scheduled_at = ${SEND_AT}::timestamptz WHERE logical_key LIKE ${"communication/" + held.id + "/%"}`,
	);
	const sent = await scheduled("Sam");
	ok(await handoff("dispatchAttempt", sent));
	await admin.execute(
		sql`UPDATE mail SET state = 'sent', sent_at = clock_timestamp() WHERE logical_key LIKE ${"communication/" + sent.id + "/%"}`,
	);
	const documentId = await savedDocument();
	const issued = ok(await documentsWriter.download(db, actor, { documentId }, storage));
	assert.equal(issued.expiresAt, "2026-10-13T16:05:00.000Z");
	const sendsBefore = transport.calls.send;

	const deletion = deletionOperations({
		queue: (tx, i) =>
			queueJobs(tx, [
				{
					tenant: i.subject.id,
					kind: "lifecycle_purge",
					subject: i.witnessId,
					key: "purge/" + i.requestId,
					revision: i.revision,
					eligibleAt: i.eligibleAt,
				},
			]),
		workspaceNotice: async () => {},
	});
	const [p] = await rows(sql`SELECT revision::text AS revision FROM plant WHERE id = ${plant.id}`);
	const request = ok(
		await gatedTransaction(db, (tx) =>
			deletion.requestWorkspaceDeletion(
				tx,
				{ session: owner.session, selected: plant },
				{ input: { plant, confirmed: true }, expectedRevision: p.revision, requestKey: key() },
			),
		),
	);
	assert.equal(request.status, "pending_deletion");
	assert.equal(request.requestedAt, DELETE_AT.toISOString());

	await admin.execute(
		sql`UPDATE mail SET scheduled_at = clock_timestamp() WHERE logical_key LIKE ${"communication/" + pending.id + "/%"}`,
	);
	assert.equal(await runDueScheduled(db, transport, keys, 10, DELETE_AT.getTime() + 60_000), 0);
	assert.equal(await cancelUnsubscribedHeld(db, transport, 10), 0);
	refused(await handoff("dispatchAttempt", pending), "access_denied");
	refused(
		await communicationWriter.cancelScheduledReviewed(
			db,
			actor,
			{ requestKey: key(), expectedRevision: held.revision, input: { communicationId: held.id } },
			transport,
		),
		"access_denied",
	);
	const newHandoffs = transport.calls.send - sendsBefore;
	assert.equal(newHandoffs, 0);
	assert.equal((await mailOf(pending.id)).state, "scheduled");

	const heldMail = await mailOf(held.id);
	assert.equal(heldMail.state, "accepted");
	assert.notEqual(heldMail.provider_message_id, null);
	assert.equal(new Date(heldMail.cancel_requested_at).toISOString(), DELETE_AT.toISOString());
	assert.equal(heldMail.cancel_confirmed_at, null);
	const scheduledCancel =
		heldMail.state === "cancelled" ? "confirmed" : heldMail.cancel_requested_at ? "reconcile" : "none";
	assert.equal(scheduledCancel, "reconcile");

	const sentMail = await mailOf(sent.id);
	assert.equal(sentMail.state, "sent");
	const sentRecalled = sentMail.state !== "sent" || transport.calls.cancel > 0;
	assert.equal(sentRecalled, false);

	assert.equal(urlExpiry(issued.url), issued.expiresAt);
	const existingUrlMayWorkUntil = urlExpiry(issued.url);
	assert.equal(existingUrlMayWorkUntil, "2026-10-13T16:05:00.000Z");
	refused(await documentsWriter.download(db, actor, { documentId }, storage));
});
