import "server-only";
import type { Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { z } from "zod";

const ACCOUNT_MAIL = new Set(["password_reset", "email_verification"]);

export async function authorizeAccountMail(
	tx: Transaction,
	mail: readonly { id: string; tenant: string; purpose: string; recipient: string | null; addressHash: string }[],
	addressHash: (email: string) => string,
): Promise<ReadonlySet<string>> {
	const accounts = mail.map((m) => m.tenant);
	const result = await tx.execute(
		sql`SELECT a.id,c.email FROM account a CROSS JOIN LATERAL access_account_contact(a.id) c WHERE a.id=ANY(${sql.param(accounts)}::uuid[]) FOR SHARE OF a`,
	);
	const contacts = new Map(result.rows.map((row) => [z.uuid().parse(row.id), z.email().parse(row.email)]));
	return new Set(
		mail
			.filter((m) => {
				const email = contacts.get(m.tenant);
				return m.recipient === m.tenant && ACCOUNT_MAIL.has(m.purpose) && email && addressHash(email) === m.addressHash;
			})
			.map((m) => m.id),
	);
}
