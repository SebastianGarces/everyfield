import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { migrate } from "../../../packages/db/src/schema/migrate.ts";
import { S3Client } from "../../../packages/db/node_modules/@aws-sdk/client-s3/dist-es/index.js";
import sharp from "../../../packages/db/node_modules/sharp/dist/index.mjs";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import {
	brandReader,
	brandWriter,
	readBrandAsset,
	uploadBrandAsset,
} from "../../../packages/domain/src/branding/index.ts";
import { documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
const localCi =
	process.env.CI === "true" &&
	process.env.EARLY_ACCESS_TEST_DATABASE === "1" &&
	["localhost", "127.0.0.1"].includes(source.hostname) &&
	source.pathname === "/everyfield_ci";
if (
	(!localCi && source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech") ||
	process.env.NODE_ENV === "production"
)
	throw Error("Only approved shared development or disposable CI endpoint allowed");
if (!localCi) source.searchParams.set("sslmode", "verify-full");

const schema = "wp104_" + randomUUID().replaceAll("-", "");
const roleName = "wp104_" + randomBytes(8).toString("hex");
const admin = createDatabase({
	connectionString: source.href,
	max: 4,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
const P = randomUUID();
const Q = randomUUID();
// 0 owner of P, 1 member of P, 2 admin of P, 3 admin of Q, 4 account with no seat
const actors = Array.from({ length: 5 }, () => ({ id: randomUUID(), user: randomUUID(), session: randomUUID() }));
let db;

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
		const input = command.input ?? {};
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
const storage = { bucket: "synthetic-only", client };

const ok = (result) => {
	assert.equal(result.status, "ok", JSON.stringify(result.status === "refused" ? result.error : result.status));
	return result.value;
};
const refused = (result, code) => {
	assert.equal(result.status, "refused", JSON.stringify(result));
	assert.equal(result.error.code, code, JSON.stringify(result.error));
	return result.error;
};
const authority = async (who) => {
	const actor = await RequestActor.resolve(db, actors[who].session);
	assert.ok(actor instanceof RequestActor, JSON.stringify(actor));
	return actor;
};
const rowsOf = async (query) => (await admin.execute(query)).rows;
const countOf = async (table, where = "") =>
	Number((await admin.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table} ${where}`))).rows[0].n);
const endSeat = (accountId) =>
	admin.execute(
		sql`UPDATE seat SET ended_at = clock_timestamp() WHERE account_id = ${accountId}::uuid AND ended_at IS NULL`,
	);
const restoreSeat = (accountId) =>
	admin.execute(sql`UPDATE seat SET ended_at = NULL WHERE account_id = ${accountId}::uuid`);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

// The CASE-BRD-002 fixture: a 960 x 380 canvas with 900 x 300 content.
const svg960 = Buffer.from(
	'<svg xmlns="http://www.w3.org/2000/svg" width="960" height="380" viewBox="0 0 960 380"><rect x="30" y="40" width="900" height="300" fill="#1F4E79"/></svg>',
);
// A transparent canvas with a flat #2E7D32 block: the dominant opaque color is exactly that.
const greenPng = await sharp({
	create: { width: 200, height: 120, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
	.composite([{ input: { create: { width: 120, height: 60, channels: 4, background: "#2E7D32" } }, left: 40, top: 30 }])
	.png()
	.toBuffer();
const photoWebp = await sharp({ create: { width: 3000, height: 1200, channels: 3, background: "#556677" } })
	.webp()
	.toBuffer();

/** Request, send bytes and finalize one asset. Returns the kit after the finalize. */
async function attach(who, slot, mediaType, bytes, altText, expectedRevision) {
	const ticket = ok(
		await brandWriter.requestUpload(db, await authority(who), { slot, mediaType, byteLength: bytes.length, altText }),
	);
	ok(await uploadBrandAsset(db, storage, await authority(who), { uploadId: ticket.uploadId, bytes }));
	return ok(
		await brandWriter.finalizeUpload(db, await authority(who), {
			uploadId: ticket.uploadId,
			slot,
			altText,
			expectedRevision,
		}),
	);
}
const kitRow = async (plant = P) =>
	(await rowsOf(sql`SELECT * FROM church_brand_kit WHERE tenant_id = ${plant}::uuid`))[0];

before(async () => {
	await admin.execute(sql.raw(`CREATE SCHEMA ${schema}`));
	await migrate(admin, schema);
	const password = randomBytes(32).toString("hex");
	await admin.execute(
		sql.raw(
			`CREATE ROLE ${roleName} LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
		),
	);
	await admin.execute(sql.raw(`GRANT everyfield_runtime TO ${roleName}`));
	const url = new URL(source);
	url.username = roleName;
	url.password = password;
	db = createDatabase({ connectionString: url.href, max: 4, options: `-c search_path=${schema},pg_catalog,pg_temp` });
	for (const actor of actors) {
		await admin.execute(
			sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${actor.user},${actor.id + "@example.test"},true,'Synthetic')`,
		);
		await admin.execute(
			sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${actor.id},${actor.user},'active','planter')`,
		);
		await admin.execute(
			sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${actor.session},${actor.user},${randomUUID()},clock_timestamp()+interval '1 day')`,
		);
	}
	for (const [id, name, zone] of [
		[P, "Harvest Point", "America/Chicago"],
		[Q, "Other Plant", "America/New_York"],
	])
		await admin.execute(
			sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${id},${name},${zone},7,14,1,8,1,1)`,
		);
	for (const [index, plant, seatRole] of [
		[0, P, "owner"],
		[1, P, "member"],
		[2, P, "admin"],
		[3, Q, "admin"],
	])
		await admin.execute(
			sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${actors[index].id},${plant},${seatRole},clock_timestamp())`,
		);
});
after(async () => {
	if (db) await closeDatabase(db);
	try {
		await admin.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
		await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${roleName}`));
	} finally {
		await closeDatabase(admin);
	}
});

describe("WP-104/api church brand kit", { concurrency: 1 }, () => {
	test("AC:CASE-BRD-001 member-refused: only the current Owner or Admin seat of the church plant reads or changes the kit", async () => {
		const member = await authority(1);
		refused(await brandReader.get(db, member, {}), "access_denied");
		refused(
			await brandWriter.saveSettings(db, member, { expectedRevision: "0", patch: { primaryColor: "#8B1E3F" } }),
			"access_denied",
		);
		refused(
			await brandWriter.requestUpload(db, member, {
				slot: "mark",
				mediaType: "image/png",
				byteLength: 10,
				altText: "Mark",
			}),
			"access_denied",
		);
		refused(await brandWriter.reset(db, member, { expectedRevision: "0" }), "access_denied");
		refused(await brandReader.suggestColors(db, member, { assetKind: "full_logo" }, storage), "access_denied");
		assert.equal(await countOf("church_brand_kit"), 0);
		assert.equal(await countOf("file_object", "WHERE purpose = 'brand_asset'"), 0);
		// A seat that ended after the viewer lookup gets the same refusal, in the statement itself.
		const admin2 = await authority(2);
		await endSeat(actors[2].id);
		refused(await brandReader.get(db, admin2, {}), "access_denied");
		refused(
			await brandWriter.saveSettings(db, admin2, { expectedRevision: "0", patch: { primaryColor: "#8B1E3F" } }),
			"access_denied",
		);
		refused(await brandReader.resolveTheme(db, admin2, { documentClass: "email" }), "access_denied");
		await restoreSeat(actors[2].id);
		assert.equal(await countOf("church_brand_kit"), 0);
		// A different church plant has its own default kit and cannot reach this one.
		assert.equal(ok(await brandReader.get(db, await authority(3), {})).kitState, "default");
		refused(await brandReader.get(db, await authority(4), {}), "access_denied");
		// Any active seat resolves a theme.
		assert.equal(ok(await brandReader.resolveTheme(db, member, { documentClass: "email" })).kind, "everyfield-neutral");
	});

	test("brand.get for a church plant with no kit returns the defaults", async () => {
		const kit = ok(await brandReader.get(db, await authority(0), {}));
		assert.equal(kit.kitState, "default");
		assert.equal(kit.revision, "0");
		assert.equal(kit.headingFont, "DM Serif Display");
		assert.equal(kit.bodyFont, "DM Sans");
		assert.deepEqual(Object.values(kit.assets), [null, null, null, null, null, null]);
		assert.deepEqual(kit.colors, { primary: null, accent: null });
	});

	test("AC:CASE-BRD-003 colors, contrast, primary required, revision conflict, audit", async () => {
		const owner = await authority(0);
		refused(
			await brandWriter.saveSettings(db, owner, { expectedRevision: "0", patch: { tagline: "Come home" } }),
			"primary_required",
		);
		refused(
			await brandWriter.saveSettings(db, owner, { expectedRevision: "0", patch: { primaryColor: null } }),
			"primary_required",
		);
		refused(
			await brandWriter.saveSettings(db, owner, { expectedRevision: "0", patch: { primaryColor: "yellow" } }),
			"invalid_input",
		);
		assert.equal(await countOf("church_brand_kit"), 0);
		const saved = ok(
			await brandWriter.saveSettings(db, owner, { expectedRevision: "0", patch: { primaryColor: "#f2d74a" } }),
		);
		assert.equal(saved.kitState, "saved");
		assert.equal(saved.revision, "1");
		assert.equal(saved.primaryColor, "#F2D74A");
		assert.equal(saved.accentColor, null);
		assert.deepEqual(saved.colors.accent, {
			hex: "#F2D74A",
			contrast: 1.44,
			badge: "fails_text",
			textColor: "#000000",
		});
		assert.equal(saved.headingFont, "DM Serif Display");
		assert.equal(saved.bodyFont, "DM Sans");
		const conflict = refused(
			await brandWriter.saveSettings(db, owner, { expectedRevision: "0", patch: { accentColor: "#112233" } }),
			"conflict",
		);
		assert.equal(conflict.retry, "refresh");
		const next = ok(
			await brandWriter.saveSettings(db, await authority(2), {
				expectedRevision: "1",
				patch: { primaryColor: "#1F4E79", accentColor: "#c9a227" },
			}),
		);
		assert.equal(next.revision, "2");
		assert.equal(next.colors.primary.badge, "passes_text");
		assert.equal(next.colors.primary.textColor, "#FFFFFF");
		assert.equal(next.accentColor, "#C9A227");
		assert.equal(next.colors.accent.badge, "fails_text");
		// A primary color can never be cleared.
		refused(
			await brandWriter.saveSettings(db, owner, { expectedRevision: "2", patch: { primaryColor: null } }),
			"primary_required",
		);
		assert.equal((await kitRow()).revision, "2");
		const audits = await rowsOf(
			sql`SELECT before_value, after_value, actor_id, before_revision::text AS before_revision, after_revision::text AS after_revision FROM audit_event WHERE action = 'branding.changed' AND tenant_id = ${P}::uuid ORDER BY recorded_at`,
		);
		assert.equal(audits.length, 2);
		assert.deepEqual(audits[1].before_value, { primary_color: "#F2D74A", accent_color: null });
		assert.deepEqual(audits[1].after_value, { primary_color: "#1F4E79", accent_color: "#C9A227" });
		assert.equal(audits[1].actor_id, actors[2].id);
		assert.deepEqual([audits[1].before_revision, audits[1].after_revision], ["1", "2"]);
	});

	test("AC:CASE-BRD-004 fonts come from the curated list", async () => {
		const owner = await authority(0);
		refused(
			await brandWriter.saveSettings(db, owner, { expectedRevision: "2", patch: { headingFont: "Papyrus" } }),
			"unsupported_font",
		);
		refused(
			await brandWriter.saveSettings(db, owner, { expectedRevision: "2", patch: { bodyFont: "Comic Sans" } }),
			"unsupported_font",
		);
		assert.equal((await kitRow()).revision, "2");
		const kit = ok(
			await brandWriter.saveSettings(db, owner, {
				expectedRevision: "2",
				patch: { headingFont: "Lora", bodyFont: "Inter" },
			}),
		);
		assert.deepEqual([kit.headingFont, kit.bodyFont, kit.revision], ["Lora", "Inter", "3"]);
		ok(
			await brandWriter.saveSettings(db, owner, {
				expectedRevision: "3",
				patch: { headingFont: "DM Serif Display", bodyFont: "DM Sans" },
			}),
		);
	});

	test("AC:CASE-BRD-005 letterhead and signature fields are one closed patch", async () => {
		const owner = await authority(0);
		refused(
			await brandWriter.saveSettings(db, owner, { expectedRevision: "4", patch: { ein: "12-34" } }),
			"invalid_ein",
		);
		refused(
			await brandWriter.saveSettings(db, owner, {
				expectedRevision: "4",
				patch: { website: "http://insecure.example" },
			}),
			"invalid_input",
		);
		refused(
			await brandWriter.saveSettings(db, owner, { expectedRevision: "4", patch: { surprise: "x" } }),
			"invalid_input",
		);
		refused(
			await brandWriter.saveSettings(db, owner, { expectedRevision: "4", patch: { tagline: "x".repeat(201) } }),
			"invalid_input",
		);
		assert.equal((await kitRow()).revision, "4");
		const kit = ok(
			await brandWriter.saveSettings(db, owner, {
				expectedRevision: "4",
				patch: {
					legalName: "Harvest Point Church Inc.",
					address: "12 Main St, Austin, TX 78701",
					website: "https://harvestpoint.example",
					phone: "512-555-0100",
					email: "hello@harvestpoint.example",
					ein: "12-3456789",
					tagline: "Come home",
					signerName: "Ada Pastor",
					signerTitle: "Lead Pastor",
				},
			}),
		);
		assert.equal(kit.ein, "12-3456789");
		assert.equal(kit.signerTitle, "Lead Pastor");
		assert.equal(kit.assets.cover_photo, null);
		assert.equal(kit.assets.signature, null);
		// null clears a field and the rest stay.
		const cleared = ok(await brandWriter.saveSettings(db, owner, { expectedRevision: "5", patch: { tagline: null } }));
		assert.equal(cleared.tagline, null);
		assert.equal(cleared.legalName, "Harvest Point Church Inc.");
	});

	test("AC:CASE-BRD-002 alt-text-required and unsupported types refuse before anything is stored", async () => {
		const owner = await authority(0);
		const filesBefore = await countOf("file_object");
		const jobsBefore = await countOf("job");
		for (const altText of [undefined, "", "   "])
			refused(
				await brandWriter.requestUpload(db, owner, {
					slot: "full_logo",
					mediaType: "image/png",
					byteLength: 100,
					altText,
				}),
				"alt_text_required",
			);
		for (const mediaType of ["image/gif", "image/jpeg", "application/pdf"])
			refused(
				await brandWriter.requestUpload(db, owner, { slot: "full_logo", mediaType, byteLength: 100, altText: "Logo" }),
				"unsupported_media_type",
			);
		assert.equal(await countOf("file_object"), filesBefore);
		assert.equal(await countOf("job"), jobsBefore);
	});

	test("AC:CASE-BRD-002 the 960 x 380 SVG is trimmed and stored as a private PNG with a 3.0 aspect ratio", async () => {
		const owner = await authority(0);
		const ticket = ok(
			await brandWriter.requestUpload(db, owner, {
				slot: "full_logo",
				mediaType: "image/svg+xml",
				byteLength: svg960.length,
				altText: "Harvest Point logo",
			}),
		);
		const staged = (await rowsOf(sql`SELECT * FROM file_object WHERE id = ${ticket.uploadId}::uuid`))[0];
		assert.equal(staged.state, "pending");
		assert.equal(staged.purpose, "brand_asset");
		assert.match(staged.opaque_key, new RegExp(`^private/${P}/[0-9a-f-]{36}$`));
		assert.equal(await countOf("job", `WHERE kind = 'object_cleanup' AND subject_record_id = '${ticket.uploadId}'`), 1);
		const stored = ok(await uploadBrandAsset(db, storage, owner, { uploadId: ticket.uploadId, bytes: svg960 }));
		const bytes = client.objects.get(staged.opaque_key);
		const meta = await sharp(bytes).metadata();
		assert.equal(meta.format, "png");
		assert.equal(meta.width / meta.height, 3);
		assert.equal(stored.byteCount, bytes.length);
		assert.equal(stored.sha256, sha(bytes));
		const ready = (
			await rowsOf(
				sql`SELECT state, media_type, byte_count::int AS byte_count, sha256 FROM file_object WHERE id = ${ticket.uploadId}::uuid`,
			)
		)[0];
		assert.deepEqual(ready, { state: "ready", media_type: "image/png", byte_count: bytes.length, sha256: sha(bytes) });
		// Not readable until the kit references it.
		refused(await readBrandAsset(db, storage, owner, ticket.uploadId), "unavailable");
		const kit = ok(
			await brandWriter.finalizeUpload(db, owner, {
				uploadId: ticket.uploadId,
				slot: "full_logo",
				altText: "Harvest Point logo",
				expectedRevision: "6",
			}),
		);
		assert.deepEqual(kit.assets.full_logo, { fileId: ticket.uploadId, alt: "Harvest Point logo" });
		assert.equal(kit.revision, "7");
		const read = ok(await readBrandAsset(db, storage, owner, ticket.uploadId));
		assert.deepEqual(Buffer.from(read.bytes), bytes);
		assert.equal(read.mediaType, "image/png");
		// Settings read needs Owner or Admin; the theme read accepts any active seat.
		refused(await readBrandAsset(db, storage, await authority(1), ticket.uploadId), "unavailable");
		assert.deepEqual(
			Buffer.from(ok(await readBrandAsset(db, storage, await authority(1), ticket.uploadId, "theme")).bytes),
			bytes,
		);
		refused(await readBrandAsset(db, storage, await authority(3), ticket.uploadId, "theme"), "unavailable");
	});

	test("AC:CASE-BRD-002 invalid bytes get invalid_file and leave no ready file", async () => {
		const owner = await authority(0);
		const attempts = [
			["image/png", Buffer.from("this is not a png at all, just text")],
			["image/webp", greenPng],
			["image/svg+xml", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
			[
				"image/svg+xml",
				Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>'),
			],
			[
				"image/svg+xml",
				Buffer.from(
					'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="https://evil.example/a.png"/></svg>',
				),
			],
			[
				"image/svg+xml",
				Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://evil.example/p)"/></svg>'),
			],
		];
		const readyBefore = await countOf("file_object", "WHERE purpose = 'brand_asset' AND state = 'ready'");
		for (const [mediaType, bytes] of attempts) {
			const ticket = ok(
				await brandWriter.requestUpload(db, owner, {
					slot: "mark",
					mediaType,
					byteLength: bytes.length,
					altText: "Mark",
				}),
			);
			refused(await uploadBrandAsset(db, storage, owner, { uploadId: ticket.uploadId, bytes }), "invalid_file");
			assert.equal(
				(await rowsOf(sql`SELECT state FROM file_object WHERE id = ${ticket.uploadId}::uuid`))[0].state,
				"pending",
			);
		}
		// A wrong byte count against the staged request is refused too.
		const ticket = ok(
			await brandWriter.requestUpload(db, owner, {
				slot: "mark",
				mediaType: "image/png",
				byteLength: greenPng.length + 1,
				altText: "Mark",
			}),
		);
		refused(await uploadBrandAsset(db, storage, owner, { uploadId: ticket.uploadId, bytes: greenPng }), "invalid_file");
		assert.equal(await countOf("file_object", "WHERE purpose = 'brand_asset' AND state = 'ready'"), readyBefore);
		// Another seat cannot upload bytes into this upload.
		const mine = ok(
			await brandWriter.requestUpload(db, owner, {
				slot: "mark",
				mediaType: "image/png",
				byteLength: greenPng.length,
				altText: "Mark",
			}),
		);
		refused(
			await uploadBrandAsset(db, storage, await authority(1), { uploadId: mine.uploadId, bytes: greenPng }),
			"access_denied",
		);
		refused(
			await uploadBrandAsset(db, storage, await authority(3), { uploadId: mine.uploadId, bytes: greenPng }),
			"unavailable",
		);
	});

	test("AC:CASE-BRD-002 finalize attaches only this church plant's ready brand_asset file", async () => {
		const owner = await authority(0);
		const foreign = randomUUID();
		const generated = randomUUID();
		for (const [id, tenant, purpose] of [
			[foreign, Q, "brand_asset"],
			[generated, P, "generated"],
		])
			await admin.execute(sql`INSERT INTO file_object (id, tenant_id, purpose, opaque_key, media_type, max_bytes, byte_count, sha256, state, upload_key, claim_generation, expires_at)
				VALUES (${id}::uuid, ${tenant}::uuid, ${purpose}, ${"private/" + tenant + "/" + id}, 'image/png', 10, 10, ${"a".repeat(64)}, 'ready', ${"brand-asset/mark/" + id}, 0, clock_timestamp() + interval '10 minutes')`);
		for (const uploadId of [foreign, generated, randomUUID()])
			refused(
				await brandWriter.finalizeUpload(db, owner, { uploadId, slot: "mark", altText: "Mark", expectedRevision: "7" }),
				"unavailable",
			);
		const pending = ok(
			await brandWriter.requestUpload(db, owner, {
				slot: "mark",
				mediaType: "image/png",
				byteLength: 5,
				altText: "Mark",
			}),
		);
		refused(
			await brandWriter.finalizeUpload(db, owner, {
				uploadId: pending.uploadId,
				slot: "mark",
				altText: "Mark",
				expectedRevision: "7",
			}),
			"unavailable",
		);
		refused(
			await brandWriter.finalizeUpload(db, owner, {
				uploadId: foreign,
				slot: "mark",
				altText: "",
				expectedRevision: "7",
			}),
			"alt_text_required",
		);
		// The slot must match the slot the upload was requested for.
		const wrongSlot = ok(
			await brandWriter.requestUpload(db, owner, {
				slot: "mark",
				mediaType: "image/png",
				byteLength: greenPng.length,
				altText: "Mark",
			}),
		);
		ok(await uploadBrandAsset(db, storage, owner, { uploadId: wrongSlot.uploadId, bytes: greenPng }));
		refused(
			await brandWriter.finalizeUpload(db, owner, {
				uploadId: wrongSlot.uploadId,
				slot: "signature",
				altText: "Sig",
				expectedRevision: "7",
			}),
			"unavailable",
		);
		const conflict = refused(
			await brandWriter.finalizeUpload(db, owner, {
				uploadId: wrongSlot.uploadId,
				slot: "mark",
				altText: "Mark",
				expectedRevision: "3",
			}),
			"conflict",
		);
		assert.equal(conflict.retry, "refresh");
		assert.equal((await kitRow()).revision, "7");
	});

	test("AC:CASE-BRD-002 suggest-from-logo returns the dominant opaque color", async () => {
		const owner = await authority(0);
		refused(await brandReader.suggestColors(db, owner, { assetKind: "signature" }, storage), "unavailable");
		const kit = await attach(0, "full_logo", "image/png", greenPng, "Green logo", "7");
		assert.equal(kit.revision, "8");
		const suggested = ok(await brandReader.suggestColors(db, owner, { assetKind: "full_logo" }, storage));
		assert.equal(suggested.suggestedPrimary, "#2E7D32");
		assert.equal(suggested.suggestedFrom, "full_logo");
		assert.deepEqual(suggested.palette, ["#2E7D32"]);
		// Replacing the logo queues cleanup of the file the slot held, and writes one audit row.
		const jobs = await rowsOf(
			sql`SELECT producer_key FROM job WHERE kind = 'object_cleanup' AND producer_key LIKE 'brand-asset-release/%'`,
		);
		assert.equal(jobs.length, 1);
		const audits = await rowsOf(
			sql`SELECT after_value FROM audit_event WHERE action = 'branding.changed' ORDER BY recorded_at DESC LIMIT 1`,
		);
		assert.deepEqual(Object.keys(audits[0].after_value).sort(), ["full_logo_alt", "full_logo_object_id"]);
	});

	test("AC:CASE-BRD-006 a cover photo is resized, not trimmed, and a removed slot queues its cleanup", async () => {
		const owner = await authority(0);
		const kit = await attach(0, "cover_photo", "image/webp", photoWebp, "Sunday gathering", "8");
		const fileId = kit.assets.cover_photo.fileId;
		const key = (await rowsOf(sql`SELECT opaque_key, media_type FROM file_object WHERE id = ${fileId}::uuid`))[0];
		assert.equal(key.media_type, "image/jpeg");
		const meta = await sharp(client.objects.get(key.opaque_key)).metadata();
		assert.deepEqual([meta.format, meta.width, meta.height], ["jpeg", 2400, 960]);
		const jobsBefore = await countOf(
			"job",
			"WHERE kind = 'object_cleanup' AND producer_key LIKE 'brand-asset-release/%'",
		);
		const removed = ok(
			await brandWriter.saveSettings(db, owner, { expectedRevision: "9", patch: { assets: { cover_photo: null } } }),
		);
		assert.equal(removed.assets.cover_photo, null);
		assert.equal((await kitRow()).cover_photo_alt, null);
		assert.equal(
			await countOf("job", "WHERE kind = 'object_cleanup' AND producer_key LIKE 'brand-asset-release/%'"),
			jobsBefore + 1,
		);
		assert.equal(await countOf("job", `WHERE producer_key = 'brand-asset-release/${fileId}'`), 1);
	});

	test("AC:CASE-BRD-006 AC:CASE-DOC-017-CHURCH brand.resolveTheme reads the kit and the church plant name in one statement", async () => {
		const owner = await authority(0);
		ok(
			await brandWriter.saveSettings(db, owner, {
				expectedRevision: "10",
				patch: { primaryColor: "#8B1E3F", accentColor: "#C9A227" },
			}),
		);
		const member = await authority(1);
		const outward = ok(await brandReader.resolveTheme(db, member, { documentClass: "outward-facing" }));
		assert.equal(outward.kind, "church");
		assert.equal(outward.churchName, "Harvest Point");
		assert.equal(outward.colors.primary, "#8B1E3F");
		assert.equal(outward.colors.accent, "#C9A227");
		assert.equal(outward.fonts.heading, "DM Serif Display");
		assert.equal(outward.fallbackUsed, false);
		assert.equal(outward.layout.coverLogo.alt, "Green logo");
		const off = ok(
			await brandReader.resolveTheme(db, member, { documentClass: "outward-facing", useChurchBranding: false }),
		);
		assert.equal(off.kind, "everyfield-neutral");
		assert.equal(off.layout.coverLogo, null);
		// Another church plant's theme is neutral and carries its own name.
		const other = ok(await brandReader.resolveTheme(db, await authority(3), { documentClass: "formal/legal" }));
		assert.deepEqual([other.kind, other.churchName], ["everyfield-neutral", "Other Plant"]);
	});

	test("AC:CASE-BRD-006-SAVED a saved document keeps its bytes when the primary color changes", async () => {
		const owner = await authority(0);
		const made = ok(
			await documentsWriter.generate(
				db,
				owner,
				{ templateId: "commitment-card", format: "pdf", requestKey: "brand-saved" },
				storage,
			),
		);
		const fileOf = async () =>
			(
				await rowsOf(
					sql`SELECT f.id, f.opaque_key, f.sha256, f.revision::text AS revision FROM generated_document g JOIN file_object f ON f.id = g.object_id WHERE g.id = ${made.id}::uuid`,
				)
			)[0];
		const before = await fileOf();
		const generatedBefore = await rowsOf(
			sql`SELECT id, sha256, revision::text AS revision FROM file_object WHERE purpose = 'generated' ORDER BY id`,
		);
		const documentsBefore = await rowsOf(sql`SELECT id, revision::text AS revision FROM document ORDER BY id`);
		const kit = ok(
			await brandWriter.saveSettings(db, owner, { expectedRevision: "11", patch: { primaryColor: "#8B1E3F" } }),
		);
		assert.equal(kit.revision, "12");
		const after = await fileOf();
		assert.deepEqual(after, before);
		assert.equal(sha(client.objects.get(after.opaque_key)), before.sha256);
		assert.equal(sha(client.objects.get(after.opaque_key)), made.digest);
		assert.deepEqual(
			await rowsOf(
				sql`SELECT id, sha256, revision::text AS revision FROM file_object WHERE purpose = 'generated' ORDER BY id`,
			),
			generatedBefore,
		);
		assert.deepEqual(
			await rowsOf(sql`SELECT id, revision::text AS revision FROM document ORDER BY id`),
			documentsBefore,
		);
		assert.equal(
			ok(await brandReader.resolveTheme(db, owner, { documentClass: "formal/legal" })).colors.primary,
			"#8B1E3F",
		);
	});

	test("AC:CASE-BRD-001 reset deletes the kit, queues cleanup of every asset file and changes no generated file", async () => {
		const owner = await authority(0);
		const kitBefore = ok(await brandReader.get(db, owner, {}));
		const heldFiles = Object.values(kitBefore.assets)
			.filter(Boolean)
			.map((asset) => asset.fileId);
		assert.equal(heldFiles.length, 1);
		const generated = async () =>
			rowsOf(sql`SELECT id, sha256 FROM file_object WHERE purpose = 'generated' ORDER BY id`);
		const before = await generated();
		assert.ok(before.length >= 1);
		const conflict = refused(await brandWriter.reset(db, owner, { expectedRevision: "5" }), "conflict");
		assert.equal(conflict.retry, "refresh");
		assert.equal((await kitRow()).revision, "12");
		const audits = await countOf("audit_event", "WHERE action = 'branding.changed'");
		const reset = ok(await brandWriter.reset(db, await authority(2), { expectedRevision: "12" }));
		assert.deepEqual([reset.kitState, reset.revision], ["default", "0"]);
		assert.equal(await kitRow(), undefined);
		assert.deepEqual(await generated(), before);
		assert.equal(await countOf("job", `WHERE producer_key = 'brand-asset-release/${heldFiles[0]}'`), 1);
		assert.equal(await countOf("audit_event", "WHERE action = 'branding.changed'"), audits + 1);
		assert.equal(ok(await brandReader.get(db, owner, {})).kitState, "default");
		assert.equal(
			ok(await brandReader.resolveTheme(db, owner, { documentClass: "formal/legal" })).kind,
			"everyfield-neutral",
		);
		// Reset of a church plant with no kit is already the answer; a stale revision still conflicts.
		assert.equal(ok(await brandWriter.reset(db, owner, { expectedRevision: "0" })).kitState, "default");
		refused(await brandWriter.reset(db, owner, { expectedRevision: "3" }), "conflict");
		// The first save after a reset expects revision 0.
		assert.equal(
			ok(await brandWriter.saveSettings(db, owner, { expectedRevision: "0", patch: { primaryColor: "#1F4E79" } }))
				.revision,
			"1",
		);
	});

	test("an upload can create the kit before a primary color, and that kit resolves to the neutral theme", async () => {
		await admin.execute(sql`DELETE FROM church_brand_kit WHERE tenant_id = ${P}::uuid`);
		const kit = await attach(2, "mark", "image/png", greenPng, "Harvest mark", "0");
		assert.deepEqual([kit.kitState, kit.revision, kit.primaryColor], ["saved", "1", null]);
		assert.deepEqual(kit.colors, { primary: null, accent: null });
		const theme = ok(await brandReader.resolveTheme(db, await authority(1), { documentClass: "operational" }));
		assert.equal(theme.kind, "everyfield-neutral");
		assert.equal(theme.layout.mark, null);
		refused(
			await brandWriter.saveSettings(db, await authority(0), { expectedRevision: "1", patch: { tagline: "Hi" } }),
			"primary_required",
		);
		ok(
			await brandWriter.saveSettings(db, await authority(0), {
				expectedRevision: "1",
				patch: { primaryColor: "#1F4E79", tagline: "Hi" },
			}),
		);
		assert.equal(
			ok(await brandReader.resolveTheme(db, await authority(1), { documentClass: "operational" })).layout.mark.alt,
			"Harvest mark",
		);
	});
});
