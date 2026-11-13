import "server-only";
import { deletionSubject } from "@everyfield/contracts/settings/native";
import type { Database } from "@everyfield/db/client";
import { and, eq, ne } from "@everyfield/db/query";
import { deleteUnreferencedObject, type PrivateStorage } from "@everyfield/db/schema";
import * as t from "@everyfield/db/tables";
import { createLifecycleCleanup, Refusal, type DeletionRequest } from "@everyfield/domain/settings";
import {
	claimDue,
	DEFAULT_LEASE_SECONDS,
	finishJob,
	lockClaim,
	recoverLease,
	type Claim,
	type JobResult,
} from "./queue.ts";

/** File removal stops this long before the claim's lease ends, so the purge records its outcome while it holds the job. */
const LEASE_MARGIN_MS = 60_000;

/**
 * The exact request a claimed purge job names: the job's own witness and revision, read with the witness's current
 * request. Null when the witness is gone, belongs to another subject, has moved to a newer request or is no longer being
 * deleted (cancelled, or active again): that job is superseded.
 */
async function requestOf(db: Database, claim: Claim): Promise<DeletionRequest | null> {
	if (!claim.subject_record_id || !claim.source_revision) return null;
	const [w] = await db
		.select({
			kind: t.lifecycle_witness.kind,
			subject: t.lifecycle_witness.opaque_subject_id,
			requestId: t.lifecycle_witness.request_id,
			revision: t.lifecycle_witness.request_revision,
			state: t.lifecycle_witness.state,
		})
		.from(t.lifecycle_witness)
		.where(eq(t.lifecycle_witness.id, claim.subject_record_id));
	if (
		!w?.requestId ||
		w.subject !== claim.tenant_id ||
		w.revision !== claim.source_revision ||
		!["pending_deletion", "purging", "purged"].includes(w.state)
	)
		return null;
	const subject = deletionSubject.safeParse({ kind: w.kind, id: w.subject });
	return subject.success ? { subject: subject.data, requestId: w.requestId, revision: w.revision } : null;
}

/**
 * Deletes the private bytes of every file the subject owns, while its request is the one being purged. True only when
 * the provider confirmed every removal; a timeout, an unknown answer, a file still referenced or the lease running out
 * leaves the rest for the job's retry, which deletes the same immutable keys.
 */
async function removeFiles(cleanup: Database, storage: PrivateStorage, input: DeletionRequest, deadline: number) {
	const files = await cleanup
		.select({ id: t.file_object.id })
		.from(t.file_object)
		.where(and(eq(t.file_object.tenant_id, input.subject.id), ne(t.file_object.state, "purged")));
	let confirmed = true;
	for (const file of files) {
		if (Date.now() >= deadline) return false;
		const outcome = await deleteUnreferencedObject(
			cleanup,
			storage,
			async (tx, identity) => {
				if (identity.tenant_id !== input.subject.id) return null;
				const [w] = await tx
					.select({ id: t.lifecycle_witness.id })
					.from(t.lifecycle_witness)
					.where(
						and(
							eq(t.lifecycle_witness.kind, input.subject.kind),
							eq(t.lifecycle_witness.opaque_subject_id, input.subject.id),
							eq(t.lifecycle_witness.request_id, input.requestId),
							eq(t.lifecycle_witness.request_revision, input.revision),
							eq(t.lifecycle_witness.state, "purging"),
						),
					);
				return w ? { kind: "system", cause: "object_cleanup" } : null;
			},
			file.id,
		).catch(() => ({ status: "unknown" as const }));
		if (outcome.status !== "inaccessible") confirmed = false;
	}
	return confirmed;
}

/** One claimed purge job, to its result. No error text is kept: it can carry row values. */
async function purge(db: Database, cleanup: Database, storage: PrivateStorage, claim: Claim): Promise<JobResult> {
	const input = await requestOf(db, claim);
	if (!input) return { state: "superseded", code: "not_current" };
	const deadline = Date.now() + DEFAULT_LEASE_SECONDS * 1000 - LEASE_MARGIN_MS;
	const run = createLifecycleCleanup(cleanup, {
		// Every step runs only while this claim still holds the job: a lost lease stops the purge before it writes.
		authorize: (tx) => lockClaim(tx, claim),
		removeOwnedResources: (request) => removeFiles(cleanup, storage, request, deadline),
	});
	try {
		const done = await run(input);
		return done.status === "purged" ? { state: "succeeded" } : { state: "retry_wait", code: "removal_unconfirmed" };
	} catch (error) {
		if (error instanceof Refusal && (error.code === "conflict" || error.code === "deadline_passed"))
			return { state: "superseded", code: error.code };
		return { state: "retry_wait", code: "purge_unavailable" };
	}
}

/**
 * Runs due lifecycle_purge jobs one at a time (REQ-IDN-032). Each job completes the exact deletion request it was queued
 * for, once its cancellation deadline has passed: pending_deletion, then purging (hidden), then purged once the provider
 * confirmed every file removal. The purge runs on the cleanup login; the job itself stays on the job login. Returns the
 * number of subjects purged.
 */
export async function runDuePurges(
	db: Database,
	cleanup: Database,
	storage: PrivateStorage,
	limit: number,
	until = Infinity,
) {
	await recoverLease(db);
	let purged = 0;
	for (let n = 0; n < limit && Date.now() < until; n++) {
		const [claim] = await claimDue(db, ["lifecycle_purge"]);
		if (!claim) break;
		const result = await purge(db, cleanup, storage, claim);
		if ((await finishJob(db, claim, result)) && result.state === "succeeded") purged++;
	}
	return purged;
}
