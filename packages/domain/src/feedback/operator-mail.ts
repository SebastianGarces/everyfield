import "server-only";
import type { Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { z } from "zod";

const KEY = /^feedback\/([0-9a-f-]{36})$/;

export async function authorizeOperatorMail(
	tx: Transaction,
	list: readonly {
		id: string;
		tenant: string;
		purpose: string;
		recipient: string | null;
		logicalKey: string;
		addressHash: string;
	}[],
	inbox: string,
): Promise<ReadonlySet<string>> {
	const wanted = list.flatMap((m) => {
		const key = KEY.exec(m.logicalKey);
		return key && m.purpose === "notification" && m.recipient === null && m.addressHash === inbox
			? [{ id: m.id, feedback: key[1], account: m.tenant }]
			: [];
	});
	if (!wanted.length) return new Set();
	const found = await tx.execute(
		sql`SELECT w.id FROM jsonb_to_recordset(${JSON.stringify(wanted)}::jsonb) w(id uuid,feedback uuid,account uuid)
 JOIN feedback f ON f.id=w.feedback AND f.account_id=w.account`,
	);
	return new Set(found.rows.map((r) => z.uuid().parse(r.id)));
}
