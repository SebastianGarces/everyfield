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
	type MailPort,
	selectQualifiedModel,
} from "@everyfield/evry";
import "server-only";
import { deliveryTransport, mailReady } from "../mail/transport.ts";
import { claimDue, finishJob } from "@everyfield/domain/jobs";
import { evryNative } from "./native.ts";

export function evryMail(): MailPort | null {
	const ready = mailReady();
	return ready ? { transport: deliveryTransport(ready), keys: ready.keys } : null;
}

const LEASE_SECONDS = 240;
const EFFECT_LEASE_SECONDS = 60;

export async function runTurns(pool: Database, limit: number, until = Infinity) {
	const model = selectQualifiedModel();
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
				{ db: pool, model, freshActor, mail: evryMail(), native: evryNative() },
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

export async function runEffects(pool: Database, reminders: TaskReminders, limit: number, until = Infinity) {
	let ran = 0;
	for (; ran < limit && Date.now() < until; ran++) {
		const [claim] = await claimDue(pool, ["evry_effect"], 1, EFFECT_LEASE_SECONDS, CLAIM_SECONDS);
		if (!claim) break;
		const outcome = await executeProposal(
			pool,
			{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
			reminders,
			evryMail(),
			evryNative(),
		);
		if (outcome !== "lost") await finishJob(pool, claim, { state: outcome === "failed" ? "failed" : "succeeded" });
	}
	return ran;
}
