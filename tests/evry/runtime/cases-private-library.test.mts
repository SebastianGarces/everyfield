import test, { after, before, mock } from "node:test";
import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { nativePorts } from "../evals/settings-ports.mts";
import { seedDocument } from "../adapters/documents/seed.mts";
import { caseWorld, reads, rowsOf, sql, type CaseWorld, type Play, type Reply, type Step } from "./case-world.mts";

type Document = { title: string; body: string };
type Case = {
	id: string;
	given: Record<"agenda-1" | "agenda-2" | "D", Document> & {
		D: { title: string; content: string };
	};
	clock: { now: string };
	action: { arguments: { utterances: [string] } };
	expected: { result: Record<string, unknown> };
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../docs/acceptance/knowledge.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const caseOf = (id: string) => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);
const saidIn = (c: Case) => c.action.arguments.utterances[0];

let w: CaseWorld;
before(async () => {
	w = await caseWorld("caseprivate", { native: nativePorts(), now: caseOf("INH-DOCUMENTS-07").clock.now });
});
after(() => w?.close());

const compose =
	(...calls: { operation: string; input: unknown }[]): Step =>
	() => ({ tool: "compose_reads", input: { reads: calls } });
const READ_FS = [
	"readFile",
	"readFileSync",
	"readdir",
	"readdirSync",
	"open",
	"openSync",
	"createReadStream",
	"opendir",
];

async function outside<T>(body: () => Promise<T>) {
	const used = { files: 0, network: 0 };
	const counting = (target: object, name: string, kind: keyof typeof used) => {
		const real = Reflect.get(target, name);
		return mock.method(
			target as Record<string, (...args: unknown[]) => unknown>,
			name,
			function (this: unknown, ...args: unknown[]) {
				used[kind]++;
				return Reflect.apply(real, this, args);
			},
		);
	};
	const spies = [
		...READ_FS.map((name) => counting(fs, name, "files")),
		...["readFile", "readdir", "open", "opendir"].map((name) => counting(fsPromises, name, "files")),
		...[http, https].flatMap((m) => ["request", "get"].map((name) => counting(m, name, "network"))),
		counting(globalThis, "fetch", "network"),
	];
	syncBuiltinESMExports();
	try {
		return { value: await body(), used };
	} finally {
		for (const spy of spies) spy.mock.restore();
		syncBuiltinESMExports();
	}
}
async function agendas(tenant: string, c: Case) {
	const seed = (name: "agenda-1" | "agenda-2", daysAgo: number) =>
		seedDocument(w.admin, tenant, "native", c.given[name].title, c.given[name].body, daysAgo);
	return {
		one: await seed("agenda-1", 1),
		two: await seed("agenda-2", 2),
		values: await seedDocument(w.admin, tenant, "core_values", c.given.D.title, c.given.D.content, 3),
	};
}

test("AC:INH-DOCUMENTS-07 a search of the laptop has no tool: no file or network is read, nothing is written, and the church's own agenda is offered", async () => {
	const c07 = caseOf("INH-DOCUMENTS-07");
	const { result } = c07.expected;
	const said = saidIn(c07);
	const c = await w.church();
	const { one, two } = await agendas(c.P.id, c07);
	const offer: Play = [reads("documents.listOwned", { title: "agenda" })];

	const { value: asked, used } = await outside(() =>
		w.quiet(() => w.ask(c.A, said, [...offer, () => "Everyfield has these."])),
	);
	const control = await outside(async () => void fs.readFileSync(new URL(import.meta.url)));
	assert.ok(control.used.files > 0, "a file read is counted");
	assert.deepEqual([used.files, used.network], [result.filesystem_reads, result.network_calls]);
	assert.deepEqual(
		rowsOf(asked.cards[0]!.result).map((r) => [r.id, r.label, r.fields.link]),
		[
			[one.id, "Agenda", `/documents/written/${one.id}`],
			[two.id, "Agenda copy", `/documents/written/${two.id}`],
		],
	);
	assert.equal(rowsOf(asked.cards[0]!.result)[0].id === one.id ? "agenda-1" : null, result.offered_document);
	assert.ok(asked.cards[0]!.result.exclusions.includes("files outside Everyfield"));
	assert.equal(asked.proposals.length, result.domain_writes);
	assert.deepEqual(
		[...asked.tools, ...asked.offered].filter((t) =>
			/laptop|disk|drive|filesystem|shell|code|fetch|http|url|browse|path/i.test(t),
		),
		[],
	);

	const attempts: [string, Step, (reply: Reply) => unknown, unknown][] = [
		["a file tool", () => ({ tool: "search_files", input: { glob: "**/*.pdf" } }), (r) => r.error, "not_offered"],
		[
			"a file read in a composition",
			compose({ operation: "fs.readdir", input: { path: "/Users" } }),
			(r) => [r.error, r.operations],
			["not_a_read", ["fs.readdir"]],
		],
		[
			"a path as a document",
			reads("documents.read", { documentId: "/Users/alex/lease.pdf" }),
			(r) => r.error,
			"not_offered",
		],
		["a path on a search", reads("documents.listOwned", { title: "lease", path: "~/" }), (r) => r.error, "not_offered"],
	];
	for (const [name, step, seen, expected] of attempts) {
		const tried = await outside(() => w.quiet(() => w.ask(c.A, said, [step])));
		assert.deepEqual(seen(tried.value.replies[0]), expected, name);
		assert.deepEqual(tried.used, { files: 0, network: 0 }, name);
		assert.deepEqual([tried.value.cards, tried.value.proposals], [[], []], name);
	}
	const bare = await w.ask(c.A, said, [reads("documents.listOwned", { title: "venue contract" })]);
	assert.deepEqual([bare.replies[0].status, bare.replies[0].rows], ["not_found", []]);

	const theirs = await c.foreign(said, offer, {
		secrets: ["Welcome Alex", "Meet Casey", "Agenda copy", "Core values"],
	});
	assert.deepEqual(
		[theirs.replies[0].status, theirs.replies[0].total, theirs.replies[0].withheldRows],
		["not_found", 0, undefined],
		"nothing is told of a document elsewhere",
	);
	await c.outage(said, offer, "document");
});

test("AC:INH-REGRESSION-EVIDENCE-CITATION two agendas are compared from their own words, each with its own source, and a title alone gives none", async () => {
	const c = caseOf("INH-REGRESSION-EVIDENCE-CITATION");
	const { comparison, citations, filename_only_claims } = c.expected.result as {
		comparison: { document: "agenda-1" | "agenda-2"; fact: string }[];
		citations: string[];
		filename_only_claims: number;
	};
	const said = saidIn(c);
	const P = await w.church();
	const { one, two } = await agendas(P.P.id, c);
	const name = (id: string) => (id === one.id ? "agenda-1" : id === two.id ? "agenda-2" : id);
	const both = compose(...[one, two].map(({ id }) => ({ operation: "documents.read", input: { documentId: id } })));
	const compared = (replies: Reply[]) =>
		replies[0].results.map((r: Reply) => ({ document: name(rowsOf(r)[0].id), fact: rowsOf(r)[0].fields.text }));

	const asked = await w.quiet(() => w.ask(P.A, said, [both]));
	assert.deepEqual(compared(asked.replies), comparison);
	const byDocumentNotFinishOrder = (a: { id: string }, b: { id: string }) => name(a.id).localeCompare(name(b.id));
	const cited = asked.cards.flatMap((card) => rowsOf(card.result)).sort(byDocumentNotFinishOrder);
	assert.deepEqual(
		cited.map((r) => [r.kind, r.id, r.fields.link]),
		[one, two].map(({ id }) => ["document", id, `/documents/written/${id}`]),
	);
	const versions = await Promise.all(
		cited.map((r) =>
			w.one<{ v: number; body: string }>(
				sql`SELECT r.version_number AS v,r.body FROM document d JOIN document_revision r ON r.id=d.current_revision_id WHERE d.id=${r.id}`,
			),
		),
	);
	assert.deepEqual(
		cited.map((r, at) => `${name(r.id)}/v${versions[at]!.v}`),
		[...citations].sort(),
	);
	assert.ok(cited.every((r, at) => versions[at]!.body.includes(r.fields.text)));

	const titles = await w.quiet(() =>
		w.ask(P.A, said, [reads("documents.listOwned", { title: "agenda" }), () => "Read them?"]),
	);
	const claims = titles.cards.flatMap((card) => rowsOf(card.result)).filter((r) => "text" in r.fields);
	assert.equal(claims.length, filename_only_claims);
	for (const { fact } of comparison)
		assert.equal(JSON.stringify([titles.prompts, titles.saved]).includes(fact), false, "a list carries no words");

	const swap = async () =>
		w.admin.execute(sql`UPDATE document d SET title=o.title FROM document o
			WHERE d.id IN (${one.id},${two.id}) AND o.id IN (${one.id},${two.id}) AND o.id<>d.id`);
	await swap();
	const renamed = await w.ask(P.A, said, [both]);
	await swap();
	assert.deepEqual(compared(renamed.replies), comparison, "the words follow the document, not its name");

	await P.foreign(said, [both], { secrets: ["Welcome Alex", "Meet Casey", "Agenda copy"] });
	await P.outage(said, [both], "document", {
		told: (reply) =>
			reply.results.length === 2 && reply.results.every((r: Reply) => r.error === "source_unavailable" && !r.rows),
	});
});
