import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
	LanguageModelV4,
	LanguageModelV4CallOptions,
} from "../../../packages/evry/node_modules/@ai-sdk/provider/dist/index.js";
import {
	createConversation,
	listConversations,
	readConversation,
	retryTurn,
	submitTurn,
	type EvryActor,
} from "../../../packages/evry/src/index.ts";
import { scriptedModel } from "../../../packages/evry-scripted/src/index.ts";
import { actor, admin, counts, db, freshActor, setup, sql, teardown, work } from "./support.mts";

before(setup);
after(teardown);

const LIMIT_COPY =
	"You've reached today's Evry questions. They'll be back tomorrow. Everything else in Discovery stays open.";
const price = { input: 0.1, output: 0.5, longContextAbove: 272_000 };

const refused = async (body: () => Promise<unknown>, code: string) =>
	assert.rejects(body, (e: { code?: string }) => {
		assert.equal(e.code, code);
		return true;
	});

function paid() {
	const seen: LanguageModelV4CallOptions[] = [];
	const base = scriptedModel();
	const model: LanguageModelV4 = {
		...base,
		doStream: (o) => (seen.push(o), base.doStream(o)),
		doGenerate: (o) => (seen.push(o), base.doGenerate(o)),
	};
	return {
		calls: () => seen.length,
		model: { status: "qualified" as const, id: "test", model, spend: { price, capMicroUsd: 1_000_000_000 } },
	};
}

async function withLimit<T>(value: string | undefined, body: () => Promise<T>) {
	const saved = process.env.EVRY_DISCOVERY_DAILY_QUESTIONS;
	if (value === undefined) delete process.env.EVRY_DISCOVERY_DAILY_QUESTIONS;
	else process.env.EVRY_DISCOVERY_DAILY_QUESTIONS = value;
	try {
		return await body();
	} finally {
		if (saved === undefined) delete process.env.EVRY_DISCOVERY_DAILY_QUESTIONS;
		else process.env.EVRY_DISCOVERY_DAILY_QUESTIONS = saved;
	}
}

async function discoveryAccount(timezone: string | null = null) {
	const [id, user, session] = [randomUUID(), randomUUID(), randomUUID()];
	await admin.execute(
		sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${user},${id + "@example.test"},true,'Planter')`,
	);
	await admin.execute(
		sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind,personal_timezone) VALUES(${id},${user},'active','discovery',${timezone})`,
	);
	await admin.execute(
		sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${session},${user},${randomUUID()},clock_timestamp()+interval '1 day')`,
	);
	await admin.execute(sql`INSERT INTO discovery(account_id) VALUES(${id})`);
	const as = (await freshActor(session))!;
	assert.equal(as.discovery, true);
	return { id, as };
}

const today = (accountId: string) =>
	sql`(SELECT (clock_timestamp() AT TIME ZONE coalesce(a.personal_timezone,'UTC'))::date FROM account a WHERE a.id=${accountId})`;
const askedToday = async (accountId: string) =>
	Number(
		(
			await admin.execute(
				sql`SELECT coalesce((SELECT questions FROM evry_question_day WHERE account_id=${accountId} AND day=${today(accountId)}),0) n`,
			)
		).rows[0]!.n,
	);
const haveAsked = (accountId: string, n: number) =>
	admin.execute(sql`INSERT INTO evry_question_day(account_id,day,questions) VALUES(${accountId},${today(accountId)},${n})
		ON CONFLICT (account_id,day) DO UPDATE SET questions=EXCLUDED.questions`);
const spend = async () =>
	(await admin.execute(sql`SELECT month::text,charged_micro_usd::text FROM model_spend ORDER BY month`)).rows;

async function ask(as: EvryActor, conversationId: string, text: string) {
	return submitTurn(db, as, conversationId, { requestKey: randomUUID(), text });
}
async function lastStatus(as: EvryActor, conversationId: string) {
	const read = await readConversation(db, as, conversationId);
	return read.events.filter((e) => e.kind === "status").at(-1)?.body;
}

test("INV-discovery-question-limit: the 30th question of the day gets a normal answer, the 31st gets the limit message with no model call, no spend and no count", async () => {
	await withLimit(undefined, async () => {
		const planter = await discoveryAccount();
		const chat = await createConversation(db, planter.as, { requestKey: randomUUID() });
		await haveAsked(planter.id, 29);

		const thirtieth = paid();
		await ask(planter.as, chat.id, "Show me how to start a church budget.");
		assert.equal(await work(thirtieth.model), "succeeded");
		assert.ok(thirtieth.calls() > 0, "the 30th question reached the model");
		assert.equal((await lastStatus(planter.as, chat.id))?.state, "completed");
		assert.equal(await askedToday(planter.id), 30);

		const before = { counts: await counts(), spend: await spend() };
		const next = paid();
		await refused(() => ask(planter.as, chat.id, "One more question"), "question_limit");
		await refused(() => createConversation(db, planter.as, { requestKey: randomUUID() }), "question_limit");
		assert.equal(await work(next.model), null, "no turn was queued");
		assert.equal(next.calls(), 0, "no model call");
		assert.deepEqual(await spend(), before.spend, "no spend reserved");
		assert.deepEqual(await counts(), before.counts, "nothing was saved");
		assert.equal(await askedToday(planter.id), 30);

		const read = await readConversation(db, planter.as, chat.id);
		assert.ok(
			read.events.some((e) => e.kind === "status"),
			"the earlier conversation still reads",
		);
		assert.ok((await listConversations(db, planter.as, {})).items.some((c) => c.id === chat.id));
	});
});

test("INV-discovery-question-limit: two questions sent at once as the 30th, in one chat or two, get exactly one answer and one limit refusal", async () => {
	await withLimit(undefined, async () => {
		const planter = await discoveryAccount();
		const one = await createConversation(db, planter.as, { requestKey: randomUUID() });
		const two = await createConversation(db, planter.as, { requestKey: randomUUID() });
		await haveAsked(planter.id, 29);
		const sent = await Promise.allSettled([ask(planter.as, one.id, "First"), ask(planter.as, two.id, "Second")]);
		assert.equal(sent.filter((s) => s.status === "fulfilled").length, 1);
		const lost = sent.find((s) => s.status === "rejected");
		assert.equal((lost as PromiseRejectedResult).reason.code, "question_limit");
		assert.equal(await askedToday(planter.id), 30);
		assert.equal(await work(), "succeeded");
		assert.equal(await work(), null, "only one turn was queued");

		const again = await discoveryAccount();
		const chat = await createConversation(db, again.as, { requestKey: randomUUID() });
		await haveAsked(again.id, 29);
		const same = await Promise.allSettled([ask(again.as, chat.id, "A"), ask(again.as, chat.id, "B")]);
		assert.equal(same.filter((s) => s.status === "fulfilled").length, 1);
		assert.equal((same.find((s) => s.status === "rejected") as PromiseRejectedResult).reason.code, "question_limit");
		assert.equal(await askedToday(again.id), 30);
		assert.equal(await work(), "succeeded");

		const busy = await discoveryAccount();
		const running = await createConversation(db, busy.as, { requestKey: randomUUID() });
		await ask(busy.as, running.id, "Still answering");
		await refused(() => ask(busy.as, running.id, "Sent while Evry answers"), "run_active");
		assert.equal(await askedToday(busy.id), 1, "a message refused for another reason gives its question back");
		assert.equal(await work(), "succeeded");
	});
});

test("INV-discovery-question-limit: a replay and a retry do not count; a new conversation's first question counts", async () => {
	await withLimit("2", async () => {
		const planter = await discoveryAccount();
		const chat = await createConversation(db, planter.as, { requestKey: randomUUID() });
		const first = { requestKey: randomUUID(), text: "What is a launch team?" };
		const sent = await submitTurn(db, planter.as, chat.id, first);
		assert.deepEqual(await submitTurn(db, planter.as, chat.id, first), { ...sent, replayed: true });
		assert.equal(await askedToday(planter.id), 1, "the replay did not count");
		assert.equal(await work(), "succeeded");
		await admin.execute(sql`UPDATE conversation_event SET body=jsonb_set(body,'{state}','"failed"')
			WHERE conversation_id=${chat.id} AND kind='status'`);
		await retryTurn(db, planter.as, chat.id, { requestKey: randomUUID() });
		assert.equal(await work(), "succeeded");
		assert.equal(await askedToday(planter.id), 1, "the retry did not count");

		const fresh = await createConversation(db, planter.as, { requestKey: randomUUID() });
		await ask(planter.as, fresh.id, "How do I find a meeting place?");
		assert.equal(await work(), "succeeded");
		assert.equal(await askedToday(planter.id), 2);
		await refused(() => ask(planter.as, fresh.id, "And a third?"), "question_limit");
		assert.equal(await askedToday(planter.id), 2);
	});
});

test("INV-discovery-question-limit: the setting changes the limit with no code change; at 2 the third question is refused", async () => {
	await withLimit("2", async () => {
		const planter = await discoveryAccount();
		const chat = await createConversation(db, planter.as, { requestKey: randomUUID() });
		for (const text of ["One", "Two"]) {
			await ask(planter.as, chat.id, text);
			assert.equal(await work(), "succeeded");
		}
		await refused(() => ask(planter.as, chat.id, "Three"), "question_limit");
		assert.equal(await askedToday(planter.id), 2);
	});
	await withLimit("0", async () => {
		const planter = await discoveryAccount();
		await refused(() => createConversation(db, planter.as, { requestKey: randomUUID() }), "question_limit");
	});
});

test("INV-discovery-question-limit: a limit reached yesterday by the database clock is gone today, in the account's own time zone", async () => {
	await withLimit(undefined, async () => {
		const planter = await discoveryAccount("Pacific/Kiritimati");
		const chat = await createConversation(db, planter.as, { requestKey: randomUUID() });
		await haveAsked(planter.id, 30);
		await refused(() => ask(planter.as, chat.id, "Still today?"), "question_limit");
		await admin.execute(sql`UPDATE evry_question_day SET day=day-1 WHERE account_id=${planter.id}`);
		await ask(planter.as, chat.id, "A new day");
		assert.equal(await work(), "succeeded");
		assert.equal((await lastStatus(planter.as, chat.id))?.state, "completed");
		const days = await admin.execute(sql`SELECT questions,day=${today(planter.id)} AS today,
			day=(clock_timestamp() AT TIME ZONE 'Pacific/Kiritimati')::date AS local FROM evry_question_day WHERE account_id=${planter.id} ORDER BY day`);
		assert.deepEqual(days.rows, [
			{ questions: 30, today: false, local: false },
			{ questions: 1, today: true, local: true },
		]);
	});
});

test("INV-discovery-question-limit: a church conversation is never refused or counted, whatever the limit", async () => {
	await withLimit("1", async () => {
		const owner = await actor("owner");
		const chat = await createConversation(db, owner, { requestKey: randomUUID() });
		for (const text of ["One", "Two", "Three"]) {
			await ask(owner, chat.id, text);
			assert.equal(await work(), "succeeded");
		}
		const rows = await admin.execute(sql`SELECT FROM evry_question_day WHERE account_id=${owner.accountId}`);
		assert.equal(rows.rows.length, 0);
	});
});

test("INV-discovery-question-limit: the documented usage query shows questions and estimated cost per account and day", async () => {
	await withLimit(undefined, async () => {
		const planter = await discoveryAccount();
		const chat = await createConversation(db, planter.as, { requestKey: randomUUID() });
		for (const text of ["Budget basics", "Finding a core team"]) {
			await ask(planter.as, chat.id, text);
			assert.equal(await work(paid().model), "succeeded");
		}
		const read = await readConversation(db, planter.as, chat.id);
		const charged = read.events
			.filter((e) => e.kind === "status")
			.reduce((n, e) => n + Number((e.body.usage as { costMicroUsd?: number }).costMicroUsd ?? 0), 0);
		assert.ok(charged > 0);

		const runbook = await readFile(new URL("../../../docs/runbooks/evry-discovery-usage.md", import.meta.url), "utf8");
		const query = /```sql\n([\s\S]+?)```/.exec(runbook)?.[1];
		assert.ok(query, "the runbook holds one sql block");
		const rows = (await admin.execute(sql.raw(query))).rows.filter((r) => r.account_id === planter.id);
		assert.equal(rows.length, 1);
		assert.equal(Number(rows[0]!.questions), 2);
		assert.equal(Number(rows[0]!.estimated_cost_usd), charged / 1_000_000);
	});
});
