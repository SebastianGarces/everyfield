import test, { after, before, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs, { readFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { createWikiProducer } from "../../../packages/domain/src/wiki/index.ts";
import { readCatalog, readConversation, submitTurn } from "../../../packages/evry/src/index.ts";
import { nativePorts } from "../evals/settings-ports.mts";
import { seedDocument } from "../adapters/documents/seed.mts";
import { GLOBAL, seedWiki, wikiIds } from "../adapters/wiki/corpus.mts";
import {
	caseWorld,
	propose,
	read,
	reads,
	refusal,
	rowsOf,
	sql,
	type CaseWorld,
	type Play,
	type Reply,
	type Step,
} from "./case-world.mts";

type Document = { title: string; body: string };
type Case = {
	id: string;
	operation_ids: string[];
	given: Record<"agenda-1" | "agenda-2" | "D" | "E" | "W", Document> & {
		D: { title: string; content: string };
		"care-A": { week: string; note: string };
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
	const cited = asked.cards.flatMap((card) => rowsOf(card.result));
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
		citations,
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

test("INV-privacy: Evry gives a seatless Discovery account only its own Discovery operations: no church, other account, private care or login data, no reading credit and no grant, also from its conversation kept open on a church page", async () => {
	const c = caseOf("EVRY-ACCOUNT-PRIVATE-DISCOVERY");
	const { result } = c.expected;
	const said = saidIn(c);
	const church = await w.church();
	const A = await w.actor(null, "owner", { account: { registration_kind: "discovery" } });
	const B = await w.actor(null, "owner", { account: { registration_kind: "discovery" } });
	await w.admin.execute(sql`INSERT INTO discovery(account_id) VALUES(${A.id})`);
	const D = await seedDocument(w.admin, A.id, "native", "My Discovery", c.given.D.body);
	const E = await seedDocument(w.admin, B.id, "native", "Their Discovery", c.given.E.body);
	const wikiSet = wikiIds(randomUUID);
	await seedWiki((query) => w.admin.execute(query), church.P.id, wikiSet);
	const W = randomUUID();
	await w.admin.execute(
		sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${W},'article','discovery/foundation',${GLOBAL})`,
	);
	await w.admin
		.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,excerpt,body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id,related_slugs)
		VALUES(${randomUUID()},${W},${GLOBAL},${wikiSet.release},1,'Foundation','discovery/foundation','Foundation',${c.given.W.body},'safe_mdx',0,1,md5('foundation'),
			clock_timestamp(),true,1,${wikiSet.section},ARRAY[]::text[])`);

	const authority = await w.authorityOf(A);
	const article = await createWikiProducer().getArticle(w.db, authority, { articleId: W });
	assert.ok(article.status === "ok", JSON.stringify(article));
	assert.equal(JSON.stringify(article).includes(String(result.W_body)), true);

	const Aa = await w.actorOf(A);
	const listed = new Set(c.operation_ids);
	const offered = [...JSON.stringify(readCatalog(Aa)).matchAll(/"operation":"([^"]+)"/g)].map((m) => m[1]!);
	assert.deepEqual(
		offered.filter((operation) => listed.has(operation)),
		["discovery.getProfile", "discovery.create", "discovery.convertToPlant"],
	);
	assert.deepEqual(
		offered.filter((operation) =>
			/^(people|teams|meetings|tasks|intelligence|privateCare|auth|identity)\./.test(operation),
		),
		[],
	);
	await w.admin.execute(sql`UPDATE person SET linked_account_id=${A.id} WHERE id=${church.casey}`);
	const canary = c.given["care-A"].note;
	await w.admin.execute(sql`INSERT INTO person_note(tenant_id,person_id,author_id,body,occurred_at,recorded_at)
		VALUES(${church.P.id},${church.casey},${church.A.id},${canary},clock_timestamp(),clock_timestamp())`);
	const C = await w.converse(Aa);
	const { token } = await w.one<{ token: string }>(sql`SELECT token FROM auth_session WHERE id=${A.session}`);
	const grants = () =>
		w.one(sql`SELECT (SELECT count(*)::int FROM seat WHERE account_id=${A.id}) AS plant_grants,
			(SELECT count(*)::int FROM affiliation WHERE account_id=${A.id}) AS organization_grants,
			(SELECT count(*)::int FROM reading WHERE account_id=${A.id}) AS new_reading_credit`);
	const { plant_grants, organization_grants, new_reading_credit } = result;
	const own = await w.quiet(() => w.ask(A, said, [reads("discovery.getProfile")], { conversation: C }));
	assert.equal(own.replies[0].operation, "discovery.getProfile", JSON.stringify(own.replies));
	assert.equal(own.replies[0].facts.foundationsRead, new_reading_credit);
	const page = [{ kind: "person" as const, id: church.casey }];
	for (const call of [
		read("documents.read", { documentId: E.id }),
		read("documents.listOwned"),
		read("people.listPeople"),
		read("people.getPerson", { personId: church.casey }),
		read("teams.list"),
		read("meetings.list"),
		read("tasks.count"),
		{ tool: "auth_read", input: { operation: "auth.readSecrets", input: {} } },
		{ tool: "private_care_read", input: { operation: "privateCare.read", input: {} } },
		propose("documents.archive", { documentId: E.id }),
		propose("documents.useForChurch", { documentId: D.id, plantId: church.P.id }),
	]) {
		const asked = await w.quiet(() => w.ask(A, said, [() => call], { conversation: C, references: page }));
		assert.deepEqual([asked.replies[0].error, asked.cards, asked.proposals], ["not_offered", [], []], call.tool);
		const told = JSON.stringify([asked.prompts, asked.saved, asked.text]);
		for (const secret of [c.given.E.body, canary, "Casey Reed", "Harvest Network", "Their Discovery", token])
			assert.equal(told.includes(secret), false, secret);
	}
	assert.deepEqual(await grants(), { plant_grants, organization_grants, new_reading_credit });

	const stranger = await w.actorOf(church.F);
	const held = await w.eventsOf(Aa, C);
	assert.equal(await refusal(readConversation(w.db, stranger, C)), "not_found");
	assert.equal(await refusal(submitTurn(w.db, stranger, C, { requestKey: randomUUID(), text: said })), "not_found");
	await church.foreign(said, [() => read("documents.read", { documentId: D.id })], {
		secrets: [c.given.D.body, c.given.E.body, canary],
	});
	assert.deepEqual(await w.eventsOf(Aa, C), held);
	await church.outage(said, [reads("discovery.getProfile")], "discovery", { as: A, conversation: C });
	assert.deepEqual(await grants(), { plant_grants, organization_grants, new_reading_credit });
});
