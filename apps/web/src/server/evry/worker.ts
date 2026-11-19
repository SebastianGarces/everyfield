import type { Database } from "@everyfield/db/client";
import type { TaskReminders } from "@everyfield/domain/tasks";
import { readViewer } from "@everyfield/domain/access";
import { sessionId } from "@everyfield/contracts/common";
import { switchedOff, type Switches } from "@everyfield/domain/flags";
import {
	CLAIM_SECONDS,
	evryActor,
	executeProposal,
	flushTraces,
	runTurn,
	type MailPort,
	type QualifiedModel,
	selectQualifiedModel,
} from "@everyfield/evry";
import "server-only";
import { deliveryTransport, mailReady } from "../mail/transport.ts";
import { claimDue, finishJob } from "../jobs/queue.ts";
import { evryNative } from "./native.ts";

export function evryMail(paused: boolean): MailPort | null {
	const ready = mailReady();
	return ready ? { transport: deliveryTransport(ready, fetch, { paused }), keys: ready.keys } : null;
}

const LEASE_SECONDS = 240;
const EFFECT_LEASE_SECONDS = 60;

export async function runTurns(
	pool: Database,
	switches: Switches,
	limit: number,
	until = Infinity,
	select: () => QualifiedModel = selectQualifiedModel,
) {
	const model: QualifiedModel = switches["evry-model-calls"] ? select() : { status: "paused" };
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
			switchedOff(switches, "evry-model-calls", "evry.runTurn");
			const outcome = await runTurn(
				{ db: pool, model, freshActor, mail: evryMail(!switches["outbound-mail"]), native: evryNative() },
				{
					turnId: claim.id,
					tenantId: claim.tenant_id,
					leaseOwner: claim.lease_owner,
					generation: claim.claim_generation,
				},
				{ claimStart, claimEnd: new Date() },
			);
			if (outcome !== "lost") await finishJob(pool, claim, { state: outcome === "failed" ? "failed" : "succeeded" });
		}
	} finally {
		await flushTraces();
	}
	return ran;
}

export async function runEffects(
	pool: Database,
	switches: Switches,
	reminders: TaskReminders,
	limit: number,
	until = Infinity,
) {
	let ran = 0;
	for (; ran < limit && Date.now() < until; ran++) {
		const [claim] = await claimDue(pool, ["evry_effect"], 1, EFFECT_LEASE_SECONDS, CLAIM_SECONDS);
		if (!claim) break;
		const outcome = await executeProposal(
			pool,
			{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
			reminders,
			evryMail(!switches["outbound-mail"]),
			evryNative(),
		);
		if (outcome !== "lost") await finishJob(pool, claim, { state: outcome === "failed" ? "failed" : "succeeded" });
	}
	return ran;
}
