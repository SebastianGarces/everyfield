import { fixture, ok, refused, type Actor } from "../../support/fixture.mts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import { DISCOVERY_TEMPLATE_IDS } from "../../../packages/domain/src/documents/own-templates.ts";
import { LEGAL_NOTICE, nativeFromText, nativeText } from "../../../packages/contracts/src/documents/index.ts";
import { MemoryClient } from "./storage.mts";
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

test("AC:CASE-DOC-022 INV-tenancy: a Discovery planter makes a private document from each of the five templates", async () => {
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

test("AC:CASE-DOC-022 a repeated request makes one document, and other templates and accounts are refused", async () => {
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

test("INV-tenancy AC:CASE-DOC-016: documents written in Discovery stay the planter's own after they start a church", async () => {
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

	const storage = { bucket: "synthetic-only", client: new MemoryClient() };
	const imported = ok(
		await documentsWriter.importMine(
			db,
			own,
			{
				title: "Imported notes",
				format: "text",
				bytes: Buffer.from("Read in the church"),
				expectedRevision: "0",
				requestKey: randomUUID(),
			},
			storage,
		),
	);
	assert.equal(imported.tenantId, planter.id);
	const values = ok(
		await documentsWriter.designateMine(db, own, { documentId: imported.id, expectedRevision: imported.revision }),
	);
	assert.equal(values.kind, "core_values");
	ok(await documentsWriter.archiveMine(db, own, { documentId: imported.id, expectedRevision: values.revision }));
	refused(
		await documentsWriter.archiveMine(db, await authority(teamAdmin), {
			documentId: written.id,
			expectedRevision: edited.revision,
		}),
	);

	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${planter.id}::uuid`);
	assert.ok(((await titles(planter, false)) as string[]).includes("Call notes"));
});

test("INV-tenancy AC:CASE-DOC-016: after a Discovery planter starts a church, Use for this church copies one Discovery document and leaves the original private", async () => {
	const ruth = await database.actor(null, "owner", { user: { name: "Ruth Planter" } });
	await admin.execute(sql`INSERT INTO discovery(id,account_id,revision) VALUES(${randomUUID()},${ruth.id},1)`);
	const inDiscovery = await authority(ruth);
	const notes = ok(
		await documentsWriter.saveNative(db, inDiscovery, {
			title: "Harbor vision notes",
			body: nativeFromText("We will gather near the river"),
			expectedRevision: "0",
		}),
	);
	const letter = ok(
		await documentsWriter.saveNative(db, inDiscovery, {
			title: "Sending letter",
			body: nativeFromText("Dear friends"),
			expectedRevision: "0",
		}),
	);
	const church = await database.plant({ name: "River Gate" });
	await database.seat(ruth, church, "owner");
	await admin.execute(sql`UPDATE discovery SET converted_at=clock_timestamp(), converted_plant_id=${church.id}::uuid
		WHERE account_id=${ruth.id}::uuid`);
	const teamAdmin = await database.actor(church, "admin");
	const teamMember = await database.actor(church, "member");
	const own = await authority(ruth);
	const count = async (query: ReturnType<typeof sql>) => (await admin.execute<{ n: number }>(query)).rows[0]?.n ?? -1;
	const churchDocuments = () => count(sql`SELECT count(*)::int AS n FROM document WHERE tenant_id=${church.id}::uuid`);
	const copies = (revisionId: string) =>
		count(sql`SELECT count(*)::int AS n FROM document WHERE copied_from_revision_id=${revisionId}::uuid`);
	const audits = (requestKey: string) =>
		count(sql`SELECT count(*)::int AS n FROM audit_event WHERE request_key=${requestKey}`);

	const sources = ok(await documentsWriter.listCopySources(db, own, {})).documents;
	assert.deepEqual(sources.map((s) => [s.title, s.revisionId]).sort(), [
		["Harbor vision notes", notes.revisionId],
		["Sending letter", letter.revisionId],
	]);

	for (const other of [teamAdmin, teamMember, director, database.actors.owner]) {
		const a = await authority(other);
		const listed = await documentsWriter.listCopySources(db, a, {});
		const ids = listed.status === "ok" ? listed.value.documents.map((d) => d.id) : [];
		assert.equal(ids.includes(notes.id), false);
		const guessed = randomUUID();
		refused(
			await documentsWriter.useForChurch(db, a, {
				documentId: notes.id,
				revisionId: notes.revisionId,
				requestKey: guessed,
			}),
		);
		assert.equal(await copies(notes.revisionId), 0);
		assert.equal(await audits(guessed), 0);
	}

	const requestKey = randomUUID();
	const copy = ok(
		await documentsWriter.useForChurch(db, own, { documentId: notes.id, revisionId: notes.revisionId, requestKey }),
	);
	assert.equal(copy.tenantId, church.id);
	assert.notEqual(copy.id, notes.id);
	assert.equal(copy.title, "Harbor vision notes");
	assert.equal(text(copy.body), "We will gather near the river");
	assert.equal(copy.copiedFromRevisionId, notes.revisionId);
	assert.equal(
		ok(await documentsWriter.useForChurch(db, own, { documentId: notes.id, revisionId: notes.revisionId, requestKey }))
			.id,
		copy.id,
	);
	assert.equal(await copies(notes.revisionId), 1);
	assert.equal(await audits(requestKey), 1);

	for (const seat of [ruth, teamAdmin, teamMember]) {
		const a = await authority(seat);
		const listed = ok(await documentsWriter.listOwned(db, a, {})).documents.map((d) => [d.id, d.title]);
		assert.deepEqual(listed, [[copy.id, "Harbor vision notes"]]);
		assert.equal(
			text(ok(await documentsWriter.read(db, a, { documentId: copy.id })).body),
			"We will gather near the river",
		);
	}
	const mine = ok(await documentsWriter.listMine(db, own, {})).documents.map((d) => d.id);
	assert.deepEqual(mine.sort(), [notes.id, letter.id].sort());
	const original = ok(await documentsWriter.readMine(db, own, { documentId: notes.id }));
	assert.equal(original.tenantId, ruth.id);
	assert.equal(original.revisionId, notes.revisionId);
	assert.equal(text(original.body), "We will gather near the river");

	const editedCopy = ok(
		await documentsWriter.saveNative(db, own, {
			documentId: copy.id,
			title: "Harbor vision notes",
			body: nativeFromText("The church will gather near the river"),
			expectedRevision: copy.revision,
		}),
	);
	assert.equal(
		text(ok(await documentsWriter.readMine(db, own, { documentId: notes.id })).body),
		"We will gather near the river",
	);
	const editedOriginal = ok(
		await documentsWriter.saveMine(db, own, {
			documentId: notes.id,
			title: "Harbor vision notes",
			body: nativeFromText("Ruth's private second thoughts"),
			expectedRevision: original.revision,
		}),
	);
	const readCopy = ok(await documentsWriter.read(db, own, { documentId: copy.id }));
	assert.equal(text(readCopy.body), "The church will gather near the river");
	assert.equal(readCopy.revision, editedCopy.revision);
	assert.equal(readCopy.copiedFromRevisionId, notes.revisionId);

	const before = await churchDocuments();
	const stale = randomUUID();
	refused(
		await documentsWriter.useForChurch(db, own, {
			documentId: notes.id,
			revisionId: notes.revisionId,
			requestKey: stale,
		}),
	);
	assert.equal(await churchDocuments(), before);
	assert.equal(await audits(stale), 0);
	assert.notEqual(editedOriginal.revisionId, notes.revisionId);
});
