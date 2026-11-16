import "server-only";
import type { Database } from "@everyfield/db/client";
import { runPeopleImport } from "@everyfield/domain/people";
import { claimDue, finishJob, recoverLease } from "../jobs/queue.ts";
import { z } from "zod";

export async function runDueImports(pool: Database, limit = 4, until = Infinity) {
	await recoverLease(pool);
	for (let n = 0; n < limit && Date.now() < until; n++) {
		const [claim] = await claimDue(pool, ["people_import"]);
		if (!claim) return;
		const outcome = await runPeopleImport(pool, claim).catch((error: unknown) => {
			const code = z.object({ cause: z.object({ code: z.string() }) }).safeParse(error).data?.cause.code ?? null;
			console.error(JSON.stringify({ component: "people-import", outcome: "retry", code }));
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
