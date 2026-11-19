import { WriteUnavailable, auditTransaction } from "../operations/writes.ts";
import * as tables from "@everyfield/db/tables";
import { and, desc, eq, isNotNull, lte, sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { createHmac, randomUUID } from "node:crypto";
import type { Database, Transaction } from "@everyfield/db/client";
import { z } from "zod";
import { refuse } from "./invitation-core.ts";

type IdentityRefusalCode =
	| "invalid_input"
	| "invalid_credentials"
	| "invalid_proof"
	| "unauthenticated"
	| "unavailable"
	| "admission_unavailable"
	| "rate_limited"
	| "origin_denied"
	| "idempotency_conflict";
export class IdentityRefusal extends Error {
	readonly code: IdentityRefusalCode;
	readonly status: number;
	constructor(code: IdentityRefusalCode, status: number) {
		super(code);
		this.code = code;
		this.status = status;
	}
}
export class RateLimited extends IdentityRefusal {
	readonly windowMinutes: number;
	constructor(windowMinutes: number) {
		super("rate_limited", 429);
		this.windowMinutes = windowMinutes;
	}
}
export const timeouts = sql`set_config('statement_timeout','10s',true)||set_config('lock_timeout','5s',true)`;
export function transaction<T>(db: Database | Transaction, body: (tx: Transaction) => Promise<T>): Promise<T> {
	return timedTransaction(db, async (tx) => {
		await tx.execute(sql`SELECT ${timeouts}`);
		return body(tx);
	});
}
export async function timedTransaction<T>(
	db: Database | Transaction,
	body: (tx: Transaction) => Promise<T>,
): Promise<T> {
	try {
		return await auditTransaction(db, body);
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

function literal(value: string | null) {
	if (value === null) return "NULL";
	if (!/^[a-z0-9_/-]+$/i.test(value)) throw new Error("unsafe_budget_literal");
	return `'${value}'`;
}
function lockPrefix(axes: (string | null | false)[]) {
	const keys = axes
		.filter((v): v is string => !!v)
		.sort()
		.map(literal);
	return `SELECT set_config('statement_timeout','10s',true),set_config('lock_timeout','5s',true),(SELECT count(pg_advisory_xact_lock(hashtextextended(k,505))) FROM unnest(ARRAY[${keys.join(",")}]::text[]) WITH ORDINALITY AS a(k,n));`;
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
			const [identifierValue, ipValue] = [literal(identifierHash), literal(ipHash)];
			const inserted = await locked(
				sql.raw(`${lockPrefix([identifierHash && `${kind}/id/${identifierHash}`, ipHash && `${kind}/ip/${ipHash}`])}
WITH expired AS (DELETE FROM admission_attempt WHERE expires_at<=clock_timestamp() RETURNING 1),
 counts AS (SELECT count(*) FILTER(WHERE identifier_hash=${identifierValue} AND state<>'cleared')::int AS identifiers,
  count(*) FILTER(WHERE trusted_ip_hash=${ipValue})::int AS ips FROM admission_attempt
  WHERE kind=${literal(kind)} AND reserved_at>clock_timestamp()-make_interval(mins=>${minutes}))
 INSERT INTO admission_attempt(id,kind,identifier_hash,trusted_ip_hash,reserved_at,state,expires_at)
 SELECT ${literal(id)}::uuid,${literal(kind)},${identifierValue},${ipValue},clock_timestamp(),'reserved',clock_timestamp()+interval '24 hours' FROM counts
 WHERE NOT ((${identifierValue}::text IS NOT NULL AND ${identifierLimit}>0 AND identifiers>=${identifierLimit})
  OR (${ipValue}::text IS NOT NULL AND ips>=${ipLimit}))
 RETURNING id`),
			);
			if (!inserted.length) throw new RateLimited(minutes);
			return { id, kind, identifierHash };
		} catch (error) {
			if (error instanceof IdentityRefusal) throw error;
			throw new IdentityRefusal("admission_unavailable", 503);
		}
	}
	async function locked(statement: SQL) {
		const results = (await db.execute(statement)) as unknown as { rows: unknown[] }[];
		return results[1]!.rows;
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
		if (!clears) return void (await settle(db));
		await locked(
			sql.raw(`${lockPrefix([`${r.kind}/id/${r.identifierHash}`])}
WITH cleared AS (UPDATE admission_attempt SET state='cleared' WHERE kind=${literal(r.kind)} AND identifier_hash=${literal(r.identifierHash)} AND state='failed' AND reserved_at>clock_timestamp()-interval '15 minutes' RETURNING 1)
 UPDATE admission_attempt SET state='cleared',trusted_ip_hash=NULL WHERE id=${literal(r.id)}::uuid`),
		);
	}
	async function release(reservation: Awaited<ReturnType<typeof reserve>>) {
		await db.delete(tables.admission_attempt).where(eq(tables.admission_attempt.id, reservation.id));
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
	return { reserve, finish, release, rememberRegistration, registrationIntent };
}
