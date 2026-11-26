import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "../../../../packages/db/node_modules/sharp/dist/index.mjs";
import { sql } from "../../../../packages/db/src/query.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import {
	brandWriter,
	readBrandAssetIfChanged,
	uploadBrandAsset,
} from "../../../../packages/domain/src/branding/index.ts";
import { library } from "../../../../packages/domain/src/documents/catalog.ts";
import { documentsReader, documentsWriter } from "../../../../packages/domain/src/documents/index.ts";
import {
	personFields,
	readPersonPhoto,
	uploadPersonPhoto,
	withPeopleWrite,
} from "../../../../packages/domain/src/people/index.ts";
import { fixture, ok, type Actor } from "../../../support/fixture.mts";
import { MemoryClient } from "../../documents/storage.mts";
import { caseOf } from "../sql/core/support.mts";

const c = caseOf("schema", "TEN-004");
const database = await fixture({
	prefix: "tenfiles",
	plant: { name: "Harvest Point" },
});
const { admin } = database;
const db = database.pools.runtime;
const P = database.tenant;
const client = new MemoryClient();
const storage = { bucket: "synthetic-only", client };
after(() => database.close());

const one = async (query: ReturnType<typeof sql>) => (await admin.execute(query)).rows[0] ?? assert.fail("no row");
const count = async (query: ReturnType<typeof sql>) => Number((await one(query)).n);
const actorOf = async (who: Actor) => {
	const found = await RequestActor.resolve(db, who.session);
	assert.ok(found instanceof RequestActor, JSON.stringify(found));
	return found;
};
const endSeat = (who: Actor) =>
	admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${who.id} AND plant_id=${P.id}`);
const demote = (who: Actor) =>
	admin.execute(sql`UPDATE seat SET role='member' WHERE account_id=${who.id} AND plant_id=${P.id}`);
const files = () => count(sql`SELECT count(*)::int AS n FROM file_object WHERE tenant_id=${P.id}`);
const puts = { n: 0 };
const send = client.send.bind(client);
client.send = ((command: Parameters<typeof send>[0]) => {
	if (command.constructor.name === "PutObjectCommand") puts.n += 1;
	return send(command);
}) as typeof client.send;
const body = (reply: { status: string; value?: unknown }) => {
	if (reply.status !== "ok") return null;
	const value = reply.value as { url?: string; bytes?: Uint8Array | null };
	return value.url ?? value.bytes ?? null;
};
const logo = await sharp({
	create: { width: 200, height: 120, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
	.composite([{ input: { create: { width: 120, height: 60, channels: 4, background: "#2E7D32" } }, left: 40, top: 30 }])
	.png()
	.toBuffer();
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPgEpH7DwABpAE8sdwFIwAAAABJRU5ErkJggg==",
	"base64",
);
async function person(name: string) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at) VALUES(${id},${P.id},${P.id},${name},'other','prospect','unknown',
		'unknown',0,'live',clock_timestamp())`);
	return id;
}
const people = (who: Actor) => ({ session: who.session, selected: P });
const writePeople = async <T,>(
	who: Actor,
	run: (tx: never, ctx: never) => Promise<T>,
): Promise<{ status: string; value?: unknown }> =>
	withPeopleWrite(db, await actorOf(who), run as never) as Promise<{ status: string; value?: unknown }>;
async function photoIntent(who: Actor, personId: string) {
	return ok(
		(await writePeople(who, ((tx: never, ctx: never) =>
			personFields.requestPersonPhotoUpload(tx, ctx, {
				requestKey: randomUUID(),
				personId,
				mime: "image/png",
				byteLength: PNG.length,
			})) as never)) as never,
	) as { uploadId: string };
}
const setPhoto = async (who: Actor, personId: string, uploadId: string) => {
	const { r } = await one(sql`SELECT revision::text AS r FROM person WHERE id=${personId}`);
	return writePeople(who, ((tx: never, ctx: never) =>
		personFields.setPersonPhoto(tx, ctx, {
			requestKey: randomUUID(),
			expectedRevision: String(r),
			input: { personId, uploadId },
		})) as never);
};
async function brandIntent(who: RequestActor) {
	return ok(
		await brandWriter.requestUpload(db, who, {
			slot: "full_logo",
			mediaType: "image/png",
			byteLength: logo.length,
			altText: "Harvest Point logo",
		}),
	);
}

test("AC:TEN-004 a role or seat revoked after a reviewed preview, an upload intent, a finalize, a download or a warm cache read lets nothing new commit and returns no body, and the earlier completed result stays without being replayed", async () => {
	const { result } = c.expected;
	const execution = c.given.execution as Record<string, unknown>;
	assert.deepEqual(
		[execution.preview_grant, execution.current_grant, execution.prior_effect_status],
		[true, false, "completed"],
	);
	const outcomes = { commits: [] as string[], bodies: [] as unknown[] };
	const commit = (name: string, reply: { status: string }) => {
		if (reply.status === "ok") outcomes.commits.push(name);
	};

	const A = await database.actor(P, "admin");
	const card = (await library()).templates.find((t) => t.id === "commitment-card") ?? assert.fail("no card");
	const generate = async (who: Actor, requestKey: string) =>
		documentsWriter.generate(db, await actorOf(who), { templateId: card.id, format: "pdf", requestKey }, storage);
	const priorKey = randomUUID();
	const prior = ok(await generate(A, priorKey));
	const preview = ok(await documentsReader.preview(db, await actorOf(A), { templateId: card.id, format: "pdf" }));
	assert.equal(preview.digest, prior.digest);
	const actorA = await actorOf(A);
	const before = { files: await files(), puts: puts.n };
	await endSeat(A);
	commit("generate after the reviewed preview", await generate(A, randomUUID()));
	const replay = await generate(A, priorKey);
	commit("replay of the completed generate", replay);
	outcomes.bodies.push(body(await documentsWriter.download(db, actorA, { documentId: prior.id }, storage)));
	assert.deepEqual({ files: await files(), puts: puts.n }, before, "no file row and no provider put");
	const stored =
		await one(sql`SELECT f.state, (SELECT count(*)::int FROM generated_document g WHERE g.id=${prior.id}) AS kept,
		(SELECT count(*)::int FROM audit_event a WHERE a.action='documents.generated' AND a.tenant_id=${P.id}) AS audits
		FROM generated_document g JOIN file_object f ON f.id=g.object_id WHERE g.id=${prior.id}`);
	assert.deepEqual(stored, { state: "ready", kept: 1, audits: 1 });

	const B = await database.actor(P, "admin");
	const alex = await person("Alex Rivera");
	const intent = await photoIntent(B, alex);
	await endSeat(B);
	commit(
		"photo upload after its intent",
		await uploadPersonPhoto(db, storage, people(B) as never, { ...intent, bytes: PNG }),
	);
	assert.equal(
		(await one(sql`SELECT state FROM file_object WHERE id=${intent.uploadId}`)).state,
		"pending",
		"the revoked upload never becomes a ready object",
	);
	const C = await database.actor(P, "admin");
	const uploaded = await photoIntent(C, alex);
	ok(await uploadPersonPhoto(db, storage, people(C) as never, { ...uploaded, bytes: PNG }));
	await endSeat(C);
	commit("photo finalize after its upload", await setPhoto(C, alex, uploaded.uploadId));
	assert.equal((await one(sql`SELECT photo_object_id FROM person WHERE id=${alex}`)).photo_object_id, null);

	const D = await database.actor(P, "admin");
	const shown = await photoIntent(D, alex);
	ok(await uploadPersonPhoto(db, storage, people(D) as never, { ...shown, bytes: PNG }));
	ok(await setPhoto(D, alex, shown.uploadId));
	const version = { personId: alex, versionId: shown.uploadId };
	assert.deepEqual(Buffer.from(ok(await readPersonPhoto(db, storage, people(D) as never, version)).bytes), PNG);
	const fetch = client.send;
	client.send = ((command: Parameters<typeof send>[0]) =>
		command.constructor.name === "GetObjectCommand"
			? endSeat(D).then(() => fetch(command))
			: fetch(command)) as typeof client.send;
	try {
		outcomes.bodies.push(body(await readPersonPhoto(db, storage, people(D) as never, version)));
	} finally {
		client.send = fetch;
	}
	outcomes.bodies.push(body(await readPersonPhoto(db, storage, people(D) as never, version)));

	const E = await database.actor(P, "admin");
	const actorE = await actorOf(E);
	const brand = await brandIntent(actorE);
	await demote(E);
	commit(
		"brand upload after its intent",
		await uploadBrandAsset(db, storage, actorE, { uploadId: brand.uploadId, bytes: logo }),
	);
	const F = await database.actor(P, "admin");
	const actorF = await actorOf(F);
	const staged = await brandIntent(actorF);
	const sent = ok(await uploadBrandAsset(db, storage, actorF, { uploadId: staged.uploadId, bytes: logo }));
	const { r: kit } = await one(
		sql`SELECT coalesce((SELECT revision::text FROM church_brand_kit WHERE tenant_id=${P.id}),'0') AS r`,
	);
	await demote(F);
	commit(
		"brand finalize after its upload",
		await brandWriter.finalizeUpload(db, actorF, {
			uploadId: staged.uploadId,
			slot: "full_logo",
			altText: "Harvest Point logo",
			expectedRevision: String(kit),
		}),
	);
	await admin.execute(sql`UPDATE seat SET role='admin' WHERE account_id=${F.id}`);
	ok(
		await brandWriter.finalizeUpload(db, actorF, {
			uploadId: staged.uploadId,
			slot: "full_logo",
			altText: "Harvest Point logo",
			expectedRevision: String(kit),
		}),
	);
	const warm = (sha: string) => readBrandAssetIfChanged(db, storage, actorF, staged.uploadId, (s) => s === sha);
	assert.deepEqual(ok(await warm(sent.sha256)).bytes, null, "a warm cache is told the copy is current");
	await demote(F);
	const cached = await warm(sent.sha256);
	assert.equal(cached.status, "refused", "a warm cache read is re-authorized, not answered from the cache");
	outcomes.bodies.push(body(cached), body(await warm("stale")));

	assert.deepEqual(outcomes.commits, []);
	assert.deepEqual(
		{
			new_commit_allowed: outcomes.commits.length > 0,
			new_body: outcomes.bodies.find((b) => b !== null) ?? null,
			prior_receipt_status: stored.state === "ready" && stored.kept === 1 ? "completed" : stored.state,
			prior_effect_replayed: replay.status === "ok",
		},
		result,
	);
	assert.equal((c.expected as { event?: unknown }).event, null);
});
