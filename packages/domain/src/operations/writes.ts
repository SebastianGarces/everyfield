import { writeAction } from "./actions.ts";
import { requestIdentity, type RequestIdentity } from "@everyfield/contracts/common";
import type { Database, Transaction } from "@everyfield/db/client";
import type { PgInsertValue } from "@everyfield/db/columns";
import { sql, type SQLWrapper } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { clearRequestWrite, requestWrite, writeVisibility } from "../access/session.ts";

export class WriteUnavailable extends Error {
	constructor() {
		super("unavailable");
	}
}

export type AuditWrite = {
	id: string;
	writes: SQLWrapper[];
	events: PgInsertValue<typeof t.audit_event>[];
};

/** Read a committed exact-request reply. A unique audit key arbitrates absent-key races at commit. */
export async function prepareWrite(tx: Transaction, request: RequestIdentity) {
	const result = await tx.execute(sql`SELECT ${writeVisibility(request.actorId, request.owner)} AS allowed,
 a.id,a.subject_id,a.request_identity,a.result FROM (SELECT 1) seed LEFT JOIN audit_event a
 ON a.tenant_id=${request.owner.id}::uuid AND a.request_key=${request.requestKey}`);
	const row = z
		.object({
			allowed: z.boolean(),
			id: z.uuid().nullable(),
			subject_id: z.uuid().nullable(),
			request_identity: z.unknown(),
			result: z.unknown(),
		})
		.parse(result.rows[0]);
	if (!row.allowed) return { kind: "unavailable" as const };
	if (row.id) {
		if (row.request_identity === null || row.result === null) return { kind: "unavailable" as const };
		const prior = requestIdentity.parse(row.request_identity);
		if (prior.actorId !== request.actorId || prior.operation !== request.operation || prior.digest !== request.digest)
			return { kind: "conflict" as const, id: row.id };
		return { kind: "replay" as const, id: row.id, subject: row.subject_id, value: row.result };
	}
	return {
		kind: "new" as const,
		id: randomUUID(),
		writes: new Array<SQLWrapper>(),
		events: new Array<PgInsertValue<typeof t.audit_event>>(),
	};
}

export async function finishAudit(tx: Transaction, command: AuditWrite, request: RequestIdentity, result: unknown) {
	const entries = command.events;
	if (!entries.some((entry) => entry.id === command.id))
		entries.unshift({
			id: command.id,
			tenant_id: request.owner.id,
			actor_id: request.actorId,
			action: writeAction(request.operation),
			kind: "edit",
			subject_type: "command",
			subject_id: request.owner.id,
		});
	const rows = entries.map((entry) => ({
		...entry,
		command_id: command.id,
		...(entry.id === command.id ? { request_key: request.requestKey, request_identity: request, result } : {}),
	}));
	// A deletion request deliberately hides its own locked root before its final audit.
	const closesOwner = ["account.requestDeletion", "churches.requestWorkspaceDeletion"].includes(request.operation);
	await executeWrites(
		tx,
		[...command.writes, tx.insert(t.audit_event).values(rows)],
		closesOwner ? undefined : request,
	);
}

/** Independent changes and their audit entries execute in one statement, on a transaction or alone on the pool. */
export async function executeWrites(
	tx: Pick<Transaction, "execute">,
	writes: readonly SQLWrapper[],
	request?: RequestIdentity,
): Promise<void> {
	if (!writes.length) return;
	const result = await tx.execute(
		sql`WITH ${sql.join(
			writes.map((q, i) => sql`${sql.identifier("write_" + i)} AS (${q.getSQL()} RETURNING 1)`),
			sql`, `,
		)} SELECT ${request ? writeVisibility(request.actorId, request.owner) : sql`true`} AS allowed`,
	);
	if (!z.boolean().parse(result.rows[0]?.allowed)) throw new WriteUnavailable();
}
export function isAuditRetry(error: unknown): boolean {
	const found = z
		.object({ cause: z.object({ code: z.literal("23505"), constraint: z.literal("audit_request_key") }) })
		.safeParse(error);
	return found.success;
}
/** A lost concurrent request may win the audit key after this transaction's first snapshot. */
export async function auditTransaction<T>(db: Database, body: (tx: Transaction) => Promise<T>): Promise<T> {
	try {
		return await db.transaction(body);
	} catch (error) {
		if (!isAuditRetry(error)) throw error;
		return db.transaction(body);
	}
}

export function setAuditDetails(command: AuditWrite, id: string, metadata: unknown, reason: string | null = null) {
	const entry = command.events.find((entry) => entry.id === id);
	if (!entry) throw new Error("missing_audit_entry");
	entry.metadata = metadata;
	entry.reason = reason;
}

export async function auditSavepoint<T>(tx: Transaction, body: (tx: Transaction) => Promise<T>): Promise<T> {
	if (requestWrite(tx)) return body(tx);
	try {
		try {
			return await tx.transaction(body);
		} catch (error) {
			if (!isAuditRetry(error)) throw error;
			clearRequestWrite(tx);
			return tx.transaction(body);
		}
	} finally {
		clearRequestWrite(tx);
	}
}
