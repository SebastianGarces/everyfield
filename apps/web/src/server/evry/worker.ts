import type { Database } from "@everyfield/db/client";
import { readViewer } from "@everyfield/domain/access";
import { sessionId } from "@everyfield/contracts/common";
import { switchedOff, type Switches } from "@everyfield/domain/flags";
import { privateStorage } from "@everyfield/db/schema";
import {
	CLAIM_SECONDS,
	type EffectPorts,
	evryActor,
	executeProposal,
	flushTraces,
	runTurn,
	type MailPort,
	type QualifiedModel,
} from "@everyfield/evry";
import "server-only";
import { deliveryTransport, mailReady } from "../mail/transport.ts";
import { claimDue, finishJob } from "@everyfield/domain/jobs";
import { evryNative } from "./native.ts";
import { evryModel } from "../models.ts";

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
	select: () => QualifiedModel | Promise<QualifiedModel> = evryModel,
) {
	const model: QualifiedModel = switches["evry-model-calls"] ? await select() : { status: "paused" };
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
				{
					db: pool,
					model,
					freshActor,
					mail: evryMail(!switches["outbound-mail"]),
					storage: privateStorage(),
					native: evryNative(),
				},
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
	ports: EffectPorts,
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
			ports,
			evryMail(!switches["outbound-mail"]),
			evryNative(),
		);
		if (outcome !== "lost") await finishJob(pool, claim, { state: outcome === "failed" ? "failed" : "succeeded" });
	}
	return ran;
}
