import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { accountId } from "../../../packages/contracts/src/common/index.ts";
import { nativeFromText, readNative } from "../../../packages/contracts/src/documents/native.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import { captureFacts, createPrivateCare } from "../../../packages/domain/src/intelligence/index.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { claimDue, finishClaim } from "../../../packages/domain/src/jobs/queue.ts";
import {
	approveProposal,
	createConversation,
	evryActor,
	executeProposal,
	prepareProposal,
	submitTurn,
} from "../../../packages/evry/src/index.ts";
import foundations from "../../../docs/reference/discovery-foundations.json" with { type: "json" };
import { fixture, ok, refused, type Actor } from "../../support/fixture.mts";
import { touched, untouched } from "../../support/recorded.mts";
import { MemoryClient } from "../documents/storage.mts";
import * as Word from "../documents/fixtures/word.mts";
import { wikiWorld } from "../wiki/case-world.mts";
import type { OnboardingContext } from "../../../packages/contracts/src/onboarding/server.ts";

type World = {
	f: Awaited<ReturnType<typeof fixture>>;
	db: Awaited<ReturnType<typeof fixture>>["pools"]["runtime"];
	admin: Awaited<ReturnType<typeof fixture>>["admin"];
	actor: (who: Pick<Actor, "session">) => Promise<RequestActor>;
};
let w: Awaited<ReturnType<typeof wikiWorld>>;
let files: ReturnType<typeof helpers>;
let wiki: ReturnType<typeof helpers>;
const onboarding = createOnboardingProducer({ relationships: async () => {}, async enqueue() {} });
const storage = { bucket: "synthetic-only", client: new MemoryClient() };
const SIX = foundations.articles.map((a) => a.id);
const NONE = { documentId: null, text: null };
type Plant = Extract<OnboardingContext["selected"], { kind: "plant" }>;
type Church = { A: Actor; P: Plant };
let plain: Awaited<ReturnType<typeof fixture>>;

before(async () => {
	w = await wikiWorld("dc046");
	for (const a of foundations.articles) await w.article({ id: a.id, slug: a.slug, title: a.title, phase: 0 });
	wiki = helpers(w);
	plain = await fixture({ prefix: "dc046f", max: 6 });
	files = helpers({
		f: plain,
		db: plain.pools.runtime,
		admin: plain.admin,
		actor: async (who) => {
			const resolved = await RequestActor.resolve(plain.pools.runtime, who.session);
			assert.ok(resolved instanceof RequestActor);
			return resolved;
		},
	});
});
after(async () => {
	await w?.close();
	await plain?.close();
});

const doc = (text: string) => nativeFromText(text);

function helpers(on: World) {
	const me = (who: Actor) => on.actor(who);
	const count = async (q: ReturnType<typeof sql>) => Number((await on.admin.execute<{ n: number }>(q)).rows[0]!.n);
	const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
		(await on.admin.execute<T>(q)).rows[0]!;
	const textOf = (documentId: string) =>
		one<{ body: string; version: number; kind: string; tenant: string; revision: string }>(
			sql`SELECT r.body, r.version_number AS version, d.kind, d.tenant_id::text AS tenant, d.revision::text AS revision
			FROM document d JOIN document_revision r ON r.id=d.current_revision_id WHERE d.id=${documentId}`,
		);
	const planter = () =>
		on.f.actor(null, "owner", { account: { registration_kind: "planter", personal_timezone: "America/Chicago" } });
	async function church(): Promise<Church> {
		const A = await planter();
		const created = ok(
			await gatedTransaction(on.db, (tx) =>
				onboarding.createPlant(
					tx,
					{ session: A.session, selected: { kind: "account", id: accountId.parse(A.id) } },
					{ requestKey: randomUUID(), expectedRevision: "1", input: { name: "Harvest Point", confirmed: true } },
				),
			),
		);
		return { A, P: created.plant };
	}
	async function resume({ A, P }: Church) {
		const value = ok(
			await gatedTransaction(on.db, (tx) => onboarding.getResume(tx, { session: A.session, selected: P }, {})),
		);
		assert.ok(value.status === "available", JSON.stringify(value));
		return value;
	}
	const evidence = async (who: Actor) => ok(await documentsWriter.readCoreValuesEvidence(on.db, await me(who), {}));
	const save = async (who: Actor, text: string, title = "Core values") =>
		ok(await documentsWriter.saveNative(on.db, await me(who), { title, body: doc(text), expectedRevision: "0" }));
	const designate = async (who: Actor, d: { id: string; revision: string }) =>
		documentsWriter.designateCoreValues(on.db, await me(who), { documentId: d.id, expectedRevision: d.revision });
	async function blankRevision(d: { id: string }, tenant: string, body: string, importState: string | null = null) {
		const id = randomUUID();
		await on.admin
			.execute(sql`INSERT INTO document_revision (id, tenant_id, document_id, version_number, body, content_hash,
			import_state, recorded_at) SELECT ${id}::uuid, ${tenant}::uuid, ${d.id}::uuid, max(version_number)+1, ${body}, md5(${body}),
			${importState}, clock_timestamp() FROM document_revision WHERE document_id=${d.id}::uuid`);
		await on.admin.execute(sql`UPDATE document SET current_revision_id=${id}::uuid WHERE id=${d.id}::uuid`);
	}
	const modelCalls = () =>
		count(sql`SELECT ((SELECT count(*) FROM model_spend)+(SELECT count(*) FROM provider_event)
			+(SELECT count(*) FROM assessment_run))::int AS n`);
	const plantRows = (P: Plant) =>
		count(sql`SELECT ((SELECT count(*) FROM document WHERE tenant_id=${P.id})
			+(SELECT count(*) FROM document_revision WHERE tenant_id=${P.id})
			+(SELECT count(*) FROM audit_event WHERE tenant_id=${P.id}))::int AS n`);
	return {
		...on,
		me,
		count,
		one,
		textOf,
		church,
		resume,
		evidence,
		save,
		designate,
		blankRevision,
		modelCalls,
		plantRows,
		untouched: <T,>(body: () => Promise<T>) => untouched(on.admin, body),
	};
}

test("AC:DC-001 AC:DC-002 Discovery reading and writing belong to the account: no plant row, one personal document", async () => {
	const { me, count, church, resume, evidence, save, plantRows, db, admin, f } = wiki;
	const D = await f.actor(null, "owner", { account: { registration_kind: "discovery" } });
	await admin.execute(sql`INSERT INTO discovery(account_id) VALUES(${D.id})`);
	const plants = () =>
		count(sql`SELECT ((SELECT count(*) FROM plant)+(SELECT count(*) FROM phase_transition))::int AS n`);
	const before = await plants();
	const read = await w.progress(D, SIX[0]!, 0.9);
	assert.equal(read.completed, true, "the Wiki domain is open to the Discovery account");
	const own = await save(D, "Why I want to plant", "Discovery notes");
	assert.equal(own.tenantId, D.id, "the native-document domain is open and the document is the account's");
	refused(
		await documentsWriter.generate(
			db,
			await me(D),
			{ templateId: "commitment-card", format: "pdf", requestKey: randomUUID() },
			storage,
		),
	);
	assert.equal(await plants(), before, "no plant or phase row");
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM seat WHERE account_id=${D.id}`), 0);
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM reading WHERE account_id=${D.id} AND plant_context_id IS NOT NULL`),
		0,
	);

	const c = await church();
	const beforeRows = await plantRows(c.P);
	ok(
		await w.api.updateProgress(db, await me(c.A), {
			requestKey: randomUUID(),
			input: { articleId: SIX[1]!, fraction: "0.5" },
		}),
	);
	const personal = ok(
		await documentsWriter.saveMine(db, await me(c.A), {
			title: "Personal values",
			body: doc("Personal values text"),
			expectedRevision: "0",
		}),
	);
	ok(
		await documentsWriter.designateMine(db, await me(c.A), {
			documentId: personal.id,
			expectedRevision: personal.revision,
		}),
	);
	assert.equal(await plantRows(c.P), beforeRows, "plant_rows 0");
	const mine = ok(await documentsWriter.listMine(db, await me(c.A), {})).documents;
	assert.deepEqual(
		mine.map((d) => [d.id, d.tenantId]),
		[[personal.id, c.A.id]],
		"saved_personal_documents 1",
	);
	assert.deepEqual(await evidence(c.A), NONE);
	assert.equal((await resume(c)).values, "missing");
});

test("AC:DC-003 AC:DC-004 AC:DC-011 only a saved, non-empty, current native document marked as core values is the values evidence", async () => {
	const { me, count, one, textOf, church, resume, evidence, save, designate, blankRevision, modelCalls, db, admin } =
		files;
	const c = await church();
	const { A, P } = c;
	const empty = await save(A, "temporary");
	await blankRevision(empty, P.id, JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] }));
	const unsaved = randomUUID();
	await admin.execute(
		sql`INSERT INTO document (id, tenant_id, kind, title, revision) VALUES (${unsaved}, ${P.id}, 'native', 'Unsaved', 1)`,
	);
	const unrelated = await save(A, "Volunteer roster", "Roster");
	const archived = await save(A, "Old values");
	const marked = ok(await designate(A, archived));
	const gone = ok(
		await documentsWriter.archive(db, await me(A), { documentId: archived.id, expectedRevision: marked.revision }),
	);
	const qualifies: boolean[] = [];
	for (const [variant, d] of [
		["empty", empty],
		["unsaved", { id: unsaved, revision: "1" }],
		["unrelated", null],
		["archived", gone],
	] as const) {
		if (d) assert.equal((await designate(A, d)).status, "refused", variant);
		const values = (await resume(c)).values;
		const read = await evidence(A);
		qualifies.push(values === "recorded" || read.documentId !== null);
		assert.equal(values, "missing", variant);
	}
	assert.equal((await textOf(unrelated.id)).kind, "native");
	assert.deepEqual(qualifies, [false, false, false, false]);

	const calls = await modelCalls();
	const D = await save(A, "Recorded values text");
	const first = ok(await designate(A, D));
	assert.equal(first.kind, "core_values");
	assert.deepEqual(await evidence(A), { documentId: D.id, text: "Recorded values text" });
	assert.equal((await resume(c)).values, "recorded", "core_values met");
	assert.equal((await modelCalls()) - calls, 0, "model_calls 0");

	const v1 = await textOf(D.id);
	assert.equal(v1.version, 1);
	const corrected = ok(
		await documentsWriter.saveNative(db, await me(A), {
			title: "Core values",
			body: doc("Corrected values text"),
			documentId: D.id,
			expectedRevision: first.revision,
		}),
	);
	const v2 = await textOf(D.id);
	assert.deepEqual([v2.version, v2.kind], [2, "core_values"]);
	assert.deepEqual(await evidence(A), { documentId: D.id, text: "Corrected values text" }, "current_state");
	const previous = await one<{ body: string }>(
		sql`SELECT body FROM document_revision WHERE document_id=${D.id} AND version_number=1`,
	);
	assert.deepEqual(readNative(previous.body).body, doc("Recorded values text"), "previous_state kept");
	ok(await documentsWriter.archive(db, await me(A), { documentId: D.id, expectedRevision: corrected.revision }));
	assert.deepEqual(await evidence(A), NONE, "archived evidence does not qualify");
	assert.equal((await resume(c)).values, "missing");
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM document_revision WHERE document_id=${D.id}`), 2);
});

test("AC:DC-005 AC:DC-006 AC:DC-007 a text or Word file becomes native content; its file alone, active content and a failed parse never count", async () => {
	const { me, count, textOf, church, resume, evidence, save, designate, blankRevision, untouched: quiet, db } = files;
	const c = await church();
	const { A, P } = c;
	const upload = (as: Actor, format: "text" | "docx", bytes: Uint8Array, extra: object = {}) =>
		me(as).then((who) =>
			documentsWriter.importTextOrWord(
				db,
				who,
				{ title: "Imported values", format, bytes, expectedRevision: "0", requestKey: randomUUID(), ...extra },
				storage,
			),
		);
	const file = (format: "text" | "docx", bytes: Uint8Array, extra: object = {}) => upload(A, format, bytes, extra);
	const fetched: unknown[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
		fetched.push(args[0]);
		throw Error("no network");
	}) as typeof fetch;
	try {
		const text = ok(await file("text", Buffer.from("We love our city\nWe pray first")));
		assert.deepEqual(text.body, {
			type: "doc",
			content: [
				{ type: "paragraph", content: [{ type: "text", text: "We love our city" }] },
				{ type: "paragraph", content: [{ type: "text", text: "We pray first" }] },
			],
		});
		assert.equal(
			await count(sql`SELECT count(*)::int AS n FROM file_object WHERE tenant_id=${P.id} AND state='ready'`),
			1,
			"the uploaded file is stored",
		);
		assert.deepEqual(await evidence(A), NONE, "the attachment alone does not qualify");
		assert.equal((await resume(c)).values, "missing");
		ok(await designate(A, text));
		assert.deepEqual(await evidence(A), { documentId: text.id, text: "We love our city\nWe pray first" });

		const linked = ok(
			await file(
				"docx",
				Word.word(Word.p(["Visit ", Word.link("rId1", "our site")]), {
					rels: Word.rels(["rId1", "https://values.example/remote.png"]),
				}),
			),
		);
		assert.equal(JSON.stringify(linked.body).includes("our site"), true, "native_content_saved");
		const stored = (await textOf(linked.id)).body;
		const rejected: [string, Uint8Array][] = [
			[
				"macro",
				Word.storedZip([
					{
						name: "word/document.xml",
						data: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${Word.p("Macro")}</w:body></w:document>`,
					},
					{ name: "word/vbaProject.bin", data: "macro" },
				]),
			],
			[
				"embedded object",
				Word.word(Word.p("Object"), {
					rels: '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="http://evil.example/x" TargetMode="External"/></Relationships>',
				}),
			],
		];
		for (const [what, bytes] of rejected) {
			const result = await quiet(async () =>
				file("docx", bytes, { documentId: linked.id, expectedRevision: linked.revision }),
			);
			refused(result, "invalid_input");
			assert.equal((await textOf(linked.id)).body, stored, what);
		}
		assert.deepEqual(fetched, [], "external_fetches 0");
		assert.equal(
			stored.includes("vbaProject") || stored.includes("oleObject") || stored.includes("evil.example"),
			false,
		);

		const later = await church();
		const values = ok(await designate(later.A, await save(later.A, "Values before the failed import")));
		const failures: [string, "text" | "docx", Uint8Array][] = [
			["malformed", "docx", Buffer.from("PK\u0003\u0004 not a real archive")],
			["empty", "text", Buffer.from("   \n  ")],
		];
		for (const [what, format, bytes] of failures) {
			const result = await quiet(async () =>
				upload(later.A, format, bytes, { documentId: values.id, expectedRevision: values.revision }),
			);
			refused(result, "invalid_input");
			assert.equal((await resume(later)).values, "recorded", `${what} leaves the saved values`);
		}
		await blankRevision(values, later.P.id, "Half-read import", "failed");
		assert.deepEqual(await evidence(later.A), NONE, "failed: criterion unknown");
		assert.equal((await resume(later)).values, "missing");
		const current = await textOf(values.id);
		const recovered = ok(
			await upload(later.A, "text", Buffer.from("Recovered values"), {
				documentId: values.id,
				expectedRevision: current.revision,
			}),
		);
		assert.equal((await textOf(recovered.id)).kind, "core_values");
		assert.deepEqual(await evidence(later.A), { documentId: values.id, text: "Recovered values" }, "recoverable");
		assert.equal((await resume(later)).values, "recorded");
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("AC:DC-008 AC:DC-009 AC:DC-010 another account's body, a foreign document, revision or file and a revoked seat give nothing", async () => {
	const { me, textOf, church, save, designate, admin, f, db, count } = files;
	const { A, P } = await church();
	const B = await f.actor(P, "admin");
	const secret = ok(
		await documentsWriter.saveMine(db, await me(B), {
			title: "B private",
			body: doc("B private body canary-dc008"),
			expectedRevision: "0",
		}),
	);
	assert.equal(secret.tenantId, B.id);
	const churchDoc = await save(A, "Plant writing", "Plant writing");
	const shown: unknown[] = [
		await documentsWriter.read(db, await me(A), { documentId: secret.id }),
		await documentsWriter.readMine(db, await me(A), { documentId: secret.id }),
		await documentsWriter.listOwned(db, await me(A), {}),
		await documentsWriter.listMine(db, await me(A), {}),
		await documentsWriter.listCopySources(db, await me(A), {}),
	];
	refused(shown[0]);
	refused(shown[1]);
	const org = await f.organization("sending_church", { name: "Sending church" });
	const editor = await f.actor(org, "admin");
	await admin.execute(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,
		share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${P.id},${org.id},clock_timestamp(),true,true,true,true,true,true,true)`);
	const asEditor = await me(editor);
	for (const target of [secret.id, churchDoc.id]) {
		refused(await documentsWriter.read(db, asEditor, { documentId: target }));
		refused(
			await documentsWriter.saveNative(db, asEditor, {
				title: "Edited",
				body: doc("Edited by the organization"),
				documentId: target,
				expectedRevision: "1",
			}),
		);
		refused(await documentsWriter.designateCoreValues(db, asEditor, { documentId: target, expectedRevision: "1" }));
	}
	assert.equal(JSON.stringify(shown).includes("canary-dc008"), false, "B_private_body null");
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM seat WHERE account_id=${editor.id} AND plant_id=${P.id}`),
		0,
	);
	assert.deepEqual(
		[(await textOf(churchDoc.id)).revision, (await textOf(secret.id)).revision],
		["1", "1"],
		"org_editor_grant false",
	);

	const T = await church();
	const foreign = await save(T.A, "Foreign values");
	const foreignFile = ok(
		await documentsWriter.generate(
			db,
			await me(T.A),
			{ templateId: "commitment-card", format: "pdf", requestKey: randomUUID() },
			storage,
		),
	);
	const before = await textOf(foreign.id);
	refused(await designate(A, foreign));
	refused(await documentsWriter.read(db, await me(A), { documentId: foreign.id }));
	refused(
		await documentsWriter.useForChurch(db, await me(A), {
			documentId: foreign.id,
			revisionId: foreign.revisionId,
			requestKey: randomUUID(),
		}),
	);
	refused(
		await documentsWriter.useForChurch(db, await me(A), {
			documentId: churchDoc.id,
			revisionId: foreign.revisionId,
			requestKey: randomUUID(),
		}),
	);
	refused(await documentsWriter.download(db, await me(A), { documentId: foreignFile.id }, storage));
	assert.deepEqual(await textOf(foreign.id), before, "foreign_state null");
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM document WHERE tenant_id=${P.id}`),
		1,
		"foreign_document null",
	);

	const R = await f.actor(P, "admin");
	const made = ok(
		await documentsWriter.generate(
			db,
			await me(R),
			{ templateId: "commitment-card", format: "pdf", requestKey: randomUUID() },
			storage,
		),
	);
	const preview = ok(await documentsWriter.getAuthorized(db, await me(R), { documentId: churchDoc.id }));
	const who = evryActor(await me(R));
	const conversation = await createConversation(db, who, { requestKey: randomUUID() });
	await submitTurn(db, who, conversation.id, { requestKey: randomUUID(), text: "Write our welcome letter" });
	const [turn] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(turn);
	const proposal = await prepareProposal(
		db,
		who,
		{ turnId: turn.id, tenantId: turn.tenant_id, leaseOwner: turn.lease_owner, generation: turn.claim_generation },
		conversation.id,
		{
			operation: "documents.saveNative",
			input: { kind: "new", title: "Welcome letter", text: "Welcome to our church." },
		},
	);
	assert.ok(proposal);
	await approveProposal(db, who, proposal.id, { revision: proposal.revision, digest: proposal.digest }, null);
	const [effect] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(effect);
	const asR = await me(R);
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${R.id} AND plant_id=${P.id}`);
	const after = await files.untouched(async () => [
		await documentsWriter.saveNative(db, asR, {
			title: "Plant writing",
			body: doc("Written after the seat ended"),
			documentId: churchDoc.id,
			expectedRevision: preview.revision,
		}),
		await documentsWriter.importTextOrWord(
			db,
			asR,
			{
				title: "Late import",
				format: "text",
				bytes: Buffer.from("Late"),
				expectedRevision: "0",
				requestKey: randomUUID(),
			},
			storage,
		),
		await documentsWriter.download(db, asR, { documentId: made.id }, storage),
	]);
	for (const result of after) refused(result);
	assert.equal(JSON.stringify(after).includes("http"), false, "download_url null");
	const outcome = await executeProposal(
		db,
		{
			jobId: effect.id,
			tenantId: effect.tenant_id,
			leaseOwner: effect.lease_owner,
			generation: effect.claim_generation,
		},
		{
			reminders: async () => {
				throw Error("no reminders");
			},
			phaseNotices: async () => undefined,
		},
	);
	await transaction(db, (tx) => finishClaim(tx, effect, { state: outcome === "failed" ? "failed" : "succeeded" }));
	assert.equal(outcome, "refused", "Evry_execute after the revoke");
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM document WHERE tenant_id=${P.id} AND title='Welcome letter'`),
		0,
		"after_revoke_effects 0",
	);
	assert.equal((await textOf(churchDoc.id)).revision, preview.revision);
});

test("AC:DC-013 AC:DC-014 AC:DC-015 AC:DC-016 AC:DC-018 the Owner alone completes the six past 80 percent; no rereading, extra article or other person is asked", async () => {
	const { church, resume, admin, f, db, count } = wiki;
	const c = await church();
	const { A, P } = c;
	const B = await f.actor(P, "admin");
	const C = await f.actor(P, "member");
	const leader = randomUUID(),
		team = randomUUID(),
		role = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at,linked_account_id) VALUES(${leader},${P.id},${P.id},'Casey Leader',
		'other','leader','adult','unknown','2','live',clock_timestamp(),${C.id})`);
	await admin.execute(sql`INSERT INTO team(id,plant_id,name,state,sort_order,leader_person_id,leader_source)
		VALUES(${team},${P.id},'Worship','active',3,${leader},'explicit')`);
	await admin.execute(sql`INSERT INTO team_role(id,plant_id,team_id,name,leadership,sort_order)
		VALUES(${role},${P.id},${team},'Worship leader',true,0)`);
	await admin.execute(sql`INSERT INTO team_tenure(plant_id,role_id,person_id,started_on)
		VALUES(${P.id},${role},${leader},(clock_timestamp() AT TIME ZONE 'America/Chicago')::date)`);
	for (let n = 0; n < 24; n++) await w.article({ phase: 0, title: `Phase 0 extra ${n + 1}` });
	assert.equal(
		await count(sql`SELECT count(DISTINCT article_id)::int AS n FROM article_revision WHERE phase=0`),
		30,
		"six required and 24 extra Phase 0 articles",
	);

	const first = SIX[0]!;
	assert.deepEqual(
		[(await w.progress(A, first, "0.8")).completed, (await w.progress(A, first, "0.800001")).completed],
		[false, true],
	);
	const earned = await w.kept(A, first);
	assert.deepEqual([earned.done, earned.completed_version], [true, 1]);
	const completions = () =>
		count(sql`SELECT count(*)::int AS n FROM reading WHERE account_id=${A.id} AND completed_at IS NOT NULL`);
	const done = await completions();
	await w.revise(first, { slug: foundations.articles[0]!.slug, phase: 0, number: 2, sequence: 1 });
	await w.progress(A, first, "0.3");
	await w.progress(A, first, "0.95");
	const kept = await w.kept(A, first);
	assert.equal((await completions()) - done, 0, "new_read_completions 0");
	assert.deepEqual(
		[kept.completed_at, kept.completed_version, kept.completed, kept.done],
		[earned.completed_at, 1, earned.completed, true],
		"the reader keeps the version 1 completion",
	);

	for (const id of SIX.slice(1)) await w.progress(A, id, "0.81");
	const r = await resume(c);
	assert.ok(r.reading.status === "complete", JSON.stringify(r.reading));
	assert.deepEqual([r.reading.readerAccountId, r.reading.eligibility], [A.id, { kind: "current_owner" }]);
	assert.deepEqual(r.reading.articles.map((a) => a.articleId).sort(), [...SIX].sort(), "required_articles 6");
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM reading r JOIN article_revision ar ON ar.article_id=r.article_id
			WHERE r.account_id=${A.id} AND ar.phase=0 AND NOT (r.article_id=ANY(${`{${SIX.join(",")}}`}::uuid[]))`),
		0,
		"extra_phase0_required 0",
	);
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM reading WHERE account_id IN (${B.id},${C.id})`),
		0,
		"other people unread",
	);
	const finished = ok(
		await gatedTransaction(db, (tx) =>
			onboarding.complete(
				tx,
				{ session: A.session, selected: P },
				{ requestKey: randomUUID(), expectedRevision: r.revision, input: {} },
			),
		),
	);
	assert.equal(finished.completion.status, "completed", "creation complete without a whole-team course");
	const after = await resume(c);
	assert.deepEqual([after.reading.status, after.completion.status], ["complete", "completed"]);
});

test("AC:DC-012 AC:DC-023 AC:DC-024 one editor for personal and church writing; Use for this church copies only the chosen revision and leaves the original private", async () => {
	const { me, church, admin, f, db, count, textOf } = files;
	const { A, P } = await church();
	const B = await f.actor(P, "admin");
	const asA = await me(A);
	const personal = await touched(admin, async () =>
		ok(
			await documentsWriter.saveMine(db, asA, {
				title: "Values",
				body: doc("Values draft one"),
				expectedRevision: "0",
			}),
		),
	);
	const values = personal.value;
	const churchCopy = await touched(admin, async () =>
		ok(
			await documentsWriter.createFromTemplate(db, asA, {
				templateId: "conflict-of-interest-policy",
				requestKey: randomUUID(),
			}),
		),
	);
	assert.equal(values.tenantId, A.id, "personal_document_owner A");
	const editorTables = ["audit_event", "document", "document_revision", "record"];
	assert.deepEqual(personal.tables, editorTables);
	assert.deepEqual(
		churchCopy.tables.filter((t) => editorTables.includes(t)),
		editorTables,
		"third_CMS false: church writing uses the same document store",
	);
	assert.equal(
		await count(
			sql`SELECT count(*)::int AS n FROM document WHERE id=${churchCopy.value.id} AND template_id='conflict-of-interest-policy'`,
		),
		1,
		"the Church Document comes from the original catalog",
	);

	const v2 = ok(
		await documentsWriter.saveMine(db, asA, {
			title: "Values",
			body: doc("Values draft two"),
			documentId: values.id,
			expectedRevision: values.revision,
		}),
	);
	const other = ok(
		await documentsWriter.saveMine(db, asA, {
			title: "Private journal",
			body: doc("Journal v1"),
			expectedRevision: "0",
		}),
	);
	const sources = ok(await documentsWriter.listCopySources(db, asA, {})).documents;
	assert.deepEqual(sources.map((s) => s.id).sort(), [values.id, other.id].sort());
	const before = await count(sql`SELECT count(*)::int AS n FROM document WHERE tenant_id=${P.id}`);
	const copy = ok(
		await documentsWriter.useForChurch(db, asA, {
			documentId: values.id,
			revisionId: v2.revisionId,
			requestKey: randomUUID(),
		}),
	);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM document WHERE tenant_id=${P.id}`), before + 1);
	assert.deepEqual(
		[copy.tenantId, copy.copiedFromRevisionId, copy.body],
		[P.id, v2.revisionId, doc("Values draft two")],
		"copied_documents [selected-values-v2], new_owner P",
	);
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM document d JOIN document_revision r ON r.document_id=d.id
			WHERE d.tenant_id=${P.id} AND (d.copied_from_revision_id=${other.revisionId} OR r.body LIKE '%Journal v1%')`),
		0,
		"unselected_private_copy false",
	);
	const source = await textOf(values.id);
	assert.deepEqual([source.tenant, source.version], [A.id, 2], "source_owner A");
	refused(await documentsWriter.read(db, await me(B), { documentId: values.id }));
	assert.equal(
		ok(await documentsWriter.listOwned(db, await me(B), {})).documents.some((d) => d.id === values.id),
		false,
		"source_private true",
	);
	assert.deepEqual(
		ok(await documentsWriter.read(db, await me(B), { documentId: copy.id })).body,
		doc("Values draft two"),
	);
});

test("AC:DC-025 a private care check-in reaches no document and no model input", async () => {
	const { me, church, admin, db } = files;
	const { A, P } = await church();
	const care = createPrivateCare();
	const asA = await me(A);
	const current = ok(await care.readCurrent(db, asA, {}));
	ok(
		await care.save(db, asA, {
			requestKey: randomUUID(),
			expectedRevision: current.revision,
			input: {
				answers: { spiritual: "struggling", family: "struggling", financial: "struggling", pace: "struggling" },
				note: "care-canary-dc025",
			},
		}),
	);
	const values = ok(
		await documentsWriter.saveNative(db, asA, { title: "Core values", body: doc("Our values"), expectedRevision: "0" }),
	);
	ok(await documentsWriter.designateCoreValues(db, asA, { documentId: values.id, expectedRevision: values.revision }));
	const documents = [
		await documentsWriter.listOwned(db, asA, {}),
		await documentsWriter.listMine(db, asA, {}),
		await documentsWriter.readCoreValuesEvidence(db, asA, {}),
		await documentsWriter.read(db, asA, { documentId: values.id }),
	];
	assert.equal(JSON.stringify(documents).includes("care-canary"), false, "private_care_in_documents null");
	const stored = await admin.execute<{ n: number }>(
		sql`SELECT count(*)::int AS n FROM document_revision WHERE body LIKE '%care-canary%'`,
	);
	assert.equal(stored.rows[0]!.n, 0);
	const snapshot = await captureFacts(db, P.id, null);
	assert.equal(JSON.stringify(snapshot).includes("care-canary"), false, "private_care_in_model null");
	assert.equal(JSON.stringify(snapshot).includes("struggling"), false);
});
