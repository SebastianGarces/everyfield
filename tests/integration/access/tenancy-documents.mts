import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { nativeFromText } from "../../../packages/contracts/src/documents/index.ts";
import { documentsReader, documentsWriter as docs } from "../../../packages/domain/src/documents/index.ts";
import { templateFill } from "../../../packages/domain/src/documents/template-fill.ts";

const objects = new Map();
const seedStorage = {
	bucket: "tenancy-seed",
	client: {
		async send(command) {
			const input = command.input ?? {};
			switch (command.constructor.name) {
				case "GetBucketAclCommand":
					return { Grants: [{ Grantee: { ID: "private-owner" }, Permission: "FULL_CONTROL" }] };
				case "PutObjectCommand":
					objects.set(input.Key, Buffer.from(input.Body));
					return {};
				default:
					throw Error(`unexpected provider operation ${command.constructor.name}`);
			}
		},
	},
};
const POLICY = "conflict-of-interest-policy";
const AGENDA = "vision-meeting-agenda";

export async function seedDocuments(t) {
	const { a, MARK, key, ok } = t;
	const owner = t.ownerA.actor;
	const db = t.f.db;
	const church = ok(await docs.createFromTemplate(db, owner, { templateId: POLICY, requestKey: key() }));
	a.churchDoc = church.id;
	const saved = ok(
		await docs.saveNative(db, owner, {
			documentId: church.id,
			expectedRevision: church.revision,
			body: { ...church.body, title: `${MARK} policy` },
		}),
	);
	a.exportKey = key();
	a.export = ok(
		await docs.exportNative(
			db,
			owner,
			{ documentId: church.id, revision: 2, format: "pdf", requestKey: a.exportKey },
			seedStorage,
		),
	).id;
	const gone = ok(await docs.createFromTemplate(db, owner, { templateId: POLICY, requestKey: key() }));
	a.deletedDoc = gone.id;
	a.deletedExport = ok(
		await docs.exportNative(
			db,
			owner,
			{ documentId: gone.id, revision: 1, format: "pdf", requestKey: key() },
			seedStorage,
		),
	).id;
	ok(await docs.deleteChurch(db, owner, { documentId: gone.id, expectedRevision: gone.revision }));
	const shelved = ok(await docs.createFromTemplate(db, owner, { templateId: POLICY, requestKey: key() }));
	ok(await docs.archiveChurch(db, owner, { documentId: shelved.id, expectedRevision: shelved.revision }));
	ok(
		await docs.saveChurchTemplate(db, owner, {
			documentId: church.id,
			revision: Number(saved.revision),
			name: `${MARK} template`,
			requestKey: key(),
		}),
	);
	const values = ok(
		await docs.saveNative(db, owner, {
			title: `${MARK} core values`,
			body: nativeFromText(`${MARK} we love our city`),
			expectedRevision: "0",
		}),
	);
	a.native = ok(
		await docs.designateCoreValues(db, owner, { documentId: values.id, expectedRevision: values.revision }),
	).id;
	a.generated = ok(
		await docs.generate(db, owner, { templateId: "commitment-card", format: "pdf", requestKey: key() }, seedStorage),
	).id;
	await t.f.admin.execute(sql`UPDATE seat SET ended_at = clock_timestamp() WHERE account_id = ${t.ownerA.id}`);
	ok(
		await docs.saveNative(db, await t.f.actor(t.ownerA.session), {
			title: `${MARK} personal plan`,
			body: nativeFromText(`${MARK} my own notes`),
			expectedRevision: "0",
		}),
	);
	await t.f.admin.execute(sql`UPDATE seat SET ended_at = NULL WHERE account_id = ${t.ownerA.id}`);
}

export function documentsCases(t, who) {
	const { a, storage } = t;
	const db = t.f.db;
	const r = (name, run, expected) => [`documents:documentsReader.${name}`, { run, expected }];
	const w = (name, run, expected) => [`documents:documentsWriter.${name}`, { run, expected }];
	const unavailable = { refused: "unavailable" };
	const gone = (...ids) => ({ ...unavailable, echo: ids });
	const doc = { documentId: a.churchDoc };
	const agenda = { templateId: AGENDA, format: "pdf", meetingId: a.vision };
	const library = { check: (value) => assert.ok(value.templateCount > 0), control: (value) => library.check(value) };
	const exports = async () =>
		(await t.rows(sql`SELECT count(*)::int AS n FROM generated_document WHERE tenant_id = ${t.plantA.id}`))[0].n;
	return [
		r("templates.list", () => documentsReader["templates.list"](db, who.actor, {}), library),
		r("templates.get", () => documentsReader["templates.get"](db, who.actor, { templateId: AGENDA }), {
			check: (value) => assert.equal(value.id, AGENDA),
			control: (value) => assert.equal(value.id, AGENDA),
		}),
		r("templates.contextual", () => documentsReader["templates.contextual"](db, who.actor, { meetingId: a.vision }), {
			partial: { templateCount: 0, formatCount: 0, templates: [] },
			control: (value) =>
				assert.deepEqual(
					value.templates.map((x) => x.id),
					[AGENDA],
				),
		}),
		r("resolveContext", () => documentsReader.resolveContext(db, who.actor, agenda), {
			refused: "invalid_subject",
		}),
		r("preview", () => documentsReader.preview(db, who.actor, agenda), { refused: "invalid_subject" }),
		r("printAgenda", () => documentsReader.printAgenda(db, who.actor, { meetingId: a.vision }), {
			refused: "invalid_subject",
			control: (value) => assert.deepEqual([value.templateId, value.artifact.length > 0], [AGENDA, true]),
		}),

		w("download", () => docs.download(db, who.actor, { documentId: a.generated }, storage), {
			refused: "unavailable",
			control: null,
		}),
		w(
			"exportNative",
			async () => {
				const before = await exports();
				const reply = await docs.exportNative(
					db,
					who.actor,
					{ documentId: a.churchDoc, revision: 2, format: "pdf", requestKey: a.exportKey },
					storage,
				);
				assert.equal(await exports(), before, "exportNative saved a generated document in church A");
				return reply;
			},
			gone(a.churchDoc),
		),
		w("getAuthorized", () => docs.getAuthorized(db, who.actor, { documentId: a.native }), gone(a.native)),
		w("read", () => docs.read(db, who.actor, { documentId: a.native }), gone(a.native)),
		w("history.list", () => docs["history.list"](db, who.actor, {}), { value: { entries: [] } }),
		w("history.get", () => docs["history.get"](db, who.actor, { ...doc, revision: 1 }), gone(a.churchDoc)),
		w("listChurch", () => docs.listChurch(db, who.actor, {}), { value: { documents: [], templates: [] } }),
		w("listArchivedChurch", () => docs.listArchivedChurch(db, who.actor, {}), { value: { documents: [] } }),
		w("listCopySources", () => docs.listCopySources(db, who.actor, {}), { value: { documents: [] } }),
		w("listExports", () => docs.listExports(db, who.actor, doc), gone(a.churchDoc)),
		w("listOwned", () => docs.listOwned(db, who.actor, {}), { value: { documents: [] } }),
		w("readChurch", () => docs.readChurch(db, who.actor, doc), gone(a.churchDoc)),
		w("readChurchFile", () => docs.readChurchFile(db, who.actor, { ...doc, format: "pdf" }, storage), {
			...gone(a.churchDoc),
			control: (value) => assert.deepEqual([value.revision, value.bytes.length > 0], [2, true]),
		}),
		w("readChurchForEdit", () => docs.readChurchForEdit(db, who.actor, doc), gone(a.churchDoc)),
		w("readCoreValuesEvidence", () => docs.readCoreValuesEvidence(db, who.actor, {}), {
			value: { documentId: null, text: null },
		}),
		w("readExportFile", () => docs.readExportFile(db, who.actor, { ...doc, exportId: a.export }, storage), {
			refused: "unavailable",
			control: null,
		}),
		w("readTemplateCompare", () => docs.readTemplateCompare(db, who.actor, doc), gone(a.churchDoc)),
		[
			"documents/fill:templateFill",
			{
				run: () => templateFill(db, who.actor, { templateId: POLICY }),
				expected: {
					partial: { templateId: POLICY },
					check: (value) => assert.ok(value.fields.some((field) => field.value === "Synthetic plant")),
				},
			},
		],
	];
}

export function deletedDocumentCases(t, who) {
	const { a, storage } = t;
	const db = t.f.db;
	const deleted = { documentId: a.deletedDoc };
	return [
		["readExportFile", (ids) => docs.readExportFile(db, who.actor, ids, storage)],
		["listExports", ({ documentId }) => docs.listExports(db, who.actor, { documentId })],
		["readChurch", ({ documentId }) => docs.readChurch(db, who.actor, { documentId })],
	].map(([name, run]) => ({
		name,
		deleted: () => run({ ...deleted, exportId: a.deletedExport }),
		unknown: () => run({ documentId: randomUUID(), exportId: randomUUID() }),
	}));
}
