import type { Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { authorizeLaunchNotices } from "../launch/index.ts";
import { meetingMailGrants } from "../meetings/index.ts";
import { relationshipMailGrants, residencyMailGrants, reviewMailGrants } from "../organizations/index.ts";
import { authorizePhaseNotices } from "../phases/index.ts";
import { authorizeTaskReminders } from "../tasks/index.ts";
import type { AuthorizeMail } from "./mail.ts";

export async function authorizeNotificationMail(
	tx: Transaction,
	mail: readonly { id: string; recipient: string | null; notice: string | null }[],
): Promise<ReadonlySet<string>> {
	const rows = mail.map((m) => ({ id: m.id, recipient: m.recipient, notice: m.notice }));
	const input = sql`jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) i(id uuid,recipient uuid,notice uuid)`;
	const r = await tx.execute(sql`WITH meeting AS (${meetingMailGrants(input)}),
		relationship AS (${relationshipMailGrants(input)}), residency AS (${residencyMailGrants(input)}),
		review AS (${reviewMailGrants(input)})
		SELECT id FROM meeting UNION SELECT id FROM relationship UNION SELECT id FROM residency UNION SELECT id FROM review`);
	return new Set(
		z
			.array(z.object({ id: z.uuid() }))
			.parse(r.rows)
			.map((row) => row.id),
	);
}

export const authorizeNoticeMail: AuthorizeMail = async (tx, mail) => {
	const granted = new Set<string>();
	for (const rule of [authorizeTaskReminders, authorizePhaseNotices, authorizeLaunchNotices, authorizeNotificationMail])
		for (const id of await rule(tx, mail)) granted.add(id);
	return granted;
};
