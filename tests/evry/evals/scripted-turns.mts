import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Database } from "../../../packages/db/src/client.ts";
import type { PrivateStorage } from "../../../packages/db/src/schema/storage.ts";
import { readViewer } from "../../../packages/domain/src/access/session.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { claimDue, finishClaim } from "../../../packages/domain/src/jobs/queue.ts";
import {
	approveProposal,
	createConversation,
	evryActor,
	executeProposal,
	readConversation,
	readReview,
	runTurn,
	submitTurn,
	type EvryActor,
	type NativePorts,
	type Proposal,
} from "../../../packages/evry/src/index.ts";
import { scriptedQualifiedModel } from "../../../packages/evry-scripted/src/index.ts";
import type { SourceResult } from "../../../packages/evry/src/catalog/types.ts";

const model = scriptedQualifiedModel();
const noPorts = {
	reminders: async () => undefined,
	phaseNotices: async () => {
		throw Error("unexpected phase notice");
	},
};

export function scriptedTurns(db: Database, native: NativePorts | null, storage: PrivateStorage | null = null) {
	const freshActor = async (session: string) => {
		const viewer = await readViewer(db, session as never);
		return viewer?.authority ? evryActor(viewer.authority) : null;
	};
	async function ask(actor: EvryActor, text: string) {
		const { id } = await createConversation(db, actor, { requestKey: randomUUID() });
		await submitTurn(db, actor, id, { requestKey: randomUUID(), text });
		const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
		assert.ok(claim, "the turn is queued");
		const lease = {
			turnId: claim.id,
			tenantId: claim.tenant_id,
			leaseOwner: claim.lease_owner,
			generation: claim.claim_generation,
		};
		const outcome = await runTurn({ db, model, freshActor, native, storage }, lease, {
			claimStart: new Date(),
			claimEnd: new Date(),
		});
		await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
		assert.equal(outcome, "succeeded", text);
		const { events, reviews } = await readConversation(db, actor, id);
		const results = events.flatMap((e) =>
			e.kind === "tool_result" && e.body.operation !== "evry.prepareProposal" ? [e.body.result as SourceResult] : [],
		);
		const proposals = Object.values(reviews).filter((p): p is Proposal => Boolean(p));
		return {
			answer: events
				.flatMap((e) => (e.kind === "assistant_text" && typeof e.body.text === "string" ? [e.body.text] : []))
				.join(""),
			results,
			reads: results.map((r) => r.operation),
			proposals,
			transcript: JSON.stringify(events),
		};
	}
	async function approve(actor: EvryActor, proposal: Proposal) {
		const witness = { revision: proposal.revision, digest: proposal.digest };
		await approveProposal(db, actor, proposal.id, witness, storage);
		await approveProposal(db, actor, proposal.id, witness, storage);
		const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
		assert.ok(claim, "the effect is queued");
		const lease = {
			jobId: claim.id,
			tenantId: claim.tenant_id,
			leaseOwner: claim.lease_owner,
			generation: claim.claim_generation,
		};
		const outcome = await executeProposal(db, lease, noPorts, null, native);
		const again = await executeProposal(db, lease, noPorts, null, native);
		assert.equal(again, "closed", "a retried effect does nothing more");
		await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
		return { outcome, review: await readReview(db, actor, proposal.id) };
	}
	return { ask, approve };
}
