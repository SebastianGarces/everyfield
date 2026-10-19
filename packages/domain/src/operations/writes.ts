import "server-only";
import { randomUUID } from "node:crypto";
import type { Transaction } from "@everyfield/db/client";
import { sql, type SQLWrapper } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import type { RequestIdentity } from "@everyfield/contracts/common";

/** The unique request row serializes retries, including an initially absent key. */
export async function claimOperation(
	tx: Transaction,
	name: typeof t.operation.$inferInsert.name,
	request: RequestIdentity,
) {
	const id = randomUUID();
	const [row] = await tx
		.insert(t.operation)
		.values({
			id,
			tenant_id: request.owner.id,
			actor_id: request.actorId,
			name,
			request_key: request.requestKey,
			request_digest: request.digest,
			review_id: request.origin.kind === "assistant" ? request.origin.reviewId : null,
			conversation_id: request.origin.kind === "assistant" ? request.origin.conversationId : null,
			state: "running",
			started_at: sql`clock_timestamp()`,
			tool_calls: 0,
			reserved_input: 0,
			reserved_output: 0,
			used_input: 0,
			used_output: 0,
		})
		.onConflictDoUpdate({
			target: [t.operation.tenant_id, t.operation.request_key],
			set: { request_key: sql`${t.operation.request_key}` },
		})
		.returning({
			id: t.operation.id,
			actor: t.operation.actor_id,
			name: t.operation.name,
			digest: t.operation.request_digest,
		});
	if (!row) throw Error("operation_unavailable");
	if (row.actor !== request.actorId || row.name !== name || row.digest !== request.digest)
		return { kind: "conflict" as const, id: row.id };
	return row.id === id ? { kind: "new" as const, id } : { kind: "replay" as const, id: row.id };
}

/** Independent writes share one statement; callers must not update the same row twice. */
export async function executeWrites(tx: Transaction, writes: readonly SQLWrapper[]): Promise<void> {
	if (!writes.length) return;
	await tx.execute(
		sql`WITH ${sql.join(
			writes.map((q, i) => sql`${sql.identifier("write_" + i)} AS (${q.getSQL()} RETURNING 1)`),
			sql`, `,
		)} SELECT 1`,
	);
}
