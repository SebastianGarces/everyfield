import "../../../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "../../../../../packages/db/src/query.ts";
import { systemTemplates } from "../../../../../packages/contracts/src/communication/index.ts";
import { RequestActor } from "../../../../../packages/domain/src/access/session.ts";
import { communicationWriter, withCommunicationWrite } from "../../../../../packages/domain/src/communication/index.ts";
import { messageTemplateInstaller } from "../../../../../packages/reference/src/message-templates.ts";
import { fixture, ok, refused } from "../../../../support/fixture.mts";
import { gatedTransaction } from "../../../../../packages/domain/src/operations/writes.ts";

const SOURCE = {
	path: "docs/reference/communication-system-templates.ts",
	sha256: "07aa5ec09e7499b77d856e079c1c7312cc04dd443146f702e5a143ae6de561ba",
};
const repository = new URL("../../../../../", import.meta.url);
const database = await fixture({ prefix: "wp092ref", clock: new Date("2026-10-13T16:00:00.000Z") });
const { admin } = database;
const db = database.pools.runtime;
const P = database.tenant;
const rows = async (query) => (await admin.execute(query)).rows;
const key = () => randomUUID();
const sourceHash = async () =>
	createHash("sha256")
		.update(await readFile(new URL(SOURCE.path, repository)))
		.digest("hex");
const actorOf = async (who) => {
	const a = await RequestActor.resolve(db, who.session);
	assert.ok(a instanceof RequestActor, JSON.stringify(a));
	return a;
};
const caller = (who) => ({ actorId: who.id, userId: who.user, sessionId: who.session });
const attempt = (run: Promise<unknown>) =>
	run.then(
		(value) => ({ status: "ok", value }),
		(error) => ({ status: "refused", code: error.code, reply: JSON.stringify({ ...error, message: error.message }) }),
	);
async function writes() {
	const [row] = await rows(sql`SELECT
		(SELECT count(*)::int FROM reference_item) AS reference_items,
		(SELECT count(*)::int FROM record) AS records,
		(SELECT count(*)::int FROM message_template) AS templates,
		(SELECT count(*)::int FROM audit_event) AS audit,
		(SELECT count(*)::int FROM mail) AS mail,
		(SELECT count(*)::int FROM job) AS jobs`);
	return row;
}
const installedTemplates = async () =>
	(
		await rows(sql`SELECT count(*)::int AS n FROM reference_item
			WHERE kind = 'mail_template' AND tenant_id = '00000000-0000-0000-0000-000000000000'::uuid`)
	)[0].n;

let A, publisher, foreign, fork;
before(async () => {
	A = { ...database.actors.admin, actor: await actorOf(database.actors.admin) };
	publisher = await database.actor(null, "owner", { account: { registration_kind: "planter" } });
	await admin.execute(
		sql`INSERT INTO platform_grant(account_id, capability) VALUES (${publisher.id}::uuid, 'reference_publish')`,
	);
	const Q = await database.plant({ name: "Quarry Hill", timezone: "America/New_York" });
	foreign = await database.actor(Q, "member");
	const write = (op, input) =>
		withCommunicationWrite(db, A.actor, (tx, ctx) => communicationWriter[op](tx, ctx, input));
	const forked = ok(
		await write("forkTemplate", { requestKey: key(), input: { sourceKey: "vision-meeting-invitation" } }),
	);
	fork = ok(
		await write("updateTemplate", {
			requestKey: key(),
			expectedRevision: forked.revision,
			input: {
				templateId: forked.templateId,
				patch: {
					name: forked.name,
					description: forked.description,
					category: "meeting_invitation",
					meetingType: "vision_meeting",
					subject: "Our invitation",
					bodyHtml: "<p>Welcome {{name}}.</p>",
				},
			},
		}),
	);
});
after(() => database.close());

test("AC:GAP-REF-006 seven system templates install twice without overwriting a church's copy-on-write fork", async (step) => {
	const installer = messageTemplateInstaller(admin);

	await step.test("a repeated install yields seven system templates and keeps the fork's subject", async () => {
		const first = ok(await attempt(installer.installMessageTemplates(caller(publisher), { source: SOURCE })));
		assert.equal(first.installed, 7);
		const afterFirst = await writes();
		const second = ok(await attempt(installer.installMessageTemplates(caller(publisher), { source: SOURCE })));
		assert.equal(second.installed, 0);
		assert.deepEqual(await writes(), afterFirst);
		assert.equal(second.systemTemplateCount, 7);
		assert.equal(await installedTemplates(), 7);
		assert.equal(second.sourceSha256, SOURCE.sha256);
		assert.equal(await sourceHash(), SOURCE.sha256);

		const listed = ok(await gatedTransaction(db, (tx) => communicationWriter.listTemplates(tx, A.actor)));
		const forkShown = listed.templates.find((t) => t.sourceKey === "vision-meeting-invitation");
		assert.equal(forkShown.origin, "plant");
		assert.equal(forkShown.subject, "Our invitation");
		const [stored] = await rows(
			sql`SELECT subject, body_html FROM message_template WHERE id = ${fork.templateId}::uuid`,
		);
		assert.deepEqual(stored, { subject: "Our invitation", body_html: "<p>Welcome {{name}}.</p>" });
		const shownSystem = listed.templates.filter((t) => t.origin === "system");
		assert.equal(shownSystem.length, 6);
		const approved = new Map(systemTemplates.map((t) => [t.sourceKey, t.subject]));
		const systemSubjectOverwritten = shownSystem.some((t) => approved.get(t.sourceKey) !== t.subject);
		assert.equal(systemSubjectOverwritten, false);
	});

	await step.test(
		"missing-variable-refuses-preview: the fork's preview with no merge fields names the missing variable",
		async () => {
			const before = await writes();
			const error = refused(
				await gatedTransaction(db, (tx) =>
					communicationWriter.readPreview(tx, A.actor, {
						bodyHtml: fork.bodyHtml,
						templateId: fork.templateId,
						merge: {},
					}),
				),
				"missing_merge_variable",
			);
			assert.deepEqual(error.details, { missing: ["name"], providerCalls: 0 });
			assert.deepEqual(await writes(), before);
			const shown = ok(
				await gatedTransaction(db, (tx) =>
					communicationWriter.readPreview(tx, A.actor, {
						bodyHtml: fork.bodyHtml,
						templateId: fork.templateId,
						merge: { name: "Alex" },
					}),
				),
			);
			assert.equal(shown.previewBody, "<p>Welcome Alex.</p>");
		},
	);

	await step.test("foreign-context-refused: a Member of church Q cannot install and learns nothing of P", async () => {
		const before = await writes();
		const reads = { count: 0 };
		const watched = messageTemplateInstaller(admin, {
			readSource: async (path) => {
				reads.count += 1;
				return readFile(new URL(path, repository));
			},
		});
		const r = await attempt(watched.installMessageTemplates(caller(foreign), { source: SOURCE }));
		assert.equal(r.status, "refused");
		assert.equal(r.code, "access_denied");
		for (const secret of ["Our invitation", "Welcome", P.id, fork.templateId, "Harvest"])
			assert.equal(r.reply.includes(secret), false, r.reply);
		assert.equal(reads.count, 0);
		assert.deepEqual(await writes(), before);
	});

	await step.test(
		"required-boundary-failure: an unavailable source writes nothing and keeps the earlier install",
		async () => {
			const before = await writes();
			const broken = messageTemplateInstaller(admin, {
				readSource: async () => {
					throw new Error("required_source_unavailable");
				},
			});
			const r = await attempt(broken.installMessageTemplates(caller(publisher), { source: SOURCE }));
			assert.equal(r.status, "refused");
			assert.equal(r.code, "source_unavailable");
			assert.deepEqual(await writes(), before);
			assert.equal(await installedTemplates(), 7);
		},
	);
});
