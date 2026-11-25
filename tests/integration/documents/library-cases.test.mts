import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test, { after, before, mock } from "node:test";
import { inspect } from "node:util";
import { sql, type SQL } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { PDFDocument, PDFDict, PDFName } from "../../../packages/domain/node_modules/pdf-lib/cjs/index.js";
import {
	deleteUnreferencedObject,
	putPrivateObject,
	toUploadKey,
	type ResourceAuthorizer,
} from "../../../packages/db/src/schema/storage.ts";
import sharp from "../../../packages/db/node_modules/sharp/dist/index.mjs";
import type { ChurchDocument, DocDocument, SlotNode } from "../../../packages/contracts/src/documents/index.ts";
import { nativeFromText } from "../../../packages/contracts/src/documents/native.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { brandReader, brandWriter, uploadBrandAsset } from "../../../packages/domain/src/branding/index.ts";
import { docTemplateSummaries } from "../../../packages/domain/src/documents/doc-templates.ts";
import { documentsReader, documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import { pdfOperators, pdfPages, docxParts, wordText } from "./fixtures/readers.mts";
import { DOCTRINAL } from "./fixtures/doctrinal.mts";
import * as W from "./fixtures/word.mts";
import { fixture, ok, raced, refused, type Actor } from "../../support/fixture.mts";
import { failingWrite, NOTHING, recorded, untouched } from "../../support/recorded.mts";
import { pinSchemaClock } from "../../support/test-database.mts";
import { MemoryClient } from "./storage.mts";
import { blocksOf, isSlot, present } from "./support.mts";

type Case = ReturnType<typeof JSON.parse>;
const cases: (Case & { id: string })[] = JSON.parse(
	readFileSync(new URL("../../../docs/acceptance/knowledge.json", import.meta.url), "utf8"),
).cases;
const caseOf = (id: string, name?: string): Case => {
	const found = present(cases.find((c) => c.id === id));
	return name ? present(found.subcases.find((s: { name: string }) => s.name === name)) : found;
};
const catalog: { templates: { id: string; title: string; class: string; source: string; formats: string[] }[] } =
	JSON.parse(readFileSync(new URL("../../../docs/catalog/document-templates.json", import.meta.url), "utf8"));

const OCTOBER_13 = "2026-10-13T16:00:00Z";
const OCTOBER_30 = "2026-10-30T16:00:00Z";
const BLANK = "Not filled in yet. Your church or its sending network adds this text. It stays blank until then.";
const NOTICE = "Template, not legal advice";

mock.timers.enable({ apis: ["Date"], now: Date.parse(OCTOBER_13) });
const database = await fixture({
	prefix: "doclib",
	max: 8,
	plant: { name: "Harvest Point" },
	clock: new Date("2026-10-13T15:00:00Z"),
});
const { admin } = database;
const db = database.pools.runtime;
const P = database.tenant.id;
const Q = await database.plant({ name: "Other Plant", timezone: "America/New_York" });
const B = await database.actor(Q, "admin");
const A = database.actors.admin;
const M = database.actors.member;
const client = new MemoryClient();
const storage = { bucket: "synthetic-only", client };

const who = async (actor: Actor) => {
	const resolved = await RequestActor.resolve(db, actor.session);
	assert.ok(resolved instanceof RequestActor, JSON.stringify(resolved));
	return resolved;
};
const at = async (instant: string) => {
	mock.timers.setTime(Date.parse(instant));
	await pinSchemaClock(admin, database.schema, new Date(instant));
};
const rows = async <T extends Record<string, unknown>>(query: SQL) => (await admin.execute<T>(query)).rows;
const count = async (query: SQL) =>
	Number(present((await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${query}`))[0]).n);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fileOf = async (generatedId: string) =>
	present(
		(
			await rows<{ id: string; key: string; state: string; bytes: number }>(
				sql`SELECT f.id, f.opaque_key AS key, f.state, f.byte_count::int AS bytes FROM generated_document g JOIN file_object f ON f.id = g.object_id WHERE g.id = ${generatedId}::uuid`,
			)
		)[0],
	);
const storedOf = async (generated: { id: string; digest: string; byteCount: number }) => {
	const file = await fileOf(generated.id);
	assert.equal(file.state, "ready");
	const bytes = present(client.objects.get(file.key));
	assert.deepEqual([sha(bytes), bytes.length], [generated.digest, generated.byteCount]);
	return bytes;
};
const history = async (actor = A) => ok(await documentsWriter["history.list"](db, await who(actor), {})).entries;
const preview = async (template: string, overrides: Record<string, string>, format = "pdf", actor = A) =>
	documentsReader.preview(db, await who(actor), { templateId: template, format, overrides }, storage);
const generate = async (
	template: string,
	requestKey: string,
	overrides: Record<string, string> = {},
	format = "pdf",
	actor = A,
) => documentsWriter.generate(db, await who(actor), { templateId: template, format, overrides, requestKey }, storage);
const create = async (
	args: { template: string; merge_fields: Record<string, string>; request_key: string },
	actor = A,
) =>
	documentsWriter.createFromTemplate(db, await who(actor), {
		templateId: args.template,
		mergeFields: args.merge_fields,
		requestKey: args.request_key,
	});
const exportOf = async (documentId: string, args: { revision: number; format: string; request_key: string }) =>
	documentsWriter.exportNative(
		db,
		await who(A),
		{ documentId, revision: args.revision, format: args.format, requestKey: args.request_key },
		storage,
	);
const save = async (doc: ChurchDocument, body: DocDocument) =>
	documentsWriter.saveNative(db, await who(A), { documentId: doc.id, expectedRevision: doc.revision, body });
const pdfText = async (bytes: Uint8Array) => (await pdfPages(bytes)).join(" ");
const artifactOf = (value: { artifact: string | null }) => Buffer.from(present(value.artifact), "base64");
const wordOf = (bytes: Uint8Array) => {
	const parts = docxParts(bytes);
	return {
		parts,
		text: Object.values(parts).map(wordText).join(" "),
		body: wordText(present(parts["word/document.xml"])),
	};
};
const paints = async (bytes: Uint8Array, rgb: string) => (await pdfOperators(bytes)).includes(rgb);
const NAVY = "0.122 0.306 0.475";
const WINE = "0.545 0.118 0.247";
const wiped = (body: DocDocument): DocDocument => {
	const next = structuredClone(body);
	next.body = { type: "doc", content: [] };
	next.page.header = { pages: "all", content: [] };
	next.page.footer = { pages: "all", content: [] };
	return next;
};
const noSideEffects = async <T,>(audits: string[], body: () => Promise<T>) => {
	const { value, added } = await recorded(admin, body);
	assert.deepEqual(added, { ...NOTHING, audits });
	return value;
};

const logo = await sharp({ create: { width: 480, height: 120, channels: 4, background: "#1F4E79" } })
	.png()
	.toBuffer();
const kitRevision = async () => ok(await brandReader.get(db, await who(A), {})).revision;
async function brand(kit: Record<string, string>, withLogo = false) {
	const saved = ok(
		await brandWriter.saveSettings(db, await who(A), {
			expectedRevision: await kitRevision(),
			patch: {
				primaryColor: kit.primary_color,
				accentColor: kit.accent_color,
				headingFont: kit.heading_font,
				bodyFont: kit.body_font,
				legalName: kit.legal_name,
				ein: kit.ein,
			},
		}),
	);
	if (!withLogo) return saved;
	const ask = { slot: "full_logo", mediaType: "image/png", altText: kit.logo_alt_text };
	const ticket = ok(await brandWriter.requestUpload(db, await who(A), { ...ask, byteLength: logo.length }));
	ok(await uploadBrandAsset(db, storage, await who(A), { uploadId: ticket.uploadId, bytes: logo }));
	return ok(
		await brandWriter.finalizeUpload(db, await who(A), {
			uploadId: ticket.uploadId,
			slot: ask.slot,
			altText: ask.altText,
			expectedRevision: saved.revision,
		}),
	);
}
const unbrand = async () => {
	const revision = await kitRevision();
	if (revision !== "0") ok(await brandWriter.reset(db, await who(A), { expectedRevision: revision }));
};

before(async () => {
	await admin.execute(sql`UPDATE auth_session SET expires_at='2026-11-12T16:00:00Z'`);
	await at(OCTOBER_13);
});
after(async () => {
	mock.timers.reset();
	await database.close();
});

test("AC:CASE-DOC-001 the list holds each catalog template once in PDF or Excel, and a retired template, an unsupported format and an unknown link give nothing", async () => {
	const c = caseOf("CASE-DOC-001");
	const { retired_template, unsupported_format } = c.given["behavior-inputs"];
	await untouched(admin, async () => {
		const page = ok(await documentsReader["templates.list"](db, await who(A), {}));
		assert.deepEqual(
			page.templates.map((t) => t.id),
			[
				"commitment-card",
				"response-card",
				"guest-sign-in-sheet",
				"vision-meeting-agenda",
				"member-expectations",
				"launch-team-commitment",
				"follow-up-letter",
				"board-meeting-agenda",
				"first-year-budget",
				"budget-worksheet",
				"launch-sunday-checklists",
				"bylaws",
				"prayer-letter",
			],
		);
		assert.deepEqual([...new Set(page.templates.flatMap((t) => t.formats))].sort(), c.expected.result.offered_formats);
		refused(await documentsReader["templates.get"](db, await who(A), { templateId: retired_template }), "unavailable");
		refused(await preview(retired_template, {}), "unavailable");
		refused(await preview("commitment-card", {}, unsupported_format), "invalid_input");
		for (const link of [
			{ wikiSlug: c.action.arguments.article },
			{ meetingId: randomUUID() },
			{ teamId: randomUUID() },
		])
			assert.deepEqual(ok(await documentsReader["templates.contextual"](db, await who(A), link)).templates, []);
	});
});

test("AC:CASE-DOC-002 every offered format generates the bytes its preview showed, and a render that fails adds no file and no history", async () => {
	const c = caseOf("CASE-DOC-002");
	const { template, merge_fields, foreign_control, invalid_control } = c.action.arguments;
	const before = await history();
	const { templates } = ok(await documentsReader["templates.list"](db, await who(A), {}));
	let made = 0;
	for (const { id, formats } of templates)
		for (const format of formats) {
			const shown = await untouched(admin, async () => ok(await preview(id, merge_fields, format)));
			const saved = await noSideEffects(["documents.generated", "files.finalized"], async () =>
				ok(await generate(id, `CASE-DOC-002-${id}`, merge_fields, format)),
			);
			assert.equal(saved.digest, shown.digest, id);
			assert.deepEqual(await storedOf(saved), artifactOf(shown), id);
			made += 1;
		}
	assert.equal(made, 13);
	assert.equal((await history()).length, before.length + 13);

	const resolved = ok(
		await documentsReader.resolveContext(db, await who(A), {
			templateId: template,
			format: "pdf",
			overrides: merge_fields,
		}),
	);
	assert.deepEqual(
		resolved.fields.filter((f) => f.key === "church_name").map((f) => [f.value, f.source]),
		[["Harvest Point", "override"]],
	);
	const blankName = { church_name: invalid_control.name };
	const kept = ok(
		await documentsReader.resolveContext(db, await who(A), {
			templateId: template,
			format: "pdf",
			overrides: blankName,
		}),
	);
	assert.equal(kept.fields.find((f) => f.key === "church_name")?.value, "Harvest Point");
	await untouched(admin, async () => {
		const malformed = { church_name: "Harvest Point \uD800" };
		for (const reply of [
			await preview(template, malformed),
			await generate(template, "CASE-DOC-002-malformed", malformed),
		]) {
			refused(reply, c.expected.result.error_code);
			assert.equal("value" in reply, false);
		}
		const oversized = { church_name: "x".repeat(2001) };
		refused(await preview(template, oversized), "invalid_input");
		refused(await generate(template, "CASE-DOC-002-oversized", oversized), "invalid_input");
		refused(
			await documentsReader.resolveContext(db, await who(A), {
				templateId: template,
				format: "pdf",
				personId: invalid_control.id,
			}),
			"invalid_input",
		);
		assert.equal(foreign_control.actor, "B");
		const team = randomUUID();
		const inputs = { templateId: template, format: "pdf" };
		refused(await documentsReader.resolveContext(db, await who(A), { ...inputs, teamId: team }), "invalid_subject");
		refused(
			await documentsWriter.generate(
				db,
				await who(A),
				{ ...inputs, teamId: team, requestKey: "CASE-DOC-002-foreign" },
				storage,
			),
			"invalid_subject",
		);
		const foreign = ok(await documentsReader.resolveContext(db, await who(B), inputs));
		assert.equal(foreign.plantId, Q.id);
		assert.equal(JSON.stringify(foreign).includes("Harvest Point"), false);
	});
});

test("AC:CASE-DOC-003 a failed insert after the upload leaves the last saved file current; its orphan is cleaned and the saved bytes never change", async () => {
	const c = caseOf("CASE-DOC-003");
	const current = ok(await generate("commitment-card", c.given["behavior-inputs"].previous_file));
	const bytes = Buffer.from(await storedOf(current));
	const before = await history();
	assert.equal(before[0]?.id, current.id);

	const failed = await failingWrite(admin, { on: "generated_document", event: "INSERT" }, () =>
		noSideEffects(["files.finalized"], () =>
			generate("response-card", "CASE-DOC-003-failed").then(
				(value) => assert.fail(`expected the save to fail, got ${JSON.stringify(value)}`),
				(thrown: unknown) => thrown,
			),
		),
	);
	assert.match(inspect(failed), /injected fault/);
	assert.deepEqual(await history(), before, "the failed save is not in the history");
	const orphan = () =>
		rows<{ id: string; state: string; key: string }>(
			sql`SELECT id, state, opaque_key AS key FROM file_object WHERE upload_key = ${`generated:${P}:CASE-DOC-003-failed`}`,
		);
	const uploaded = present((await orphan())[0]);
	assert.deepEqual([uploaded.state, client.objects.has(uploaded.key)], ["ready", true], "the upload did succeed");

	await at("2026-10-13T16:20:00Z");
	const rescued = randomUUID();
	const other = ok(await generate("response-card", "CASE-DOC-003-other"));
	const [raceResult] = await raced(
		admin,
		db,
		sql`INSERT INTO generated_document (id, tenant_id, creator_account_id, template_id, template_version, saved_template_name,
				renderer_version, format, object_id, inputs, download_name, generated_at, request_key)
			SELECT ${rescued}::uuid, tenant_id, creator_account_id, 'old-template', template_version, 'Old template', renderer_version,
				format, ${uploaded.id}::uuid, inputs, download_name, generated_at, 'CASE-DOC-003-failed'
			FROM generated_document WHERE id = ${other.id}::uuid`,
		[() => documentsWriter.reconcileOrphans(db, storage)],
	);
	assert.equal(ok(raceResult).purged, 0, "a file that gains its record while cleanup waits is kept");
	assert.deepEqual([(await fileOf(rescued)).state, client.objects.has(uploaded.key)], ["ready", true]);
	const removedTemplate = ok(await documentsWriter["history.get"](db, await who(A), { documentId: rescued }));
	assert.deepEqual([removedTemplate.templateId, removedTemplate.savedTemplateName], ["old-template", "Old template"]);
	ok(await documentsWriter.download(db, await who(A), { documentId: rescued }, storage));

	await failingWrite(admin, { on: "generated_document", event: "INSERT" }, () =>
		generate("response-card", "CASE-DOC-003-orphan").catch(() => null),
	);
	const unreferenced = async () => ok(await documentsWriter.reconcileOrphans(db, storage)).purged;
	assert.equal(await unreferenced(), 0, "a fresh upload is not an orphan yet");
	await at("2026-10-13T16:40:00Z");
	assert.equal(await unreferenced(), 1);
	assert.deepEqual(
		await rows(sql`SELECT state FROM file_object WHERE upload_key = ${`generated:${P}:CASE-DOC-003-orphan`}`),
		[{ state: "purged" }],
	);

	try {
		await admin.execute(sql`UPDATE plant SET name = 'Renamed Church' WHERE id = ${P}::uuid`);
		assert.notEqual(ok(await preview("commitment-card", {})).digest, current.digest, "the source fact changed");
		const entry = present((await history()).find((e) => e.id === current.id));
		assert.deepEqual(entry, present(before[0]));
		const link = ok(await documentsWriter.download(db, await who(A), { documentId: current.id }, storage));
		const { key } = await fileOf(current.id);
		assert.equal(link.url.includes(key), true);
		assert.deepEqual(client.objects.get(key), bytes);
	} finally {
		await admin.execute(sql`UPDATE plant SET name = 'Harvest Point' WHERE id = ${P}::uuid`);
	}
});

test("AC:CASE-DOC-015 a download of a church's own file expires five minutes after it is issued; foreign-download-denied, a false type, 11 MiB and a referenced delete are refused", async () => {
	await at(OCTOBER_13);
	const c = caseOf("CASE-DOC-015");
	const denied = caseOf("CASE-DOC-015", "foreign-download-denied");
	const { TTL_seconds } = c.given["behavior-inputs"];
	const bytes = Buffer.from(c.given.D.bytes_utf8);
	const D = randomUUID();
	const object = randomUUID();
	const key = `private/${P}/${randomUUID()}`;
	client.objects.set(key, bytes);
	await admin.execute(sql`INSERT INTO file_object (id, tenant_id, purpose, opaque_key, media_type, max_bytes, byte_count, sha256, state, upload_key, claim_generation)
		VALUES (${object}::uuid, ${P}::uuid, 'generated', ${key}, 'application/pdf', ${bytes.length}, ${bytes.length}, ${sha(bytes)}, 'ready', 'CASE-DOC-015', 0)`);
	await admin.execute(sql`INSERT INTO generated_document (id, tenant_id, template_id, template_version, saved_template_name, renderer_version, format, object_id, inputs, download_name, generated_at)
		VALUES (${D}::uuid, ${P}::uuid, 'commitment-card', ${"ab".repeat(32)}, 'D', 'renderer', 'pdf', ${object}::uuid, '[]'::jsonb, 'D.pdf', clock_timestamp())`);

	await untouched(admin, async () => {
		const link = ok(await documentsWriter.download(db, await who(A), { documentId: D }, storage));
		assert.deepEqual([link.expiresAt, link.expiresInSeconds], ["2026-10-13T16:05:00.000Z", TTL_seconds]);
		assert.equal(Date.parse(link.expiresAt), Date.parse(c.expected.result.expires_at));
		const signed = new URL(link.url);
		assert.equal(signed.pathname.endsWith(key), true);
		assert.deepEqual(
			[signed.searchParams.get("X-Amz-Date"), signed.searchParams.get("X-Amz-Expires")],
			["20261013T160000Z", "300"],
		);

		assert.equal(denied.expected.result.error_code, "access_denied");
		for (const reply of [
			await documentsWriter.download(db, await who(B), { documentId: D }, storage),
			await documentsWriter.download(db, await who(B), { documentId: object }, storage),
			await documentsWriter.download(db, await who(A), { documentId: object }, storage),
			await documentsWriter.download(db, await who(B), { documentId: randomUUID() }, storage),
		]) {
			refused(reply, "unavailable");
			assert.equal("value" in reply, false);
			assert.equal(JSON.stringify(reply).includes(key), false);
		}
		refused(await documentsWriter.download(db, await who(A), { documentId: key }, storage), "invalid_input");
		const system: ResourceAuthorizer = async (_tx, _file, intent) =>
			intent === "read" ? null : { kind: "system", cause: "native_file_upload" };
		const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } })
			.png()
			.toBuffer();
		const commitment = (claimed: Buffer, size = claimed.length) =>
			putPrivateObject(db, storage, system, {
				tenantId: P,
				purpose: "commitment",
				mediaType: "application/pdf",
				bytes: Buffer.concat([claimed], size),
				uploadKey: toUploadKey(randomUUID()),
			});
		await assert.rejects(commitment(png), /invalid_file/);
		await assert.rejects(commitment(Buffer.from("%PDF-1.7"), 11 * 1024 * 1024), /invalid_file/);
		await assert.rejects(deleteUnreferencedObject(db, storage, system, object), /unavailable/);
		assert.equal(ok(await documentsWriter.reconcileOrphans(db, storage)).purged, 0);
		assert.deepEqual(client.objects.get(key), bytes, "the referenced object is not deleted");
	});

	const replacement = randomUUID();
	const replacementKey = `private/${P}/${randomUUID()}`;
	client.objects.set(replacementKey, bytes);
	await admin.execute(sql`INSERT INTO file_object (id, tenant_id, purpose, opaque_key, media_type, max_bytes, byte_count, sha256, state, upload_key, claim_generation)
		VALUES (${replacement}::uuid, ${P}::uuid, 'generated', ${replacementKey}, 'application/pdf', ${bytes.length}, ${bytes.length}, ${sha(bytes)}, 'ready', 'CASE-DOC-015-replacement', 0)`);
	const [cleaned] = await raced(
		admin,
		db,
		sql`INSERT INTO generated_document (tenant_id, template_id, template_version, saved_template_name, renderer_version, format, object_id, inputs, download_name, generated_at)
			VALUES (${P}::uuid, 'commitment-card', ${"ab".repeat(32)}, 'D', 'renderer', 'pdf', ${replacement}::uuid, '[]'::jsonb, 'D.pdf', clock_timestamp())`,
		[() => documentsWriter.reconcileOrphans(db, storage)],
	);
	assert.equal(ok(cleaned).purged, 0);
	assert.deepEqual([client.objects.has(replacementKey), client.objects.has(key)], [true, true]);
});

test("AC:CASE-DOC-016 an import becomes native content, a malformed Word file changes nothing, a save racing an archive keeps one outcome, and Use for this church copies one revision", async () => {
	const c = caseOf("CASE-DOC-016");
	const { import_text } = c.given["behavior-inputs"];
	assert.equal(import_text, "We serve our community.");
	const expected = {
		type: "doc",
		content: [{ type: "paragraph", content: [{ type: "text", text: "We serve our community." }] }],
	};
	const note = c.given["private-A"].note;
	const importing = (input: Record<string, unknown>) =>
		who(A).then((authority) => documentsWriter.importTextOrWord(db, authority, { title: "Values", ...input }, storage));
	const imported = await noSideEffects(["documents.imported", "files.finalized"], async () =>
		ok(
			await importing({
				format: "text",
				bytes: Buffer.from(import_text),
				expectedRevision: "0",
				requestKey: "CASE-DOC-016-text",
			}),
		),
	);
	assert.deepEqual(imported.body, expected);
	assert.equal(imported.tenantId, P);
	const held = await noSideEffects(["documents.saved"], async () =>
		ok(
			await documentsWriter.saveNative(db, await who(A), {
				title: "Held",
				body: nativeFromText(c.given["behavior-inputs"].previous_state),
				expectedRevision: "0",
			}),
		),
	);
	const word = (entries: Parameters<typeof W.storedZip>[0]) => W.storedZip(entries);
	const malformed: [string, Uint8Array][] = [
		["malformed_DOCX", Buffer.from("PK\u0003\u0004 not a Word file")],
		["no document part", word([{ name: "word/other.xml", data: "<x/>" }])],
		["broken XML", word([{ name: "word/document.xml", data: "<w:document><w:body>" }])],
	];
	await untouched(admin, async () => {
		for (const [name, bytes] of malformed)
			refused(
				await importing({
					format: "docx",
					bytes,
					documentId: held.id,
					expectedRevision: held.revision,
					requestKey: name,
				}),
				"invalid_input",
			);
		const read = ok(await documentsWriter.getAuthorized(db, await who(A), { documentId: held.id }));
		assert.deepEqual(read.body, {
			type: "doc",
			content: [{ type: "paragraph", content: [{ type: "text", text: c.expected.result.failed_control_state }] }],
		});
	});

	const holding = async (title: string) =>
		ok(
			await documentsWriter.saveNative(db, await who(A), {
				title,
				body: nativeFromText("Before the race."),
				expectedRevision: "0",
			}),
		);
	for (const first of ["save", "archive"] as const) {
		const doc = await holding(`Race, ${first} first`);
		const change = { documentId: doc.id, expectedRevision: doc.revision };
		const revise = async () =>
			documentsWriter.saveNative(db, await who(A), {
				...change,
				title: "Race",
				body: nativeFromText("Saved during the race."),
			});
		const archive = async () => documentsWriter.archive(db, await who(A), change);
		const pair = await raced(
			admin,
			db,
			sql`SELECT FROM document WHERE id = ${doc.id}::uuid FOR UPDATE`,
			first === "save" ? [revise, archive] : [archive, revise],
		);
		ok(pair[0]);
		refused(pair[1], "conflict");
		assert.deepEqual(
			await rows(sql`SELECT revision::text AS revision, archived_at IS NOT NULL AS archived,
				(SELECT count(*)::int FROM document_revision r WHERE r.document_id = d.id) AS revisions,
				(SELECT count(*)::int FROM audit_event a WHERE a.subject_id = d.id) AS audits
				FROM document d WHERE id = ${doc.id}::uuid`),
			[{ revision: "2", archived: first === "archive", revisions: first === "save" ? 2 : 1, audits: 2 }],
			first,
		);
	}

	const { id: seat } = present(
		(
			await rows<{ id: string }>(
				sql`UPDATE seat SET ended_at = clock_timestamp() WHERE account_id = ${A.id}::uuid AND ended_at IS NULL RETURNING id`,
			)
		)[0],
	);
	const privately = async (title: string, text: string) =>
		ok(
			await documentsWriter.saveNative(db, await who(A), { title, body: nativeFromText(text), expectedRevision: "0" }),
		);
	const source = await privately("Personal values", import_text);
	const other = await privately("Private note", note);
	await admin.execute(sql`UPDATE seat SET ended_at = NULL WHERE id = ${seat}::uuid`);
	const owned = async () => ok(await documentsWriter.listOwned(db, await who(A), {})).documents;
	const listedBefore = await owned();
	const copy = ok(
		await documentsWriter.useForChurch(db, await who(A), {
			documentId: source.id,
			revisionId: source.revisionId,
			requestKey: "CASE-DOC-016-copy",
		}),
	);
	assert.deepEqual(copy.body, expected);
	assert.deepEqual([copy.tenantId, copy.copiedFromRevisionId], [P, source.revisionId]);
	const listed = await owned();
	const added = listed.filter((d) => !listedBefore.some((b) => b.id === d.id));
	assert.deepEqual(
		added.map((d) => [d.id, d.title]),
		[[copy.id, "Personal values"]],
	);
	assert.equal(JSON.stringify(listed).includes(note), false);
	assert.equal(
		await count(
			sql`document d JOIN document_revision r ON r.document_id = d.id WHERE d.tenant_id = ${P}::uuid AND r.body LIKE ${`%${note}%`}`,
		),
		c.expected.result.private_other_docs_copied,
	);
	assert.deepEqual(
		await rows(
			sql`SELECT id, tenant_id::text AS owner FROM document WHERE id IN (${source.id}::uuid, ${other.id}::uuid) ORDER BY title`,
		),
		[
			{ id: source.id, owner: A.id },
			{ id: other.id, owner: A.id },
		],
	);
});

test("AC:CASE-DOC-017 an outward-facing preview with no brand kit is the neutral theme with the church name in type, and takes the church's theme once there is a kit", async () => {
	await at(OCTOBER_30);
	const { template, merge_fields } = caseOf("CASE-DOC-017").action.arguments;
	const shown = await untouched(admin, async () => ok(await preview(template, merge_fields)));
	const bytes = artifactOf(shown);
	assert.equal(shown.brandKit, false);
	const theme = ok(await brandReader.resolveTheme(db, await who(A), { documentClass: "outward-facing" }));
	assert.deepEqual([theme.kind, theme.churchName], [caseOf("CASE-DOC-017").expected.result.theme, "Harvest Point"]);
	const pages = await pdfPages(bytes);
	assert.match(present(pages[0]), /^Harvest Point /);
	assert.equal(pages.join(" ").includes("Everyfield"), false);
	assert.equal(/\/XObject/.test(await pdfOperators(bytes)), false, "no logo image of any kind");
	const opened = await PDFDocument.load(bytes, { updateMetadata: false });
	assert.ok(opened.getPageCount() >= 1);
	assert.equal(await paints(bytes, NAVY), false);
	assert.equal(await paints(bytes, "0.094 0.114 0.098"), true, "the neutral ink");
	await brand(caseOf("CASE-DOC-019").given.kit);
	const themed = ok(await preview(template, merge_fields));
	assert.equal(themed.brandKit, true);
	assert.equal(await paints(artifactOf(themed), NAVY), true, "the supplied theme's primary color");
	await unbrand();
});

test("AC:CASE-DOC-017-CHURCH a saved kit replaces the neutral theme", async () => {
	const c = caseOf("CASE-DOC-017-CHURCH");
	await brand(c.given.kit, true);
	const theme = await untouched(admin, async () =>
		ok(await brandReader.resolveTheme(db, await who(A), { documentClass: c.action.arguments.document_class })),
	);
	assert.deepEqual(
		{
			theme: theme.kind,
			primary_color: theme.colors.primary,
			accent_color: theme.colors.accent,
			heading_font: theme.fonts.heading,
			fallback_used: theme.fallbackUsed,
		},
		c.expected.result,
	);
	assert.equal(theme.fonts.body, "DM Sans");
	assert.ok(theme.layout.documentClass === "outward-facing");
	assert.equal(present(theme.layout.coverLogo).alt, "Harvest Point Church logo");
	await unbrand();
});

test("AC:CASE-DOC-018 every catalog template carries exactly one of the four document classes and the product's lists agree", async () => {
	const { classes_offered, budget_class } = caseOf("CASE-DOC-018").expected.result;
	const classOf = new Map<string, string>();
	for (const t of catalog.templates) {
		assert.equal(classOf.has(t.id), false, `${t.id} has one entry`);
		assert.ok(classes_offered.includes(t.class), `${t.id}: ${t.class}`);
		classOf.set(t.id, t.class);
	}
	assert.deepEqual([...new Set(classOf.values())].sort(), [...classes_offered].sort());
	for (const id of ["first-year-budget", "budget-worksheet"]) assert.equal(classOf.get(id), budget_class);
	await untouched(admin, async () => {
		const library = ok(await documentsReader["templates.list"](db, await who(A), {})).templates;
		for (const t of [...library, ...docTemplateSummaries()]) assert.equal(t.documentClass, classOf.get(t.id), t.id);
		for (const { id } of library) {
			const one = ok(await documentsReader["templates.get"](db, await who(A), { templateId: id }));
			assert.equal(one.documentClass, classOf.get(id), id);
		}
		for (const documentClass of classes_offered) {
			const theme = ok(await brandReader.resolveTheme(db, await who(A), { documentClass }));
			assert.equal(theme.layout.documentClass, documentClass);
		}
	});
	const emails = catalog.templates.filter((t) => t.class === "email");
	assert.deepEqual(
		emails.map((t) => t.title),
		[
			"Vision Meeting Invitation",
			"Vision Meeting Reminder",
			"Vision Meeting Follow-Up — Attended",
			"Vision Meeting Follow-Up — No Show",
			"Orientation Invitation",
			"Team Meeting Invitation",
			"General Announcement",
		],
	);
});

test("AC:CASE-DOC-019 a formal/legal template prints its legal notice with church branding on, in the preview and the saved PDF; operational-has-no-notice", async () => {
	const c = caseOf("CASE-DOC-019");
	await brand(c.given.kit, true);
	const { template, merge_fields } = c.action.arguments;
	const shown = await untouched(admin, async () => ok(await preview(template, merge_fields)));
	assert.equal(shown.brandKit, true);
	assert.equal(await paints(artifactOf(shown), NAVY), true, "church branding is on");
	const saved = ok(await generate(template, "CASE-DOC-019", merge_fields));
	assert.equal(saved.digest, shown.digest);
	for (const page of [...(await pdfPages(artifactOf(shown))), ...(await pdfPages(await storedOf(saved)))])
		assert.equal(page.split(c.expected.result.legal_notice).length - 1, 1, page);

	const plain = caseOf("CASE-DOC-019", "operational-has-no-notice").action.arguments;
	const checklists = ok(await preview(plain.template, plain.merge_fields));
	const printed = ok(await generate(plain.template, "CASE-DOC-019-operational", plain.merge_fields));
	for (const text of [await pdfText(artifactOf(checklists)), await pdfText(await storedOf(printed))]) {
		assert.ok(text.includes("Harvest Point"));
		assert.equal(/legal advice/i.test(text), false);
	}
	await unbrand();
});

test("AC:CASE-DOC-019-EDIT a bylaws document with no body text still exports the notice as PDF and docx-keeps-notice; outward-facing-has-no-notice", async () => {
	const c = caseOf("CASE-DOC-019-EDIT");
	await brand(caseOf("CASE-DOC-019").given.kit, true);
	const merge_fields = { church_name: "Harvest Point" };
	const D = ok(await create({ template: "bylaws", merge_fields, request_key: "CASE-DOC-019-EDIT-D" }));
	const emptied = ok(await save(D, wiped(D.body)));
	assert.equal(emptied.revision, "2");
	assert.equal(emptied.useChurchBranding, true);
	assert.equal(JSON.stringify(emptied.body).includes("legal advice"), false, "the notice is not in the editable body");
	const pdf = await noSideEffects(["documents.exported", "files.finalized"], async () =>
		ok(await exportOf(D.id, c.action.arguments)),
	);
	assert.deepEqual([pdf.format, pdf.theme?.kind], [c.expected.result.format, "church"]);
	assert.ok((await pdfText(await storedOf(pdf))).includes(c.expected.result.legal_notice));
	const asWord = caseOf("CASE-DOC-019-EDIT", "docx-keeps-notice");
	const docx = ok(await exportOf(D.id, asWord.action.arguments));
	assert.equal(docx.format, asWord.expected.result.format);
	const word = wordOf(await storedOf(docx));
	assert.ok(word.text.includes(asWord.expected.result.legal_notice));
	assert.equal(word.body.includes(NOTICE), false, "the notice is outside the Word body");

	const letter = caseOf("CASE-DOC-019-EDIT", "outward-facing-has-no-notice");
	const L = ok(await create({ template: "prayer-letter", merge_fields, request_key: "CASE-DOC-019-EDIT-L" }));
	assert.equal(L.documentClass, "outward-facing");
	const sent = ok(await exportOf(L.id, letter.action.arguments));
	const text = await pdfText(await storedOf(sent));
	assert.equal(sent.format, letter.expected.result.format);
	assert.ok(text.includes("Harvest Point"));
	assert.equal(/legal advice/i.test(text), false);
	await unbrand();
});

const slotIn = (body: DocDocument): SlotNode | undefined =>
	blocksOf(body)
		.filter(isSlot)
		.find((n) => n.attrs?.key === "statement-of-faith");
const assertBlank = (text: string) => {
	assert.match(text, /2 Statement of faith statement of faith Not filled in yet\./i);
	assert.ok(text.includes(BLANK), "the visible blank");
	assert.equal(DOCTRINAL.test(text), false, `doctrinal words: ${DOCTRINAL.exec(text)?.[0]}`);
};
const assertOmitted = (text: string) => {
	assert.ok(text.includes("Harvest Point"));
	assert.match(
		text,
		/2 Statement of faith 3 Members/,
		"the template's own heading, with no slot label or blank under it",
	);
	assert.equal(text.match(/statement of faith/gi)?.length, 1);
	assert.equal(text.includes("Not filled in yet"), false);
	assert.equal(DOCTRINAL.test(text), false);
};

test("AC:CASE-DOC-020 an unfilled doctrinal section previews and forks as a visible blank; network-fills-slot and network-fills-preview print the network's text; no-network-blank-slot", async () => {
	const c = caseOf("CASE-DOC-020");
	const { template, merge_fields } = c.action.arguments;
	const shown = await untouched(admin, async () => ok(await preview(template, merge_fields)));
	assertBlank(await pdfText(artifactOf(shown)));
	const blank = caseOf("CASE-DOC-020", "no-network-blank-slot");
	const unfilled = await noSideEffects(["documents.created_from_template"], async () =>
		ok(await create(blank.action.arguments)),
	);
	assert.equal(unfilled.revision, "1");
	assert.deepEqual(present(slotIn(unfilled.body)).content ?? [], []);
	const exported = ok(
		await exportOf(unfilled.id, { revision: 1, format: "pdf", request_key: "CASE-DOC-020-blank-pdf" }),
	);
	assertBlank(await pdfText(await storedOf(exported)));

	const fills = caseOf("CASE-DOC-020", "network-fills-slot");
	const words = fills.given.network.statement_of_faith;
	const network = await database.organization("sending_network", { statement_of_faith: words });
	await admin.execute(
		sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
			VALUES(${P}::uuid,${network.id}::uuid,clock_timestamp(),false,false,false,false,false,false,false)`,
	);
	try {
		const filled = ok(await create(fills.action.arguments));
		assert.equal(filled.revision, "1");
		assert.deepEqual(present(slotIn(filled.body)).content, [
			{ type: "paragraph", content: [{ type: "text", text: "Network statement of faith." }] },
		]);
		const out = ok(await exportOf(filled.id, { revision: 1, format: "pdf", request_key: "CASE-DOC-020-filled-pdf" }));
		const inPreview = caseOf("CASE-DOC-020", "network-fills-preview").action.arguments;
		const again = await untouched(admin, async () => ok(await preview(inPreview.template, inPreview.merge_fields)));
		for (const text of [await pdfText(await storedOf(out)), await pdfText(artifactOf(again))]) {
			assert.match(text, /statement of faith Network statement of faith\./i);
			assert.equal(text.includes("Not filled in yet"), false);
			assert.equal(DOCTRINAL.test(text), false);
		}
	} finally {
		await admin.execute(
			sql`UPDATE affiliation SET ended_at = clock_timestamp() WHERE organization_id = ${network.id}::uuid`,
		);
	}
});

test("AC:CASE-DOC-020-EDIT an unfilled slot exports blank as PDF and docx-shows-blank; slot-delete-saves; deleted-slot-pdf-omits-section, deleted-slot-docx-omits-section and earlier-revision-keeps-blank", async () => {
	const c = caseOf("CASE-DOC-020-EDIT");
	const sub = (name: string) => caseOf("CASE-DOC-020-EDIT", name).action.arguments;
	const D = ok(
		await create({
			template: "bylaws",
			merge_fields: { church_name: "Harvest Point" },
			request_key: "CASE-DOC-020-EDIT-D",
		}),
	);
	assert.equal(D.useChurchBranding, true);
	const exported = async (args: { revision: number; format: string; request_key: string }) => {
		const made = await noSideEffects(["documents.exported", "files.finalized"], async () =>
			ok(await exportOf(D.id, args)),
		);
		assert.deepEqual([made.format, made.source?.revision], [args.format, args.revision]);
		const bytes = await storedOf(made);
		return args.format === "pdf" ? pdfText(bytes) : wordOf(bytes).text;
	};
	assertBlank(await exported(c.action.arguments));
	assertBlank(await exported(sub("docx-shows-blank")));

	const removed = structuredClone(D.body);
	removed.body.content = blocksOf(removed).filter(
		(n) => !(isSlot(n) && n.attrs?.key === sub("slot-delete-saves").remove_node),
	);
	const saved = await noSideEffects(["documents.saved"], async () => ok(await save(D, removed)));
	assert.equal(saved.revision, "2");
	assert.equal("warning" in saved, false);
	const read = async (revision: number) =>
		ok(await documentsWriter["history.get"](db, await who(A), { documentId: D.id, revision })).body;
	assert.deepEqual(
		{
			current_revision: Number(ok(await documentsWriter.readChurch(db, await who(A), { documentId: D.id })).revision),
			revision_2_slot_present: slotIn(await read(2)) !== undefined,
			revision_1_slot_present: slotIn(await read(1)) !== undefined,
		},
		{ current_revision: 2, revision_2_slot_present: false, revision_1_slot_present: true },
	);
	assertOmitted(await exported(sub("deleted-slot-pdf-omits-section")));
	assertOmitted(await exported(sub("deleted-slot-docx-omits-section")));
	assertBlank(await exported(sub("earlier-revision-keeps-blank")));
});

test("AC:CASE-DOC-021 the child protection policy prints church plant, never a bare plant, and spells Everyfield one way", async () => {
	const { template, merge_fields } = caseOf("CASE-DOC-021").action.arguments;
	const doc = ok(await create({ template, merge_fields, request_key: "CASE-DOC-021" }));
	assert.equal(doc.documentClass, "formal/legal");
	const file = await untouched(admin, async () =>
		ok(await documentsWriter.readChurchFile(db, await who(A), { documentId: doc.id, format: "pdf" }, storage)),
	);
	const text = await pdfText(Buffer.from(file.bytes, "base64"));
	assert.ok(text.includes("Harvest Point"));
	assert.match(text, /\bchurch plant\b/);
	assert.equal(/\bplants?\b/i.test(text.replace(/church plants?/gi, "")), false);
	assert.equal(/every ?field/i.test(text.replaceAll("Everyfield", "")), false);
});

test("AC:CASE-DOC-022 an Admin creates a bylaws document with its merge values in revision 1; member-refused; fixed-layout-refused", async () => {
	const c = caseOf("CASE-DOC-022");
	const filesBefore = await count(sql`file_object`);
	const generatedBefore = await count(sql`generated_document`);
	const doc = await noSideEffects(["documents.created_from_template"], async () =>
		ok(await create(c.action.arguments)),
	);
	const owner = present(
		(await rows(sql`SELECT tenant_id::text AS owner FROM document WHERE id = ${doc.id}::uuid`))[0],
	).owner;
	assert.deepEqual(
		{
			revision: Number(doc.revision),
			template: doc.templateId,
			template_version: doc.templateVersion,
			document_class: doc.documentClass,
			revision_1_church_name: doc.body.data?.church_name,
			use_church_branding: doc.useChurchBranding,
			files_created:
				(await count(sql`file_object`)) - filesBefore + (await count(sql`generated_document`)) - generatedBefore,
			document_owner: owner === P ? "P" : owner,
		},
		c.expected.result,
	);
	assert.deepEqual(
		await rows(
			sql`SELECT tenant_id::text AS owner, document_class, use_church_branding FROM document WHERE id = ${doc.id}::uuid`,
		),
		[{ owner: P, document_class: "formal/legal", use_church_branding: true }],
	);
	assert.deepEqual(
		doc.provenance.find((p) => p.key === "church_name"),
		{ key: "church_name", value: "Harvest Point", source: "override" },
	);
	try {
		await admin.execute(sql`UPDATE plant SET name = 'Renamed Church' WHERE id = ${P}::uuid`);
		const one = ok(await documentsWriter["history.get"](db, await who(A), { documentId: doc.id, revision: 1 }));
		assert.equal(one.body.data?.church_name, "Harvest Point");
	} finally {
		await admin.execute(sql`UPDATE plant SET name = 'Harvest Point' WHERE id = ${P}::uuid`);
	}

	const member = caseOf("CASE-DOC-022", "member-refused");
	await untouched(admin, async () => {
		const reply = await create(member.action.arguments, M);
		refused(reply, member.expected.result.error_code);
		assert.equal("value" in reply, false);
	});

	const fixed = caseOf("CASE-DOC-022", "fixed-layout-refused");
	const documents = () => count(sql`document`);
	const held = await documents();
	await untouched(admin, async () => {
		refused(await create(fixed.action.arguments), "unavailable");
		for (const template of ["vision-meeting-agenda", "first-year-budget", "vision-meeting-invitation"])
			refused(await create({ ...fixed.action.arguments, template, request_key: `fixed-${template}` }), "unavailable");
	});
	assert.equal((await documents()) > held, fixed.expected.result.document_created);
});

test("AC:CASE-DOC-023 revision 2 exports in the church theme as PDF and export-docx; download-after-edit-and-kit-change returns the same bytes; new-export-uses-new-theme", async () => {
	const c = caseOf("CASE-DOC-023");
	const sub = (name: string) => caseOf("CASE-DOC-023", name);
	await brand(c.given.kit, true);
	const D = ok(
		await create({ template: "bylaws", merge_fields: { church_name: "Harvest Point" }, request_key: "CASE-DOC-023-D" }),
	);
	const edited = structuredClone(D.body);
	blocksOf(edited).push({ type: "paragraph", content: [{ type: "text", text: "Second revision." }] });
	const two = ok(await save(D, edited));
	assert.equal(two.revision, "2");

	const saved = await count(sql`generated_document`);
	const pdf = await noSideEffects(["documents.exported", "files.finalized"], async () =>
		ok(await exportOf(D.id, c.action.arguments)),
	);
	assert.equal((await count(sql`generated_document`)) - saved, c.expected.result.generated_document_saved);
	assert.deepEqual(
		{ format: pdf.format, theme: pdf.theme?.kind, primary_color: pdf.theme?.primary },
		{ format: "pdf", theme: "church", primary_color: "#1F4E79" },
	);
	assert.deepEqual([pdf.source?.documentId, pdf.source?.revision], [D.id, c.expected.result.provenance.revision]);
	assert.equal(pdf.generatedAt.slice(0, 10), "2026-10-30");
	const pdfBytes = Buffer.from(await storedOf(pdf));
	assert.ok((await pdfText(pdfBytes)).includes("Second revision."));
	assert.equal(await paints(pdfBytes, NAVY), true);
	const opened = await PDFDocument.load(pdfBytes, { updateMetadata: false });
	const marked = opened.catalog.lookup(PDFName.of("MarkInfo"));
	assert.ok(marked instanceof PDFDict);
	assert.equal(String(marked.get(PDFName.of("Marked"))), "true");
	assert.ok(opened.catalog.lookup(PDFName.of("StructTreeRoot")) instanceof PDFDict);
	assert.ok(opened.catalog.has(PDFName.of("Lang")));

	const docxCase = sub("export-docx");
	const docx = ok(await exportOf(D.id, docxCase.action.arguments));
	assert.equal((await count(sql`generated_document`)) - saved, 2);
	assert.deepEqual([docx.format, docx.theme?.kind, docx.theme?.primary], ["docx", "church", "#1F4E79"]);
	const docxBytes = Buffer.from(await storedOf(docx));
	const { parts, text } = wordOf(docxBytes);
	const body = present(parts["word/document.xml"]);
	assert.ok(parts["[Content_Types].xml"] && parts["_rels/.rels"]);
	assert.match(body, /<w:pStyle w:val="Heading1"\/>/);
	assert.match(body, /<w:tbl>/);
	assert.match(body, /descr="Harvest Point Church logo"/);
	assert.ok(present(parts["word/styles.xml"]).includes('w:val="1F4E79"'));
	assert.ok(text.includes("Second revision."));

	const third = structuredClone(two.body);
	blocksOf(third).push({ type: "paragraph", content: [{ type: "text", text: "Third revision." }] });
	assert.equal(ok(await save(two, third)).revision, "3");
	await brand(sub("download-after-edit-and-kit-change").given.kit);
	await untouched(admin, async () => {
		for (const [made, bytes] of [
			[pdf, pdfBytes],
			[docx, docxBytes],
		] as const) {
			const file = ok(
				await documentsWriter.readExportFile(db, await who(A), { documentId: D.id, exportId: made.id }, storage),
			);
			const got = Buffer.from(file.bytes, "base64");
			assert.deepEqual([sha(got), got.length, file.revision], [made.digest, made.byteCount, 2]);
			assert.deepEqual(got, bytes);
			const link = ok(await documentsWriter.download(db, await who(A), { documentId: made.id }, storage));
			const { key } = await fileOf(made.id);
			assert.equal(link.url.includes(key), true);
			assert.equal(sha(present(client.objects.get(key))), made.digest);
		}
	});

	const next = sub("new-export-uses-new-theme");
	const fresh = ok(await exportOf(D.id, next.action.arguments));
	assert.deepEqual(
		{ format: fresh.format, theme: fresh.theme?.kind, primary_color: fresh.theme?.primary },
		{ format: "pdf", theme: "church", primary_color: "#8B1E3F" },
	);
	assert.notEqual(fresh.digest, pdf.digest);
	const freshBytes = await storedOf(fresh);
	assert.deepEqual([await paints(freshBytes, WINE), await paints(freshBytes, NAVY)], [true, false]);
	assert.ok((await pdfText(freshBytes)).includes("Third revision."));
	await unbrand();
});
