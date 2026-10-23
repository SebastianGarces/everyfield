import type { Database } from "@everyfield/db/client";
import type { TaskReminders } from "@everyfield/domain/tasks";
import { readViewer } from "@everyfield/domain/access";
import { sessionId } from "@everyfield/contracts/common";
import {
	CLAIM_SECONDS,
	evryActor,
	executeProposal,
	flushTraces,
	runTurn,
	selectQualifiedModel,
} from "@everyfield/evry";
import "server-only";
import { claimDue, finishClaim } from "../jobs/queue.ts";
import { transaction } from "../platform/database.ts";

// The Evry workers on the WP-031 queue. The request drains (index.ts) and the scheduled runner (jobs/scheduled.ts)
// both run them. A job older than CLAIM_SECONDS is never claimed: Evry already reports it lost, and the scheduled
// runner closes it (closeLostJobs).

const LEASE_SECONDS = 240; // above the 180-second turn wall time
const EFFECT_LEASE_SECONDS = 60;

/**
 * Claims due turns and runs them one at a time while the deadline allows another start. The turns' traces are exported
 * last, after every turn saved its end. Returns how many turns ran.
 */
export async function runTurns(pool: Database, limit: number, until = Infinity) {
	const model = selectQualifiedModel();
	// The current authority of a turn's session, read again from the database before every read the turn makes.
	const freshActor = async (session: string) => {
		const parsed = sessionId.safeParse(session);
		const viewer = parsed.success ? await readViewer(pool, parsed.data) : null;
		return viewer?.authority ? evryActor(viewer.authority) : null;
	};
	let ran = 0;
	try {
		for (; ran < limit && Date.now() < until; ran++) {
			const claimStart = new Date();
			const [claim] = await claimDue(pool, ["assistant_turn"], 1, LEASE_SECONDS, CLAIM_SECONDS);
			if (!claim) break;
			const outcome = await runTurn(
				{ db: pool, model, freshActor },
				{
					turnId: claim.id,
					tenantId: claim.tenant_id,
					leaseOwner: claim.lease_owner,
					generation: claim.claim_generation,
				},
				{ claimStart, claimEnd: new Date() },
			);
			if (outcome !== "lost")
				await transaction(pool, (tx) =>
					finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }),
				);
		}
	} finally {
		await flushTraces();
	}
	return ran;
}

/**
 * Claims approved Evry effects and runs each once. The executor saves the outcome with the change; the claim then
 * ends. A People command that hands tasks on replans their reminders through `reminders`. Returns how many ran.
 */
export async function runEffects(pool: Database, reminders: TaskReminders, limit: number) {
	let ran = 0;
	for (; ran < limit; ran++) {
		const [claim] = await claimDue(pool, ["evry_effect"], 1, EFFECT_LEASE_SECONDS, CLAIM_SECONDS);
		if (!claim) break;
		const outcome = await executeProposal(
			pool,
			{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
			reminders,
		);
		if (outcome !== "lost")
			await transaction(pool, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	}
	return ran;
}
