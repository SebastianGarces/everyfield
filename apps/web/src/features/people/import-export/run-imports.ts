import "server-only";
import type { Database } from "@everyfield/db/client";
import { runPeopleImport } from "@everyfield/domain/people";
import { claimDue, finishJob, recoverLease } from "../../../server/jobs/queue.ts";
import { logFailure } from "@everyfield/domain/log";

export async function runDueImports(pool: Database, limit = 4, until = Infinity) {
	await recoverLease(pool);
	for (let n = 0; n < limit && Date.now() < until; n++) {
		const [claim] = await claimDue(pool, ["people_import"]);
		if (!claim) return;
		const outcome = await runPeopleImport(pool, claim).catch((error: unknown) => {
			logFailure({ component: "people-import", outcome: "retry" }, error);
			return "retry" as const;
		});
		await finishJob(
			pool,
			claim,
			outcome === "retry"
				? { state: "retry_wait", code: "import_interrupted" }
				: { state: outcome === "lost" ? "failed" : "succeeded" },
		);
	}
}
