import "server-only";
import type { Database } from "@everyfield/db/client";
import { deleteUnreferencedObject, type PrivateStorage } from "@everyfield/db/schema";
import { transaction } from "../platform/database.ts";
import { claimDue, finishClaim, recoverLease, type JobResult } from "./queue.ts";

/**
 * Runs due object_cleanup jobs one at a time. Each job names one private file. The file's bytes are deleted only when no
 * record references it; a referenced, missing or already purged file has nothing to delete. A provider failure leaves
 * the claimed file for the retry, which deletes the same immutable key.
 */
export async function runDueObjectCleanup(db: Database, storage: PrivateStorage, limit: number) {
	await recoverLease(db);
	let removed = 0;
	for (let n = 0; n < limit; n++) {
		const [claim] = await claimDue(db, ["object_cleanup"]);
		if (!claim) break;
		const fileId = claim.subject_record_id;
		const outcome = fileId
			? await deleteUnreferencedObject(
					db,
					storage,
					async (_tx, file) =>
						file.tenant_id === claim.tenant_id ? { kind: "system", cause: "object_cleanup" } : null,
					fileId,
				).catch((error: unknown) => {
					if (error instanceof Error && error.message === "unavailable") return { status: "kept" as const };
					throw error;
				})
			: { status: "kept" as const };
		const result: JobResult =
			outcome.status === "inaccessible"
				? { state: "succeeded" }
				: outcome.status === "kept"
					? { state: "superseded", code: "nothing_to_delete" }
					: { state: "retry_wait", code: "provider_unknown" };
		if (outcome.status === "inaccessible") removed++;
		await transaction(db, (tx) => finishClaim(tx, claim, result));
	}
	return removed;
}
