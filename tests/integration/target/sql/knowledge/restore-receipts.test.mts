import "../../../platform/setup.mts";
import test, { after, before, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "../../../../../packages/db/src/query.ts";
import * as t from "../../../../../packages/db/src/schema/tables.ts";
import { createLifecycleCleanup, deletionOperations } from "../../../../../packages/domain/src/settings/index.ts";
import { RequestActor } from "../../../../../packages/domain/src/access/session.ts";
import { feedbackWriter } from "../../../../../packages/domain/src/feedback/index.ts";
import { runDueScheduled } from "../../../../../packages/domain/src/communication/index.ts";
import { queueJobs } from "../../../../../packages/domain/src/jobs/queue.ts";
import { runDueFeedbackPublication } from "../../../../../packages/domain/src/jobs/feedback-publication.ts";
import { readCurrentManifest, restoreWithCurrentManifest } from "../../../../../ops/maintenance/restore.mts";
import { testDatabase } from "../../../../support/test-database.mts";
import { ok, seeds } from "../../../../support/fixture.mts";
import { closedTo, dropTarget, freezeClock, objectStore, operator, snapshot, type Store } from "./support.mts";
import { gatedTransaction } from "../../../../../packages/domain/src/operations/writes.ts";

const IMAGE_AT = new Date("2026-09-06T12:00:00.000Z");
const REQUESTED = new Date("2026-09-06T15:00:00.000Z");
const PURGED = new Date("2026-10-06T15:00:00.000Z");
const COPIED = new Date("2026-10-13T12:00:00.000Z");
const RESTORE_AT = new Date("2026-10-13T16:00:00.000Z");
const PRIVATE = "A's private note about the launch budget";

const database = await testDatabase({
	prefix: "wp092rcp",
	roles: { runtime: ["runtime"], cleanup: ["cleanup"] },
	clock: IMAGE_AT,
});
const { admin, schema } = database;
const { runtime: db, cleanup } = database.pools;
const seed = seeds(admin);
const api = deletionOperations({
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
const targets: string[] = [];

const transport = {
	sends: 0,
	async send(batch) {
		this.sends += 1;
		return { outcome: "ids", ids: batch.messages.map(() => "prov-" + randomUUID()) };
	},
	async cancel(ids) {
		return ids.map(() => ({ outcome: "unknown" }));
	},
	async reschedule() {
		throw new Error("provider_timeout");
	},
};
const publisher = {
	calls: 0,
	async create() {
		this.calls += 1;
		return { kind: "created", issue: { number: 8, url: "https://example.test/issues/8" } };
	},
	async search() {
		this.calls += 1;
		return { kind: "none" };
	},
};

let a, b, mailId, issueOf, image;
async function at(when: Date) {
	await freezeClock(admin, schema, when);
	mock.timers.setTime(when.getTime());
}
const submit = async (who, description: string) => {
	const actor = await RequestActor.resolve(db, who.session);
	assert.ok(actor instanceof RequestActor);
	return ok(
		await feedbackWriter.submit(
			db,
			actor,
			{ requestKey: randomUUID(), category: "suggestion", description, page: "Documents", address: "/documents" },
			{ appVersion: null },
		),
	);
};

before(async () => {
	mock.timers.enable({ apis: ["Date"], now: IMAGE_AT.getTime() });
	await at(IMAGE_AT);
	const plant = await seed.plant({ name: "Harvest Point" });
	a = await seed.actor(plant, "admin", { email: "alex@example.test" });
	b = await seed.actor(plant, "member");
	await submit(a, PRIVATE);
	issueOf = (await submit(b, "The calendar could show the launch week.")).id;
	mailId = randomUUID();
	await admin.execute(sql`INSERT INTO mail (id, tenant_id, recipient_account_id, recipient_address_encrypted, purpose,
		logical_key, payload_hash, audience_hash, frozen_payload, address_hash, state, created_at)
		VALUES (${mailId}::uuid, ${plant.id}::uuid, ${a.id}::uuid, 'sealed', 'notification', ${"notice/" + mailId}, 'p', 'a',
		'{"subject":"Your week"}'::jsonb, 'h', 'pending', clock_timestamp())`);
	image = await snapshot(admin, new Map(), { createdAt: IMAGE_AT });

	await admin.execute(sql`UPDATE mail SET state='accepted', provider_message_id='prov-accepted-1',
		accepted_at=clock_timestamp() WHERE id=${mailId}::uuid`);
	await admin.execute(sql`UPDATE feedback SET publication_state='published', publication_payload='{"title":"t","body":"b"}',
		publication_hash='h7', repository_id=10, repository_name='everyfield-test/feedback', issue_number=7,
		issue_url='https://example.test/issues/7', published_at=clock_timestamp() WHERE id=${issueOf}::uuid`);

	await at(REQUESTED);
	const [account] = await admin.select().from(t.account).where(eq(t.account.id, a.id));
	const subject = { kind: "account" as const, id: a.id };
	const requested = ok(
		await gatedTransaction(db, (tx) =>
			api.requestAccountDeletion(
				tx,
				{ session: a.session, selected: subject },
				{ input: { confirmed: true }, expectedRevision: account.revision, requestKey: randomUUID() },
			),
		),
	);
	await at(PURGED);
	const purge = createLifecycleCleanup(cleanup, {
		authorize: async () => true,
		removeOwnedResources: async () => true,
	});
	assert.equal(
		(await purge({ subject, requestId: requested.requestId, revision: requested.revision })).status,
		"purged",
	);
});
after(async () => {
	mock.timers.reset();
	for (const name of targets) await dropTarget(admin, name);
	await database.close();
});

const rows = async (query) => (await admin.execute(query)).rows as Record<string, any>[];

test("AC:REC59-006 an old copy restores no expired body and replays no mail or issue; its rows take the current receipts", async () => {
	const [w] = await admin.select().from(t.lifecycle_witness).where(eq(t.lifecycle_witness.opaque_subject_id, a.id));
	assert.equal(w.state, "purged");
	assert.equal(w.copy_expires_at.toISOString(), "2026-10-13T15:00:00.000Z");

	await at(RESTORE_AT);
	const target = `${schema}_r0`;
	targets.push(target);
	const copy = {
		...image,
		manifest: { ...image.manifest, createdAt: COPIED.toISOString(), expiresAt: "2026-10-20T12:00:00.000Z" },
	};
	const store: Store = new Map();
	const result = await restoreWithCurrentManifest(
		{ admin, source: schema, targetSchema: target, objects: objectStore(store), clock: () => RESTORE_AT },
		{ capability: operator, target: "isolated", snapshot: copy, current: () => readCurrentManifest(admin) },
	);
	assert.equal(result.restore_success, true, JSON.stringify(result));
	assert.equal(result.service_opened, false);

	const runtime = database.connect("runtime", { schema: target, max: 1 });
	const until = RESTORE_AT.getTime() + 30_000;
	assert.equal(await closedTo(runtime, target), true);
	await assert.rejects(runDueScheduled(runtime, transport, {} as never, 10, until));
	await assert.rejects(
		runDueFeedbackPublication(
			runtime,
			{ repository: { id: "10", name: "everyfield-test/feedback" }, issues: publisher, operatorMail: null },
			10,
			until,
		),
	);

	const in_ = (table: string) => sql.raw(`${target}.${table}`);
	const [body] = await rows(
		sql`SELECT (SELECT description FROM ${in_("feedback")} WHERE account_id=${a.id}::uuid) AS body`,
	);
	const [restoredMail] = await rows(
		sql`SELECT state, provider_message_id, frozen_payload FROM ${in_("mail")} WHERE id=${mailId}::uuid`,
	);
	const [liveMail] = await rows(sql`SELECT state, provider_message_id FROM mail WHERE id=${mailId}::uuid`);
	const [restoredIssue] = await rows(
		sql`SELECT publication_state, issue_number FROM ${in_("feedback")} WHERE id=${issueOf}::uuid`,
	);
	const [restoredWitness] = await rows(
		sql`SELECT copy_expires_at FROM ${in_("lifecycle_witness")} WHERE opaque_subject_id=${a.id}::uuid`,
	);
	const imageMail = JSON.parse(copy.image.toString()).tables.mail.length;
	const [{ mail: targetMail }] = await rows(sql`SELECT count(*)::int AS mail FROM ${in_("mail")}`);
	const outcome = {
		restored_body: body!.body,
		new_mail: transport.sends + (targetMail - imageMail),
		new_issues: publisher.calls,
		expiry_reset: new Date(restoredWitness!.copy_expires_at).toISOString() !== "2026-10-13T15:00:00.000Z",
	};
	assert.deepEqual(outcome, { restored_body: null, new_mail: 0, new_issues: 0, expiry_reset: false });
	assert.deepEqual(
		{ state: restoredMail!.state, provider_message_id: restoredMail!.provider_message_id },
		{ state: liveMail!.state, provider_message_id: liveMail!.provider_message_id },
	);
	assert.equal(restoredMail!.state, "accepted");
	assert.equal(restoredMail!.frozen_payload, null);
	assert.deepEqual(restoredIssue, { publication_state: "published", issue_number: 7 });
	assert.equal(result.subjects.find((s) => s.id === a.id)!.copy_expiry, "2026-10-13T15:00:00Z");
});
