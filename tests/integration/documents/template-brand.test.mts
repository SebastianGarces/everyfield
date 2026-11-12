// T-190 (Nora, Audit #551, Nov 10 2026; DOC-017, BRD-006): a library template's preview and "Save for your church"
// render with the church theme when the church plant has a brand kit and with the Everyfield-neutral theme when it has
// none. Both go through the same render, so a saved file holds the bytes its preview showed. A kit change never changes
// a saved file; a replay on the same request key returns the file saved first.
import { fixture, ok } from "../../support/fixture.mts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { S3Client } from "../../../packages/db/node_modules/@aws-sdk/client-s3/dist-es/index.js";
import sharp from "../../../packages/db/node_modules/sharp/dist/index.mjs";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { brandWriter, uploadBrandAsset } from "../../../packages/domain/src/branding/index.ts";
import { library } from "../../../packages/domain/src/documents/catalog.ts";
import { documentsReader, documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import { resolveMerge } from "../../../packages/domain/src/documents/merge.ts";
import { digestOf, renderPreview } from "../../../packages/domain/src/documents/render.ts";
import { docxParts, pdfOperators, pdfPages } from "./fixtures/readers.mts";
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";

const CHURCH = "Harvest Point";
const database = await fixture({ prefix: "t190", plant: { name: CHURCH } });
const { admin } = database;
const db = database.pools.runtime;
const P = database.tenant.id;
// 0 owner, 1 member
const actors = [database.actors.owner, database.actors.member];

class MemoryClient extends S3Client {
	objects = new Map<string, Buffer>();
	constructor() {
		super({
			region: "us-east-1",
			endpoint: "https://example.invalid",
			forcePathStyle: true,
			credentials: { accessKeyId: "test", secretAccessKey: "test" },
		});
	}
	// @ts-expect-error The test double answers only the commands the code sends.
	async send(command: { constructor: { name: string }; input?: Record<string, unknown> }) {
		const input = (command.input ?? {}) as { Key: string; Body: Uint8Array };
		switch (command.constructor.name) {
			case "GetBucketAclCommand":
				return { Grants: [{ Grantee: { ID: "private-owner" }, Permission: "FULL_CONTROL" }] };
			case "PutObjectCommand":
				this.objects.set(input.Key, Buffer.from(input.Body));
				return {};
			case "GetObjectCommand": {
				const body = this.objects.get(input.Key);
				if (!body) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
				return { ContentLength: body.length, Body: { transformToByteArray: async () => body } };
			}
			case "DeleteObjectCommand":
				this.objects.delete(input.Key);
				return {};
			default:
				throw new Error(`unexpected provider operation ${command.constructor.name}`);
		}
	}
}
const client = new MemoryClient();
const storage = { bucket: "synthetic-only", client } as never;

const authority = async (who = 0) => {
	const actor = await RequestActor.resolve(db, actors[who]!.session);
	assert.ok(actor instanceof RequestActor, JSON.stringify(actor));
	return actor;
};

const PRIMARY = "#8B1E3F";
const NEXT_PRIMARY = "#1F4E79";
const LEGAL = "Harvest Point Church, Inc.";
// A wide logo with a flat block, and a cover photo: the kit rasterizes both.
const logo = await sharp({ create: { width: 600, height: 200, channels: 4, background: "#8B1E3F" } })
	.png()
	.toBuffer();
const photo = await sharp({ create: { width: 1800, height: 600, channels: 3, background: "#556677" } })
	.webp()
	.toBuffer();

let revision = "0";
async function attach(slot: "full_logo" | "cover_photo", mediaType: string, bytes: Buffer) {
	const owner = await authority(0);
	const altText = `${CHURCH} ${slot}`;
	const ticket = ok(await brandWriter.requestUpload(db, owner, { slot, mediaType, byteLength: bytes.length, altText }));
	ok(await uploadBrandAsset(db, storage, owner, { uploadId: ticket.uploadId, bytes }));
	revision = ok(
		await brandWriter.finalizeUpload(db, owner, { uploadId: ticket.uploadId, slot, altText, expectedRevision: revision }),
	).revision;
}
async function saveKit(patch: Record<string, unknown>) {
	revision = ok(await brandWriter.saveSettings(db, await authority(0), { expectedRevision: revision, patch })).revision;
}
async function resetKit() {
	ok(await brandWriter.reset(db, await authority(0), { expectedRevision: revision }));
	revision = "0";
}

/** Every required field of a template filled, so each template renders. */
async function overridesFor(templateId: string) {
	const { templates } = await library();
	const template = templates.find((item) => item.id === templateId)!;
	return Object.fromEntries(
		template.mergeFields.filter((f) => f.required && f.key !== "church_name").map((f) => [f.key, "Sample"]),
	);
}
/** The Everyfield-neutral render of a template for this plant, with no theme given at all. */
async function neutralDigest(templateId: string, format: "pdf" | "xlsx") {
	const { templates } = await library();
	const template = templates.find((item) => item.id === templateId)!;
	const merge = resolveMerge(
		template,
		{ churchName: CHURCH, pastorName: null, launchDate: null },
		await overridesFor(templateId),
	);
	assert.ok(merge.ok);
	return digestOf((await renderPreview(template, format, merge))!);
}
async function preview(templateId: string, format: "pdf" | "xlsx" = "pdf", who = 0, store: unknown = storage) {
	const value = ok(
		await documentsReader.preview(
			db,
			await authority(who),
			{ templateId, format, overrides: await overridesFor(templateId) },
			store as never,
		),
	);
	assert.ok(value.artifact && value.digest);
	return { ...value, bytes: Buffer.from(value.artifact, "base64") };
}
async function save(templateId: string, requestKey: string, format: "pdf" | "xlsx" = "pdf") {
	return ok(
		await documentsWriter.generate(
			db,
			await authority(0),
			{ templateId, format, overrides: await overridesFor(templateId), requestKey },
			storage,
		),
	);
}
/** The stored bytes of one saved file, read straight from private storage. */
async function storedBytes(id: string) {
	const row = (
		await admin.execute(
			sql`SELECT f.opaque_key FROM generated_document g JOIN file_object f ON f.id = g.object_id WHERE g.id = ${id}::uuid`,
		)
	).rows[0] as { opaque_key: string };
	return client.objects.get(row.opaque_key)!;
}
const rgb = (hex: string) =>
	[1, 3, 5].map((i) => +(parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3).replace(/0+$/, "")).join(" ");
const paints = async (bytes: Buffer, hex: string) => (await pdfOperators(bytes)).includes(rgb(hex));
const hasImage = async (bytes: Buffer) => /\/XObject/.test(await pdfOperators(bytes));

before(async () => {
	await admin.execute(sql`DELETE FROM church_brand_kit WHERE tenant_id = ${P}::uuid`);
});
after(async () => {
	await database.close();
});

describe("T-190 library templates follow the church brand kit", { concurrency: 1 }, () => {
	test("with no brand kit the preview is the neutral render, says so, and Save for your church stores it", async () => {
		for (const id of ["guest-sign-in-sheet", "commitment-card"]) {
			const shown = await preview(id);
			assert.equal(shown.brandKit, false);
			assert.equal(shown.digest, await neutralDigest(id, "pdf"), `${id} is byte-identical to the neutral render`);
			assert.equal(await hasImage(shown.bytes), false);
			assert.equal(await paints(shown.bytes, PRIMARY), false);
			const saved = await save(id, `t190-none-${id}`);
			assert.equal(saved.digest, shown.digest);
			assert.equal(digestOf(await storedBytes(saved.id)), shown.digest);
			assert.equal(saved.theme, null);
		}
		const sheet = await preview("budget-worksheet", "xlsx");
		assert.equal(sheet.brandKit, false);
		assert.equal(sheet.digest, await neutralDigest("budget-worksheet", "xlsx"));
		const styles = docxParts(await storedBytes((await save("budget-worksheet", "t190-none-xlsx", "xlsx")).id))[
			"xl/styles.xml"
		]!;
		assert.ok(!styles.includes(`FF${PRIMARY.slice(1)}`));
	});

	test("with a brand kit the preview paints the kit's colors, logo and legal name, for a Member too", async () => {
		await saveKit({ primaryColor: PRIMARY, legalName: LEGAL, tagline: "A church for the whole valley." });
		await attach("full_logo", "image/png", logo);
		await attach("cover_photo", "image/webp", photo);
		for (const id of ["guest-sign-in-sheet", "commitment-card", "launch-sunday-checklists"]) {
			const shown = await preview(id);
			assert.equal(shown.brandKit, true);
			assert.notEqual(shown.digest, await neutralDigest(id, "pdf"));
			assert.equal(await paints(shown.bytes, PRIMARY), true, `${id} paints the primary color`);
			assert.equal(await hasImage(shown.bytes), true, `${id} shows the kit's logo`);
			const member = await preview(id, "pdf", 1);
			assert.equal(member.brandKit, true);
			assert.equal(member.digest, shown.digest, "a Member sees the same church-themed preview");
		}
		const sheet = (await pdfPages((await preview("guest-sign-in-sheet")).bytes)).join(" ");
		assert.match(sheet, new RegExp(`${LEGAL.replace(/[.,]/g, "\\$&")}\\s+\\|\\s+Guest sign-in sheet`));
		const card = (await pdfPages((await preview("commitment-card")).bytes)).join(" ");
		assert.match(card, /A church for the whole valley\./);
	});

	test("with a brand kit Save for your church stores the preview's bytes, and the budget worksheet uses the kit's colors", async () => {
		for (const id of ["guest-sign-in-sheet", "commitment-card"]) {
			const shown = await preview(id);
			const saved = await save(id, `t190-kit-${id}`);
			assert.equal(saved.digest, shown.digest);
			assert.equal(digestOf(await storedBytes(saved.id)), shown.digest);
			assert.equal(saved.theme, null, "a template save records no theme");
		}
		const sheet = await preview("budget-worksheet", "xlsx");
		assert.equal(sheet.brandKit, true);
		assert.notEqual(sheet.digest, await neutralDigest("budget-worksheet", "xlsx"));
		const saved = await save("budget-worksheet", "t190-kit-xlsx", "xlsx");
		assert.equal(saved.digest, sheet.digest);
		assert.ok(docxParts(await storedBytes(saved.id))["xl/styles.xml"]!.includes(`FF${PRIMARY.slice(1)}`));
	});

	test("a kit change keeps a saved file's bytes, a replay returns the first file, and a new key renders the kit now", async () => {
		const first = await save("guest-sign-in-sheet", "t190-change");
		const firstBytes = digestOf(await storedBytes(first.id));
		await saveKit({ primaryColor: NEXT_PRIMARY });
		assert.equal(digestOf(await storedBytes(first.id)), firstBytes, "the stored file did not change");
		ok(await documentsWriter.download(db, await authority(0), { documentId: first.id }, storage));
		const replay = await save("guest-sign-in-sheet", "t190-change");
		assert.equal(replay.id, first.id);
		assert.equal(replay.digest, first.digest, "the replay is the file saved first, not a conflict");
		const now = await preview("guest-sign-in-sheet");
		const again = await save("guest-sign-in-sheet", "t190-change-2");
		assert.notEqual(again.digest, first.digest);
		assert.equal(again.digest, now.digest);
		assert.equal(await paints(await storedBytes(again.id), NEXT_PRIMARY), true);
	});

	test("an asset that cannot be read leaves the church name in type and keeps the kit's colors", async () => {
		const full = await preview("guest-sign-in-sheet");
		const noStorage = await preview("guest-sign-in-sheet", "pdf", 0, null);
		assert.equal(noStorage.brandKit, true);
		assert.equal(await paints(noStorage.bytes, NEXT_PRIMARY), true);
		assert.equal(await hasImage(noStorage.bytes), false);
		assert.notEqual(noStorage.digest, full.digest);
		assert.match((await pdfPages(noStorage.bytes)).join(" "), new RegExp(CHURCH));
		// A missing file in storage reads the same as no storage.
		const kept = new Map(client.objects);
		const logoKey = (
			await admin.execute(
				sql`SELECT f.opaque_key FROM church_brand_kit k JOIN file_object f ON f.id = k.full_logo_object_id WHERE k.tenant_id = ${P}::uuid`,
			)
		).rows[0] as { opaque_key: string };
		client.objects.delete(logoKey.opaque_key);
		try {
			const missing = await preview("guest-sign-in-sheet");
			assert.equal(missing.digest, noStorage.digest);
		} finally {
			client.objects = kept;
		}
	});

	test("Reset to default returns the preview to the neutral render and the no-kit line", async () => {
		await resetKit();
		const shown = await preview("guest-sign-in-sheet");
		assert.equal(shown.brandKit, false);
		assert.equal(shown.digest, await neutralDigest("guest-sign-in-sheet", "pdf"));
	});
});
