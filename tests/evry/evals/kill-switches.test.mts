import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createConversation, readConversation, runTurn, submitTurn } from "../../../packages/evry/src/index.ts";
import { readViewer } from "../../../packages/domain/src/access/session.ts";
import { evryActor, type QualifiedModel } from "../../../packages/evry/src/index.ts";
import { claimDue } from "../../../packages/domain/src/jobs/queue.ts";
import { EvryRefusal } from "../../../packages/evry/src/context/errors.ts";
import { readSwitches, setFlag, type KillSwitch } from "../../../packages/domain/src/flags/index.ts";
import { endNotice, sendNotice, type TurnEnd } from "../../../apps/web/src/features/evry/conversation/model.ts";
import { sql } from "../../../packages/db/src/query.ts";
import { goldenChurch, type GoldenChurch } from "./golden-church.mts";
import { converse, MAIL, recorder, type Turn } from "./golden-harness.mts";

type Case = {
	case_id: string;
	switch: KillSwitch;
	question: string;
	eval: { history?: Turn[]; require?: string[]; forbid?: string[]; proposals?: { operation: string; error: string }[] };
};
const cases: Case[] = JSON.parse(readFileSync(new URL("kill-switches.cases.json", import.meta.url), "utf8"));
const byId = (id: string) => cases.find((c) => c.case_id === id)!;
const recorded = recorder("kill-switches");
const pattern = (p: string) => {
	const m = /^\/(.*)\/([a-z]*)$/s.exec(p);
	return m ? new RegExp(m[1]!, m[2]) : new RegExp(p, "i");
};

let church: GoldenChurch;
before(async () => {
	church = await goldenChurch();
});
after(async () => {
	recorded.save();
	await church?.close();
});

async function off<T>(name: KillSwitch, body: () => Promise<T>): Promise<T> {
	const operator = church.actors.owner.accountId;
	await setFlag(church.db, { flag: name, scope: { kind: "global" }, value: false, operator });
	try {
		return await body();
	} finally {
		await setFlag(church.db, { flag: name, scope: { kind: "global" }, value: null, operator });
	}
}

test("KILL-01 with Evry's model calls off, a natural question gets the paused answer and Evry makes zero model calls", async () => {
	const c = byId("KILL-01");
	const owner = church.actors.owner;
	const keys: string[] = [];
	const modelFor = async (): Promise<QualifiedModel> =>
		(await readSwitches(church.db))["evry-model-calls"]
			? { status: "qualified", id: "recorded", model: recorded.model(keys) }
			: { status: "paused" };
	const freshActor = async (session: string) => {
		const viewer = await readViewer(church.db, session as never);
		return viewer?.authority ? evryActor(viewer.authority) : null;
	};
	const queued = await createConversation(church.db, owner, { requestKey: randomUUID() });
	await submitTurn(church.db, owner, queued.id, { requestKey: randomUUID(), text: c.question });
	await off(c.switch, async () => {
		const [claim] = await claimDue(church.db, ["assistant_turn"], 1, 240);
		assert.ok(claim);
		const lease = {
			turnId: claim.id,
			tenantId: claim.tenant_id,
			leaseOwner: claim.lease_owner,
			generation: claim.claim_generation,
		};
		assert.equal(await runTurn({ db: church.db, model: await modelFor(), freshActor }, lease), "failed");
		const end = (await readConversation(church.db, owner, queued.id)).events.find((e) => e.kind === "status");
		const notice = endNotice(end!.body as unknown as TurnEnd);
		assert.equal(notice?.title, "Evry is paused");
		assert.match(notice!.text, /stopped before it read or changed anything/);
		const refused = await submitTurn(church.db, owner, queued.id, { requestKey: randomUUID(), text: c.question }).catch(
			(error: unknown) => error,
		);
		assert.ok(refused instanceof EvryRefusal && refused.code === "model_paused");
		const shown = sendNotice({
			key: "k",
			text: c.question,
			references: [],
			state: "refused",
			error: { code: "model_paused", correlationId: randomUUID(), retry: "new_turn", outcome: "refused" },
			sequence: null,
		});
		assert.match(shown ?? "", /^Not sent\. Evry is paused for now, so nothing was saved\./);
	});
	assert.deepEqual(keys, [], "no model call, paid or recorded");
});

test("KILL-02 with outbound mail off, asking Evry to schedule an email gets an honest paused answer and nothing is sent", async () => {
	const c = byId("KILL-02");
	const sends: unknown[] = [];
	const answer = await off(c.switch, async () => {
		const paused = !(await readSwitches(church.db))["outbound-mail"];
		const mail = {
			...MAIL,
			transport: {
				...MAIL.transport,
				paused,
				send: async (batch: unknown) => (sends.push(batch), { outcome: "refused" as const }),
			},
		};
		return converse(church, "owner", c.question, c.eval.history ?? [], { recorded, mail });
	});
	const failures: string[] = [];
	for (const expected of c.eval.proposals ?? []) {
		const card = answer.proposals.find((p) => p.operation === expected.operation);
		if (!card)
			failures.push(`no ${expected.operation} proposal (${answer.proposals.map((p) => p.operation).join(", ")})`);
		else if (card.error !== expected.error || card.prepared)
			failures.push(`${expected.operation} was ${card.error ?? "prepared"}`);
	}
	if (answer.proposals.some((p) => p.prepared)) failures.push("a proposal was prepared");
	for (const p of c.eval.require ?? [])
		if (!pattern(p).test(answer.answer)) failures.push(`missing ${p}: ${answer.answer}`);
	for (const p of c.eval.forbid ?? [])
		if (pattern(p).test(answer.answer)) failures.push(`forbidden ${p}: ${answer.answer}`);
	assert.deepEqual(failures, []);
	assert.deepEqual(sends, [], "no send reached the email service");
	const proposals = await church.admin.execute(
		sql`SELECT count(*)::int AS n FROM proposal WHERE operation='communication.scheduleReviewed'`,
	);
	assert.equal((proposals.rows[0] as { n: number }).n, 0, "no schedule proposal row");
});
