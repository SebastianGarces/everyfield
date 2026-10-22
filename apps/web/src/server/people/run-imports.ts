import "server-only";
import type { Database } from "@everyfield/db/client";
import { runPeopleImport } from "@everyfield/domain/people";
import { claimDue, finishClaim, recoverLease } from "../jobs/queue.ts";
import { transaction } from "../platform/database.ts";
import { z } from "zod";

/**
 * Runs due People CSV imports one at a time on the WP-031 queue. It first returns expired leases to the queue with the
 * shared recovery, so an import whose worker stopped resumes once its retry delay has passed. A run that fails for a
 * reason that is not a row's own waits for the queue's retry delay with its rows still remaining.
 */
export async function runDueImports(pool: Database, limit = 4) {
	await recoverLease(pool);
	for (let n = 0; n < limit; n++) {
		const [claim] = await claimDue(pool, ["people_import"]);
		if (!claim) return;
		const outcome = await runPeopleImport(pool, claim).catch((error: unknown) => {
			// The SQLSTATE only: the error text carries the rows' values.
			const code = z.object({ cause: z.object({ code: z.string() }) }).safeParse(error).data?.cause.code ?? null;
			console.error(JSON.stringify({ component: "people-import", outcome: "retry", code }));
			return "retry" as const;
		});
		await transaction(pool, (tx) =>
			finishClaim(
				tx,
				claim,
				outcome === "retry"
					? { state: "retry_wait", code: "import_interrupted" }
					: { state: outcome === "lost" ? "failed" : "succeeded" },
			),
		);
	}
}
