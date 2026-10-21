import { WriteUnavailable, auditTransaction, executeWrites } from "../operations/writes.ts";
import * as tables from "@everyfield/db/tables";
import { and, desc, eq, gt, isNotNull, lte, sql } from "@everyfield/db/query";
import "server-only";
import { createHmac, randomUUID } from "node:crypto";
import type { Database, Transaction } from "@everyfield/db/client";
import { z } from "zod";
import { refuse } from "./invitation-core.ts";

export class IdentityRefusal extends Error {
	constructor(
		readonly code:
			| "invalid_input"
			| "invalid_credentials"
			| "invalid_proof"
			| "unauthenticated"
			| "unavailable"
			| "admission_unavailable"
			| "rate_limited"
			| "origin_denied"
			| "idempotency_conflict",
		readonly status: number,
	) {
		super(code);
	}
}
export async function transaction<T>(db: Database, body: (tx: Transaction) => Promise<T>): Promise<T> {
	try {
		return await auditTransaction(db, async (tx) => {
			await tx.execute(sql`SELECT set_config('statement_timeout','10s',true),set_config('lock_timeout','5s',true)`);
			return body(tx);
		});
	} catch (error) {
		rethrowWriteError(error);
	}
}
export function rethrowWriteError(error: unknown): never {
	if (error instanceof WriteUnavailable) refuse();
	const storage = z.object({ cause: z.object({ code: z.string() }) }).safeParse(error);
	if (storage.success && ["55P03", "57014"].includes(storage.data.cause.code)) refuse("temporary");
	throw error;
}

export function attemptBudget(db: Database, key: string) {
	const hash = (value: string) => createHmac("sha256", key).update(value).digest("hex");
	async function reserve(
		kind: "login" | "reset" | "registration" | "email_change" | "password_change",
		identifier: string | null,
		ip: string | null,
	) {
		if (kind === "registration" && !ip) throw new IdentityRefusal("admission_unavailable", 503);
		const identifierHash = identifier ? hash(identifier) : null,
			ipHash = ip ? hash(ip) : null;
		const [minutes, identifierLimit, ipLimit] =
			kind === "login" || kind === "password_change"
				? [15, 5, 20]
				: kind === "reset" || kind === "email_change"
					? [60, 3, 10]
					: [60, 0, 3];
		const id = randomUUID();
		try {
			const inserted = await locked(
				[identifierHash && `${kind}/id/${identifierHash}`, ipHash && `${kind}/ip/${ipHash}`],
				// One statement after the locks: drop expired rows, count this window and reserve within the limits.
				// The expired rows are 24 hours old, outside every window, so the count does not depend on them.
				(tx) =>
					tx.execute(sql`WITH expired AS (DELETE FROM admission_attempt WHERE expires_at<=clock_timestamp() RETURNING 1),
 counts AS (SELECT count(*) FILTER(WHERE identifier_hash=${identifierHash} AND state<>'cleared')::int AS identifiers,
  count(*) FILTER(WHERE trusted_ip_hash=${ipHash})::int AS ips FROM admission_attempt
  WHERE kind=${kind} AND reserved_at>clock_timestamp()-make_interval(mins=>${minutes}))
 INSERT INTO admission_attempt(id,kind,identifier_hash,trusted_ip_hash,reserved_at,state,expires_at)
 SELECT ${id}::uuid,${kind},${identifierHash},${ipHash},clock_timestamp(),'reserved',clock_timestamp()+interval '24 hours' FROM counts
 WHERE NOT ((${identifierHash}::text IS NOT NULL AND ${identifierLimit}::int>0 AND identifiers>=${identifierLimit}::int)
  OR (${ipHash}::text IS NOT NULL AND ips>=${ipLimit}::int))
 RETURNING id`),
			);
			if (!inserted.rows.length) throw new IdentityRefusal("rate_limited", 429);
			return { id, kind, identifierHash };
		} catch (error) {
			if (error instanceof IdentityRefusal) throw error;
			throw new IdentityRefusal("admission_unavailable", 503);
		}
	}
	/** One transaction that takes the axis locks, in a stable order, in the same statement as its time limits. */
	async function locked<T>(axes: (string | null | false)[], body: (tx: Transaction) => Promise<T>) {
		const keys = axes.filter((v): v is string => !!v).sort();
		return auditTransaction(db, async (tx) => {
			await tx.execute(
				sql`SELECT set_config('statement_timeout','10s',true),set_config('lock_timeout','5s',true),(SELECT count(pg_advisory_xact_lock(hashtextextended(k,505))) FROM unnest(${sql.param(keys)}::text[]) WITH ORDINALITY AS a(k,n))`,
			);
			return body(tx);
		}).catch((error) => rethrowWriteError(error));
	}
	async function finish(reservation: Awaited<ReturnType<typeof reserve>>, success: boolean) {
		const r = reservation,
			clears = success && (r.kind === "login" || r.kind === "password_change");
		const settle = (tx: Pick<Transaction, "update">) =>
			tx
				.update(tables.admission_attempt)
				.set({
					state: clears ? "cleared" : r.kind === "login" || r.kind === "password_change" ? "failed" : "counted",
					trusted_ip_hash: sql<unknown>`CASE WHEN ${clears} THEN NULL ELSE ${tables.admission_attempt.trusted_ip_hash} END`,
				})
				.where(eq(tables.admission_attempt.id, r.id));
		// A failure or a counted attempt only settles its own row: one statement.
		if (!clears) return void (await settle(db));
		// A success clears this login's recent failures under its identifier lock. In-flight attempts keep their
		// reservation, and another request's later failure is not cleared.
		await locked([`${r.kind}/id/${r.identifierHash}`], (tx) =>
			executeWrites(tx, [
				tx
					.update(tables.admission_attempt)
					.set({ state: "cleared" })
					.where(
						and(
							eq(tables.admission_attempt.kind, r.kind),
							eq(tables.admission_attempt.identifier_hash, sql`${r.identifierHash}`),
							eq(tables.admission_attempt.state, "failed"),
							gt(tables.admission_attempt.reserved_at, sql<unknown>`(clock_timestamp() - ('15 minutes')::interval)`),
						),
					),
				settle(tx),
			]),
		);
	}
	async function rememberRegistration(id: string, email: string, kind: string, intent: string) {
		await db
			.update(tables.admission_attempt)
			.set({ identifier_hash: hash(email), workspace_key: JSON.stringify({ kind, intent }) })
			.where(and(eq(tables.admission_attempt.id, id), eq(tables.admission_attempt.kind, "registration")));
	}
	async function registrationIntent(email: string, createdAt: Date) {
		const row = await db
			.select({ workspace_key: tables.admission_attempt.workspace_key })
			.from(tables.admission_attempt)
			.where(
				and(
					and(
						and(
							eq(tables.admission_attempt.kind, "registration"),
							eq(tables.admission_attempt.identifier_hash, hash(email)),
						),
						lte(tables.admission_attempt.reserved_at, createdAt),
					),
					isNotNull(tables.admission_attempt.workspace_key),
				),
			)
			.orderBy(desc(tables.admission_attempt.reserved_at))
			.limit(1);
		return row[0]?.workspace_key;
	}
	return { reserve, finish, rememberRegistration, registrationIntent };
}
