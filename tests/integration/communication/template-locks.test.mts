import "../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import type { CommunicationReply } from "../../../packages/domain/src/communication/index.ts";
import { ok, refused, waitingOnLock } from "../../support/fixture.mts";
import {
	rowsFrom,
	writeAs,
	type Church,
	type Fixture,
	type Row,
	type Staff,
	type Value,
	type WriteOp,
} from "./communication-support.mts";

let f: Fixture;
let plant: Church;
let owner: Staff;
const key = () => randomUUID();
const rows = <R extends Row = Row>(query: SQL) => rowsFrom<R>(f, query);
const write = <K extends WriteOp>(op: K, input: unknown) => writeAs(f.db, owner.actor, op, input);
type Settled<T> = { status: "ok"; value: T } | { status: "threw"; error: unknown };
const settled = <T,>(run: Promise<T>): Promise<Settled<T>> =>
	run.then(
		(value) => ({ status: "ok", value }),
		(error: unknown) => ({ status: "threw", error }),
	);

before(async () => {
	f = await fixture();
	plant = await f.workspace();
	const account = await f.account();
	await f.seat(account, plant, "owner");
	owner = { ...account, actor: await f.actor(account.session) };
});
after(() => f?.close());

test("INV-template-locks: deleting a template refuses as referenced when a draft using it commits while the delete waits", async () => {
	const template = ok(
		await write("createTemplate", {
			requestKey: key(),
			input: { name: "Welcome", category: "announcement", subject: "Welcome", bodyHtml: "<p>Hello {{name}}.</p>" },
		}),
	);
	const draftId = randomUUID();
	let deleting!: ReturnType<typeof settled<CommunicationReply<Value<"deleteTemplate">>>>;
	await f.admin.transaction(async (side) => {
		await side.execute(sql`INSERT INTO communication (id, plant_id, author_id, revision, state, subject, template_id, audience)
			VALUES (${draftId}::uuid, ${plant.id}::uuid, ${owner.id}::uuid, 1, 'draft', 'Welcome', ${template.templateId}::uuid,
				'{"groups":[],"teamIds":[],"personIds":[]}'::jsonb)`);
		deleting = settled(
			write("deleteTemplate", {
				requestKey: key(),
				expectedRevision: template.revision,
				input: { templateId: template.templateId },
			}),
		);
		assert.ok(await waitingOnLock(f.db), "the delete waits for the draft's transaction");
	});
	const result = await deleting;
	assert.ok(result.status === "ok", String(result.status === "threw" && result.error));
	refused(result.value, "referenced");
	assert.equal(
		(await rows(sql`SELECT count(*)::int AS n FROM message_template WHERE id = ${template.templateId}::uuid`))[0]!.n,
		1,
	);
});

test("INV-template-locks: a fork that waits on a concurrent fork of the same system template returns that copy", async () => {
	const sourceKey = "general-announcement";
	const concurrent = randomUUID();
	let forking!: ReturnType<typeof settled<CommunicationReply<Value<"forkTemplate">>>>;
	await f.admin.transaction(async (side) => {
		await side.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${plant.id}), hashtext(${sourceKey}))`);
		await side.execute(sql`INSERT INTO message_template (id, plant_id, source_key, name, category, subject, body_html, body_text)
			VALUES (${concurrent}::uuid, ${plant.id}::uuid, ${sourceKey}, 'Concurrent copy', 'announcement', 'Hello', '<p>Hello.</p>', 'Hello.')`);
		forking = settled(write("forkTemplate", { requestKey: key(), input: { sourceKey } }));
		assert.ok(await waitingOnLock(f.db), "the fork waits for the other fork's transaction");
	});
	const result = await forking;
	assert.ok(result.status === "ok", String(result.status === "threw" && result.error));
	const forked = ok(result.value);
	assert.equal(forked.templateId, concurrent);
	assert.equal(forked.name, "Concurrent copy");
	assert.deepEqual(
		await rows(
			sql`SELECT id::text AS id FROM message_template WHERE plant_id = ${plant.id}::uuid AND source_key = ${sourceKey}`,
		),
		[{ id: concurrent }],
	);
	assert.equal(
		(await rows(sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id = ${concurrent}::uuid`))[0]!.n,
		0,
	);
});
