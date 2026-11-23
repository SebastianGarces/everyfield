import "server-only";
import type { Transaction } from "@everyfield/db/client";
import { and, eq, gt, inArray, isNull, sql } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import { z } from "zod";

const WORKSPACE_NOTICE = /^workspace-deletion\/(requested|cancelled)\/([0-9a-f-]{36})$/;
const noticeHolder = z.object({ id: z.uuid(), email: z.string() });

export async function authorizeSettingsMail(
	tx: Transaction,
	list: readonly {
		id: string;
		tenant: string;
		purpose: string;
		recipient: string | null;
		logicalKey: string;
		addressHash: string;
	}[],
	addressHash: (address: string) => string,
): Promise<ReadonlySet<string>> {
	const notices = list.flatMap((m) => {
		const key = WORKSPACE_NOTICE.exec(m.logicalKey);
		return key && m.purpose === "notification" && m.recipient === m.tenant
			? [{ id: m.id, account: m.tenant, kind: key[1], request: key[2] }]
			: [];
	});
	const held = notices.length
		? (
				await tx.execute(
					sql`SELECT n.id, c.email FROM jsonb_to_recordset(${JSON.stringify(notices)}::jsonb) n(id uuid,account uuid,kind text,request uuid)
 JOIN lifecycle_witness w ON w.kind='plant' AND w.request_id=n.request
  AND CASE n.kind WHEN 'requested' THEN w.state='pending_deletion' AND w.cancel_until>clock_timestamp() ELSE w.state='cancelled' END
 CROSS JOIN LATERAL access_account_contact(n.account) c
 WHERE EXISTS(SELECT FROM seat s WHERE s.account_id=n.account AND s.plant_id=w.plant_id AND s.ended_at IS NULL)
  AND NOT EXISTS(SELECT FROM lifecycle_witness h WHERE h.kind='account' AND h.opaque_subject_id=n.account AND h.state NOT IN ('active','cancelled'))`,
				)
			).rows.map((r) => noticeHolder.parse(r))
		: [];
	const proofs = await tx
		.select({ account: t.identity_proof.account_id, address: t.identity_proof.proposed_email })
		.from(t.identity_proof)
		.where(
			and(
				inArray(
					t.identity_proof.account_id,
					list.map((m) => m.tenant),
				),
				eq(t.identity_proof.purpose, "email_change"),
				isNull(t.identity_proof.superseded_at),
				isNull(t.identity_proof.consumed_at),
				gt(t.identity_proof.expires_at, sql`clock_timestamp()`),
			),
		);
	return new Set(
		list
			.filter(
				(m) =>
					m.recipient === m.tenant &&
					(m.purpose === "email_change"
						? proofs.some((p) => p.account === m.tenant && p.address && addressHash(p.address) === m.addressHash)
						: m.purpose === "notification" &&
							(m.logicalKey.startsWith("security/") ||
								held.some((h) => h.id === m.id && addressHash(h.email) === m.addressHash))),
			)
			.map((m) => m.id),
	);
}
