import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createPrivateCare } from "../../../packages/domain/src/intelligence/index.ts";
import {
	cancelTurn,
	createConversation,
	listConversations,
	observeConversation,
	openLatestConversation,
	readConversation,
	readReview,
	retryTurn,
	reviseProposal,
	submitTurn,
} from "../../../packages/evry/src/index.ts";
import { resolveReferences } from "../../../packages/evry/src/context/compile.ts";
import { ok, type Actor } from "../../support/fixture.mts";
import { untouched } from "../../support/recorded.mts";
import { NETWORK_LINE, seedWiki, VISION_SLUG, wikiIds } from "../adapters/wiki/corpus.mts";
import { caseWorld, proposes, reads, rowsOf, sql, type CaseWorld, type Church, type Play } from "./case-world.mts";

let w: CaseWorld;
before(async () => {
	w = await caseWorld("casepanel");
});
after(() => w?.close());

const code = (attempt: Promise<unknown>) =>
	attempt.then(
		() => "answered",
		(e: { code?: string }) => e.code,
	);
const threads = async (a: Actor) => (await listConversations(w.db, await w.actorOf(a), {})).total;
const navigate = async (c: Church, conversation: string) => {
	const panel = await openLatestConversation(w.db, c.Aa);
	const full = await readConversation(w.db, c.Aa, conversation);
	return { panel, full };
};
async function task(c: Church, title: string, due: string, owner: string) {
	const id = randomUUID();
	await w.admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,due_date)
		VALUES(${id},${c.P.id},${title},'general','medium','not_started',clock_timestamp(),'date_only',${due}::date)`);
	await w.admin.execute(sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${c.P.id},${id},${owner})`);
	return id;
}

test("AC:INH-REGRESSION-FOREIGN-SESSION another account, or the same account in another church, is refused every call on a conversation with no sign that it exists", async () => {
	const c = await w.church();
	const B = await w.seated(c.P, "member");
	const running = await w.converse(c.Aa);
	await submitTurn(w.db, c.Aa, running, { requestKey: randomUUID(), text: "Private planning note" });
	const other = await w.plant();
	await w.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${c.A.id}`);
	await w.seat({ id: c.A.id }, other, "admin");
	const moved = await w.actorOf(c.A);
	await w.admin.execute(
		sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${c.A.id} AND plant_id=${other.id}`,
	);
	await w.admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${c.A.id} AND plant_id=${c.P.id}`);
	for (const who of [await w.actorOf(B), moved])
		for (const id of [running, c.C]) {
			const calls = (conversation: string) => [
				readConversation(w.db, who, conversation),
				(async () => {
					for await (const _ of observeConversation(w.db, who, conversation, 0, AbortSignal.timeout(300))) void _;
				})(),
				submitTurn(w.db, who, conversation, { requestKey: randomUUID(), text: "append" }),
				cancelTurn(w.db, who, conversation),
				retryTurn(w.db, who, conversation, { requestKey: randomUUID() }),
			];
			const [real, unknown] = await untouched(w.admin, async () => [
				await Promise.all(calls(id).map(code)),
				await Promise.all(calls(randomUUID()).map(code)),
			]);
			assert.deepEqual(real, unknown, "a real conversation answers as a made-up one");
			assert.ok(
				real!.every((r) => r === "not_found" || r === "access_denied"),
				JSON.stringify(real),
			);
		}
	assert.deepEqual((await listConversations(w.db, await w.actorOf(B), { search: "Private" })).items, []);
	assert.equal(await openLatestConversation(w.db, await w.actorOf(B)), null);
	assert.equal((await readConversation(w.db, c.Aa, running)).events.length, 1, "nothing was appended");
	await cancelTurn(w.db, c.Aa, running);
	await c.foreign("Private planning note", []);
	await c.outage("Continue", [reads("people.listPeople", {})], "person");
});

test("AC:INH-REGRESSION-SESSION-NAVIGATION opening a task and returning to the full chat keeps one conversation and one run, and tomorrow stays the caller's own tasks", async () => {
	const c = await w.church();
	const said = ["Show my tasks.", "Open the first task, return to expanded chat.", "What about tomorrow?"] as const;
	const other = await w.seated(c.P, "member");
	const first = await task(c, "Call venue", "2026-10-13", c.A.id);
	const tomorrow = await task(c, "Print cards", "2026-10-14", c.A.id);
	const theirs = await task(c, "Theirs", "2026-10-14", other.id);
	const mine: Play = [reads("tasks.list", { mine: true, due: "this_week" })];
	const before = await threads(c.A);
	const one = await w.ask(c.A, said[0], mine);
	const { conversation } = one;
	await w.ask(c.A, said[1], [reads("tasks.get", { taskId: first })], {
		conversation,
		references: [{ kind: "page", route: "/tasks" }],
	});
	const { panel, full } = await navigate(c, conversation);
	assert.deepEqual([panel?.conversation.id, full.conversation.id, full.run], [conversation, conversation, null]);
	await submitTurn(w.db, c.Aa, conversation, { requestKey: randomUUID(), text: said[2] });
	assert.equal(
		await code(submitTurn(w.db, c.Aa, conversation, { requestKey: randomUUID(), text: said[2] })),
		"run_active",
		"one controller at a time",
	);
	const run = await w.work(mine);
	assert.equal(run.outcome, "succeeded", "the follow-up is accepted");
	const { events } = await w.eventsOf(c.Aa, conversation);
	const last = events.findLast((e) => e.kind === "tool_result")!.body;
	assert.deepEqual(last.input, { mine: true, due: "this_week" }, "the scope is still the caller");
	const rows = rowsOf(last.result);
	assert.deepEqual(
		rows.filter((r) => r.fields.due === "2026-10-14").map((r) => r.id),
		[tomorrow],
	);
	assert.equal(
		rows.some((r) => r.id === theirs),
		false,
	);
	assert.ok(rows.every((r) => r.fields.yours));
	assert.deepEqual(
		[await threads(c.A), events.filter((e) => e.kind === "user_message").map((e) => e.body.text)],
		[before + 1, [...said]],
		"no new conversation but the one",
	);
	await c.foreign(said[2], [...mine, reads("tasks.get", { taskId: first })], {
		secrets: ["Call venue", "Print cards"],
	});
	await c.outage(said[2], mine, "task");
});

test("AC:UI45-001 expanding the panel reads the same conversation at sequence 4 with its draft, and starts no thread", async () => {
	const c = await w.church();
	const said = "Expand full-width";
	const asked = await w.ask(c.A, "Draft an email", [
		proposes("communication.saveDraft", { subject: "Draft D", body: "Hi", audience: { groups: ["core_group"] } }),
	]);
	const { conversation } = asked;
	const [draft] = asked.proposals;
	const before = await threads(c.A);
	const { panel, full } = await untouched(w.admin, () => navigate(c, conversation));
	assert.deepEqual([panel!.conversation.id, full.conversation.id], [conversation, conversation]);
	assert.deepEqual([full.conversation.lastSequence, full.events.at(-1)!.sequence], [4, 4]);
	for (const page of [panel!, full]) {
		const shown = Object.values(page.reviews);
		assert.deepEqual(
			shown.map((r) => [r?.id, r?.revision, r?.digest, r?.status]),
			[[draft!.id, 1, draft!.digest, "pending"]],
		);
		assert.match(JSON.stringify(shown), /Draft D/);
	}
	assert.equal(await threads(c.A), before, "no new thread");
	const key = randomUUID();
	const made = await createConversation(w.db, c.Aa, { requestKey: key });
	assert.equal(
		(await createConversation(w.db, c.Aa, { requestKey: key })).id,
		made.id,
		"a repeated open makes no second one",
	);
	await c.foreign(said, [reads("communication.list", {})], { secrets: ["Draft D"] });
	await c.outage(said, [reads("communication.list", {})], "communication");
});

test("AC:UI45-002 collapsing, reopening, expanding and changing page keep the conversation, the edited review and the receipt, and approve and save nothing", async () => {
	const c = await w.church();
	const said = "Collapse, reopen, expand and change native page";
	const conversation = c.C;
	const [done] = Object.values((await readConversation(w.db, c.Aa, conversation)).reviews);
	const asked = await w.ask(
		c.A,
		"Change Casey's city",
		[proposes("people.updatePerson", { personId: c.casey, patch: { city: "Austin" } })],
		{ conversation },
	);
	const edited = await reviseProposal(w.db, c.Aa, asked.proposals[0]!.id, {
		operation: "people.updatePerson",
		revision: 1,
		input: { personId: c.casey, patch: { city: "Denver" } },
	});
	assert.equal(edited.revision, 2);
	await untouched(w.admin, async () => {
		for (let step = 0; step < 4; step++) {
			const { panel, full } = await navigate(c, conversation);
			for (const page of [panel!, full]) {
				assert.equal(page.conversation.id, conversation);
				const review = page.reviews[edited.id]!;
				assert.deepEqual(
					[review.revision, review.digest, review.status, review.outcome],
					[2, edited.digest, "pending", null],
				);
				assert.deepEqual(
					[page.reviews[done!.id]?.outcome, page.reviews[done!.id]?.receipt],
					["completed", done!.receipt],
				);
			}
			assert.equal((await readReview(w.db, c.Aa, edited.id)).status, "pending");
		}
	});
	assert.equal(await w.effect(), null, "navigation approves nothing");
	assert.equal((await w.one(sql`SELECT city FROM person WHERE id=${c.casey}`)).city, null, "and saves nothing");
	await c.foreign(said, [reads("people.getPerson", { personId: c.casey })], { secrets: ["Denver"] });
	await c.foreignReview(edited);
	await c.outage(said, [reads("people.listPeople", {})], "person");
});

test("AC:UI45-006 continuing after navigation re-checks every kept reference: foreign, private care and revoked sources give nothing to the model, the saved turn or the logs", async () => {
	const c = await w.church();
	const said = "Continue after navigation and source revoke";
	const foreignPerson = await c.person("Quinn Foreign", { plant: c.Q.id, city: "Peoria" });
	const planter = await w.seated(c.P, "owner");
	await w.admin.execute(sql`UPDATE account SET personal_timezone='America/Chicago' WHERE id=${planter.id}`);
	const authority = await RequestActor.resolve(w.db, planter.session);
	assert.ok(authority instanceof RequestActor);
	const care = createPrivateCare();
	const current = ok(await care.readCurrent(w.db, authority, {}));
	ok(
		await care.save(w.db, authority, {
			requestKey: randomUUID(),
			expectedRevision: current.revision,
			input: {
				answers: { spiritual: "struggling", family: "struggling", financial: "struggling", pace: "struggling" },
				note: "CARE-CANARY",
			},
		}),
	);
	const { id: careId } = await w.one<{ id: string }>(sql`SELECT id FROM private_week`);
	const ids = wikiIds(randomUUID);
	await seedWiki((query) => w.admin.execute(query), c.P.id, ids);
	const references = [
		{ kind: "person" as const, id: foreignPerson },
		{ kind: "person" as const, id: careId },
		{ kind: "article" as const, slug: VISION_SLUG },
	];
	const first = await w.ask(
		c.A,
		"What does this page say?",
		[reads("wiki.referenceExcerpt", { articleId: ids.vision.article })],
		{ references: references.slice(2) },
	);
	assert.match(first.prompts.at(-1)!, new RegExp(NETWORK_LINE));
	const { conversation } = first;
	await navigate(c, conversation);
	await w.admin.execute(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=${ids.affiliation}`);
	await w.admin.execute(sql`DELETE FROM reference_activation`);
	assert.deepEqual(await resolveReferences(w.db, c.Aa, references), [], "no kept reference is still authorized");
	const logged: unknown[] = [];
	const real = { log: console.log, error: console.error, warn: console.warn, info: console.info };
	Object.assign(
		console,
		Object.fromEntries(Object.keys(real).map((k) => [k, (...args: unknown[]) => void logged.push(args)])),
	);
	let asked;
	try {
		asked = await w.quiet(() =>
			w.ask(
				c.A,
				said,
				[reads("people.getPerson", { personId: foreignPerson }), reads("people.getPerson", { personId: careId })],
				{ conversation, references },
			),
		);
	} finally {
		Object.assign(console, real);
	}
	assert.deepEqual(
		asked.replies.map((r) => [r.status, r.rows]),
		[
			["not_found", []],
			["not_found", []],
		],
	);
	const system = String(JSON.parse(asked.prompts.at(-1)!)[0].content);
	assert.equal(system.includes("Verified references on the user's page"), false);
	const { events } = await w.eventsOf(c.Aa, conversation);
	const traces = await w.rows(sql`SELECT metadata,before_value,after_value FROM audit_event WHERE tenant_id=${c.P.id}`);
	const told = JSON.stringify([asked.prompts, events, logged, traces]);
	for (const secret of ["CARE-CANARY", "struggling", "Quinn", "Peoria", NETWORK_LINE])
		assert.equal(told.includes(secret), false, secret);
	assert.equal(
		asked.offered.some((o) => /care|privateWeek|private_week/i.test(o)),
		false,
	);
	await c.foreign(said, [reads("people.getPerson", { personId: c.rivera })], { on: { references } });
	await c.outage(said, [reads("people.listPeople", {})], "person");
});
