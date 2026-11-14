import type { Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { seatHeld } from "../access/session.ts";

/**
 * The mail a Launch notification may send (NTF-009): its notice is the recipient's own Launch notice, its milestone is
 * still completed in that church and the recipient still holds an accepted Owner or Admin seat there. One statement,
 * locking the notice and the seat.
 */
export async function authorizeLaunchNotices(
	tx: Transaction,
	mail: readonly { id: string; recipient: string | null; notice: string | null }[],
): Promise<ReadonlySet<string>> {
	const input = mail.map((m) => ({ id: m.id, recipient: m.recipient, notice: m.notice }));
	const r =
		await tx.execute(sql`SELECT i.id FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb) i(id uuid,recipient uuid,notice uuid)
 JOIN notice n ON n.id=i.notice AND n.recipient_id=i.recipient AND n.purpose='launch_milestone'
 JOIN launch_milestone m ON m.id=n.source_record_id AND m.plant_id=n.tenant_id AND m.completed_at IS NOT NULL
	AND m.removed_at IS NULL
 JOIN seat s ON s.account_id=i.recipient AND s.plant_id=n.tenant_id AND s.role IN ('owner','admin') AND ${seatHeld("s")}
 FOR SHARE OF n, s`);
	return new Set(
		z
			.array(z.object({ id: z.uuid() }))
			.parse(r.rows)
			.map((row) => row.id),
	);
}
