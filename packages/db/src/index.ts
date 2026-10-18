import { and, asc, desc, eq, gt, isNotNull, lt, sql } from "drizzle-orm";
import { database, type Database } from "./client.js";
import { early_access_attempt, early_access_request } from "./schema/tables.js";
export { database, createDatabase, closeDatabase } from "./client.js";
export type { Database, Transaction } from "./client.js";

export async function expireAccessRequests(db: Database = database()) {
	return db.transaction(async (tx) => {
		const deleted = await tx
			.delete(early_access_request)
			.where(lt(early_access_request.created_at, sql`now() - interval '12 months'`))
			.returning({ id: early_access_request.id });
		const cleared = await tx
			.update(early_access_request)
			.set({ ip_address: null })
			.where(
				and(
					lt(early_access_request.created_at, sql`now() - interval '30 days'`),
					isNotNull(early_access_request.ip_address),
				),
			)
			.returning({ id: early_access_request.id });
		await tx.delete(early_access_attempt).where(lt(early_access_attempt.created_at, sql`now() - interval '24 hours'`));
		return { deleted: deleted.length, clearedIps: cleared.length };
	});
}

export const CSV_COLUMNS = [
	"id",
	"created_at",
	"kind",
	"name",
	"email",
	"plant_name",
	"city",
	"phase",
	"sending",
	"organization",
	"role",
	"plants",
	"message",
	"ip_address",
	"mail_id",
	"mailed_at",
] as const;
function csvCell(value: unknown): string {
	let text = value instanceof Date ? value.toISOString() : String(value ?? "");
	if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
	return '"' + text.replaceAll('"', '""') + '"';
}
export async function exportAccessRequests(db: Database = database()): Promise<string> {
	const t = early_access_request;
	const rows = await db
		.select({
			id: t.id,
			created_at: t.created_at,
			kind: t.kind,
			name: sql<string>`${t.data}->>'name'`,
			email: t.email,
			plant_name: sql<string>`${t.data}->>'plant_name'`,
			city: sql<string>`${t.data}->>'city'`,
			phase: sql<string>`${t.data}->>'phase'`,
			sending: sql<string>`${t.data}->>'sending'`,
			organization: sql<string>`${t.data}->>'organization'`,
			role: sql<string>`${t.data}->>'role'`,
			plants: sql<string>`${t.data}->>'plants'`,
			message: sql<string>`${t.data}->>'message'`,
			ip_address: sql<string>`host(${t.ip_address})`,
			mail_id: t.mail_id,
			mailed_at: t.mailed_at,
		})
		.from(t)
		.orderBy(asc(t.created_at), asc(t.id));
	return (
		[CSV_COLUMNS.join(","), ...rows.map((row) => CSV_COLUMNS.map((key) => csvCell(row[key])).join(","))].join("\r\n") +
		"\r\n"
	);
}
export type AccessReservation =
	| { status: "received" }
	| { status: "rate_limited"; reason: "email" | "ip" }
	| { status: "deliver"; id: string; createdAt: Date; payload: unknown };
export async function reserveAccessRequest(
	input: {
		kind: "planter" | "network";
		email: string;
		data: Record<string, unknown>;
		ip: string | null;
		mailPayload: Record<string, unknown>;
	},
	db: Database = database(),
): Promise<AccessReservation> {
	return db.transaction(async (tx) => {
		for (const key of ["email:" + input.email, "ip:" + (input.ip ?? "unknown")].sort())
			await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`);
		const attempts = early_access_attempt;
		const [emailCount] = await tx
			.select({ n: sql<number>`count(*)::int` })
			.from(attempts)
			.where(and(eq(attempts.email, input.email), gt(attempts.created_at, sql`clock_timestamp()-interval '24 hours'`)));
		const [ipCount] = await tx
			.select({ n: sql<number>`count(*)::int` })
			.from(attempts)
			.where(
				and(
					eq(attempts.ip_key, input.ip ?? "unknown"),
					gt(attempts.created_at, sql`clock_timestamp()-interval '1 hour'`),
				),
			);
		if (!emailCount || !ipCount) throw new Error("Rate count unavailable");
		if (emailCount.n >= 5 || ipCount.n >= 20)
			return { status: "rate_limited", reason: emailCount.n >= 5 ? "email" : "ip" };
		await tx.insert(attempts).values({ email: input.email, ip_key: input.ip ?? "unknown" });
		const t = early_access_request;
		const [existing] = await tx
			.select({ id: t.id, created_at: t.created_at, mail_payload: t.mail_payload, mailed_at: t.mailed_at })
			.from(t)
			.where(
				and(
					eq(t.email, input.email),
					eq(t.kind, input.kind),
					gt(
						t.created_at,
						sql`clock_timestamp()-CASE WHEN ${t.mailed_at} IS NULL THEN interval '23 hours' ELSE interval '24 hours' END`,
					),
				),
			)
			.orderBy(desc(t.created_at))
			.limit(1);
		if (existing)
			return existing.mailed_at
				? { status: "received" }
				: { status: "deliver", id: existing.id, createdAt: existing.created_at, payload: existing.mail_payload };
		const [row] = await tx
			.insert(t)
			.values({
				kind: input.kind,
				email: input.email,
				data: input.data,
				ip_address: input.ip,
				mail_payload: input.mailPayload,
			})
			.returning({ id: t.id, created_at: t.created_at, mail_payload: t.mail_payload });
		if (!row) throw new Error("Request storage unavailable");
		return { status: "deliver", id: row.id, createdAt: row.created_at, payload: row.mail_payload };
	});
}
export async function recordAccessMail(id: string, mailId: string, db: Database = database()): Promise<void> {
	const result = await db
		.update(early_access_request)
		.set({ mail_id: mailId, mailed_at: sql`clock_timestamp()` })
		.where(eq(early_access_request.id, id))
		.returning({ id: early_access_request.id });
	if (result.length !== 1) throw new Error("Mail receipt storage unavailable");
}
