// Result rows are kept or withheld by their own kind (WP-051 slice 2): a household or tag row is live while it exists,
// a person row while the person is live, and kinds that are not stored sources are never withheld. Replay
// (retainedEvents) and the in-turn check (withLiveRows) use one rule (conversations/liveness.ts).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { LanguageModelV4 } from "../../../packages/evry/node_modules/@ai-sdk/provider/dist/index.js";
import { createConversation, readConversation, submitTurn, type EvryActor } from "../../../packages/evry/src/index.ts";
import { liveRowKeys } from "../../../packages/evry/src/conversations/liveness.ts";
import { scriptedModel } from "../../../packages/evry/src/runtime/scripted.ts";
import { actor, accounts, admin, db, people, plant, setup, sql, teardown, work } from "./support.mts";

before(setup);
after(teardown);

const qualified = (model: LanguageModelV4) => ({ status: "qualified" as const, id: "test", model });
const usage = {
	inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
};
async function ask(who: EvryActor, text: string) {
	const c = await createConversation(db, who, { requestKey: randomUUID() });
	await submitTurn(db, who, c.id, { requestKey: randomUUID(), text });
	return c.id;
}
async function events(who: EvryActor, id: string) {
	const all = [];
	for (
		let page = await readConversation(db, who, id);
		;
		page = await readConversation(db, who, id, all.at(-1)!.sequence)
	) {
		all.push(...page.events);
		if (!page.more) break;
	}
	return {
		cards: all.filter((e) => e.kind === "tool_result").map((e) => e.body as Record<string, any>),
		texts: all.filter((e) => e.kind === "assistant_text").map((e) => e.body as Record<string, any>),
	};
}
async function household(name: string, city: string | null, members: { id: string; role: string }[] = []) {
	const id = randomUUID();
	await admin.execute(
		sql`INSERT INTO record(id,kind,tenant_id) VALUES(${id},'household',${plant}) ON CONFLICT DO NOTHING`,
	);
	await admin.execute(sql`INSERT INTO household(id,plant_id,name,city) VALUES(${id},${plant},${name},${city})`);
	for (const m of members)
		await admin.execute(sql`UPDATE person SET household_id=${id},household_role=${m.role} WHERE id=${m.id}`);
	return id;
}
async function removeHousehold(id: string) {
	await admin.execute(sql`UPDATE person SET household_id=NULL,household_role=NULL WHERE household_id=${id}`);
	await admin.execute(sql`DELETE FROM household WHERE id=${id}`);
}
const setState = (id: string, state: "live" | "retired") =>
	admin.execute(
		state === "live"
			? sql`UPDATE person SET state='live',retired_at=NULL WHERE id=${id}`
			: sql`UPDATE person SET state='retired',retired_at=clock_timestamp() WHERE id=${id}`,
	);

/** A model that makes these reads in order, then answers `answer`; `before[n]` runs just before model call n. */
function script(
	calls: { operation: string; input: unknown }[],
	answer: string,
	before: Record<number, () => Promise<unknown>> = {},
) {
	const prompts: string[] = [];
	const base = scriptedModel();
	let step = 0;
	const model: LanguageModelV4 = {
		...base,
		async doStream(options) {
			if (options.responseFormat?.type === "json") return base.doStream(options);
			prompts.push(JSON.stringify(options.prompt));
			const n = step++;
			await before[n]?.();
			const call = calls[n];
			const parts = call
				? [
						{
							type: "tool-call" as const,
							toolCallId: randomUUID(),
							toolName: "peopleOrganization_read",
							input: JSON.stringify(call),
						},
					]
				: [
						{ type: "text-start" as const, id: "t" },
						{ type: "text-delta" as const, id: "t", delta: answer },
						{ type: "text-end" as const, id: "t" },
					];
			return {
				stream: new ReadableStream({
					start(c) {
						for (const p of parts) c.enqueue(p);
						c.enqueue({
							type: "finish",
							finishReason: { unified: call ? "tool-calls" : "stop", raw: undefined },
							usage,
						});
						c.close();
					},
				}),
			};
		},
	};
	return { prompts, model: qualified(model) };
}

test("AC:EVRY-CONTEXT-BOUNDS a listHouseholds turn keeps its household row in-turn and on replay, and the answer text", async () => {
	const owner = await actor("owner");
	const home = await household("Okafor household", "North Ridgeville", [
		{ id: people.alexRivera, role: "head" },
		{ id: people.alexChen, role: "spouse" },
	]);
	try {
		const id = await ask(owner, "what households do we have?");
		const prompts: string[] = [];
		const base = scriptedModel();
		const watching: LanguageModelV4 = {
			...base,
			async doStream(options) {
				if (options.responseFormat?.type !== "json") prompts.push(JSON.stringify(options.prompt));
				return base.doStream(options);
			},
		};
		assert.equal(await work(qualified(watching)), "succeeded");
		assert.ok(
			prompts[1]!.includes("Okafor household") && !prompts[1]!.includes("withheldRows"),
			"the next model step sees the row",
		);
		const replay = await events(owner, id);
		const card = replay.cards[0]!.result;
		assert.equal(card.operation, "people.listHouseholds");
		assert.deepEqual(
			[
				card.rows.map((r: any) => [r.kind, r.label, r.fields.city, r.fields.memberCount]),
				card.total,
				card.withheldRows,
			],
			[[["household", "Okafor household", "North Ridgeville", "2"]], 1, undefined],
		);
		assert.equal(replay.texts.map((t) => t.text).join(""), "There is 1 household: Okafor household.");
		assert.ok(replay.texts.every((t) => t.withheld !== true));
	} finally {
		await removeHousehold(home);
	}
});

test("AC:EVRY-CONTEXT-BOUNDS a household removed after its turn is withheld from replay, its answer text and the next model call", async () => {
	const owner = await actor("owner");
	const home = await household("Okafor household", "North Ridgeville");
	const id = await ask(owner, "what households do we have?");
	assert.equal(await work(), "succeeded");
	await removeHousehold(home);
	const replay = await events(owner, id);
	const card = replay.cards[0]!.result;
	assert.deepEqual([card.rows, card.total, card.withheldRows, card.completeness], [[], null, 1, "partial"]);
	assert.ok(replay.texts.length > 0 && replay.texts.every((t) => t.withheld === true && t.text === ""));
	assert.ok(!JSON.stringify(replay).includes("Okafor"));

	// Removed between two model calls of one turn: the later call gets the result without the row.
	const mid = await household("Okafor household", "North Ridgeville");
	await ask(owner, "what households do we have?");
	const run = script(
		[
			{ operation: "people.listHouseholds", input: {} },
			{ operation: "people.listTags", input: {} },
		],
		"The Okafor household is the only one.",
		{ 1: () => removeHousehold(mid) },
	);
	assert.equal(await work(run.model), "succeeded");
	assert.ok(run.prompts[1]!.includes("Okafor household"), "before the removal the row is there");
	assert.ok(
		!run.prompts[2]!.includes("Okafor") && run.prompts[2]!.includes("withheldRows"),
		"after it, the row is withheld",
	);
});

test("AC:EVRY-CONTEXT-BOUNDS a mixed household result withholds only the source that is gone", async () => {
	const owner = await actor("owner");
	const home = await household("Okafor household", "North Ridgeville", [
		{ id: people.alexRivera, role: "head" },
		{ id: people.alexChen, role: "spouse" },
	]);
	const labels = (card: Record<string, any>) => card.result.rows.map((r: any) => r.label).sort();
	try {
		const id = await ask(owner, "show me the Okafor household");
		const run = script([{ operation: "people.getHousehold", input: { householdId: home } }], "Done.");
		assert.equal(await work(run.model), "succeeded");
		const kept = (await events(owner, id)).cards[0]!;
		assert.deepEqual(labels(kept), ["Alex Chen", "Alex Rivera", "Okafor household"]);
		assert.equal(kept.result.withheldRows, undefined);

		// One member deleted (retired): only that person is withheld.
		await setState(people.alexChen, "retired");
		const oneGone = (await events(owner, id)).cards[0]!;
		assert.deepEqual(labels(oneGone), ["Alex Rivera", "Okafor household"]);
		assert.equal(oneGone.result.withheldRows, 1);
		await setState(people.alexChen, "live");

		// Only the household deleted: both live people stay.
		await admin.execute(sql`UPDATE person SET household_id=NULL,household_role=NULL WHERE household_id=${home}`);
		await admin.execute(sql`DELETE FROM household WHERE id=${home}`);
		const homeGone = (await events(owner, id)).cards[0]!;
		assert.deepEqual(labels(homeGone), ["Alex Chen", "Alex Rivera"]);
		assert.equal(homeGone.result.withheldRows, 1);
	} finally {
		await setState(people.alexChen, "live");
		await removeHousehold(home);
	}
});

test("AC:EVRY-CONTEXT-BOUNDS the in-turn check withholds a mixed result by row and keeps the rest", async () => {
	const owner = await actor("owner");
	const home = await household("Okafor household", "North Ridgeville", [
		{ id: people.alexRivera, role: "head" },
		{ id: people.alexChen, role: "spouse" },
	]);
	try {
		await ask(owner, "show me the Okafor household");
		const run = script(
			[
				{ operation: "people.getHousehold", input: { householdId: home } },
				{ operation: "people.listTags", input: {} },
			],
			"Done.",
			{ 1: () => setState(people.alexChen, "retired") },
		);
		assert.equal(await work(run.model), "succeeded");
		assert.ok(run.prompts[1]!.includes("Alex Chen"), "before the removal the row is there");
		const later = run.prompts[2]!;
		assert.ok(!later.includes("Alex Chen") && later.includes("withheldRows"), "the removed person is withheld");
		assert.ok(
			later.includes("Alex Rivera") && later.includes("Okafor household"),
			"the household and the other member stay",
		);
	} finally {
		await setState(people.alexChen, "live");
		await removeHousehold(home);
	}
});

test("AC:EVRY-CONTEXT-BOUNDS every row kind the catalog returns is kept while its source exists; tags are withheld once gone", async () => {
	const owner = await actor("owner");
	const tag = randomUUID();
	await admin.execute(sql`INSERT INTO record(id,kind,tenant_id) VALUES(${tag},'tag',${plant}) ON CONFLICT DO NOTHING`);
	await admin.execute(
		sql`INSERT INTO tag(id,plant_id,name,normalized_name) VALUES(${tag},${plant},'Volunteers','volunteers')`,
	);
	const home = await household("Okafor household", "North Ridgeville");
	try {
		// Real reads through a turn, replayed: household, tag and file rows.
		const id = await ask(owner, "Tags and the template");
		const run = script(
			[
				{ operation: "people.listTags", input: {} },
				{ operation: "people.generateCsvTemplate", input: {} },
				{ operation: "people.listHouseholds", input: {} },
			],
			"Here they are.",
		);
		assert.equal(await work(run.model), "succeeded");
		const replay = await events(owner, id);
		assert.deepEqual(
			replay.cards.map((c) => [c.result.rows[0].kind, c.result.rows.length, c.result.withheldRows]),
			[
				["tag", 1, undefined],
				["file", 1, undefined],
				["household", 1, undefined],
			],
		);
		assert.ok(replay.texts.every((t) => t.withheld !== true));

		// Every kind in the one in-turn statement, including ids that are not uuids.
		const rows = [
			{ kind: "person", id: people.alexRivera },
			{ kind: "household", id: home },
			{ kind: "tag", id: tag },
			{ kind: "import", id: "3" },
			{ kind: "file", id: "export" },
			{ kind: "skill", id: randomUUID() },
			{ kind: "activity", id: randomUUID() },
		];
		const key = (r: { kind: string; id: string }) => `${r.kind}:${r.id}`;
		assert.deepEqual([...(await liveRowKeys(db, owner, rows))].sort(), rows.map(key).sort());

		await admin.execute(sql`DELETE FROM tag WHERE id=${tag}`);
		await removeHousehold(home);
		const gone = await liveRowKeys(db, owner, rows);
		assert.deepEqual(
			rows.filter((r) => !gone.has(key(r))).map((r) => r.kind),
			["household", "tag"],
		);
		const after = (await events(owner, id)).cards;
		assert.deepEqual([after[0]!.result.rows, after[0]!.result.withheldRows, after[2]!.result.withheldRows], [[], 1, 1]);
	} finally {
		await admin.execute(sql`DELETE FROM tag WHERE id=${tag}`);
	}
});

test("AC:EVRY-CONTEXT-BOUNDS an actor who lost access gets no row of any kind from the in-turn check", async () => {
	const owner = await actor("owner");
	const home = await household("Okafor household", "North Ridgeville");
	const rows = [
		{ kind: "household", id: home },
		{ kind: "person", id: people.alexRivera },
		{ kind: "file", id: "export" },
	];
	try {
		assert.equal((await liveRowKeys(db, owner, rows)).size, 3);
		await admin.execute(
			sql`UPDATE auth_session SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=${accounts.owner.session}`,
		);
		assert.equal((await liveRowKeys(db, owner, rows)).size, 0);
		// A member of another church cannot see this church's household either.
		assert.equal((await liveRowKeys(db, await actor("foreign"), rows.slice(0, 2))).size, 0);
	} finally {
		await admin.execute(
			sql`UPDATE auth_session SET expires_at=clock_timestamp()+interval '1 day' WHERE id=${accounts.owner.session}`,
		);
		await removeHousehold(home);
	}
});
