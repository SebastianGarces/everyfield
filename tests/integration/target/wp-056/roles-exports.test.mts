import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { sql } from "../../../../packages/db/src/query.ts";
import type { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { documentsReader, documentsWriter } from "../../../../packages/domain/src/documents/index.ts";
import { meetingsWriter } from "../../../../packages/domain/src/meetings/index.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import { readPipelineExport } from "../../../../packages/domain/src/organizations/index.ts";
import { PeopleReadContext } from "../../../../packages/domain/src/people/core.ts";
import { getCommitmentDownload, peopleCsv } from "../../../../packages/domain/src/people/index.ts";
import { teamsReader } from "../../../../packages/domain/src/teams/index.ts";
import { createWikiProducer } from "../../../../packages/domain/src/wiki/index.ts";
import { ok } from "../../../support/fixture.mts";
import { FUTURE, key, rolesWorld, ROLES, type Role, type RolesWorld } from "./roles-world.mts";

let w: RolesWorld;
let vision: string;
before(async () => {
	w = await rolesWorld("roles_exports");
	vision = ok(
		await w.write.meetings((tx, c) =>
			meetingsWriter.schedule(tx, c, {
				requestKey: key(),
				input: { type: "vision_meeting", title: "Vision night", date: FUTURE, time: "18:00" },
			}),
		),
	).meeting.id;
	const object = key();
	await w.admin
		.execute(sql`INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,byte_count,sha256,state,upload_key,claim_generation)
		VALUES(${object},${w.plant.id},'commitment',${`private/${w.plant.id}/${object}`},'image/png',100,10,${"a".repeat(64)},'ready',${object},0)`);
	await w.admin.execute(sql`UPDATE commitment SET object_id=${object} WHERE id=${w.ids.commitment}`);
});
after(() => w?.close());

const wiki = createWikiProducer();
type Reply<V> = { status: "ok"; value: V } | { status: "refused"; error: { code: string } };
const refusals: unknown[] = [];
function shown<V, S>(reply: Reply<V>, project: (value: V) => S): S | string {
	if (reply.status === "ok") return project(reply.value);
	refusals.push(reply);
	return `refused: ${reply.error.code}`;
}
const magic = (base64: string) => Buffer.from(base64, "base64").subarray(0, 4).toString("latin1");
function docxText(base64: string) {
	const file = Buffer.from(base64, "base64");
	for (let at = file.indexOf("PK\x03\x04"); at >= 0; at = file.indexOf("PK\x03\x04", at + 4)) {
		const [size, name, extra] = [file.readUInt32LE(at + 18), file.readUInt16LE(at + 26), file.readUInt16LE(at + 28)];
		if (file.subarray(at + 30, at + 30 + name).toString() !== "word/document.xml") continue;
		const body = file.subarray(at + 30 + name + extra, at + 30 + name + extra + size);
		return (file.readUInt16LE(at + 8) ? inflateRawSync(body) : body).toString();
	}
	return "";
}

const EXPORTS: Record<string, (a: RequestActor) => Promise<unknown>> = {
	"people CSV": async (a) =>
		shown(await gatedTransaction(w.db, (tx) => peopleCsv.exportPeople(tx, new PeopleReadContext(a), {})), (v) => ({
			rows: v.text
				.slice(1)
				.trimEnd()
				.split("\r\n")
				.map((line) => line.split(",").slice(0, 4).join(",")),
			matched: v.receipt.matched,
		})),
	"signed commitment document": async (a) =>
		shown(
			await getCommitmentDownload(w.db, w.storage, new PeopleReadContext(a), { commitmentId: w.ids.commitment }),
			(v) => v.expiresInSeconds,
		),
	"church document PDF": async (a) =>
		shown(
			await documentsWriter.readChurchFile(w.db, a, { documentId: w.ids.policy, format: "pdf" }, w.storage),
			(v) => [magic(v.bytes), v.downloadName],
		),
	"church document Word": async (a) =>
		shown(
			await documentsWriter.readChurchFile(w.db, a, { documentId: w.ids.policy, format: "docx" }, w.storage),
			(v) => [
				docxText(v.bytes)
					.replace(/<[^>]+>/g, "")
					.trim()
					.slice(0, 52),
				v.downloadName,
			],
		),
	"saved PDF": async (a) =>
		shown(
			await documentsWriter.readExportFile(w.db, a, { documentId: w.ids.policy, exportId: w.ids.exported }, w.storage),
			(v) => [magic(v.bytes), v.revision],
		),
	"new saved Word": async (a) =>
		shown(
			await documentsWriter.exportNative(
				w.db,
				a,
				{ documentId: w.ids.policy, revision: 2, format: "docx", requestKey: key() },
				w.storage,
			),
			(v) => v.savedTemplateName,
		),
	"template PDF": async (a) =>
		shown(
			await documentsWriter.generate(
				w.db,
				a,
				{ templateId: "commitment-card", format: "pdf", requestKey: key() },
				w.storage,
			),
			(v) => v.downloadName,
		),
	"written document text": async (a) =>
		shown(await documentsWriter.read(w.db, a, { documentId: w.ids.values }), (v) => JSON.stringify(v.body)),
	"meeting agenda": async (a) =>
		shown(await documentsReader.printAgenda(w.db, a, { meetingId: vision }), (v) => [v.templateId, magic(v.artifact)]),
	"organization view PDF": async (a) =>
		shown(await teamsReader.readOrgChartExport(w.db, a, {}), (v) => [
			v.pdf.slice(0, 4),
			v.pdf.includes("Welcome Team"),
			v.svg.includes("Welcome Team"),
		]),
	"wiki PDF": async (a) =>
		shown(await wiki.exportPdf(w.db, a, { articleId: w.ids.articles.grace }), (v) =>
			v.bytes ? magic(v.bytes) : v.errorCode,
		),
	"wiki print": async (a) =>
		shown(
			await wiki.printArticle(w.db, a, { articleId: w.ids.articles.grace }),
			(v) => v.html?.includes("Gather the Grace way.") ?? v.errorCode,
		),
	"wiki PDF of an unlinked organization": async (a) =>
		shown(await wiki.exportPdf(w.db, a, { articleId: w.ids.articles.cedar }), (v) => [v.bytes, v.errorCode]),
	"wiki print of an unlinked organization": async (a) =>
		shown(await wiki.printArticle(w.db, a, { articleId: w.ids.articles.cedar }), (v) => [v.html, v.errorCode]),
	"pipeline CSV": async (a) => {
		const reply = await readPipelineExport(w.db, a);
		if (reply.status === "ok") return reply.value.text.slice(1).split("\r\n")[0];
		refusals.push(reply);
		return `refused: ${reply.refusal.code}`;
	},
};

const NO = "refused: unavailable";
const DENIED = "refused: access_denied";
const church = (value: unknown, director: unknown): Record<Role, unknown> => ({
	owner: value,
	admin: value,
	lead: value,
	member: value,
	director,
});
const EXPECTED: Record<string, Record<Role, unknown>> = {
	"people CSV": church(
		{
			rows: [
				"first_name,last_name,email,phone",
				"Alma,Reyes,alma@example.test,'+1 555 0101",
				"Ben,Cole,ben@example.test,",
				"Lena,Lead,lead@example.test,",
				"Max,Member,member@example.test,",
			],
			matched: 4,
		},
		NO,
	),
	"signed commitment document": { owner: 300, admin: 300, lead: NO, member: NO, director: NO },
	"church document PDF": church(["%PDF", "conflict-of-interest-policy-revision-2.pdf"], DENIED),
	"church document Word": church(
		["Harvest PointBoard policyConflict of Interest Policy", "conflict-of-interest-policy-revision-2.docx"],
		DENIED,
	),
	"saved PDF": church(["%PDF", 2], DENIED),
	"new saved Word": church("Harvest conflict policy", DENIED),
	"template PDF": church("commitment-card.pdf", NO),
	"written document text": church(
		'{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"We love our city"}]}]}',
		NO,
	),
	"meeting agenda": church(["vision-meeting-agenda", "%PDF"], NO),
	"organization view PDF": church(["%PDF", true, true], NO),
	"wiki PDF": church("%PDF", "%PDF"),
	"wiki print": church(true, true),
	"wiki PDF of an unlinked organization": church([null, "content_access_denied"], [null, "content_access_denied"]),
	"wiki print of an unlinked organization": church([null, "content_access_denied"], [null, "content_access_denied"]),
	"pipeline CSV": church(NO, "Grace Austin pipeline export"),
};
const RECORD_WORDS = [
	"Alma",
	"Ben Cole",
	"Lena",
	"@example.test",
	"conflict",
	"We love our city",
	"Welcome",
	"Grace",
	"Private",
];

for (const [name, run] of Object.entries(EXPORTS))
	test(`INV-roles: the ${name} export gives each role only what it may read, and a refusal carries nothing from the record`, async () => {
		refusals.length = 0;
		for (const role of ROLES) assert.deepEqual(await run(await w.actor(role)), EXPECTED[name]![role], role);
		const expectedRefusals = Object.values(EXPECTED[name]!).filter((v) => String(v).startsWith("refused: "));
		assert.equal(refusals.length, expectedRefusals.length);
		const text = JSON.stringify(refusals);
		for (const word of RECORD_WORDS) assert.equal(text.includes(word), false, word);
	});

test("INV-roles: an export lists only the files of its own church", async () => {
	const files = async (a: RequestActor) =>
		shown(await documentsWriter.listExports(w.db, a, { documentId: w.ids.policy }), (v) => v.exports.length > 0);
	for (const role of ROLES) assert.equal(await files(await w.actor(role)), role === "director" ? DENIED : true, role);
	assert.equal(await files(await w.as(w.hiddenOwner)), NO);
	assert.equal(
		shown(await wiki.exportPdf(w.db, await w.as(w.cedarOwner), { articleId: w.ids.articles.cedar }), (v) =>
			v.bytes ? magic(v.bytes) : v.errorCode,
		),
		"%PDF",
	);
});
