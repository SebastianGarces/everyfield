import { fixture, ok, refused, type Actor } from "../../support/fixture.mts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import { DISCOVERY_TEMPLATE_IDS } from "../../../packages/domain/src/documents/own-templates.ts";
import { LEGAL_NOTICE, nativeFromText, nativeText } from "../../../packages/contracts/src/documents/index.ts";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const database = await fixture({ prefix: "t661doc", plant: { name: "Harvest Point" } });
const { admin } = database;
const db = database.pools.runtime;
const planter = await database.actor(null, "owner", { user: { name: "Jo Planter" } });
await admin.execute(sql`INSERT INTO discovery(id,account_id,revision) VALUES(${randomUUID()},${planter.id},1)`);
const former = await database.actor(null, "owner", { account: { registration_kind: "planter" } });
const sending = await database.organization("sending_church");
const director = await database.actor(sending, "owner");

after(() => database.close());

const authority = async (who: Actor) => {
	const actor = await RequestActor.resolve(db, who.session);
	assert.ok(actor instanceof RequestActor, JSON.stringify(actor));
	return actor;
};
const make = async (who: Actor, templateId: string, requestKey = randomUUID()) =>
	documentsWriter.createMineFromTemplate(db, await authority(who), { templateId, requestKey });
const text = (body: Parameters<typeof nativeText>[0]) => nativeText(body);
const titles = async (who: Actor, own = true) => {
	const a = await authority(who);
	const listed = own ? await documentsWriter.listMine(db, a, {}) : await documentsWriter.listOwned(db, a, {});
	return listed.status === "ok" ? listed.value.documents.map((d) => d.title).sort() : listed.error.code;
};

test("AC:DOC-022 INV-tenancy: a Discovery planter makes a private document from each of the five templates", async () => {
	const made = new Map<string, Awaited<ReturnType<typeof make>>>();
	for (const id of DISCOVERY_TEMPLATE_IDS) made.set(id, await make(planter, id));
	for (const [id, result] of made) {
		const doc = ok(result);
		assert.equal(doc.tenantId, planter.id, id);
		assert.equal(doc.kind, "native", id);
		const body = text(doc.body);
		assert.match(body, /\[church name\]/, id);
		assert.doesNotMatch(body, /Harbor City|Daniel Reyes/, id);
	}
	assert.match(text(ok(made.get("follow-up-letter")!).body), /With gratitude,\nJo Planter\n\[church name\]/);
	assert.match(text(ok(made.get("prayer-letter")!).body), /Jo Planter/);
	assert.ok(text(ok(made.get("bylaws")!).body).startsWith(LEGAL_NOTICE));
	assert.deepEqual(await titles(planter), [
		"Bylaws",
		"Expectations of a Core Group Member",
		"Launch Team Commitment",
		"Prayer Letter",
		"Vision Meeting Follow-up Letter",
	]);
});

test("AC:DOC-022 a repeated request makes one document, and other templates and accounts are refused", async () => {
	const key = randomUUID();
	const first = ok(await make(planter, "bylaws", key));
	const again = ok(await make(planter, "bylaws", key));
	assert.equal(again.id, first.id);
	const [count] = (
		await admin.execute<{ n: number }>(
			sql`SELECT count(*)::int AS n FROM audit_event WHERE request_key=${key} AND tenant_id=${planter.id}::uuid`,
		)
	).rows;
	assert.equal(count?.n, 1);
	refused(await make(planter, "prayer-letter", key), "conflict");
	for (const id of ["budget-worksheet", "commitment-card", "guest-sign-in-sheet", "church-template-record"])
		refused(await make(planter, id));
	refused(await make(former, "bylaws"));
	refused(await make(database.actors.owner, "bylaws"));
	refused(await make(director, "bylaws"));
});

test("INV-tenancy AC:DOC-016: documents written in Discovery stay the planter's own after they start a church", async () => {
	const written = ok(
		await documentsWriter.saveNative(db, await authority(planter), {
			title: "Call notes",
			body: nativeFromText("Why I am planting"),
			expectedRevision: "0",
		}),
	);
	const church = await database.plant({ name: "New Hope" });
	await database.seat(planter, church, "owner");
	await admin.execute(sql`UPDATE discovery SET converted_at=clock_timestamp(), converted_plant_id=${church.id}::uuid
		WHERE account_id=${planter.id}::uuid`);
	const teamAdmin = await database.actor(church, "admin");
	const teamMember = await database.actor(church, "member");

	const own = await authority(planter);
	assert.ok((await titles(planter)) instanceof Array && (await titles(planter)).includes("Call notes"));
	assert.equal(((await titles(planter, false)) as string[]).includes("Call notes"), false);
	const opened = ok(await documentsWriter.readMine(db, own, { documentId: written.id }));
	refused(await documentsWriter.read(db, own, { documentId: written.id }));
	const edited = ok(
		await documentsWriter.saveMine(db, own, {
			documentId: written.id,
			title: "Call notes",
			body: nativeFromText("Why I am planting, edited in the church"),
			expectedRevision: opened.revision,
		}),
	);
	assert.equal(edited.tenantId, planter.id);
	assert.equal(
		text(ok(await documentsWriter.readMine(db, own, { documentId: written.id })).body),
		"Why I am planting, edited in the church",
	);

	for (const other of [teamAdmin, teamMember, database.actors.owner, director, former]) {
		const a = await authority(other);
		refused(await documentsWriter.read(db, a, { documentId: written.id }));
		refused(await documentsWriter.readMine(db, a, { documentId: written.id }));
		refused(
			await documentsWriter.saveMine(db, a, {
				documentId: written.id,
				title: "Taken",
				body: nativeFromText("x"),
				expectedRevision: edited.revision,
			}),
		);
		const listed = await titles(other, true);
		assert.equal(Array.isArray(listed) && listed.includes("Call notes"), false);
		const church = await titles(other, false);
		assert.equal(Array.isArray(church) && church.includes("Call notes"), false);
	}

	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${planter.id}::uuid`);
	assert.ok(((await titles(planter, false)) as string[]).includes("Call notes"));
});
