import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "../../../../packages/db/src/query.ts";
import { nativeFromText } from "../../../../packages/contracts/src/documents/index.ts";
import { listPeopleRequest } from "../../../../packages/contracts/src/people/index.ts";
import type { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { communicationWriter } from "../../../../packages/domain/src/communication/index.ts";
import { dashboardReader } from "../../../../packages/domain/src/dashboard/index.ts";
import { documentsReader, documentsWriter } from "../../../../packages/domain/src/documents/index.ts";
import { meetingsReader } from "../../../../packages/domain/src/meetings/index.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import { readPipelineExport } from "../../../../packages/domain/src/organizations/index.ts";
import { getPlant, listPlants } from "../../../../packages/domain/src/oversight/index.ts";
import { PeopleReadContext } from "../../../../packages/domain/src/people/core.ts";
import {
	getCommitmentDownload,
	peopleCsv,
	peopleReader,
	searchPeople,
} from "../../../../packages/domain/src/people/index.ts";
import { taskReader } from "../../../../packages/domain/src/tasks/index.ts";
import { teamsReader } from "../../../../packages/domain/src/teams/index.ts";
import { createWikiProducer } from "../../../../packages/domain/src/wiki/index.ts";
import { evryActor, EvryRefusal, invokeRead, READ_DOMAINS } from "../../../../packages/evry/src/index.ts";
import type { ReadAdapter } from "../../../../packages/evry/src/catalog/types.ts";
import { ok } from "../../../support/fixture.mts";
import { docxParts, pdfPages, wordText } from "../../documents/fixtures/readers.mts";
import { key, rolesWorld, type RolesWorld } from "./roles-world.mts";

const TITLE_WORD = "Zephyrwick";
const BODY_WORD = "quillmarrow";
const WORDS = [TITLE_WORD, BODY_WORD];
const NONE = "Xylobrandt";

let w: RolesWorld;
let notes: { id: string; revisionId: string };
let values: { id: string; revisionId: string };
before(async () => {
	w = await rolesWorld("roles_discovery");
	const planter = await w.actor("owner");
	await w.admin.execute(sql`INSERT INTO discovery(id,account_id,revision,converted_at,converted_plant_id)
		VALUES(${key()},${w.people.owner.id},1,clock_timestamp(),${w.plant.id})`);
	const written = ok(
		await documentsWriter.saveMine(w.db, planter, {
			title: `${TITLE_WORD} call notes`,
			body: nativeFromText(`Our ${BODY_WORD} plan for the city`),
			expectedRevision: "0",
		}),
	);
	notes = { id: written.id, revisionId: written.revisionId };
	const draft = ok(
		await documentsWriter.saveMine(w.db, planter, {
			title: `${TITLE_WORD} values`,
			body: nativeFromText(`We hold ${BODY_WORD} values`),
			expectedRevision: "0",
		}),
	);
	const designated = ok(
		await documentsWriter.designateMine(w.db, planter, { documentId: draft.id, expectedRevision: draft.revision }),
	);
	assert.equal(designated.kind, "core_values");
	values = { id: designated.id, revisionId: designated.revisionId };
});
after(() => w?.close());

const wiki = createWikiProducer();
const locked = <V,>(body: Parameters<typeof gatedTransaction<V>>[1]) => gatedTransaction(w.db, body);
const inPeople = <V,>(
	a: RequestActor,
	body: (tx: Parameters<Parameters<typeof gatedTransaction>[1]>[0], c: PeopleReadContext) => Promise<V>,
) => locked((tx) => body(tx, new PeopleReadContext(a)));

async function fileText(bytes: Buffer) {
	const magic = bytes.subarray(0, 4).toString("latin1");
	if (magic === "%PDF") return `${bytes.toString("latin1")}\n${(await pdfPages(bytes)).join("\n")}`;
	if (magic === "PK\x03\x04") {
		const parts = docxParts(bytes);
		return [...Object.values(parts), wordText(parts["word/document.xml"] ?? "")].join("\n");
	}
	return bytes.toString("latin1");
}
async function unpacked(value: unknown): Promise<string> {
	const parts = [JSON.stringify(value)];
	const visit = async (node: unknown) => {
		if (typeof node === "string" && node.length > 200 && /^[A-Za-z0-9+/=]+$/.test(node))
			parts.push(await fileText(Buffer.from(node, "base64")));
		else if (node instanceof Uint8Array) parts.push(await fileText(Buffer.from(node)));
		else if (node && typeof node === "object") for (const v of Object.values(node)) await visit(v);
	};
	await visit(value);
	return parts.join("\n").toLowerCase();
}
const carried = async (value: unknown) => {
	const text = await unpacked(value);
	return WORDS.filter((word) => text.includes(word.toLowerCase()));
};
const DISCOVERY_IDS = () => [notes.id, notes.revisionId, values.id, values.revisionId];
const masked = async (value: unknown, term: string) =>
	DISCOVERY_IDS()
		.reduce((text, id) => text.replaceAll(id.toLowerCase(), "<discovery>"), await unpacked(value))
		.replaceAll(term.toLowerCase(), "<term>")
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
		.replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z/g, "<time>");
const refusedReply = (reply: unknown) =>
	typeof reply === "object" && reply !== null && "status" in reply && reply.status === "refused";

const SEARCHES: Record<string, (a: RequestActor, term: string) => Promise<unknown>> = {
	people: (a, search) => inPeople(a, (tx, c) => peopleReader.listPeople(tx, c, listPeopleRequest.parse({ search }))),
	"people picker": (a, term) => inPeople(a, (tx, c) => searchPeople(tx, c, term, 8)),
	pipeline: (a, search) =>
		inPeople(a, (tx, c) => peopleReader.getPipelineData(tx, c, listPeopleRequest.parse({ search }))),
	"people export count": (a, search) => inPeople(a, (tx, c) => peopleCsv.countExport(tx, c, { search })),
	tasks: (a, search) => locked((tx) => taskReader.list(tx, a, { search })),
	"task count": (a, search) => locked((tx) => taskReader.count(tx, a, { search })),
	"team members": (a, q) => teamsReader.searchMembers(w.db, a, { q }),
	"leader candidates": (a, q) => teamsReader.listLeaderCandidates(w.db, a, { q }),
	messages: (a, query) => locked((tx) => communicationWriter.listHistory(tx, a, { query, limit: 10 })),
	"message recipients": (a, query) => locked((tx) => communicationWriter.readRecipients(tx, a, { query })),
	"launch guests": (a, query) => w.launchReader.suggestGuests(w.db, a, query),
	wiki: (a, query) => wiki.search(w.db, a, { query }),
	"church documents": (a) => documentsWriter.listOwned(w.db, a, {}),
	"church library": (a) => documentsWriter.listChurch(w.db, a, {}),
	"archived church library": (a) => documentsWriter.listArchivedChurch(w.db, a, {}),
	"own documents": (a) => documentsWriter.listMine(w.db, a, {}),
	"copy sources": (a) => documentsWriter.listCopySources(w.db, a, {}),
	"core values evidence": (a) => documentsWriter.readCoreValuesEvidence(w.db, a, {}),
	overview: (a) => dashboardReader.readMetrics(w.db, a),
	meetings: (a) => meetingsReader.list(w.db, a, {}),
	staffing: (a) => teamsReader.staffingSummary(w.db, a, {}),
	"oversight directory": (a) => listPlants(w.db, a),
	"oversight plant": (a) => getPlant(w.db, a, w.plant.id),
};

const adapters = Object.values(READ_DOMAINS)
	.flat()
	.map((a) => a as unknown as ReadAdapter<unknown>);
const KINDS: Record<string, object[]> = {
	"tasks.relationOptions": [{ kind: "person" }, { kind: "meeting" }, { kind: "team" }],
};
function evryInputs(adapter: ReadAdapter<unknown>, term: string) {
	const fill: Record<string, string> = {
		search: term,
		query: term,
		q: term,
		documentId: notes.id,
		fileId: notes.id,
		churchId: w.grace.id,
		commitmentId: w.ids.commitment,
		personId: w.ids.ben,
		meetingId: w.ids.planning,
		communicationId: w.ids.letter,
		teamId: w.ids.welcome,
		plantId: w.plant.id,
		taskId: w.ids.tasks.member,
		articleId: w.ids.articles.grace,
	};
	const schema = adapter.input as { shape?: Record<string, unknown> };
	const shape = Object.keys(schema.shape ?? {});
	const input = Object.fromEntries(shape.filter((k) => k in fill).map((k) => [k, fill[k]]));
	return (KINDS[adapter.operation] ?? [{}]).flatMap((kind) => {
		const parsed = adapter.input.safeParse({ ...input, ...kind });
		return parsed.success ? [parsed.data] : [];
	});
}
async function evryRead(a: RequestActor, adapter: ReadAdapter<unknown>, input: unknown) {
	try {
		return await invokeRead(w.db, evryActor(a), adapter, input);
	} catch (error) {
		assert.ok(error instanceof EvryRefusal, `${adapter.operation}: ${String(error)}`);
		return { status: "refused", code: error.code, message: error.message };
	}
}

async function searchesFindNothing(role: "member" | "director") {
	const planter = await w.actor("owner");
	const mine = ok(await documentsWriter.listMine(w.db, planter, {}))
		.documents.map((d) => d.title)
		.sort();
	assert.deepEqual(mine, [`${TITLE_WORD} call notes`, `${TITLE_WORD} values`]);
	assert.deepEqual(await carried(await documentsWriter.readMine(w.db, planter, { documentId: notes.id })), WORDS);

	const a = await w.actor(role);
	const ran: string[] = [];
	for (const term of WORDS) {
		const same = async (found: unknown, control: unknown, name: string) => {
			const shown = await masked(found, term);
			assert.equal(shown, await masked(control, NONE), `${name} ${term}`);
			for (const word of [...WORDS, "<discovery>"])
				assert.equal(shown.includes(word.toLowerCase()), false, `${name} ${word}`);
			ran.push(name);
		};
		for (const [name, search] of Object.entries(SEARCHES)) await same(await search(a, term), await search(a, NONE), name);
		for (const adapter of adapters) {
			const controls = evryInputs(adapter, NONE);
			for (const [at, input] of evryInputs(adapter, term).entries())
				await same(await evryRead(a, adapter, input), await evryRead(a, adapter, controls[at]), adapter.operation);
		}
	}
	for (const operation of [
		"documents.listOwned",
		"documents.read",
		"documents.readCoreValuesEvidence",
		"documents.download",
		"wiki.search",
		"tasks.relationOptions",
	])
		assert.ok(ran.includes(operation), operation);
}

test("INV-roles AC:CASE-DOC-016: after a Discovery planter starts a church, the church's Member finds none of the planter's Discovery documents in any search, Evry read or count", () =>
	searchesFindNothing("member"));
test("INV-roles AC:CASE-DOC-016: after a Discovery planter starts a church, the sending director finds none of the planter's Discovery documents in any search, Evry read or count", () =>
	searchesFindNothing("director"));

const EXPORTS: Record<string, (a: RequestActor) => Promise<unknown>> = {
	"people CSV": (a) => locked((tx) => peopleCsv.exportPeople(tx, new PeopleReadContext(a), {})),
	"signed commitment document": (a) =>
		getCommitmentDownload(w.db, w.storage, new PeopleReadContext(a), { commitmentId: w.ids.commitment }),
	"church document PDF": (a) =>
		documentsWriter.readChurchFile(w.db, a, { documentId: w.ids.policy, format: "pdf" }, w.storage),
	"church document Word": (a) =>
		documentsWriter.readChurchFile(w.db, a, { documentId: w.ids.policy, format: "docx" }, w.storage),
	"saved exports": (a) => documentsWriter.listExports(w.db, a, { documentId: w.ids.policy }),
	"saved PDF": (a) =>
		documentsWriter.readExportFile(w.db, a, { documentId: w.ids.policy, exportId: w.ids.exported }, w.storage),
	"template PDF": (a) =>
		documentsWriter.generate(w.db, a, { templateId: "commitment-card", format: "pdf", requestKey: key() }, w.storage),
	"written document text": (a) => documentsWriter.read(w.db, a, { documentId: w.ids.values }),
	"organization view PDF": (a) => teamsReader.readOrgChartExport(w.db, a, {}),
	"wiki PDF": (a) => wiki.exportPdf(w.db, a, { articleId: w.ids.articles.grace }),
	"wiki print": (a) => wiki.printArticle(w.db, a, { articleId: w.ids.articles.grace }),
	"pipeline CSV": (a) => readPipelineExport(w.db, a),
};
const NAMED: Record<string, (a: RequestActor, documentId: string) => Promise<unknown>> = {
	"church document PDF": (a, documentId) =>
		documentsWriter.readChurchFile(w.db, a, { documentId, format: "pdf" }, w.storage),
	"church document Word": (a, documentId) =>
		documentsWriter.readChurchFile(w.db, a, { documentId, format: "docx" }, w.storage),
	"saved exports": (a, documentId) => documentsWriter.listExports(w.db, a, { documentId }),
	"saved PDF": (a, documentId) =>
		documentsWriter.readExportFile(w.db, a, { documentId, exportId: w.ids.exported }, w.storage),
	"new saved Word": (a, documentId) =>
		documentsWriter.exportNative(w.db, a, { documentId, revision: 1, format: "docx", requestKey: key() }, w.storage),
	"new saved PDF": (a, documentId) =>
		documentsWriter.exportNative(w.db, a, { documentId, revision: 1, format: "pdf", requestKey: key() }, w.storage),
	"written document text": (a, documentId) => documentsWriter.read(w.db, a, { documentId }),
	"own document text": (a, documentId) => documentsWriter.readMine(w.db, a, { documentId }),
	"church document": (a, documentId) => documentsWriter.readChurch(w.db, a, { documentId }),
	"generated download": (a, documentId) => documentsWriter.download(w.db, a, { documentId }, w.storage),
};

async function exportsCarryNothing(role: "member" | "director") {
	const a = await w.actor(role);
	const READABLE: Record<string, string> =
		role === "member"
			? { "church document PDF": "lawyer", "saved PDF": "lawyer", "church document Word": "lawyer" }
			: {};
	const meetings = ok(await meetingsReader.list(w.db, await w.actor("owner"), {})).items.map((m) => m.id);
	const exports: [string, () => Promise<unknown>][] = [
		...Object.entries(EXPORTS).map(([name, run]) => [name, () => run(a)] as [string, () => Promise<unknown>]),
		...meetings.map(
			(meetingId) =>
				[`meeting agenda ${meetingId}`, () => documentsReader.printAgenda(w.db, a, { meetingId })] as [
					string,
					() => Promise<unknown>,
				],
		),
	];
	let answered = 0;
	for (const [name, run] of exports) {
		const reply = await run();
		if (!refusedReply(reply)) answered += 1;
		if (name in READABLE) assert.ok((await unpacked(reply)).includes(READABLE[name]), `the reader sees ${name}`);
		assert.deepEqual(await carried(reply), [], name);
	}
	assert.ok(answered > 0, "some export answers this role");
	for (const doc of [notes, values])
		for (const [name, run] of Object.entries(NAMED)) {
			const reply = await run(a, doc.id);
			assert.ok(refusedReply(reply), `${name} ${JSON.stringify(reply).slice(0, 200)}`);
			assert.deepEqual(await carried(reply), [], name);
		}
}

test("INV-roles AC:CASE-DOC-016: after a Discovery planter starts a church, no export the church's Member can run carries the planter's Discovery documents, and one that names them is refused", () =>
	exportsCarryNothing("member"));
test("INV-roles AC:CASE-DOC-016: after a Discovery planter starts a church, no export the sending director can run carries the planter's Discovery documents, and one that names them is refused", () =>
	exportsCarryNothing("director"));
