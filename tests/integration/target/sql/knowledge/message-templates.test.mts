import "../../../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { sql, type SQL } from "../../../../../packages/db/src/query.ts";
import { systemTemplates } from "../../../../../packages/contracts/src/communication/index.ts";
import { RequestActor } from "../../../../../packages/domain/src/access/session.ts";
import { communicationWriter, withCommunicationWrite } from "../../../../../packages/domain/src/communication/index.ts";
import { messageTemplateInstaller } from "../../../../../packages/reference/src/message-templates.ts";
import { type Actor, fixture, ok, refused } from "../../../../support/fixture.mts";
import { gatedTransaction } from "../../../../../packages/domain/src/operations/writes.ts";

const SOURCE = {
	path: "docs/reference/communication-system-templates.ts",
	sha256: "07aa5ec09e7499b77d856e079c1c7312cc04dd443146f702e5a143ae6de561ba",
};
const repository = new URL("../../../../../", import.meta.url);
type Fixture = Awaited<ReturnType<typeof fixture>>;
const CLOCK = new Date("2026-10-13T16:00:00.000Z");
const database = await fixture({ prefix: "wp092ref", clock: CLOCK });
const { admin } = database;
const db = database.pools.runtime;
const P = database.tenant;
const rowsOf = (d: Fixture) => async (query: SQL) => (await d.admin.execute(query)).rows;
const rows = rowsOf(database);
const key = () => randomUUID();
const sourceHash = async () =>
	createHash("sha256")
		.update(await readFile(new URL(SOURCE.path, repository)))
		.digest("hex");
const actorOf = async (who: Actor, runtime = db) => {
	const a = await RequestActor.resolve(runtime, who.session);
	assert.ok(a instanceof RequestActor, JSON.stringify(a));
	return a;
};
const caller = (who: Actor) => ({ actorId: who.id, userId: who.user, sessionId: who.session });
const attempt = <V,>(run: Promise<V>) =>
	run.then(
		(value) => ({ status: "ok" as const, value }),
		(error) => ({
			status: "refused" as const,
			code: error.code,
			reply: JSON.stringify({ ...error, message: error.message }),
		}),
	);
async function writes(query = rows) {
	const [row] = await query(sql`SELECT
		(SELECT count(*)::int FROM reference_item) AS reference_items,
		(SELECT count(*)::int FROM record) AS records,
		(SELECT count(*)::int FROM message_template) AS templates,
		(SELECT count(*)::int FROM audit_event) AS audit,
		(SELECT count(*)::int FROM mail) AS mail,
		(SELECT count(*)::int FROM job) AS jobs`);
	return row;
}
const installedTemplates = async (query = rows) =>
	(
		await query(sql`SELECT count(*)::int AS n FROM reference_item
			WHERE kind = 'mail_template' AND tenant_id = '00000000-0000-0000-0000-000000000000'::uuid`)
	)[0]!.n;

/** A church with a customized fork of the vision invitation and a platform publisher, before any install. */
async function world(d: Fixture) {
	const runtime = d.pools.runtime;
	const A = { ...d.actors.admin, actor: await actorOf(d.actors.admin, runtime) };
	const publisher = await d.actor(null, "owner", { account: { registration_kind: "planter" } });
	await d.admin.execute(
		sql`INSERT INTO platform_grant(account_id, capability) VALUES (${publisher.id}::uuid, 'reference_publish')`,
	);
	const Q = await d.plant({ name: "Quarry Hill", timezone: "America/New_York" });
	const foreign = await d.actor(Q, "member");
	const forked = ok(
		await withCommunicationWrite(runtime, A.actor, (tx, ctx) =>
			communicationWriter.forkTemplate(tx, ctx, {
				requestKey: key(),
				input: { sourceKey: "vision-meeting-invitation" },
			}),
		),
	);
	const fork: { templateId: string; bodyHtml: string } = ok(
		await withCommunicationWrite(runtime, A.actor, (tx, ctx) =>
			communicationWriter.updateTemplate(tx, ctx, {
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
		),
	);
	return { A, publisher, foreign, fork };
}

let A: Actor & { actor: RequestActor }, publisher: Actor, foreign: Actor;
let fork: { templateId: string; bodyHtml: string };
before(async () => {
	({ A, publisher, foreign, fork } = await world(database));
});
after(() => database.close());

test("AC:GAP-REF-006 AC:CASE-COM-008 seven system templates install twice without overwriting a church's copy-on-write fork", async (step) => {
	const installer = messageTemplateInstaller(admin);
	const { expected, given } = JSON.parse(
		await readFile(new URL("docs/acceptance/communications-notifications.json", repository), "utf8"),
	).cases.find((c: { id: string }) => c.id === "CASE-COM-008");
	const systemRows = () =>
		rows(sql`SELECT id, canonical_key FROM reference_item WHERE kind = 'mail_template' ORDER BY canonical_key`);

	await step.test("an altered source, or an altered checksum for the approved one, installs nothing", async () => {
		const before = await writes();
		const altered = Buffer.from("export const altered = [];\n");
		const alteredSha = createHash("sha256").update(altered).digest("hex");
		const swapped = messageTemplateInstaller(admin, { readSource: async () => altered });
		for (const [with_, sha256] of [
			[installer, alteredSha],
			[swapped, alteredSha],
			[swapped, SOURCE.sha256],
		] as const) {
			const r = await attempt(
				with_.installMessageTemplates(caller(publisher), { source: { path: SOURCE.path, sha256 } }),
			);
			assert.deepEqual([r.status, "code" in r && r.code], ["refused", "digest_conflict"]);
		}
		assert.deepEqual(await writes(), before);
	});

	await step.test("a repeated install yields seven system templates and keeps the fork's subject", async () => {
		const first = ok(await attempt(installer.installMessageTemplates(caller(publisher), { source: SOURCE })));
		assert.equal(first.installed, 7);
		const afterFirst = await writes();
		const items = await systemRows();
		assert.equal(items.length, expected.result.installed_template_count);
		assert.equal(items.length, given["behavior-inputs"].template_ids.length);
		const second = ok(await attempt(installer.installMessageTemplates(caller(publisher), { source: SOURCE })));
		assert.equal(second.installed, expected.result.replay_new_rows);
		assert.deepEqual(await systemRows(), items, "the same seven ids");
		assert.deepEqual(await writes(), afterFirst);
		assert.equal(second.systemTemplateCount, 7);
		assert.equal(await installedTemplates(), 7);
		assert.equal(second.sourceSha256, SOURCE.sha256);
		assert.equal(await sourceHash(), SOURCE.sha256);

		const listed = ok(await gatedTransaction(db, (tx) => communicationWriter.listTemplates(tx, A.actor)));
		const forkShown = listed.templates.find((t) => t.sourceKey === "vision-meeting-invitation")!;
		assert.equal(forkShown.origin, "plant");
		assert.equal(forkShown.subject, "Our invitation");
		const [stored] = await rows(
			sql`SELECT subject, body_html FROM message_template WHERE id = ${fork.templateId}::uuid`,
		);
		assert.deepEqual(stored, { subject: "Our invitation", body_html: "<p>Welcome {{name}}.</p>" });
		const invitation = ok(
			await gatedTransaction(db, (tx) =>
				communicationWriter.readMeetingTemplate(tx, A.actor, { meetingType: "vision_meeting" }),
			),
		);
		const label = new Map([[fork.templateId, given["behavior-inputs"].plant_fork]]);
		assert.equal(label.get(invitation.templateId), expected.result.selected_template);
		assert.equal(invitation.bodyHtml, "<p>Welcome {{name}}.</p>");
		const shownSystem = listed.templates.filter((t) => t.origin === "system");
		assert.equal(shownSystem.length, 6);
		const approved = new Map(systemTemplates.map((t) => [t.sourceKey, t.subject]));
		const systemSubjectOverwritten = shownSystem.some((t) => approved.get(t.sourceKey ?? "") !== t.subject);
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

	await step.test("an altered source after the install changes no row and no fork", async () => {
		const before = await writes();
		const items = await systemRows();
		const swapped = messageTemplateInstaller(admin, { readSource: async () => Buffer.from('    name: "Changed",\n') });
		const r = await attempt(swapped.installMessageTemplates(caller(publisher), { source: SOURCE }));
		assert.deepEqual([r.status, "code" in r && r.code], ["refused", "digest_conflict"]);
		assert.deepEqual([await writes(), await systemRows()], [before, items]);
		const [row] = await rows(sql`SELECT subject FROM message_template WHERE id = ${fork.templateId}::uuid`);
		assert.deepEqual(row, { subject: "Our invitation" });
	});

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

test("AC:REF-CASE-006 seven system templates install with no recipient, schedule or send; the vision invitation with no place or agenda shows no empty location icon or agenda prefix, and a church's fork stays its own", async () => {
	const { given, expected } = JSON.parse(
		await readFile(new URL("docs/acceptance/schema.json", repository), "utf8"),
	).cases.find((c: { id: string }) => c.id === "REF-CASE-006");
	const exec = given.execution;
	const { result } = expected;
	assert.equal(await sourceHash(), exec.catalog_sha256);
	// Its own schema, so the counts below span the first install of the seven templates, not a replay.
	const d = await fixture({ prefix: "wp092ref6", clock: CLOCK });
	after(() => d.close());
	const query = rowsOf(d);
	const runtime = d.pools.runtime;
	const { A, publisher, fork } = await world(d);
	assert.equal(await installedTemplates(query), 0);
	const installer = messageTemplateInstaller(d.admin);
	const R = await d.plant({ name: "Riverbend", timezone: "America/Chicago" });
	const B = await d.actor(R, "admin");
	const seeded = async () =>
		Object.fromEntries(
			Object.entries(
				(
					await query(sql`SELECT (SELECT count(*)::int FROM communication) AS schedules,
			(SELECT count(*)::int FROM mail) AS sends,
			(SELECT count(*)::int FROM mail WHERE recipient_account_id IS NOT NULL OR recipient_person_id IS NOT NULL) AS recipients,
			(SELECT count(*)::int FROM job) AS jobs`)
				)[0]!,
			).map(([k, v]) => [k, Number(v)]),
		) as Record<"schedules" | "sends" | "recipients" | "jobs", number>;
	const before = await seeded();
	const installed = ok(await attempt(installer.installMessageTemplates(caller(publisher), { source: SOURCE })));
	assert.equal(installed.installed, result.system_templates);
	assert.equal(installed.systemTemplateCount, result.system_templates);
	assert.equal(installed.systemTemplateCount, exec.template_count);
	assert.equal(await installedTemplates(query), result.system_templates);
	const installedCounts = await seeded();
	assert.deepEqual(
		[
			installedCounts.recipients - before.recipients,
			installedCounts.schedules - before.schedules,
			installedCounts.sends - before.sends,
			installedCounts.jobs - before.jobs,
		],
		[result.seeded_recipients, result.seeded_schedules, result.seeded_sends, 0],
	);
	assert.equal(exec.recipients_in_seed, result.seeded_recipients);

	const actor = await actorOf(B, runtime);
	const invitation = ok(
		await gatedTransaction(runtime, (tx) =>
			communicationWriter.readMeetingTemplate(tx, actor, { meetingType: "vision_meeting" }),
		),
	);
	const shipped = systemTemplates.find((t) => t.sourceKey === "vision-meeting-invitation")!;
	assert.equal(shipped.name.toLowerCase(), String(exec.template).toLowerCase());
	assert.equal(invitation.bodyHtml, shipped.bodyHtml);
	const meeting = randomUUID();
	await d.admin.execute(sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision,agenda,venue_name,venue_address)
		VALUES(${meeting},${R.id},'vision_meeting',NULL,'2026-11-10','18:30','America/Chicago','2026-11-11T00:30:00Z','test','planning',1,'[]'::jsonb,${exec.optional_location},${exec.optional_location})`);
	const quiet = await writes(query);
	const shown = ok(
		await gatedTransaction(runtime, (tx) =>
			communicationWriter.readPreview(tx, actor, {
				bodyHtml: invitation.bodyHtml,
				meetingId: meeting,
				merge: { name: "Alex" },
			}),
		),
	);
	assert.deepEqual(await writes(query), quiet);
	assert.equal(exec.optional_agenda, null);
	for (const text of [shown.previewBody, shown.previewHtml]) {
		assert.equal(/\p{Extended_Pictographic}/u.test(text), result.empty_optional_location_icon, text);
		assert.equal(
			/agenda\s*:|\{\{\s*meeting_(location|agenda)\s*\}\}/i.test(text),
			result.empty_optional_agenda_prefix,
			text,
		);
	}

	assert.equal(exec.tenant_template_fork, "customized");
	const [forkRow] = await query(sql`SELECT subject,body_html FROM message_template WHERE id=${fork.templateId}::uuid`);
	assert.equal(
		!isDeepStrictEqual(forkRow, { subject: "Our invitation", body_html: "<p>Welcome {{name}}.</p>" }),
		result.tenant_fork_overwritten,
	);
	const own = ok(
		await gatedTransaction(runtime, (tx) =>
			communicationWriter.readMeetingTemplate(tx, A.actor, { meetingType: "vision_meeting" }),
		),
	);
	assert.deepEqual([own.templateId, own.bodyHtml], [fork.templateId, "<p>Welcome {{name}}.</p>"]);
});
