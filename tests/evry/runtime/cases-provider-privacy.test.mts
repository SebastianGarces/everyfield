import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { claimDue, finishJob } from "../../../packages/domain/src/jobs/queue.ts";
import { assessmentDrafter, evryModel } from "../../../apps/web/src/server/models.ts";
import { wikiEmbeddingMount } from "../../../apps/web/src/features/wiki/embedding.ts";
import { providerVerified } from "../../../packages/db/src/provider.ts";
import { search } from "../../../packages/domain/src/wiki/reads.ts";
import {
	approveProposal,
	cancelProposal,
	createConversation,
	flushTraces,
	LIMITS,
	listConversations,
	readConversation,
	readReview,
	retryTurn,
	REVIEW_MINUTES,
	runTurn,
	selectQualifiedModel,
	submitTurn,
} from "../../../packages/evry/src/index.ts";
import { paidAssessment } from "../../../packages/evry/src/runtime/assessment-model.ts";
import { registerTracing } from "../../../packages/evry/src/runtime/trace.ts";
import { wikiPassageEmbedder, wikiQueryEmbedder } from "../../../packages/reference/src/starter/verify/query.ts";
import { touched, untouched } from "../../support/recorded.mts";
import { NETWORK_LINE, seedWiki, wikiIds } from "../adapters/wiki/corpus.mts";
import { caseWorld, propose, read, reads, refusal, sql, type CaseWorld, type Church } from "./case-world.mts";
import {
	CHAT,
	classified,
	EMBEDDING,
	KEYED,
	neverCalled,
	PAID,
	PRODUCTION,
	RECORD,
	recorded,
	streamed,
	traceSink,
	UNVERIFIED,
	withEnv,
	withProvider,
	type Sent,
} from "./provider.mts";

type Case = {
	id: string;
	given: Record<string, Record<string, unknown>>;
	expected: { result: Record<string, unknown> };
};
const { cases } = JSON.parse(readFileSync(new URL("../../../docs/acceptance/evry.json", import.meta.url), "utf8")) as {
	cases: Case[];
};
const expectedOf = (id: string) => (cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`)).expected.result;

const ids = wikiIds(randomUUID);
let w: CaseWorld;
let c: Church;
let traces: Awaited<ReturnType<typeof traceSink>>;
before(async () => {
	traces = await traceSink();
	assert.ok(registerTracing(traces.env));
	w = await caseWorld("caseprovider");
	c = await w.church();
	await seedWiki((query) => w.admin.execute(query), c.P.id, ids);
	await w.admin.execute(
		sql`UPDATE reference_release SET embedding_profile='openai-text-embedding-3-small',embedding_dimensions=1536`,
	);
	await w.care(c.A);
});
after(async () => {
	traces?.close();
	await w?.close();
});

type Env = Record<string, string | undefined>;
async function processing(env: Env) {
	const model = await evryModel(env);
	return {
		chat: model.status === "qualified",
		gate: model.status === "unavailable" ? (model.releaseGate ?? null) : null,
		judge: paidAssessment(w.db, env) !== null,
		drafter: (await assessmentDrafter(w.db, env)) !== null,
		query: wikiQueryEmbedder(env) !== null,
		passage: wikiPassageEmbedder(env) !== null,
		mount: wikiEmbeddingMount(w.db, env) !== null,
	};
}
const BLOCKED = {
	chat: false,
	gate: "blocked",
	judge: false,
	drafter: false,
	query: false,
	passage: false,
	mount: false,
};
const VERIFIED = { chat: true, gate: null, judge: true, drafter: false, query: true, passage: true, mount: true };
const TESTING = { ...VERIFIED, drafter: true };

async function unanswered(text: string) {
	const conversation = await w.converse(c.Aa);
	await submitTurn(w.db, c.Aa, conversation, { requestKey: randomUUID(), text });
	assert.equal(await runQueued(PRODUCTION), "failed");
	return conversation;
}
const refusals = async (conversation: string, text: string) =>
	untouched(w.admin, async () => [
		await refusal(createConversation(w.db, c.Aa, { requestKey: randomUUID() })),
		await refusal(submitTurn(w.db, c.Aa, conversation, { requestKey: randomUUID(), text })),
		await refusal(retryTurn(w.db, c.Aa, conversation, { requestKey: randomUUID() })),
	]);
const REFUSED = ["evry_unavailable", "evry_unavailable", "evry_unavailable"];
async function runQueued(env: Env) {
	const [claim] = await claimDue(w.db, ["assistant_turn"], 1, 240);
	assert.ok(claim, "a turn is queued");
	const outcome = await runTurn(
		{ db: w.db, model: await evryModel(env), freshActor: async () => c.Aa },
		{ turnId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		{ claimStart: new Date(), claimEnd: new Date() },
	);
	await finishJob(w.db, claim, { state: outcome === "failed" ? "failed" : "succeeded" });
	return outcome;
}
const turnsOf = async (conversation: string) =>
	(await w.eventsOf(c.Aa, conversation)).events.filter((e) => e.kind === "status").map((e) => e.body);

test("AC:AI44-002 a claimed enrollment or claimed credits verify nothing; only the operator's record verifies the settings", async () => {
	const claims: Env[] = [
		PRODUCTION,
		{ ...PRODUCTION, AI_PROVIDER_RECORD: "" },
		{ ...PRODUCTION, AI_PROVIDER_RECORD: "enrolled" },
		{ ...PRODUCTION, AI_PROVIDER_ENROLLED: "1" },
		recorded({ user_says_enrolled: true, operator_receipt: null }),
		recorded({ ...RECORD, complimentaryCredits: true }),
	];
	for (const env of claims) {
		const settings_verified = providerVerified(env, CHAT) || providerVerified(env, EMBEDDING);
		const credits_verified = (await evryModel(env)).status === "qualified";
		assert.deepEqual({ settings_verified, credits_verified }, expectedOf("AI44-002"), JSON.stringify(env));
	}
	const said = "We are enrolled in the sharing program and have complimentary credits.";
	const before = await unanswered(said);
	await withEnv(PRODUCTION, async () => assert.deepEqual(await refusals(before, said), REFUSED));
	const env = recorded(RECORD);
	assert.deepEqual([providerVerified(env, CHAT), providerVerified(env, EMBEDDING)], [true, true]);
	assert.equal((await evryModel(env)).status, "qualified");
});

test("AC:AI44-003 synthetic input is answered in test deployments; real private input is refused in production at every model and embedding path, with no trace of it", async () => {
	for (const kind of [undefined, "development", "preview"])
		assert.deepEqual(await processing({ ...KEYED, VERCEL_ENV: kind }), TESTING, String(kind));
	traces.take();
	const asked = await withEnv({}, () => w.ask(c.A, "Synthetic: list the people", [reads("people.listPeople", {})]));
	assert.equal(asked.outcome, "succeeded");
	await flushTraces();
	assert.match(
		traces.take(),
		/Synthetic: list the people/,
		"a permitted turn is traced, so an absent trace means something",
	);

	const CANARY = "PRIVATE-PILOT-CANARY";
	const queued = await w.converse(c.Aa);
	await submitTurn(w.db, c.Aa, queued, { requestKey: randomUUID(), text: `${CANARY} struggling marriage` });
	for (const kind of ["production", "Production", "staging", ""]) {
		const env = { ...PRODUCTION, VERCEL_ENV: kind };
		assert.deepEqual(await processing(env), BLOCKED, kind);
		assert.deepEqual(await processing({ ...env, EVRY_SCRIPTED_MODEL: "1" }), BLOCKED, `${kind}, scripted`);
	}
	const { sent } = await withProvider(neverCalled, () =>
		withEnv(PRODUCTION, async () => {
			assert.deepEqual(await refusals(queued, CANARY), REFUSED);
			const found = await search(w.db, await w.authorityOf(c.A), { query: `vision meeting` });
			assert.equal(found.status, "ok", "search answers by words");
			assert.ok(JSON.stringify(found).includes(ids.vision.article));
			assert.equal(await runQueued(PRODUCTION), "failed", "the queued turn ends");
		}),
	);
	assert.deepEqual(sent, []);
	const ends = (await turnsOf(queued)) as { state: string; text: string; error: { code: string }; usage: object }[];
	assert.deepEqual(
		ends.map((e) => [e.state, e.text, e.error.code, e.usage]),
		[["failed", "", "evry_unavailable", { inputTokens: 0, outputTokens: 0, toolCalls: 0 }]],
	);
	assert.equal(await w.count(sql`SELECT count(*) AS n FROM model_spend`), 0);
	await flushTraces();
	const traced = traces.take();
	assert.equal(traced.includes(CANARY), false, "no trace of the private message");
	const real_private_input_allowed =
		Object.values(await processing(PRODUCTION)).some((v) => v === true) || sent.length > 0;
	assert.deepEqual(
		{ permitted_input: asked.status.state === "completed", real_private_input_allowed },
		expectedOf("AI44-003"),
	);
});

test("AC:AI44-004 one church's data is not processed in production while sharing is on or any setting is unverified; the valid record is the control", async () => {
	for (const [name, record] of UNVERIFIED) {
		const p = await processing(recorded(record));
		assert.deepEqual([p.chat, p.gate, p.judge, p.drafter], [false, "blocked", false, false], name);
	}
	assert.deepEqual(await processing(recorded({ ...RECORD, paths: [CHAT] })), {
		...VERIFIED,
		query: false,
		passage: false,
		mount: false,
	});
	assert.deepEqual(await processing(recorded({ ...RECORD, paths: [EMBEDDING] })), {
		...VERIFIED,
		chat: false,
		gate: "blocked",
		judge: false,
	});
	const env = recorded({ ...RECORD, programSharing: "on", zeroDataRetention: "unverified" });
	assert.equal(await w.count(sql`SELECT count(*) AS n FROM plant WHERE id=${c.P.id}`), 1);
	const conversation = await unanswered("Who visited?");
	const { sent } = await withProvider(neverCalled, () =>
		withEnv(env, async () => assert.deepEqual(await refusals(conversation, "Who visited?"), REFUSED)),
	);
	const now = await processing(env);
	assert.deepEqual(now, BLOCKED);
	assert.deepEqual(
		{ AI_processing_allowed: now.chat || sent.length > 0, release_gate: now.gate },
		expectedOf("AI44-004"),
	);
	assert.deepEqual(await processing(recorded(RECORD)), VERIFIED);
});

test("AC:AI44-005 without verified zero data retention inference is blocked while the synthetic evaluation still runs", async () => {
	const { zeroDataRetention: _, ...unstated } = RECORD;
	for (const record of [
		unstated,
		{ ...RECORD, zeroDataRetention: "unverified" },
		{ ...RECORD, zeroDataRetention: true },
	]) {
		const env = recorded(record);
		const conversation = await w.converse(c.Aa);
		await submitTurn(w.db, c.Aa, conversation, { requestKey: randomUUID(), text: "Paid church data" });
		const { sent } = await withProvider(neverCalled, () => withEnv(env, () => runQueued(env)));
		const [end] = (await turnsOf(conversation)) as { error: { code: string } }[];
		assert.equal(end?.error.code, "evry_unavailable");
		const synthetic = await w.ask(c.A, "Synthetic evaluation", [reads("people.listPeople", {})]);
		assert.deepEqual(
			{
				inference_allowed: sent.length > 0 || (await processing(env)).chat,
				synthetic_evaluation_allowed: synthetic.outcome === "succeeded" && synthetic.cards.length === 1,
				release_gate: (await processing(env)).gate,
			},
			expectedOf("AI44-005"),
		);
	}
	assert.deepEqual((await processing(recorded(RECORD))).chat, true);
});

test("AC:AI44-006 private care and a revoked source reach no model request, tool result, embedding request or trace, and the request keeps no provider state", async () => {
	const selected = selectQualifiedModel(PAID);
	assert.equal(selected.status, "qualified");
	const model = selected.status === "qualified" ? selected.model : assert.fail();
	let n = 0;
	type Plan = Parameters<typeof streamed>[0];
	const turn = async (text: string, steps: (Plan | (() => Promise<Plan>))[], conversation?: string) => {
		const left = [...steps];
		const run = await withProvider(
			async ({ url, body }: Sent) => {
				if (url === EMBEDDING.endpoint)
					return Response.json({
						data: (body.input as string[]).map((_, index) => ({
							index,
							embedding: Array.from({ length: 1536 }, (__, at) => (at === 0 ? 1 : 0)),
						})),
						usage: { total_tokens: 3 },
					});
				assert.equal(url, CHAT.endpoint);
				if (!body.stream) return classified();
				const next = left.shift() ?? "Done.";
				return streamed(typeof next === "function" ? await next() : next, ++n);
			},
			() => withEnv(KEYED, () => w.ask(c.A, text, [], { model, ...(conversation && { conversation }) })),
		);
		const { value: asked } = run;
		assert.equal(asked.outcome, "succeeded", JSON.stringify(asked.status));
		await flushTraces();
		return { asked, sent: run.sent, trace: traces.take() };
	};
	const linked = (ended: boolean) =>
		w.admin.execute(
			sql`UPDATE affiliation SET ended_at=${ended ? sql`clock_timestamp()` : sql`NULL`} WHERE id=${ids.affiliation}`,
		);
	const find = read("wiki.search", { query: "vision meeting" });
	const body = read("wiki.referenceExcerpt", { articleId: ids.vision.article });
	const people = read("people.listPeople", {});
	const chats = (sent: Sent[]) => sent.filter((s) => s.url === CHAT.endpoint).map((s) => s.body);
	const everything = (t: Awaited<ReturnType<typeof turn>>) =>
		JSON.stringify([t.sent, t.asked.cards, t.asked.saved, t.trace]);

	traces.take();
	try {
		const open = await turn("Search the Wiki for the vision meeting", [[find, body], "Read it."]);
		assert.ok(JSON.stringify(open.sent).includes(NETWORK_LINE), "S1 is read while it is shared");
		assert.ok(open.trace.includes(NETWORK_LINE), "and traced");
		assert.deepEqual(
			open.sent.filter((s) => s.url === EMBEDDING.endpoint).map((s) => s.body.input),
			[["vision meeting"]],
		);
		const [, , second] = chats(open.sent);
		assert.ok(JSON.stringify(second!.input).includes("SEALED-1"), "reasoning is carried by the application");
		const revokedMidTurn = await turn("Search the Wiki for the vision meeting", [
			[find, body],
			async () => {
				await linked(true);
				return [people];
			},
			"Read it.",
		]);
		const last = JSON.stringify(chats(revokedMidTurn.sent).at(-1));
		assert.equal(last.includes(NETWORK_LINE), false, "revoked mid-turn, S1 leaves the next request");
		assert.equal(/SEALED-/.test(last), false, "with the reasoning that could hold it");

		const closed = await turn("And what does it say now?", [[find, body, people], "Done."], open.asked.conversation);
		for (const t of [open, revokedMidTurn, closed]) {
			for (const b of chats(t.sent)) {
				assert.equal(b.store, false);
				assert.equal("previous_response_id" in b || "conversation" in b, false);
				assert.equal(JSON.stringify(b).includes("item_reference"), false);
			}
			assert.doesNotMatch(everything(t), /CARE-CANARY|struggling/);
		}
		const history = JSON.stringify(chats(closed.sent).find((b) => b.stream)!.input);
		assert.ok(history.includes("Search the Wiki for the vision meeting"), "the earlier message is sent from our rows");

		const env = { ...PRODUCTION, OPENAI_STORE: "false", AI_PROVIDER_RECORD: JSON.stringify({ store: false }) };
		const found = (text: string, secret: string) => (text.includes(secret) ? secret : null);
		const requests = JSON.stringify([open, revokedMidTurn, closed].map((t) => [t.sent, t.asked.cards]));
		assert.deepEqual(
			{
				private_care_in_model: found(requests, "CARE-CANARY"),
				private_care_in_trace: found([open, revokedMidTurn, closed].map((t) => t.trace).join(), "CARE-CANARY"),
				S1_body: found(everything(closed), NETWORK_LINE),
				store_false_proves_ZDR: (await processing(env)).chat || providerVerified(env, CHAT),
				history_owner: history.includes("Search the Wiki for the vision meeting") ? "application" : "provider",
			},
			expectedOf("AI44-006"),
		);
	} finally {
		await linked(false);
	}
});

test("while production Evry is off, past conversations are read and prepared reviews are approved or cancelled", async () => {
	const one = await w.prepare(c.A, "people.updatePerson", { personId: c.chen, patch: { city: "Evanston" } });
	const two = await w.prepare(c.A, "people.updatePerson", { personId: c.casey, patch: { city: "Cicero" } });
	await withEnv(PRODUCTION, async () => {
		assert.ok((await listConversations(w.db, c.Aa, {})).total > 0);
		assert.ok((await readConversation(w.db, c.Aa, c.C)).events.length > 0);
		assert.equal((await w.approve(c.A, one)).review.outcome, "completed");
		await cancelProposal(w.db, c.Aa, two.id);
		assert.equal((await readReview(w.db, c.Aa, two.id)).status, "cancelled");
	});
	assert.deepEqual(
		(await w.rows(sql`SELECT city FROM person WHERE id IN(${c.chen},${c.casey}) ORDER BY city`)).map(
			(r) => r.city !== "Cicero",
		),
		[true, true],
	);
});

test("AC:AI44-007 an unapproved review saves nothing, before and after it expires, within the configured limits; no record or copy claims a user-approved retention", async () => {
	assert.deepEqual(
		[
			REVIEW_MINUTES,
			LIMITS.reviewCards,
			LIMITS.toolCalls,
			LIMITS.inputTokens,
			LIMITS.outputTokens,
			LIMITS.contextTokens,
		],
		[15, 10, 24, 128_000, 16_000, 32_000],
	);
	const cities = () => w.rows(sql`SELECT id,city,revision FROM person ORDER BY id`);
	const effects = () => w.count(sql`SELECT count(*) AS n FROM job WHERE kind='evry_effect'`);
	const before = await cities();
	const effectsBefore = await effects();
	const conversation = await w.converse(c.Aa);
	const call = propose("people.updatePerson", { personId: c.casey, patch: { city: "Skokie" } });
	const { value: asked, tables } = await touched(w.admin, () =>
		w.ask(c.A, "Move Casey to Skokie", [...Array.from({ length: 11 }, () => () => call)], {
			conversation,
			onError: "go_on",
		}),
	);
	assert.equal(asked.proposals.length, LIMITS.reviewCards, "the eleventh review is refused");
	assert.equal(asked.replies.at(-1)?.error, "review_limit");
	const OWN = new Set(["audit_event", "conversation", "conversation_event", "job", "record", "proposal"]);
	assert.deepEqual(
		tables.filter((t) => !OWN.has(t)),
		[],
	);
	const [review] = asked.proposals;
	assert.ok(review);
	const { created, expires, exact } = await w.one<{ created: string; expires: string; exact: boolean }>(
		sql`SELECT created_at::text AS created,expires_at::text AS expires,
			expires_at-created_at=make_interval(mins=>${REVIEW_MINUTES}) AS exact FROM proposal WHERE id=${review.id}`,
	);
	assert.equal(exact, true, `expires_at ${expires} is not exactly ${REVIEW_MINUTES} minutes after ${created}`);
	assert.equal(Date.parse(expires) - Date.parse(created), REVIEW_MINUTES * 60_000);
	assert.equal(await w.effect(), null);
	await w.at(new Date(Date.parse(expires) + 1).toISOString());
	const told = await refusal(approveProposal(w.db, c.Aa, review.id, w.witness(review), null));
	assert.equal(told, "review_expired");
	assert.equal(await w.effect(), null);
	const durable_effects =
		Number(JSON.stringify(await cities()) !== JSON.stringify(before)) + (await effects()) - effectsBefore;
	const env = recorded({ ...RECORD, userApprovedRetentionDays: 30 });
	const COPY = [
		"../../../design/marketing-copy.json",
		"../../../apps/web/src/features/evry/conversation/EvryPanel.tsx",
	];
	const claim =
		/(?:audit|telemetry|trace|log)s?\b[^.]{0,80}\b(?:30|thirty)[ -]days?|\b(?:30|thirty)[ -]days?[^.]{0,80}\b(?:audit|telemetry|trace|log)s?\b/i;
	const copy = COPY.map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
	assert.deepEqual(
		{ durable_effects, user_approved_30day_retention: providerVerified(env, CHAT) || claim.test(copy) },
		expectedOf("AI44-007"),
	);
});
