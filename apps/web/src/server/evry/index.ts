import "server-only";
import { EvryRefusal, evryActor, projectError, runTurn, selectQualifiedModel, type EvryActor } from "@everyfield/evry";
import { readViewer } from "@everyfield/domain/access";
import { sessionId } from "@everyfield/contracts/common";
import { after } from "next/server";
import { claimDue, finishClaim } from "../jobs/queue";
import { transaction } from "../platform/database";
import { privateHeaders } from "../platform/boundary";
import { requestDatabase } from "../database";
import { getViewer } from "../request-context";

// The thin web door to the Evry kernel: one cached viewer per request (D60), the shared pool, sanitized errors and
// the turn worker on the WP-031 queue. Domain behavior lives in @everyfield/evry.

function db() {
	const pool = requestDatabase();
	if (!pool) throw new EvryRefusal("unknown");
	return pool;
}

/** The request's verified conversation owner, or access_denied. */
export async function requestActor(): Promise<EvryActor> {
	const viewer = await getViewer();
	if (!viewer || viewer.status !== "active" || !viewer.authority) throw new EvryRefusal("access_denied");
	return evryActor(viewer.authority);
}

const status = { not_found: 404, access_denied: 403, invalid_input: 400, run_active: 409 } as const;
/** Runs one Evry operation and answers JSON; every failure leaves as a projected error only. */
export async function evryResponse(
	body: (db: ReturnType<typeof requestDatabase> & object, actor: EvryActor) => Promise<unknown>,
) {
	try {
		const value = await body(db(), await requestActor());
		return Response.json(value, { headers: privateHeaders });
	} catch (error) {
		const projected = projectError(error);
		return Response.json(
			{ error: projected },
			{ status: status[projected.code as keyof typeof status] ?? 503, headers: privateHeaders },
		);
	}
}

/** The current authority of a turn's session, read again from the database before every read the turn makes. */
async function freshActor(session: string) {
	const parsed = sessionId.safeParse(session);
	const viewer = parsed.success ? await readViewer(db(), parsed.data) : null;
	return viewer?.authority ? evryActor(viewer.authority) : null;
}

const LEASE_SECONDS = 240; // above the 180-second turn wall time

/** After the response, claims due turns through the WP-031 queue and runs them one at a time. */
export function drainTurns() {
	after(async () => {
		const pool = db();
		const model = selectQualifiedModel();
		for (let n = 0; n < 4; n++) {
			const [claim] = await claimDue(pool, ["assistant_turn"], 1, LEASE_SECONDS);
			if (!claim) return;
			const outcome = await runTurn(
				{ db: pool, model, freshActor },
				{
					turnId: claim.id,
					tenantId: claim.tenant_id,
					leaseOwner: claim.lease_owner,
					generation: claim.claim_generation,
				},
			);
			if (outcome !== "lost")
				await transaction(pool, (tx) =>
					finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }),
				);
		}
	});
}
