import "server-only";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import {
	deleteUnreferencedObject,
	StorageError,
	type PrivateStorage,
	type ResourceAuthorizer,
} from "@everyfield/db/schema";
import { claimDue, finishJob, recoverLease, type JobResult } from "./queue.ts";

const cleanable =
	(tenant: string): ResourceAuthorizer =>
	async (tx, file) => {
		if (file.tenant_id !== tenant) return null;
		if (file.purpose === "person_photo") {
			const held = await tx.execute(sql`SELECT 1 FROM person WHERE photo_object_id=${file.id}::uuid
				UNION ALL SELECT 1 FROM person_merge WHERE tenant_id=${tenant}::uuid AND unmerged_at IS NULL
				AND prior->'survivor'->>'photo_object_id'=${file.id}`);
			if (held.rows.length) return null;
		}
		return { kind: "system", cause: "object_cleanup" };
	};

export async function runDueObjectCleanup(db: Database, storage: PrivateStorage, limit: number, until = Infinity) {
	await recoverLease(db);
	let removed = 0;
	for (let n = 0; n < limit && Date.now() < until; n++) {
		const [claim] = await claimDue(db, ["object_cleanup"]);
		if (!claim) break;
		const fileId = claim.subject_record_id;
		const outcome = fileId
			? await deleteUnreferencedObject(db, storage, cleanable(claim.tenant_id), fileId).catch((error: unknown) => {
					if (error instanceof StorageError && error.code === "unavailable") return { status: "kept" as const };
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
		await finishJob(db, claim, result);
	}
	return removed;
}
