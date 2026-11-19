import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fixture, ok } from "../../support/fixture.mts";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import { EXPORT_MESSAGES } from "../../../apps/web/src/features/documents/church/refusal.ts";
import { capturedLines, withSwitchOff } from "../../support/flags.mts";

const database = await fixture({ prefix: "t472x", plant: { name: "Harvest Point" } });
after(() => database.close());
const { admin } = database;
const db = database.pools.runtime;
const owner = database.actors.owner;

const objects = new Map<string, Buffer>();
const puts: string[] = [];
const storage = {
	bucket: "synthetic-only",
	client: {
		async send(command: { constructor: { name: string }; input: { Key: string; Body?: Uint8Array } }) {
			const { Key, Body } = command.input;
			switch (command.constructor.name) {
				case "GetBucketAclCommand":
					return { Grants: [{ Grantee: { ID: "private-owner" }, Permission: "FULL_CONTROL" }] };
				case "PutObjectCommand":
					puts.push(Key);
					objects.set(Key, Buffer.from(Body!));
					return {};
				case "GetObjectCommand": {
					const body = objects.get(Key);
					if (!body) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
					return { ContentLength: body.length, Body: { transformToByteArray: async () => body } };
				}
				default:
					throw new Error(`unexpected provider operation ${command.constructor.name}`);
			}
		},
	},
} as never;

const authority = async () => {
	const actor = await RequestActor.resolve(db, owner.session as never);
	assert.ok(actor instanceof RequestActor);
	return actor;
};
const count = async (query: ReturnType<typeof sql>) => Number((await admin.execute(query)).rows[0]!.n);
const counts = async () => ({
	generated: await count(sql`SELECT count(*)::int AS n FROM generated_document`),
	files: await count(sql`SELECT count(*)::int AS n FROM file_object WHERE purpose = 'generated'`),
	audits: await count(sql`SELECT count(*)::int AS n FROM audit_event WHERE action LIKE 'documents.%'`),
});
const exportDoc = async (documentId: string, requestKey: string) =>
	documentsWriter.exportNative(db, await authority(), { documentId, revision: 1, format: "pdf", requestKey }, storage);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("with document-exports off, saving an export is refused before rendering with no row or stored object; an earlier export still downloads; back on, it saves", async () => {
	const doc = ok(
		await documentsWriter.createFromTemplate(db, await authority(), {
			templateId: "conflict-of-interest-policy",
			requestKey: "t472-policy",
		}),
	) as { id: string };
	const earlier = ok(await exportDoc(doc.id, "t472-earlier")) as { id: string; digest: string };
	const before = await counts();
	const stored = puts.length;

	const { value, lines } = await capturedLines(() =>
		withSwitchOff(db, { flag: "document-exports", operator: owner.id }, async () => {
			const reply = await exportDoc(doc.id, "t472-paused");
			const file = ok(
				await documentsWriter.readExportFile(
					db,
					await authority(),
					{ documentId: doc.id, exportId: earlier.id },
					storage,
				),
			) as { bytes: string };
			return { reply, file };
		}),
	);
	assert.equal(value!.reply.status, "refused");
	assert.equal((value!.reply as { error: { code: string } }).error.code, "exports_paused");
	assert.deepEqual(await counts(), before, "no generated_document row, file or audit row");
	assert.equal(puts.length, stored, "nothing was stored");
	assert.equal(
		sha256(Buffer.from(value!.file.bytes, "base64")),
		earlier.digest,
		"an export saved earlier still downloads",
	);
	assert.deepEqual(
		lines.map((l) => [l.switch, l.action]),
		[["document-exports", "documents.exportNative"]],
	);
	assert.equal(
		EXPORT_MESSAGES.exports_paused,
		"Saving exports is paused for now, so nothing was saved or downloaded. Exports you saved earlier still download. Try again later.",
	);

	const saved = ok(await exportDoc(doc.id, "t472-paused")) as { id: string };
	assert.notEqual(saved.id, earlier.id, "back on, with no restart or deploy");
	assert.equal((await counts()).generated, before.generated + 1);
});
