import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { seatHeld } from "../access/session.ts";
import type { Transaction } from "@everyfield/db/client";

export async function authorizeTaskReminders(
	tx: Transaction,
	mail: readonly { id: string; recipient: string | null; notice: string | null }[],
): Promise<ReadonlySet<string>> {
	const input = mail.map((m) => ({ id: m.id, recipient: m.recipient, notice: m.notice }));
	const r =
		await tx.execute(sql`SELECT i.id FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb) i(id uuid,recipient uuid,notice uuid)
		JOIN notice n ON n.id=i.notice AND n.recipient_id=i.recipient
		JOIN task t ON t.id=n.source_record_id AND t.plant_id=n.tenant_id AND t.revision=n.source_revision
		JOIN seat s ON s.account_id=i.recipient AND s.plant_id=t.plant_id AND ${seatHeld("s")}
		WHERE n.purpose='task_due' AND EXISTS(SELECT FROM task_assignee ta WHERE ta.task_id=t.id AND ta.account_id=i.recipient) AND t.deleted_at IS NULL
			AND t.status NOT IN ('complete','no_longer_needed')
		FOR SHARE OF n, t, s`);
	return new Set(
		z
			.array(z.object({ id: z.uuid() }))
			.parse(r.rows)
			.map((row) => row.id),
	);
}

export const reminderSeats = (plantId: string, accounts: SQL) =>
	sql`SELECT s.account_id, c.email FROM seat s CROSS JOIN LATERAL access_account_contact(s.account_id) c
		WHERE s.plant_id=${plantId}::uuid AND ${seatHeld("s")}
			AND s.account_id IN (${accounts}) FOR SHARE OF s`;

export async function reminderRecipients(
	tx: Transaction,
	plantId: string,
	accounts: readonly string[],
): Promise<ReadonlyMap<string, string>> {
	const r = await tx.execute(reminderSeats(plantId, sql`SELECT unnest(${sql.param(accounts)}::uuid[])`));
	const rows = z.array(z.object({ account_id: z.uuid(), email: z.email() })).parse(r.rows);
	return new Map(rows.map((row) => [row.account_id, row.email]));
}
