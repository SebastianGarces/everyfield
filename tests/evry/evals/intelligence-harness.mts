// One Evry turn and one approval as the app runs them, for the Plant Intelligence and oversight suites (T-331): the
// turn is submitted, claimed from the queue and run on the scripted model with the real catalog, reads and review
// cards; an approval runs its effect once through the WP-031 queue. Returns what the turn read, said and proposed, and
// every tool result the model was given, so a case can prove what never reached it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Database } from "../../../packages/db/src/client.ts";
import { readViewer } from "../../../packages/domain/src/access/session.ts";
import {
	approveProposal,
	createConversation,
	evryActor,
	executeProposal,
	readConversation,
	runTurn,
	selectQualifiedModel,
	submitTurn,
	type EvryActor,
	type NativePorts,
	type Proposal,
} from "../../../packages/evry/src/index.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { claimDue, finishClaim } from "../../../packages/domain/src/jobs/queue.ts";

type Change = { field: string; before: unknown; after: unknown };
type Case = {
	id: string;
	operation?: string;
	criterion: number | number[];
	golden?: string;
	setup?: string;
	actor: string;
	ask: string;
	calls: string[];
	answer: string[];
	absent?: string[];
	proposal?: { operation: string; target: string; changes?: Change[] };
	approve?: true;
};
export const loadCases = (file: string) =>
	(JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")) as { cases: Case[] }).cases;

export function harness(db: Database, today: Date, native: NativePorts | null = null) {
	const model = selectQualifiedModel({ EVRY_SCRIPTED_MODEL: "1" });
	// The host clock in the database clock's frame, as the prompt states it (deps.now).
	const shift = today.getTime() - Date.now();
	const now = () => new Date(Date.now() + shift);
	const freshActor = async (session: string) => {
		const viewer = await readViewer(db, session as never);
		return viewer?.authority ? evryActor(viewer.authority) : null;
	};
	async function ask(actor: EvryActor, text: string) {
		const conversationId = (await createConversation(db, actor, { requestKey: randomUUID() })).id;
		await submitTurn(db, actor, conversationId, { requestKey: randomUUID(), text, references: [] });
		const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
		assert.ok(claim, "the turn is queued");
		const outcome = await runTurn(
			{ db, model, freshActor, native, now },
			{
				turnId: claim.id,
				tenantId: claim.tenant_id,
				leaseOwner: claim.lease_owner,
				generation: claim.claim_generation,
			},
			{ claimStart: new Date(), claimEnd: new Date() },
		);
		await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
		assert.equal(outcome, "succeeded", text);
		// Every event of the conversation, page by page.
		let read = await readConversation(db, actor, conversationId);
		const events = [...read.events];
		for (let page = read; page.events.length;) {
			page = await readConversation(db, actor, conversationId, page.events.at(-1)!.sequence);
			events.push(...page.events);
			read = { ...page, reviews: { ...read.reviews, ...page.reviews } };
		}
		const turn = events.slice(events.findLastIndex((e) => e.kind === "user_message") + 1);
		const results = turn.filter((e) => e.kind === "tool_result");
		const reads = results.flatMap((e) =>
			typeof e.body.operation === "string" && e.body.operation !== "evry.prepareProposal" ? [e.body.operation] : [],
		);
		const answer = turn
			.flatMap((e) => (e.kind === "assistant_text" && typeof e.body.text === "string" ? [e.body.text] : []))
			.join("");
		const ids = results.flatMap((e) =>
			typeof (e.body.result as { proposalId?: unknown })?.proposalId === "string"
				? [(e.body.result as { proposalId: string }).proposalId]
				: [],
		);
		const proposals = ids.map((id) => read.reviews[id]).filter((p): p is Proposal => Boolean(p));
		return { reads, answer, proposals, results: JSON.stringify(results.map((e) => e.body)) };
	}
	async function approveAndRun(actor: EvryActor, proposal: Proposal) {
		await approveProposal(db, actor, proposal.id, { revision: proposal.revision, digest: proposal.digest }, null);
		const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
		assert.ok(claim, "the effect is queued");
		const outcome = await executeProposal(
			db,
			{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
			{ reminders: async () => undefined as never, phaseNotices: async () => undefined },
			null,
			native,
		);
		await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
		return outcome;
	}
	return { ask, approveAndRun, freshActor };
}

/** The hard checks every case makes: the reads in order, each answer line, nothing absent, the card as given. */
export function checkCase(
	c: Case,
	got: { reads: string[]; answer: string; proposals: Proposal[] },
	fill: (s: string) => string = (s) => s,
) {
	assert.deepEqual(got.reads, c.calls, `${c.id} reads`);
	for (const line of c.answer)
		assert.ok(got.answer.includes(fill(line)), `${c.id} says ${fill(line)}\n---\n${got.answer}`);
	for (const word of c.absent ?? [])
		assert.ok(
			!got.answer.toLowerCase().includes(fill(word).toLowerCase()),
			`${c.id} never says ${word}\n${got.answer}`,
		);
	if (!c.proposal) {
		assert.equal(got.proposals.length, 0, `${c.id} prepares no card`);
		return null;
	}
	assert.equal(got.proposals.length, 1, `${c.id} prepares one card`);
	const p = got.proposals[0]!;
	assert.equal(p.operation, c.proposal.operation, c.id);
	assert.equal(p.review.target?.label ?? null, c.proposal.target === "null" ? null : fill(c.proposal.target), c.id);
	if (c.proposal.changes)
		assert.deepEqual(p.review.changes, JSON.parse(fill(JSON.stringify(c.proposal.changes))), c.id);
	assert.equal(p.review.refusal, undefined, `${c.id} card can be approved`);
	return p;
}
