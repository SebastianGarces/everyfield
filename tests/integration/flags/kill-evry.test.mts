import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	createConversation,
	readConversation,
	retryTurn,
	submitTurn,
	type EvryActor,
} from "../../../packages/evry/src/index.ts";
import { scriptedModel } from "../../../packages/evry/src/runtime/scripted.ts";
import { readSwitches, setFlag } from "../../../packages/domain/src/flags/index.ts";
import { runTurns } from "../../../apps/web/src/server/evry/worker.ts";
import { scheduledJobs } from "../../../apps/web/src/server/jobs/scheduled.ts";
import {
	accounts,
	actor,
	admin,
	counts,
	db,
	plant,
	queries,
	setup,
	sql,
	teardown,
} from "../../evry/runtime/support.mts";
import { setServerEnv } from "../../support/server-env.mts";
import { capturedLines, withSwitchOff } from "../../support/flags.mts";

setServerEnv();
const PAUSED = { flag: "evry-model-calls", operator: accounts.owner.id } as const;
let owner: EvryActor;

function countingModel() {
	const base = scriptedModel();
	const calls = { n: 0 };
	const model = {
		...base,
		doGenerate: (options: Parameters<typeof base.doGenerate>[0]) => (calls.n++, base.doGenerate(options)),
		doStream: (options: Parameters<typeof base.doStream>[0]) => (calls.n++, base.doStream(options)),
	};
	return { calls, select: () => ({ status: "qualified" as const, id: "counting", model }) };
}

const statementsOf = async (body: () => Promise<unknown>) => {
	const start = queries.length;
	const outcome = await body().then(
		() => "ok",
		(error: { code?: string }) => error.code ?? "threw",
	);
	return {
		outcome,
		statements: queries.slice(start).filter((q) => !/^(BEGIN|COMMIT|ROLLBACK)/i.test(q.trim())).length,
	};
};

const lastStatus = async (conversationId: string) =>
	(await readConversation(db, owner, conversationId)).events.filter((e) => e.kind === "status").at(-1)?.body as
		{ state: string; error?: { code: string }; text: string } | undefined;

before(async () => {
	await setup();
	owner = await actor("owner");
});
after(teardown);

test("with evry-model-calls off, a turn already queued ends with the paused code and no model call, and nothing else starts until it is back on", async () => {
	const c = await createConversation(db, owner, { requestKey: randomUUID() });
	await submitTurn(db, owner, c.id, { requestKey: randomUUID(), text: "How many people are in our church?" });
	const model = countingModel();
	type Measured = { outcome: string; statements: number };
	const seen: { refused: { create: Measured; submit: Measured; retry: Measured } | null } = { refused: null };

	await withSwitchOff(db, PAUSED, async () => {
		const switches = await readSwitches(db);
		const { value: ran, lines } = await capturedLines(() => runTurns(db, switches, 4, Infinity, model.select));
		assert.equal(ran, 1);
		assert.equal(model.calls.n, 0, "no model call for a claimed turn");
		assert.deepEqual(lines, [
			{ component: "kill-switch", switch: "evry-model-calls", action: "evry.runTurn", outcome: "refused" },
		]);
		const end = await lastStatus(c.id);
		assert.equal(end?.state, "failed");
		assert.equal(end?.error?.code, "model_paused");
		assert.equal(end?.text, "");
		const read = await readConversation(db, owner, c.id);
		assert.deepEqual(
			read.events.map((e) => e.kind),
			["user_message", "status"],
			"no partial assistant output is saved",
		);
		const [job] = (
			await admin.execute(sql`SELECT state FROM job WHERE kind='assistant_turn' AND subject_record_id=${c.id}::uuid`)
		).rows as { state: string }[];
		assert.equal(job?.state, "failed");

		const before = await counts();
		const attempt = await capturedLines(async () => ({
			create: await statementsOf(() => createConversation(db, owner, { requestKey: randomUUID() })),
			submit: await statementsOf(() =>
				submitTurn(db, owner, c.id, { requestKey: randomUUID(), text: "Who joined this month?" }),
			),
			retry: await statementsOf(() => retryTurn(db, owner, c.id, { requestKey: randomUUID() })),
		}));
		const refused = attempt.value;
		seen.refused = refused;
		assert.deepEqual(
			[refused.create.outcome, refused.submit.outcome, refused.retry.outcome],
			["model_paused", "model_paused", "model_paused"],
		);
		assert.deepEqual(await counts(), before, "no conversation, message, turn job or audit row is written");
		assert.deepEqual(
			attempt.lines.map((l) => l.action),
			["evry.createConversation", "evry.submitTurn", "evry.retryTurn"],
		);
		assert.equal(await runTurns(db, switches, 4, Infinity, model.select), 0, "no turn was queued");
		assert.equal(model.calls.n, 0);
	});

	const on = {
		create: await statementsOf(() => createConversation(db, owner, { requestKey: randomUUID() })),
		retry: await statementsOf(() => retryTurn(db, owner, c.id, { requestKey: randomUUID() })),
	};
	assert.deepEqual([on.create.outcome, on.retry.outcome], ["ok", "ok"], "back on, with no restart or deploy");
	const refused = seen.refused;
	assert.ok(refused);
	assert.ok(refused.create.statements <= on.create.statements, "a refused create sends no more statements");
	assert.ok(refused.retry.statements <= on.retry.statements, "a refused retry sends no more statements");
	assert.equal(refused.submit.statements, 1, "a refused message sends only the switch read");
	assert.equal(await runTurns(db, await readSwitches(db), 4, Infinity, model.select), 1);
	assert.ok(model.calls.n > 0, "the model answers once the switch is back on");
	assert.equal((await lastStatus(c.id))?.state, "completed");
});

test("a workspace override of evry-model-calls has no effect: the switch reads only its global value", async () => {
	const scope = { kind: "workspace", id: plant } as const;
	await setFlag(db, { flag: "evry-model-calls", scope, value: false, operator: accounts.owner.id });
	try {
		const c = await createConversation(db, owner, { requestKey: randomUUID() });
		const sent = await submitTurn(db, owner, c.id, { requestKey: randomUUID(), text: "Who joined this month?" });
		assert.equal(sent.replayed, false);
		const model = countingModel();
		assert.equal(await runTurns(db, await readSwitches(db), 4, Infinity, model.select), 1);
		assert.equal((await lastStatus(c.id))?.state, "completed");
	} finally {
		await setFlag(db, { flag: "evry-model-calls", scope, value: null, operator: accounts.owner.id });
	}
});

test("with evry-model-calls off, a cron run reads the switch once, leaves assessment jobs pending and never calls the drafter", async () => {
	const drafted = { n: 0 };
	const drafter = async () => {
		drafted.n++;
		throw Error("the drafter must not run while Evry is paused");
	};
	const tick = scheduledJobs({
		db,
		storage: null,
		cleanup: null,
		reminders: null,
		digests: null,
		mail: null,
		assessments: { drafter: drafter as never },
	});
	await admin.execute(sql`INSERT INTO job(tenant_id,kind,subject_record_id,producer_key,state,eligible_at,attempt_count,max_attempts,claim_generation)
		VALUES(${plant}::uuid,'assessment',${plant}::uuid,${"kill-switch/" + randomUUID()},'ready',clock_timestamp(),0,10,0)`);
	const touched = async () =>
		(
			await admin.execute(
				sql`SELECT count(*)::int AS n FROM job WHERE kind='assessment' AND (state<>'ready' OR attempt_count>0)`,
			)
		).rows[0]!.n as number;
	assert.equal(await touched(), 0);
	await withSwitchOff(db, PAUSED, async () => {
		const start = queries.length;
		const { value: response, lines } = await capturedLines(() => tick());
		const body = (await response.json()) as { steps: Record<string, { status: string }> };
		assert.equal(body.steps.assessment?.status, "paused");
		assert.equal(drafted.n, 0);
		assert.equal(await touched(), 0, "every assessment job stays pending with no attempt");
		assert.deepEqual(
			lines.filter((l) => l.component === "kill-switch"),
			[{ component: "kill-switch", switch: "evry-model-calls", action: "assessment", outcome: "refused" }],
		);
		const flagReads = queries.slice(start).filter((q) => /FROM feature_flag/.test(q)).length;
		assert.equal(flagReads, 1, "one switch read per cron run");
	});
});
