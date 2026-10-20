import "server-only";
import { z } from "zod";
import { writeVisibility } from "../access/session.ts";
import { randomUUID } from "node:crypto";
import type { PgInsertValue } from "@everyfield/db/columns";
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

	const result = await tx.execute(sql`INSERT INTO operation
  (id,tenant_id,actor_id,name,request_key,request_digest,review_id,conversation_id,state,started_at,
   tool_calls,reserved_input,reserved_output,used_input,used_output)
  SELECT ${id}::uuid,${request.owner.id}::uuid,${request.actorId}::uuid,${name},${request.requestKey},${request.digest},
   ${request.origin.kind === "assistant" ? request.origin.reviewId : null}::uuid,
   ${request.origin.kind === "assistant" ? request.origin.conversationId : null}::uuid,'running',clock_timestamp(),0,0,0,0,0
  WHERE ${writeVisibility(request.actorId, request.owner)}
  AND (${request.origin.kind !== "assistant"} OR EXISTS (SELECT 1 FROM review r WHERE r.id=${request.origin.kind === "assistant" ? request.origin.reviewId : null}::uuid AND r.tenant_id=${request.owner.id}::uuid AND r.conversation_id=${request.origin.kind === "assistant" ? request.origin.conversationId : null}::uuid))
  ON CONFLICT (tenant_id,request_key) DO UPDATE SET request_key=excluded.request_key
  RETURNING id,actor_id AS actor,name,request_digest AS digest`);
	const row = z
		.object({ id: z.uuid(), actor: z.uuid().nullable(), name: z.string(), digest: z.string().nullable() })
		.optional()
		.parse(result.rows[0]);
	if (!row) return { kind: "unavailable" as const };
	if (row.actor !== request.actorId || row.name !== name || row.digest !== request.digest)
		return { kind: "conflict" as const, id: row.id };
	return row.id === id
		? { kind: "new" as const, id, writes: new Array<SQLWrapper>(), events: new Array<PgInsertValue<typeof t.event>>() }
		: { kind: "replay" as const, id: row.id };
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
