import type { Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";

/**
 * The mail a phase-advance notice may send: its notice is the recipient's own phase notice, its source is an actual
 * forward move, the recipient's organization is still connected to that plant and the recipient still holds an Owner
 * or Admin seat there (NTF-009). One statement, locking the notice and the seat.
 */
export async function authorizePhaseNotices(
	tx: Transaction,
	mail: readonly { id: string; recipient: string | null; notice: string | null }[],
): Promise<ReadonlySet<string>> {
	const input = mail.map((m) => ({ id: m.id, recipient: m.recipient, notice: m.notice }));
	const r =
		await tx.execute(sql`SELECT i.id FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb) i(id uuid,recipient uuid,notice uuid)
 JOIN notice n ON n.id=i.notice AND n.recipient_id=i.recipient AND n.purpose='phase_transition'
 JOIN phase_transition t ON t.id=n.source_record_id AND t.kind='movement' AND t.to_phase>t.from_phase
 JOIN seat s ON s.account_id=i.recipient AND s.organization_id=n.tenant_id AND s.role IN ('owner','admin') AND s.ended_at IS NULL
 WHERE EXISTS(SELECT FROM affiliation a WHERE a.plant_id=t.plant_id AND a.organization_id=n.tenant_id AND a.ended_at IS NULL)
 FOR SHARE OF n, s`);
	return new Set(
		z
			.array(z.object({ id: z.uuid() }))
			.parse(r.rows)
			.map((row) => row.id),
	);
}
