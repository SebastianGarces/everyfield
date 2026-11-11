// The documents reads of INV-tenancy (tenancy.test.mts): church A's documents, written through the documents writes as
// its owner, and one case per read. The cases read through the test's throwing storage; only the seed saves files.
import assert from "node:assert/strict";
import { sql } from "../../../packages/db/src/query.ts";
import { nativeFromText } from "../../../packages/contracts/src/documents/index.ts";
import { documentsReader, documentsWriter as docs } from "../../../packages/domain/src/documents/index.ts";

/** Private storage for the seed's saved files, as a local fake of the object store (as the documents suites use). */
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
	// An account document, for listCopySources. Raw seat rows because no public write moves a seated session to its
	// account: with the seat ended, the owner's session reads as their own account (as owned.test.mts does), then the
	// seat is restored as it was.
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
	// A reply may name the document the caller asked for; church A's control must show more of church A than that.
	const gone = (...ids) => ({ ...unavailable, echo: ids });
	const doc = { documentId: a.churchDoc };
	const agenda = { templateId: AGENDA, format: "pdf", meetingId: a.vision };
	// The shared template library: system rows, the same for every church and caller.
	const library = { check: (value) => assert.ok(value.templateCount > 0), control: (value) => library.check(value) };
	const exports = async () =>
		(await t.rows(sql`SELECT count(*)::int AS n FROM generated_document WHERE tenant_id = ${t.plantA.id}`))[0].n;
	return [
		r("templates.list", () => documentsReader["templates.list"](db, who.actor, {}), library),
		r("templates.get", () => documentsReader["templates.get"](db, who.actor, { templateId: AGENDA }), {
			// One system template, the same for every church.
			check: (value) => assert.equal(value.id, AGENDA),
			control: (value) => assert.equal(value.id, AGENDA),
		}),
		r("templates.contextual", () => documentsReader["templates.contextual"](db, who.actor, { meetingId: a.vision }), {
			// `version` is the shared library's hash, the same for every church.
			partial: { templateCount: 0, formatCount: 0, templates: [] },
			// Church A's own meeting offers its agenda, a system template.
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
			// A PDF and the meeting's date: church A's own owner prints its meeting's agenda.
			control: (value) => assert.deepEqual([value.templateId, value.artifact.length > 0], [AGENDA, true]),
		}),

		w("download", () => docs.download(db, who.actor, { documentId: a.generated }, storage), {
			refused: "unavailable",
			// The file is in private storage, which stays the throwing fake here.
			control: null,
		}),
		w(
			"exportNative",
			async () => {
				// It saves a generated document: church B's call on church A's revision must leave church A's exports as they were.
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
			// The seed's request key: church A's own owner gets the saved export back, with no new file.
			gone(a.churchDoc),
		),
		w("getAuthorized", () => docs.getAuthorized(db, who.actor, { documentId: a.native }), gone(a.native)),
		w("read", () => docs.read(db, who.actor, { documentId: a.native }), gone(a.native)),
		// With no document named, the church's saved files; with a document and revision, a Church Document revision.
		w("history.list", () => docs["history.list"](db, who.actor, {}), { value: { entries: [] } }),
		w("history.get", () => docs["history.get"](db, who.actor, { ...doc, revision: 1 }), gone(a.churchDoc)),
		w("listChurch", () => docs.listChurch(db, who.actor, {}), { value: { documents: [], templates: [] } }),
		w("listCopySources", () => docs.listCopySources(db, who.actor, {}), { value: { documents: [] } }),
		w("listExports", () => docs.listExports(db, who.actor, doc), gone(a.churchDoc)),
		w("listOwned", () => docs.listOwned(db, who.actor, {}), { value: { documents: [] } }),
		w("readChurch", () => docs.readChurch(db, who.actor, doc), gone(a.churchDoc)),
		w("readChurchFile", () => docs.readChurchFile(db, who.actor, { ...doc, format: "pdf" }, storage), {
			...gone(a.churchDoc),
			// A rendered PDF: church A's own owner gets its saved second revision (no brand images, so no storage).
			control: (value) => assert.deepEqual([value.revision, value.bytes.length > 0], [2, true]),
		}),
		w("readChurchForEdit", () => docs.readChurchForEdit(db, who.actor, doc), gone(a.churchDoc)),
		w("readCoreValuesEvidence", () => docs.readCoreValuesEvidence(db, who.actor, {}), {
			value: { documentId: null, text: null },
		}),
		w("readExportFile", () => docs.readExportFile(db, who.actor, { ...doc, exportId: a.export }, storage), {
			refused: "unavailable",
			// The saved bytes are in private storage, which stays the throwing fake here.
			control: null,
		}),
		w("readTemplateCompare", () => docs.readTemplateCompare(db, who.actor, doc), gone(a.churchDoc)),
	];
}
