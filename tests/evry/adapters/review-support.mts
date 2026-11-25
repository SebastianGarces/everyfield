import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Database } from "../../../packages/db/src/client.ts";
import { readViewer } from "../../../packages/domain/src/access/session.ts";
import { claimDue, finishClaim } from "../../../packages/domain/src/jobs/queue.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import {
	approveProposal,
	createConversation,
	evryActor,
	executeProposal,
	prepareProposal,
	readReview,
	submitTurn,
	type EvryActor,
	type NativePorts,
	type Proposal,
} from "../../../packages/evry/src/index.ts";

export function reviews(db: Database, native: NativePorts | null = null) {
	async function actorOf(session: string): Promise<EvryActor> {
		const viewer = await readViewer(db, session as never);
		assert.ok(viewer?.authority, "a live session");
		return evryActor(viewer.authority);
	}
	async function prepare(actor: EvryActor, operation: string, input: unknown): Promise<Proposal> {
		const c = await createConversation(db, actor, { requestKey: randomUUID() });
		await submitTurn(db, actor, c.id, { requestKey: randomUUID(), text: "hold this turn", references: [] });
		const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
		assert.ok(claim, "the turn is queued");
		try {
			const lease = {
				turnId: claim.id,
				tenantId: claim.tenant_id,
				leaseOwner: claim.lease_owner,
				generation: claim.claim_generation,
			};
			const proposal = await prepareProposal(db, actor, lease, c.id, { operation, input }, null, native);
			assert.ok(proposal, `${operation} prepares a review`);
			assert.equal(proposal.status, "pending");
			return proposal;
		} finally {
			await transaction(db, (tx) => finishClaim(tx, claim, { state: "failed" }));
		}
	}
	const witness = (p: Proposal) => ({ revision: p.revision, digest: p.digest });
	async function approve(actor: EvryActor, proposal: Proposal): Promise<Proposal> {
		await approveProposal(db, actor, proposal.id, witness(proposal), null);
		const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
		if (claim) {
			const outcome = await executeProposal(
				db,
				{
					jobId: claim.id,
					tenantId: claim.tenant_id,
					leaseOwner: claim.lease_owner,
					generation: claim.claim_generation,
				},
				{ reminders: async () => undefined as never, phaseNotices: async () => undefined },
				null,
				native,
			);
			await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
		}
		return readReview(db, actor, proposal.id);
	}
	async function replayed(actor: EvryActor, proposal: Proposal) {
		return (await approveProposal(db, actor, proposal.id, witness(proposal), null)).replayed;
	}
	const refusedCard = async (actor: EvryActor, operation: string, input: unknown, text: string) => {
		const p = await prepare(actor, operation, input);
		assert.equal(p.review.refusal, text);
		await assert.rejects(approve(actor, p), { code: "review_closed" });
	};
	const refuses = (actor: EvryActor, operation: string, input: unknown, code: string) =>
		assert.rejects(prepare(actor, operation, input), { code }, `${operation} ${JSON.stringify(input)}`);
	return { actorOf, prepare, approve, replayed, refusedCard, refuses };
}

export const completed = (p: Proposal) => assert.equal(p.outcome, "completed", JSON.stringify(p.receipt));
export const refusedAs = (p: Proposal, code: string) =>
	assert.deepEqual([p.outcome, p.receipt?.code], ["refused", code], JSON.stringify(p.receipt));
