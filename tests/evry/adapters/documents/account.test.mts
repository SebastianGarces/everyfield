import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readNative } from "../../../../packages/contracts/src/documents/index.ts";
import { documentsWriter } from "../../../../packages/domain/src/documents/index.ts";
import { createWikiProducer } from "../../../../packages/domain/src/wiki/index.ts";
import { readAttachment } from "../../../../packages/evry/src/attachments/store.ts";
import {
	approveProposal,
	cancelProposal,
	listConversations,
	openLatestConversation,
	readCatalog,
	readConversation,
	readReview,
	stageAttachment,
	submitTurn,
	type Proposal,
} from "../../../../packages/evry/src/index.ts";
import type { Actor } from "../../../support/fixture.mts";
import { recorded, untouched } from "../../../support/recorded.mts";
import * as Word from "../../../integration/documents/fixtures/word.mts";
import { pdf } from "../../../integration/platform/fixtures.mjs";
import {
	caseWorld,
	NOW,
	propose,
	proposes,
	read,
	reads,
	refusal,
	rowsOf,
	sql,
	type CaseWorld,
	type Church,
	type Turn,
} from "../../runtime/case-world.mts";
import { nativePorts } from "../../evals/settings-ports.mts";
import { DRAFT_LINE, FOREIGN_LINE, GLOBAL, NETWORK_LINE, seedWiki, wikiIds } from "../wiki/corpus.mts";
import { seedDocument } from "./seed.mts";

type Case = {
	operation_ids: string[];
	given: { D: { body: string }; E: { body: string }; W: { body: string }; "care-A": { note: string } };
	action: { arguments: { utterances: [string] } };
	clock: { now: string };
	expected: { result: Record<string, unknown> };
	subcases: { name: string; expected: { result: Record<string, unknown> } }[];
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../../docs/acceptance/knowledge.json", import.meta.url), "utf8"),
) as { cases: (Case & { id: string })[] };
const c = cases.find((k) => k.id === "EVRY-ACCOUNT-PRIVATE-DISCOVERY") ?? assert.fail("no case");
const expectedOf = (name: string) =>
	c.subcases.find((s) => s.name === name)?.expected.result ?? assert.fail(`no subcase ${name}`);
const said = c.action.arguments.utterances[0];

const READS = [
	"discovery.getProfile",
	"wiki.search",
	"wiki.referenceExcerpt",
	"wiki.navigation",
	"wiki.articles.list",
	"wiki.tableOfContents",
	"documents.listOwned",
	"documents.read",
];
const WRITES = ["discovery.convertToPlant", "documents.saveNative", "documents.archive", "documents.importTextOrWord"];

let w: CaseWorld;
let church: Church;
let foundation: string;
const ids = wikiIds(randomUUID);
const UNPUBLISHED = "Unpublished foundation draft.";
const shared = globalThis as Record<symbol, { configured?: unknown; checks: WeakMap<object, unknown> } | undefined>;
before(async () => {
	assert.equal(c.clock.now, NOW);
	w = await caseWorld("caseaccount", { native: nativePorts() });
	(shared[Symbol.for("everyfield.db.privateStorage")] ??= { checks: new WeakMap() }).configured = w.files.storage;
	church = await w.church();
	await seedWiki((query) => w.admin.execute(query), church.P.id, ids);
	foundation = await article("discovery/foundation", "Foundation", c.given.W.body, sql`clock_timestamp()`);
	await article("discovery/unpublished", "Unpublished foundation", UNPUBLISHED, sql`NULL`);
});
after(() => w?.close());

async function article(slug: string, title: string, body: string, published: ReturnType<typeof sql>) {
	const id = randomUUID();
	await w.admin.execute(
		sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${id},'article',${slug},${GLOBAL})`,
	);
	await w.admin
		.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,excerpt,body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id,related_slugs)
		VALUES(${randomUUID()},${id},${GLOBAL},${ids.release},1,${title},${slug},${title},${body},'safe_mdx',0,1,md5(${slug}),
			${published},true,1,${ids.section},ARRAY[]::text[])`);
	return id;
}
async function person(name = "Dana Discovery") {
	const a = await w.actor(null, "owner", { account: { registration_kind: "discovery" }, user: { name } });
	await w.admin.execute(sql`INSERT INTO discovery(account_id) VALUES(${a.id})`);
	return a;
}
async function attach(a: Actor, conversation: string, name: string, bytes: Buffer) {
	const who = await w.actorOf(a);
	const staged = await stageAttachment(w.db, w.files.storage, who, conversation, { name, byteLength: bytes.length });
	const key = decodeURIComponent(new URL(staged.upload.url).pathname).replace("/synthetic-only/", "");
	w.files.objects.set(key, bytes);
	return staged.attachment;
}
const documentsOf = (a: { id: string }) =>
	w.rows<{ id: string; title: string; body: string; kind: string; archived: boolean; revision: string }>(
		sql`SELECT d.id,d.title,r.body,d.kind,d.archived_at IS NOT NULL AS archived,d.revision::text AS revision
			FROM document d JOIN document_revision r ON r.id=d.current_revision_id WHERE d.tenant_id=${a.id} ORDER BY d.title DESC`,
	);
const everyDocument = () =>
	w.rows(sql`SELECT d.id,d.tenant_id,d.title,d.revision::text AS revision,d.archived_at::text AS archived,r.body
		FROM document d LEFT JOIN document_revision r ON r.document_id=d.id ORDER BY d.id,r.id`);
const words = (body: string) => JSON.stringify(readNative(body).body);
const changesOf = (p: Proposal) => p.review.changes.map((x) => [x.field, x.before, x.after]);
const only = (t: Turn) => {
	assert.equal(t.proposals.length, 1, JSON.stringify(t.replies));
	return t.proposals[0]!;
};
const reviewing = async (body: () => Promise<Turn>) => only(await w.quiet(body, ["proposal"]));
const reading = () =>
	w.rows(sql`SELECT account_id,article_id,observed_fraction::text AS seen,last_viewed_at::text AS viewed,completed_at::text AS done,
		bookmarked,revision::text AS revision FROM reading ORDER BY account_id,article_id`);
const grants = (a: Actor) =>
	w.one(sql`SELECT (SELECT count(*)::int FROM seat WHERE account_id=${a.id}) AS plant_grants,
		(SELECT count(*)::int FROM affiliation WHERE account_id=${a.id}) AS organization_grants,
		(SELECT count(*)::int FROM reading WHERE account_id=${a.id}) AS new_reading_credit`);
const plainReply = (reply: unknown) => JSON.stringify(reply).replaceAll(/"resultId":\d+,?/g, "");

test("AC:EVRY-ACCOUNT-PRIVATE-DISCOVERY a person with no church reads only their own documents, Discovery space and the public Wiki, and saves, imports and archives only what they approved; nothing of anyone else is told, also from a church page", async () => {
	const { result } = c.expected;
	const A = await person();
	const B = await person("Blair Other");
	const D = await seedDocument(w.admin, A.id, "native", "My Discovery", c.given.D.body);
	const E = await seedDocument(w.admin, B.id, "native", "Their Discovery", c.given.E.body);
	const Aa = await w.actorOf(A);
	const C = await w.converse(Aa);

	const offered = [...JSON.stringify(readCatalog(Aa)).matchAll(/"operation":"([^"]+)"/g)].map((m) => m[1]!);
	const listed = new Set(c.operation_ids);
	assert.deepEqual(
		offered.filter((operation) => listed.has(operation)),
		[...READS, ...WRITES],
	);
	assert.deepEqual(
		offered.filter((operation) =>
			/^(people|teams|meetings|tasks|intelligence|privateCare|auth|identity)\./.test(operation),
		),
		[],
	);

	const beforeReading = await reading();
	const own = await w.quiet(() =>
		w.ask(
			A,
			said,
			[
				() => [read("documents.listOwned"), read("wiki.search", { query: "foundation" }), read("discovery.getProfile")],
				(r) => [
					read("documents.read", { documentId: rowsOf(r[0])[0].id }),
					read("wiki.referenceExcerpt", { articleId: rowsOf(r[1])[0].fields.articleId }),
				],
			],
			{ conversation: C },
		),
	);
	const [list, found, profile, document, excerpt] = own.replies;
	assert.deepEqual(
		rowsOf(list).map((r) => [r.id, r.label, r.fields.link]),
		[[D.id, "My Discovery", `/documents/written/${D.id}`]],
	);
	assert.equal(rowsOf(document)[0].fields.text, result.D_body);
	assert.deepEqual(
		rowsOf(found).map((r) => [r.fields.articleId, r.fields.href, r.fields.source]),
		[[foundation, "/wiki/discovery/foundation", "global"]],
	);
	assert.equal(rowsOf(excerpt)[0].fields.excerpt, result.W_body);
	assert.equal(profile.facts.foundationsRead, result.new_reading_credit);
	const authority = await w.authorityOf(A);
	const opened = await documentsWriter.read(w.db, authority, { documentId: D.id } as unknown);
	assert.equal(opened.status, "ok", "the linked page opens for its owner");
	assert.deepEqual(await reading(), beforeReading);

	const edited = await reviewing(() =>
		w.ask(
			A,
			"In My Discovery, say hopes instead of values",
			[
				reads("documents.read", { documentId: D.id }),
				proposes("documents.saveNative", {
					kind: "edit",
					documentId: D.id,
					edits: [{ find: "values", replace: "hopes" }],
				}),
			],
			{ conversation: C },
		),
	);
	assert.deepEqual(changesOf(edited), [["text", "My Discovery values.", "My Discovery hopes."]]);
	assert.equal(edited.review.private, true);
	assert.equal((await w.approve(A, edited)).review.outcome, "completed");
	const [saved] = await documentsOf(A);
	assert.match(words(saved!.body), /"My Discovery hopes\."/);
	assert.deepEqual([saved!.id, saved!.revision], [D.id, "2"]);

	const H = await attach(A, C, "Imported hopes.txt", Buffer.from("A hope I wrote elsewhere."));
	const imported = await reviewing(() =>
		w.ask(A, "Import this", [proposes("documents.importTextOrWord", { attachmentId: H.id })], {
			conversation: C,
			attachments: [{ id: H.id, name: H.name }],
			storage: w.files.storage,
		}),
	);
	assert.equal((await w.approve(A, imported)).review.outcome, "completed");
	assert.deepEqual(
		(await documentsOf(A)).map((d) => [d.title, d.kind]),
		[
			["My Discovery", "native"],
			["Imported hopes", "native"],
		],
	);
	const archived = await reviewing(() =>
		w.ask(A, "Archive My Discovery", [proposes("documents.archive", { documentId: D.id })], { conversation: C }),
	);
	assert.equal((await documentsOf(A))[0]!.archived, false);
	assert.equal((await w.approve(A, archived)).review.outcome, "completed");
	assert.deepEqual(
		(await documentsOf(A)).map((d) => d.archived),
		[true, false],
	);

	await w.admin.execute(sql`UPDATE person SET linked_account_id=${A.id} WHERE id=${church.casey}`);
	const canary = c.given["care-A"].note;
	await w.admin.execute(sql`INSERT INTO person_note(tenant_id,person_id,author_id,body,occurred_at,recorded_at)
		VALUES(${church.P.id},${church.casey},${church.A.id},${canary},clock_timestamp(),clock_timestamp())`);
	const { token } = await w.one<{ token: string }>(sql`SELECT token FROM auth_session WHERE id=${A.session}`);
	const page = [
		{ kind: "page" as const, route: "/people" },
		{ kind: "person" as const, id: church.casey },
		{ kind: "article" as const, slug: "core-group/vision-meetings/running-the-meeting" },
	];
	const secrets = [c.given.E.body, "Their Discovery", canary, "Casey Reed", "Harvest Network", token];
	const told = (t: Turn) => JSON.stringify([t.prompts, t.replies, t.saved, t.text]);
	const bodies: string[] = [];
	for (const call of [
		read("people.listPeople"),
		read("people.getPerson", { personId: church.casey }),
		read("teams.list"),
		read("teams.health"),
		read("meetings.list"),
		read("tasks.count"),
		read("documents.readCoreValuesEvidence"),
		read("documents.templates.list"),
		read("documents.history.list"),
		read("wiki.reading.stats"),
		read("wiki.bookmarks.list"),
		read("wiki.contextGuide", { route: "/people" }),
		{ tool: "auth_read", input: { operation: "auth.readSecrets", input: {} } },
		{ tool: "private_care_read", input: { operation: "privateCare.read", input: {} } },
		propose("documents.useForChurch", { documentId: D.id, plantId: church.P.id }),
		propose("documents.designateCoreValues", { documentId: D.id }),
		propose("wiki.bookmarks.set", { articleId: foundation, bookmarked: true }),
	]) {
		const asked = await w.quiet(() => w.ask(A, said, [() => call], { conversation: C, references: page }));
		assert.deepEqual([asked.replies[0].error, asked.cards, asked.proposals], ["not_offered", [], []], call.tool);
		for (const secret of secrets) assert.equal(told(asked).includes(secret), false, secret);
		assert.equal(asked.conversation, C);
	}
	const guess = randomUUID();
	for (const tried of [
		(id: string) => read("documents.read", { documentId: id }),
		(id: string) => propose("documents.archive", { documentId: id }),
		(id: string) =>
			propose("documents.saveNative", {
				kind: "edit",
				documentId: id,
				edits: [{ find: "PRIVATE", replace: "x" }],
			}),
	]) {
		const [theirs, missing] = [
			await w.quiet(() => w.ask(A, said, [() => tried(E.id)], { conversation: C, references: page })),
			await w.quiet(() => w.ask(A, said, [() => tried(guess)], { conversation: C, references: page })),
		];
		assert.equal(plainReply(theirs.replies), plainReply(missing.replies), "a real id reads as a missing one");
		assert.deepEqual([theirs.proposals, rowsOf(theirs.replies[0])], [[], []]);
		for (const secret of secrets) assert.equal(told(theirs).includes(secret), false, secret);
		bodies.push(...theirs.cards.flatMap((card) => rowsOf(card.result).map((r) => r.fields.text)));
	}
	assert.equal(bodies[0] ?? null, result.E_body);
	const events = JSON.stringify(await w.eventsOf(Aa, C));
	for (const secret of secrets) assert.equal(events.includes(secret), false, secret);
	assert.deepEqual(
		[events.includes(token) || null, events.includes(canary) || null],
		[result.auth_secrets, result.private_care],
	);
	const { plant_grants, organization_grants, new_reading_credit } = result;
	assert.deepEqual(await grants(A), { plant_grants, organization_grants, new_reading_credit });
	assert.equal((await openLatestConversation(w.db, Aa))!.conversation.context, "account");

	const denied = expectedOf("foreign-context-refused");
	const conversation = async () => (await w.eventsOf(Aa, C)).events;
	const held = await conversation();
	const stranger = await w.actorOf(church.F);
	const codes = await untouched(w.admin, async () => [
		await refusal(readConversation(w.db, stranger, C)),
		await refusal(submitTurn(w.db, stranger, C, { requestKey: randomUUID(), text: said })),
		await refusal(readReview(w.db, stranger, edited.id)),
		await refusal(stageAttachment(w.db, w.files.storage, stranger, C, { name: "x.txt", byteLength: 1 })),
	]);
	assert.deepEqual(codes, ["not_found", "not_found", "not_found", denied.error_code]);
	const before = await everyDocument();
	const foreign = await recorded(w.admin, () =>
		church.foreign(said, [() => read("documents.read", { documentId: D.id })], {
			secrets: ["My Discovery", "A hope I wrote elsewhere", c.given.E.body, canary],
		}),
	);
	const asked = foreign.value;
	const [none] = asked.replies;
	assert.deepEqual(
		[rowsOf(none)[0]?.fields.text ?? null, rowsOf(none)[0]?.id ?? null],
		[denied.forbidden_body, denied.forbidden_existence],
	);
	assert.deepEqual(
		[asked.proposals.length, foreign.added.mail + foreign.added.notices],
		[denied.domain_writes, denied.provider_effects],
	);
	assert.deepEqual(await everyDocument(), before);
	assert.deepEqual(await conversation(), held);

	const outage = expectedOf("required-boundary-failure");
	const completed = () =>
		w.rows(sql`SELECT id,receipt FROM proposal WHERE conversation_id=${C} AND outcome='completed' ORDER BY id`);
	const kept = await completed();
	const { value, added } = await recorded(w.admin, async () => [
		await church.outage(said, [reads("documents.listOwned")], "document", { as: A, conversation: C }),
		await church.outage(said, [reads("wiki.search", { query: "foundation" })], "article_revision", {
			as: A,
			conversation: C,
		}),
		await church.outage(said, [reads("discovery.getProfile")], "discovery", { as: A, conversation: C }),
	]);
	for (const t of value) {
		assert.equal(t.replies.at(-1).error, outage.error_code);
		assert.equal(t.proposals.length, outage.new_domain_writes);
	}
	assert.equal(added.mail + added.notices, outage.new_provider_effects);
	assert.deepEqual(await everyDocument(), before);
	assert.equal(JSON.stringify(await completed()) === JSON.stringify(kept), outage.prior_committed_outcomes_retained);
	assert.equal(kept.length, 3);
	assert.deepEqual(await grants(A), { plant_grants, organization_grants, new_reading_credit });
});

test("INV-account-wiki: an account browses and searches only published public articles, also while a sending network with its own articles is linked, and no reading row changes", async () => {
	const A = await person();
	await w.admin
		.execute(sql`INSERT INTO affiliation(account_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${A.id},${ids.network},clock_timestamp()-interval '1 day',false,false,false,false,false,false,false)`);
	await createWikiProducer().recordView(w.db, await w.authorityOf(A), {
		requestKey: randomUUID(),
		input: { articleId: foundation },
	});
	const before = await reading();
	assert.equal(before.filter((r) => r.account_id === A.id).length, 1);
	const asked = await w.quiet(() =>
		w.ask(A, "What is in the Wiki?", [
			() => [
				read("wiki.navigation"),
				read("wiki.articles.list"),
				read("wiki.search", { query: "vision meeting" }),
				read("wiki.search", { query: "draft only published" }),
				read("wiki.search", { query: "other network guidance" }),
				read("wiki.search", { query: "unpublished foundation" }),
				read("wiki.referenceExcerpt", { articleId: ids.vision.article }),
				read("wiki.referenceExcerpt", { articleId: ids.vision.article, heading: "The Agenda" }),
				read("wiki.tableOfContents", { articleId: ids.vision.article }),
			],
		]),
	);
	const [menu, all, vision, draft, foreign, unpublished, excerpt, agenda, contents] = asked.replies;
	assert.equal(menu.facts.articles, rowsOf(all).length);
	assert.deepEqual(
		[...new Set(rowsOf(all).map((r) => r.fields.source))],
		["global"],
		"only the public Wiki's own articles",
	);
	assert.ok(rowsOf(all).some((r) => r.fields.articleId === foundation && r.label === "Foundation"));
	assert.deepEqual(
		rowsOf(vision).map((r) => [r.id, r.fields.source]),
		[[ids.vision.global, "global"]],
	);
	for (const none of [draft, foreign]) assert.deepEqual(rowsOf(none), []);
	assert.equal(
		rowsOf(unpublished).some((r) => /unpublished/i.test(r.label)),
		false,
	);
	assert.match(rowsOf(excerpt)[0].fields.excerpt, /^A vision meeting is a short gathering/);
	assert.match(rowsOf(agenda)[0].fields.excerpt, /Welcome, share the vision/);
	assert.deepEqual(
		rowsOf(contents).map((r) => r.fields.heading),
		["Before the Meeting", "The Agenda"],
	);
	const told = JSON.stringify([asked.prompts, asked.saved]);
	for (const line of [NETWORK_LINE, DRAFT_LINE, FOREIGN_LINE, UNPUBLISHED, "Harvest Network"])
		assert.equal(told.includes(line), false, line);
	assert.deepEqual(await reading(), before);
});

test("AC:DC-026 INV-account-document: a document an account asks Evry to write is stored only on approval, word for word, as one private document", async () => {
	const A = await person();
	const before = await everyDocument();
	const none = { plant_grants: 0, organization_grants: 0, new_reading_credit: 0 };
	assert.deepEqual(await grants(A), none, "no church, so Evry holds no church grant");
	const proposed = await reviewing(() =>
		w.ask(A, "Write down why I want to plant", [
			proposes("documents.saveNative", { kind: "new", title: "Why plant", text: "# Why\n\nFor the city.\n\n- Hope" }),
		]),
	);
	assert.deepEqual(changesOf(proposed), [
		["title", null, "Why plant"],
		["text", null, "Why\n\nFor the city.\n\n• Hope"],
	]);
	assert.deepEqual(await everyDocument(), before, "the write waits for the exact review");
	assert.equal((await w.approve(A, proposed)).review.outcome, "completed", "one approval is the only approval");
	assert.deepEqual(await grants(A), none);
	const [saved, ...more] = await documentsOf(A);
	assert.deepEqual([saved!.title, saved!.kind, more], ["Why plant", "native", []]);
	assert.deepEqual(readNative(saved!.body).body, {
		type: "doc",
		content: [
			{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Why" }] },
			{ type: "paragraph", content: [{ type: "text", text: "For the city." }] },
			{
				type: "bulletList",
				content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Hope" }] }] }],
			},
		],
	});
	assert.deepEqual(
		(await everyDocument()).filter((d) => d.tenant_id !== A.id),
		before,
	);
});

test("INV-account-import: an account's attached Word or text file becomes one private document of theirs on approval; a CSV, photo or PDF is refused, and a file from another conversation or account is not usable", async () => {
	const A = await person();
	const B = await person("Blair Other");
	const Aa = await w.actorOf(A);
	const C = await w.converse(Aa);
	const bytes = Word.word(Word.styled("Heading1", "My call") + Word.p("I want to serve Austin."), {
		styles: Word.styles(Word.style("Heading1", "heading 1")),
	});
	const word = await attach(A, C, "My call.docx", bytes);
	const importing = (file: { id: string; name: string }, conversation = C, a = A) =>
		w.ask(a, "Import it", [proposes("documents.importTextOrWord", { attachmentId: file.id })], {
			conversation,
			attachments: [{ id: file.id, name: file.name }],
			storage: w.files.storage,
		});
	const proposed = await reviewing(() => importing(word));
	assert.deepEqual(changesOf(proposed), [
		["file", null, "My call.docx"],
		["title", null, "My call"],
		["text", null, "My call · I want to serve Austin."],
	]);
	assert.deepEqual(await documentsOf(A), []);
	const done = await w.approve(A, proposed);
	assert.equal(done.review.outcome, "completed");
	const [saved, ...more] = await documentsOf(A);
	assert.deepEqual(
		[saved!.id, saved!.title, saved!.kind, more],
		[done.review.receipt?.receiptId, "My call", "native", []],
	);
	assert.match(words(saved!.body), /"My call".*"I want to serve Austin\."/);
	assert.deepEqual(
		await w.rows(sql`SELECT DISTINCT tenant_id FROM file_object WHERE purpose='native_import' AND state='ready'
			AND byte_count=${bytes.length}`),
		[{ tenant_id: A.id }],
	);

	const files = await w.count(sql`SELECT count(*) AS n FROM file_object`);
	for (const [name, body] of [
		["people.csv", Buffer.from("first_name\nAna")],
		["me.png", Buffer.from([0x89, 0x50, 0x4e, 0x47])],
		["me.jpg", Buffer.from([0xff, 0xd8, 0xff])],
		["letter.pdf", pdf()],
	] as const)
		assert.equal(
			await refusal(stageAttachment(w.db, w.files.storage, Aa, C, { name, byteLength: body.length })),
			"access_denied",
			name,
		);
	assert.equal(await w.count(sql`SELECT count(*) AS n FROM file_object`), files);

	const elsewhere = await w.converse(Aa);
	const theirs = await w.converse(await w.actorOf(B));
	const foreign = await attach(B, theirs, "Blair.txt", Buffer.from("BLAIR-CANARY"));
	const other = await attach(A, elsewhere, "Other.txt", Buffer.from("OTHER-CONVERSATION"));
	for (const file of [foreign, other, { id: randomUUID(), name: "Guess.txt" }]) {
		const asked = await w.ask(A, "Import it", [proposes("documents.importTextOrWord", { attachmentId: file.id })], {
			conversation: C,
			storage: w.files.storage,
		});
		assert.deepEqual([asked.replies[0].error, asked.proposals], ["attachment_elsewhere", []]);
		assert.equal(
			await refusal(submitTurn(w.db, Aa, C, { requestKey: randomUUID(), text: "x", attachments: [file] })),
			"attachment_gone",
		);
		assert.equal(await refusal(readAttachment(w.db, w.files.storage, Aa, C, file.id)), "attachment_elsewhere");
	}
	const changed = only(await importing(await attach(A, C, "Later.txt", Buffer.from("first words"))));
	const key = [...w.files.objects].find(([, b]) => b.toString() === "first words")![0];
	w.files.objects.set(key, Buffer.from("other words"));
	assert.deepEqual((await w.approve(A, changed)).review.receipt?.code, "file_changed");
	assert.equal((await documentsOf(A)).length, 1);
});

test("INV-account-archive: an account's document is archived only by an approved, current review: cancelled, expired or stale writes nothing", async () => {
	const A = await person();
	const Aa = await w.actorOf(A);
	const mine = await seedDocument(w.admin, A.id, "native", "Notes", "Keep me.");
	const other = await seedDocument(w.admin, A.id, "native", "Others", "Stay.");
	const ask = async () =>
		reviewing(() => w.ask(A, "Archive Notes", [proposes("documents.archive", { documentId: mine.id })]));
	const before = await documentsOf(A);

	const first = await ask();
	assert.deepEqual(
		[first.review.target?.id, changesOf(first)],
		[
			mine.id,
			[
				["status", "Live", "Archived"],
				["list", null, "Documents"],
			],
		],
	);
	await cancelProposal(w.db, Aa, first.id);
	assert.equal(await refusal(approveProposal(w.db, Aa, first.id, w.witness(first), null)), "review_closed");

	const second = await ask();
	await w.admin.execute(sql`UPDATE proposal SET expires_at=clock_timestamp() WHERE id=${second.id}`);
	assert.equal(await refusal(approveProposal(w.db, Aa, second.id, w.witness(second), null)), "review_expired");
	assert.equal(await w.effect(), null);
	assert.deepEqual(await documentsOf(A), before);

	const third = await ask();
	const { status } = await documentsWriter.saveNative(w.db, await w.authorityOf(A), {
		title: "Notes",
		body: readNative(before.find((d) => d.id === mine.id)!.body).body,
		documentId: mine.id,
		expectedRevision: "1",
	} as unknown);
	assert.equal(status, "ok");
	const stale = await w.approve(A, third);
	assert.deepEqual([stale.review.outcome, stale.review.receipt?.code], ["refused", "revision_conflict"]);
	assert.deepEqual(
		(await documentsOf(A)).map((d) => d.archived),
		[false, false],
	);

	const fourth = await ask();
	assert.equal((await w.approve(A, fourth)).review.outcome, "completed");
	assert.deepEqual(
		new Map((await documentsOf(A)).map((d) => [d.id, d.archived])),
		new Map([
			[mine.id, true],
			[other.id, false],
		]),
	);
});

test("INV-account-privacy: a linked sending church, its network or a church Owner sees nothing of an account's documents, conversation, reviews or files, and every audit of them stays the account's", async () => {
	const A = await person();
	const Aa = await w.actorOf(A);
	const sender = await w.organization("sending_church");
	const network = await w.organization("sending_network");
	for (const org of [sender, network])
		await w.admin
			.execute(sql`INSERT INTO affiliation(account_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
			VALUES(${A.id},${org.id},clock_timestamp()-interval '1 day',false,false,false,false,false,false,false)`);
	const watchers = [
		await w.seated(sender, "owner"),
		await w.seated(network, "owner"),
		await w.seated(church.P, "owner"),
	];
	const secret = "PRIVATE-CALL-CANARY";
	const C = await w.converse(Aa);
	const { added } = await recorded(w.admin, async () => {
		const file = await attach(A, C, "Call.txt", Buffer.from(secret));
		const proposed = only(
			await w.ask(A, secret, [proposes("documents.importTextOrWord", { attachmentId: file.id })], {
				conversation: C,
				attachments: [{ id: file.id, name: file.name }],
				storage: w.files.storage,
			}),
		);
		assert.equal((await w.approve(A, proposed)).review.outcome, "completed");
	});
	assert.deepEqual([added.notices, added.mail], [0, 0]);
	const audited = await w.rows(sql`SELECT DISTINCT tenant_id,actor_id FROM audit_event
		WHERE subject_id=${C} OR (action LIKE 'documents.%' AND actor_id=${A.id})`);
	assert.deepEqual(audited, [{ tenant_id: A.id, actor_id: A.id }]);
	const [document] = await documentsOf(A);
	const [file] = await w.rows<{ id: string }>(
		sql`SELECT id FROM file_object WHERE tenant_id=${A.id} AND purpose='assistant_staging'`,
	);
	const [review] = Object.values((await w.eventsOf(Aa, C)).reviews);
	for (const watcher of watchers) {
		const who = await w.actorOf(watcher);
		assert.deepEqual(
			[
				await refusal(readConversation(w.db, who, C)),
				await refusal(readReview(w.db, who, review!.id)),
				await refusal(approveProposal(w.db, who, review!.id, w.witness(review!), null)),
				await refusal(readAttachment(w.db, w.files.storage, who, C, file!.id)),
			],
			["not_found", "not_found", "not_found", "attachment_elsewhere"],
		);
		assert.equal((await listConversations(w.db, who, { search: "PRIVATE-CALL" })).total, 0);
		const authority = await w.authorityOf(watcher);
		assert.equal(
			(await documentsWriter.read(w.db, authority, { documentId: document!.id } as unknown)).status,
			"refused",
		);
		const asked = await w.ask(
			watcher,
			"Show me what this person is writing",
			[
				() => [
					read("documents.read", { documentId: document!.id }),
					read("documents.listOwned"),
					read("oversight.listPlants"),
				],
			],
			{ onError: "go_on" },
		);
		assert.equal(JSON.stringify([asked.prompts, asked.saved, asked.replies]).includes(secret), false);
		assert.equal(
			asked.replies.some((r) => rowsOf(r).some((row) => row.id === document!.id)),
			false,
		);
	}
});

test("INV-account-conversion: once an account gains a church, its plant Evry carries neither the Discovery conversation nor its documents; the conversation stays readable, read-only, and an earlier account review can't be approved there", async () => {
	const A = await person();
	const Aa = await w.actorOf(A);
	const C = await w.converse(Aa);
	const D = await seedDocument(w.admin, A.id, "native", "My Discovery", c.given.D.body);
	const waiting = only(
		await w.ask(A, "Archive it", [proposes("documents.archive", { documentId: D.id })], { conversation: C }),
	);
	const turned = only(
		await w.ask(
			A,
			"Turn my Discovery space into a church",
			[proposes("discovery.convertToPlant", { name: "New Hope" })],
			{
				conversation: C,
			},
		),
	);
	assert.equal((await w.approve(A, turned)).review.outcome, "completed");
	const seated = await w.actorOf(A);
	assert.equal(seated.contextKind, "plant");
	const before = await documentsOf(A);
	assert.equal((await readConversation(w.db, seated, C)).conversation.discovery, true);
	assert.equal((await readReview(w.db, seated, waiting.id)).closed, true);
	assert.deepEqual(
		[
			await refusal(submitTurn(w.db, seated, C, { requestKey: randomUUID(), text: "go on" })),
			await refusal(approveProposal(w.db, seated, waiting.id, w.witness(waiting), null)),
		],
		["discovery_read_only", "review_closed"],
	);
	assert.equal(await w.effect(), null);
	assert.deepEqual(
		(await listConversations(w.db, seated, {})).items.map((c) => [c.id, c.discovery]),
		[[C, true]],
	);
	const asked = await w.ask(
		A,
		"What documents are there?",
		[() => [read("documents.listOwned"), read("documents.read", { documentId: D.id })]],
		{ onError: "go_on" },
	);
	assert.deepEqual(
		asked.replies.map((r) => [r.status, rowsOf(r)]),
		[
			["not_found", []],
			["not_found", []],
		],
	);
	assert.equal(JSON.stringify([asked.prompts, asked.saved]).includes(c.given.D.body), false);
	assert.deepEqual(await documentsOf(A), before);
});
