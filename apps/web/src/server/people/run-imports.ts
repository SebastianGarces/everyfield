import "server-only";
import type { Database } from "@everyfield/db/client";
import { runPeopleImport } from "@everyfield/domain/people";
import { claimDue, finishClaim, recoverLease } from "../jobs/queue.ts";
import { transaction } from "../platform/database.ts";

/**
 * Runs due People CSV imports one at a time on the WP-031 queue. It first returns expired leases to the queue with the
 * shared recovery, so an import whose worker stopped resumes once its retry delay has passed.
 */
export async function runDueImports(pool: Database, limit = 4) {
	await recoverLease(pool);
	for (let n = 0; n < limit; n++) {
		const [claim] = await claimDue(pool, ["people_import"]);
		if (!claim) return;
		const outcome = await runPeopleImport(pool, claim);
		await transaction(pool, (tx) => finishClaim(tx, claim, { state: outcome === "lost" ? "failed" : "succeeded" }));
	}
}
