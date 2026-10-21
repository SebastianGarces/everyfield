import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { z } from "zod";
import { LIMITS } from "../context/limits.ts";
import { eventRow, reference, type ConversationEvent } from "../conversations/store.ts";

/**
 * The run's claim on its assistant_turn job, as the WP-031 queue issued it. The job lease is the run fence: a worker
 * may save events only while this exact claim is current, so a cancelled, expired or replaced run cannot publish.
 */
export type RunLease = { turnId: string; tenantId: string; leaseOwner: string; generation: string };

const fence = (lease: RunLease) =>
	sql`EXISTS(SELECT FROM job j WHERE j.id=${lease.turnId}::uuid AND j.tenant_id=${lease.tenantId}::uuid AND j.state='claimed'
		AND j.lease_owner=${lease.leaseOwner} AND j.claim_generation=${lease.generation}::bigint AND j.lease_until>clock_timestamp())`;

const turnRow = z.object({
	conversation_id: z.uuid(),
	tenant_id: z.uuid(),
	account_id: z.uuid(),
	session_id: z.uuid(),
	message: z.object({
		sequence: z.coerce.number(),
		body: z.object({ text: z.string(), references: z.array(reference).default([]) }),
	}),
	history: z.array(eventRow),
});
export type Turn = z.infer<typeof turnRow>;

/**
 * The claimed turn: its conversation, the submitted message and the recent saved history before it (each earlier
 * message and the final status of its turn, which carries the assistant's full reply). Null when the
 * conversation no longer runs this turn (cancelled) or the lease is gone. One statement.
 */
export async function loadTurn(db: Database, lease: RunLease): Promise<Turn | null> {
	const r = await db.execute(sql`
		SELECT c.id AS conversation_id,c.tenant_id,c.account_id,c.active_session_id AS session_id,
			(SELECT jsonb_build_object('sequence',m.sequence,'body',m.body) FROM conversation_event m
				WHERE m.conversation_id=c.id AND m.turn_id=${lease.turnId}::uuid AND m.kind='user_message') AS message,
			coalesce((SELECT jsonb_agg(jsonb_build_object('sequence',h.sequence,'turnId',h.turn_id,'kind',h.kind,'body',h.body,'createdAt',h.created_at) ORDER BY h.sequence)
				FROM (SELECT * FROM conversation_event e WHERE e.conversation_id=c.id AND e.kind IN ('user_message','status')
					AND e.turn_id IS DISTINCT FROM ${lease.turnId}::uuid ORDER BY e.sequence DESC LIMIT ${LIMITS.recentMessages * 2}) h), '[]'::jsonb) AS history
		FROM conversation c JOIN job j ON j.subject_record_id=c.id
		WHERE j.id=${lease.turnId}::uuid AND c.active_turn_id=${lease.turnId}::uuid AND ${fence(lease)}`);
	return r.rows.length ? turnRow.parse(r.rows[0]) : null;
}

/**
 * Saves one event of the running turn, fenced by the lease and by the conversation still pointing at this turn. Returns
 * the event's sequence, or null when the run lost ownership and must stop. One statement.
 */
export async function appendEvent(
	db: Database,
	lease: RunLease,
	conversationId: string,
	kind: Exclude<ConversationEvent["kind"], "user_message">,
	body: Record<string, unknown>,
	finish = false,
): Promise<number | null> {
	const r = await db.execute(sql`
		WITH c AS (
			UPDATE conversation SET last_sequence=last_sequence+1,updated_at=clock_timestamp()
				${finish ? sql`,active_turn_id=NULL,active_session_id=NULL` : sql``}
			WHERE id=${conversationId}::uuid AND active_turn_id=${lease.turnId}::uuid AND ${fence(lease)}
			RETURNING id,last_sequence
		)
		INSERT INTO conversation_event(conversation_id,sequence,turn_id,kind,body)
		SELECT id,last_sequence,${lease.turnId}::uuid,${kind},${JSON.stringify(body)}::jsonb FROM c RETURNING sequence`);
	return r.rows.length ? z.coerce.number().parse(r.rows[0]!.sequence) : null;
}

/** A source-bound result this conversation saved earlier, for selection from returned rows. */
export async function savedResult(db: Database, conversationId: string, sequence: number) {
	const r = await db.execute(sql`
		SELECT body FROM conversation_event WHERE conversation_id=${conversationId}::uuid AND sequence=${sequence} AND kind='tool_result'`);
	return r.rows.length ? (r.rows[0]!.body as Record<string, unknown>) : null;
}
