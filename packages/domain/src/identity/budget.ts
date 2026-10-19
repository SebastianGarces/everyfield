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
		return await db.transaction(async (tx) => {
			await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
			await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
			return body(tx);
		});
	} catch (error) {
		// The transaction has rolled back before an exact-request retry is offered.
		const storage = z.object({ cause: z.object({ code: z.string() }) }).safeParse(error);
		if (storage.success && ["55P03", "57014"].includes(storage.data.cause.code)) refuse("temporary");
		throw error;
	}
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
		try {
			return await transaction(db, async (tx) => {
				for (const axis of [identifierHash && `${kind}/id/${identifierHash}`, ipHash && `${kind}/ip/${ipHash}`]
					.filter((v): v is string => !!v)
					.sort()) {
					await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${axis},505))`);
				}
				await tx.delete(tables.admission_attempt).where(
					lte(
						tables.admission_attempt.expires_at,
						sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
					),
				);
				const [count] = await tx
					.select({
						identifiers: sql<number>`count(*) FILTER(WHERE ${tables.admission_attempt.identifier_hash}=${identifierHash} AND ${tables.admission_attempt.state}<>'cleared')::int`,
						ips: sql<number>`count(*) FILTER(WHERE ${tables.admission_attempt.trusted_ip_hash}=${ipHash})::int`,
					})
					.from(tables.admission_attempt)
					.where(
						and(
							eq(tables.admission_attempt.kind, kind),
							gt(tables.admission_attempt.reserved_at, sql`clock_timestamp()-make_interval(mins=>${minutes})`),
						),
					);
				if (!count) throw new Error("budget_unavailable");
				if (
					(identifierHash && identifierLimit && count.identifiers >= identifierLimit) ||
					(ipHash && count.ips >= ipLimit)
				)
					throw new IdentityRefusal("rate_limited", 429);
				const id = randomUUID();
				await tx.insert(tables.admission_attempt).values({
					id: id,
					kind: kind,
					identifier_hash: identifierHash,
					trusted_ip_hash: ipHash,
					reserved_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
					state: "reserved",
					expires_at: sql<unknown>`(clock_timestamp() + ('24 hours')::interval)`,
				});
				return { id, kind, identifierHash };
			});
		} catch (error) {
			if (error instanceof IdentityRefusal) throw error;
			throw new IdentityRefusal("admission_unavailable", 503);
		}
	}
	async function finish(reservation: Awaited<ReturnType<typeof reserve>>, success: boolean) {
		await transaction(db, async (tx) => {
			const r = reservation;
			if (success && (r.kind === "login" || r.kind === "password_change")) {
				await tx.execute(
					sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${r.kind}/id/${r.identifierHash}`},505))`,
				);
				// In-flight attempts keep their reservation. Another request's later failure is not cleared.
				await tx
					.update(tables.admission_attempt)
					.set({ state: "cleared" })
					.where(
						and(
							and(
								and(
									eq(tables.admission_attempt.kind, r.kind),
									eq(tables.admission_attempt.identifier_hash, sql`${r.identifierHash}`),
								),
								eq(tables.admission_attempt.state, "failed"),
							),
							gt(tables.admission_attempt.reserved_at, sql<unknown>`(clock_timestamp() - ('15 minutes')::interval)`),
						),
					);
			}
			await tx
				.update(tables.admission_attempt)
				.set({
					state:
						success && (r.kind === "login" || r.kind === "password_change")
							? "cleared"
							: r.kind === "login" || r.kind === "password_change"
								? "failed"
								: "counted",
					trusted_ip_hash: sql<unknown>`CASE WHEN ${success && (r.kind === "login" || r.kind === "password_change")} THEN NULL ELSE ${tables.admission_attempt.trusted_ip_hash} END`,
				})
				.where(eq(tables.admission_attempt.id, r.id));
		});
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
