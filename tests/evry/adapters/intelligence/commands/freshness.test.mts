import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	approveProposal,
	createConversation,
	evryActor,
	executeProposal,
	prepareProposal,
	submitTurn,
} from "../../../../../packages/evry/src/index.ts";
import { scriptedAssessmentDrafter } from "../../../../../packages/evry-scripted/src/scripted-assessment.ts";
import { transaction } from "../../../../../packages/domain/src/jobs/transaction.ts";
import { claimDue, finishClaim } from "../../../../../packages/domain/src/jobs/queue.ts";
import {
	createAssessmentJob,
	createAssessments,
	createFacts,
	runAssessmentBatch,
} from "../../../../../packages/domain/src/intelligence/index.ts";
import { ok } from "../../../../support/fixture.mts";
import { church, type Church } from "../../../../integration/intelligence/assessment-church.mts";

let c: Church;
const assessments = createAssessments();
const facts = createFacts();

before(async () => {
	c = await church("t625e");
	await c.release("methodology-2026.11");
});
after(() => c?.database.close());

test("INV-freshness: a commitment Evry records after approval marks the assessment out of date, and its review card alone does not", async () => {
	const p = await c.harvest("Evry Writes");
	const newcomer = await c.person(p, "Evry Newcomer");
	ok(await assessments.requestRefresh(c.db, p.actor, { requestId: randomUUID() }));
	await runAssessmentBatch(createAssessmentJob(), c.db, scriptedAssessmentDrafter(), 5);
	const current = async () => ok(await assessments.readAssessment(c.db, p.actor, {})).current!;
	const run = await current();
	const outOfDate = async () => ok(await facts.readFactsSinceRun(c.db, p.actor, {})).outOfDateRunId;
	assert.equal(await outOfDate(), null);

	const who = evryActor(p.actor);
	assert.ok(who);
	const conversation = await createConversation(c.db, who, { requestKey: randomUUID() });
	await submitTurn(c.db, who, conversation.id, { requestKey: randomUUID(), text: "hold this turn" });
	const [turn] = await claimDue(c.db, ["assistant_turn"], 1, 240);
	assert.ok(turn);
	const proposal = await prepareProposal(
		c.db,
		who,
		{
			turnId: turn.id,
			tenantId: turn.tenant_id,
			leaseOwner: turn.lease_owner,
			generation: turn.claim_generation,
		},
		conversation.id,
		{
			operation: "people.createCommitment",
			input: { personId: newcomer.id, kind: "core_group", occurredOn: c.day(-1) },
		},
	);
	assert.ok(proposal);
	assert.equal(await outOfDate(), null, "a review card is not a change");

	await approveProposal(c.db, who, proposal.id, { revision: proposal.revision, digest: proposal.digest }, null);
	const [effect] = await claimDue(c.db, ["evry_effect"], 1, 60);
	assert.ok(effect);
	const outcome = await executeProposal(
		c.db,
		{
			jobId: effect.id,
			tenantId: effect.tenant_id,
			leaseOwner: effect.lease_owner,
			generation: effect.claim_generation,
		},
		{
			reminders: async () => {
				throw Error("unexpected task reminder replan");
			},
			phaseNotices: async () => undefined,
		},
	);
	await transaction(c.db, (tx) => finishClaim(tx, effect, { state: "succeeded" }));
	assert.equal(outcome, "completed");
	assert.equal(await outOfDate(), run.runId);
	assert.deepEqual(await current(), run, "the assessment stays readable as it was");
});
