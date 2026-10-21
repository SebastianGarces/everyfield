import "server-only";
import { runPeopleImport } from "@everyfield/domain/people";
import { after } from "next/server";
import { claimDue, finishClaim } from "../jobs/queue";
import { transaction } from "../platform/database";
import { requestDatabase } from "../database";

/**
 * After the response, claims due People CSV imports on the WP-031 queue and runs them one at a time. The import and
 * receipt routes call it, so a job a crash left behind runs again once its lease is recovered.
 */
export function drainPeopleImports() {
	after(async () => {
		const pool = requestDatabase();
		if (!pool) return;
		for (let n = 0; n < 4; n++) {
			const [claim] = await claimDue(pool, ["people_import"]);
			if (!claim) return;
			const outcome = await runPeopleImport(pool, claim);
			await transaction(pool, (tx) => finishClaim(tx, claim, { state: outcome === "lost" ? "failed" : "succeeded" }));
		}
	});
}
