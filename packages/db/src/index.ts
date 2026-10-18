import pg from "pg";
import type { Pool } from "pg";

let pool: Pool | undefined;

export function database(): Pool {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) throw new Error("DATABASE_URL is required");
	pool ??= new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 10_000 });
	return pool;
}

export async function expireAccessRequests(db: Pool = database()) {
	const client = await db.connect();
	try {
		await client.query("BEGIN");
		const deleted = await client.query(
			"DELETE FROM early_access_request WHERE created_at < now() - interval '12 months'",
		);
		const cleared = await client.query(
			"UPDATE early_access_request SET ip_address = NULL WHERE created_at < now() - interval '30 days' AND ip_address IS NOT NULL",
		);
		await client.query("DELETE FROM early_access_attempt WHERE created_at < now() - interval '24 hours'");
		await client.query("COMMIT");
		return { deleted: deleted.rowCount, clearedIps: cleared.rowCount };
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
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
	// Prevent spreadsheet formula execution when a visitor controls the cell.
	if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
	return '"' + text.replaceAll('"', '""') + '"';
}

export async function exportAccessRequests(db: Pool = database()): Promise<string> {
	const result = await db.query<Record<string, unknown>>(`
    SELECT id, created_at, kind, data->>'name' AS name, email,
      data->>'plant_name' AS plant_name, data->>'city' AS city, data->>'phase' AS phase,
      data->>'sending' AS sending, data->>'organization' AS organization,
      data->>'role' AS role, data->>'plants' AS plants, data->>'message' AS message,
      host(ip_address) AS ip_address, mail_id, mailed_at
    FROM early_access_request ORDER BY created_at, id
  `);
	return (
		[CSV_COLUMNS.join(","), ...result.rows.map((row) => CSV_COLUMNS.map((key) => csvCell(row[key])).join(","))].join(
			"\r\n",
		) + "\r\n"
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
	db: Pool = database(),
): Promise<AccessReservation> {
	const client = await db.connect();
	try {
		await client.query("BEGIN");
		// Every caller acquires email and IP locks in the same order. Mail runs after commit.
		for (const key of ["email:" + input.email, "ip:" + (input.ip ?? "unknown")].sort()) {
			await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
		}
		const counts = await client.query<{ email_count: number; ip_count: number }>(
			`
      SELECT
        (SELECT count(*)::int FROM early_access_attempt WHERE email = $1 AND created_at > clock_timestamp() - interval '24 hours') AS email_count,
        (SELECT count(*)::int FROM early_access_attempt WHERE ip_key = $2 AND created_at > clock_timestamp() - interval '1 hour') AS ip_count
    `,
			[input.email, input.ip ?? "unknown"],
		);
		const count = counts.rows[0];
		if (!count) throw new Error("Rate count unavailable");
		if (count.email_count >= 5 || count.ip_count >= 20) {
			await client.query("COMMIT");
			return { status: "rate_limited", reason: count.email_count >= 5 ? "email" : "ip" };
		}
		await client.query("INSERT INTO early_access_attempt (email, ip_key) VALUES ($1, $2)", [
			input.email,
			input.ip ?? "unknown",
		]);
		const duplicate = await client.query<{
			id: string;
			created_at: Date;
			mail_payload: unknown;
			mailed_at: Date | null;
		}>(
			`
      SELECT id, created_at, mail_payload, mailed_at FROM early_access_request
      WHERE email = $1 AND kind = $2
        AND created_at > clock_timestamp() - CASE
          WHEN mailed_at IS NULL THEN interval '23 hours'
          ELSE interval '24 hours'
        END
      ORDER BY created_at DESC LIMIT 1
    `,
			[input.email, input.kind],
		);
		const existing = duplicate.rows[0];
		if (existing) {
			await client.query("COMMIT");
			return existing.mailed_at
				? { status: "received" }
				: { status: "deliver", id: existing.id, createdAt: existing.created_at, payload: existing.mail_payload };
		}
		const result = await client.query<{ id: string; created_at: Date; mail_payload: unknown }>(
			`
      INSERT INTO early_access_request (kind, email, data, ip_address, mail_payload)
      VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at, mail_payload
    `,
			[input.kind, input.email, JSON.stringify(input.data), input.ip, JSON.stringify(input.mailPayload)],
		);
		const row = result.rows[0];
		if (!row) throw new Error("Request storage unavailable");
		await client.query("COMMIT");
		return { status: "deliver", id: row.id, createdAt: row.created_at, payload: row.mail_payload };
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

export async function recordAccessMail(id: string, mailId: string, db: Pool = database()): Promise<void> {
	const result = await db.query(
		"UPDATE early_access_request SET mail_id = $2, mailed_at = clock_timestamp() WHERE id = $1 RETURNING id",
		[id, mailId],
	);
	if (result.rowCount !== 1) throw new Error("Mail receipt storage unavailable");
}
