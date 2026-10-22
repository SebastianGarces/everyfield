import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import type { Tx } from "./core.ts";

/**
 * Which task reminder mail may go out (REQ-TSK-014): the notice's task is still at the revision it was planned for,
 * still open and not deleted, the recipient is still its assignee and still holds a seat in the church. A reminder for
 * a former assignee, a settled task or an older plan is refused. One statement.
 */
export async function authorizeTaskReminders(
	tx: Tx,
	mail: readonly { id: string; recipient: string | null; notice: string | null }[],
): Promise<ReadonlySet<string>> {
	const input = mail.map((m) => ({ id: m.id, recipient: m.recipient, notice: m.notice }));
	const r =
		await tx.execute(sql`SELECT i.id FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb) i(id uuid,recipient uuid,notice uuid)
		JOIN notice n ON n.id=i.notice AND n.recipient_id=i.recipient
		JOIN task t ON t.id=n.source_record_id AND t.plant_id=n.tenant_id AND t.revision=n.source_revision
		JOIN seat s ON s.account_id=i.recipient AND s.plant_id=t.plant_id AND s.ended_at IS NULL
		WHERE n.purpose='task_due' AND t.assignee_id=i.recipient AND t.deleted_at IS NULL
			AND t.status NOT IN ('complete','no_longer_needed')
		FOR SHARE OF n, t, s`);
	return new Set(
		z
			.array(z.object({ id: z.uuid() }))
			.parse(r.rows)
			.map((row) => row.id),
	);
}

/**
 * The given accounts that may receive the plant's task reminders, with their email: each holds a current, accepted seat
 * in the plant. A query for a CTE, locking the seats it returns.
 */
export const reminderSeats = (plantId: string, accounts: SQL) =>
	sql`SELECT s.account_id, c.email FROM seat s CROSS JOIN LATERAL access_account_contact(s.account_id) c
		WHERE s.plant_id=${plantId}::uuid AND s.ended_at IS NULL AND s.accepted_at<=clock_timestamp()
			AND s.account_id IN (${accounts}) FOR SHARE OF s`;

/** The email address of each account that holds a current seat in the plant. One statement. */
export async function reminderRecipients(
	tx: Tx,
	plantId: string,
	accounts: readonly string[],
): Promise<ReadonlyMap<string, string>> {
	const r = await tx.execute(reminderSeats(plantId, sql`SELECT unnest(${sql.param(accounts)}::uuid[])`));
	const rows = z.array(z.object({ account_id: z.uuid(), email: z.email() })).parse(r.rows);
	return new Map(rows.map((row) => [row.account_id, row.email]));
}
