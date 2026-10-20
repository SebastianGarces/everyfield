import "server-only";
import type { Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { z } from "zod";

/** Frozen mail intent, checked in bulk both at enqueue and immediately before handoff. */
export async function authorizeInvitationMail(
	tx: Transaction,
	mail: readonly {
		id: string;
		tenant: string;
		purpose: string;
		recipient: string | null;
		logicalKey: string;
		addressHash: string;
		operation: string | null;
	}[],
	addressHash: (email: string) => string,
): Promise<ReadonlySet<string>> {
	const input = mail.flatMap((m) => {
		const [prefix, invitation, revision, ...extra] = m.logicalKey.split("/");
		if (
			extra.length ||
			!invitation ||
			!z.uuid().safeParse(invitation).success ||
			!["invitation", "invitation-accepted"].includes(prefix ?? "")
		)
			return [];
		return [{ id: m.id, tenant: m.tenant, invitation, prefix, revision: revision ?? null }];
	});
	if (!input.length) return new Set();
	const result =
		await tx.execute(sql`WITH input AS MATERIALIZED (SELECT * FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb) i(id uuid,tenant uuid,invitation uuid,prefix text,revision text)),
  source AS MATERIALIZED (SELECT i.* FROM invitation i WHERE i.id IN (SELECT invitation FROM input)),
  accounts AS MATERIALIZED (SELECT a.id FROM account a WHERE a.id IN (SELECT inviter_id FROM source UNION SELECT accepted_account_id FROM source) ORDER BY a.id FOR SHARE),
  plants AS MATERIALIZED (SELECT p.id FROM plant p WHERE p.id IN (SELECT tenant FROM input) AND (SELECT count(*) FROM accounts)>=0 ORDER BY p.id FOR SHARE),
  organizations AS MATERIALIZED (SELECT o.id FROM organization o WHERE o.id IN (SELECT tenant FROM input) AND (SELECT count(*) FROM plants)>=0 ORDER BY o.id FOR SHARE),
  people AS MATERIALIZED (SELECT p.id,p.state,p.linked_account_id,p.organization_id FROM person p WHERE p.id IN (SELECT resident_person_id FROM source) AND (SELECT count(*) FROM organizations)>=0 ORDER BY p.id FOR SHARE),
  invitations AS MATERIALIZED (SELECT i.* FROM invitation i WHERE i.id IN (SELECT id FROM source) AND (SELECT count(*) FROM people)>=0 ORDER BY i.id FOR SHARE),
  seats AS MATERIALIZED (SELECT s.id,s.account_id,coalesce(s.plant_id,s.organization_id) AS owner FROM seat s WHERE s.account_id IN (SELECT inviter_id FROM invitations) AND s.ended_at IS NULL AND s.role<>'member' ORDER BY s.id FOR SHARE)
 SELECT q.id AS input_id,i.tenant_id,i.recipient_email,i.purpose,i.state,i.revision::text,i.inviter_id,i.accepted_account_id,
  i.created_at+interval '720 hours'>clock_timestamp() AS unexpired,
  (EXISTS(SELECT FROM plants WHERE id=q.tenant) OR EXISTS(SELECT FROM organizations WHERE id=q.tenant)) AS owner_live,
  (SELECT id FROM seats s WHERE s.account_id=i.inviter_id AND s.owner=i.tenant_id LIMIT 1) AS seat_id,
  EXISTS(SELECT FROM people p WHERE p.id=i.resident_person_id AND p.organization_id=i.tenant_id AND p.state='live' AND p.linked_account_id IS NULL AND NOT EXISTS(SELECT FROM organization_person_removal r WHERE r.organization_id=i.tenant_id AND r.person_record_id=p.id)) AS person_live
 FROM input q JOIN invitations i ON i.id=q.invitation AND i.tenant_id=q.tenant`);
	const rows = z
		.array(
			z.object({
				input_id: z.uuid(),
				tenant_id: z.uuid(),
				recipient_email: z.string(),
				purpose: z.string(),
				state: z.string(),
				revision: z.string(),
				inviter_id: z.uuid().nullable(),
				accepted_account_id: z.uuid().nullable(),
				unexpired: z.boolean(),
				owner_live: z.boolean(),
				seat_id: z.uuid().nullable(),
				person_live: z.boolean(),
			}),
		)
		.parse(result.rows);
	const subjects = [...new Set(rows.flatMap((r) => [r.tenant_id, ...(r.inviter_id ? [r.inviter_id] : [])]))],
		seats = rows.flatMap((r) => (r.seat_id ? [r.seat_id] : []));
	const barriers = await tx.execute(
		sql`SELECT opaque_subject_id,seat_id FROM lifecycle_witness WHERE state NOT IN ('active','cancelled') AND (opaque_subject_id=ANY(${sql.param(subjects)}::uuid[]) OR seat_id=ANY(${sql.param(seats)}::uuid[])) FOR SHARE`,
	);
	const blockedSubjects = new Set(barriers.rows.map((r) => r.opaque_subject_id)),
		blockedSeats = new Set(barriers.rows.map((r) => r.seat_id));
	return new Set(
		mail
			.filter((m) => {
				const row = rows.find((r) => r.input_id === m.id),
					q = input.find((q) => q.id === m.id);
				if (
					!row ||
					!q ||
					!row.owner_live ||
					blockedSubjects.has(m.tenant) ||
					addressHash(row.recipient_email) !== m.addressHash ||
					!m.operation
				)
					return false;
				if (q.prefix === "invitation-accepted")
					return (
						q.revision === null &&
						row.state === "accepted" &&
						m.recipient === row.accepted_account_id &&
						m.purpose === "relationship_receipt"
					);
				return (
					row.state === "pending" &&
					row.revision === q.revision &&
					row.unexpired &&
					m.recipient === null &&
					m.purpose === (row.purpose === "seat" ? "seat_invitation" : "relationship_invitation") &&
					!!row.inviter_id &&
					!!row.seat_id &&
					!blockedSubjects.has(row.inviter_id) &&
					!blockedSeats.has(row.seat_id) &&
					(row.purpose === "seat" || (row.purpose === "residency_link" && row.person_live))
				);
			})
			.map((m) => m.id),
	);
}
