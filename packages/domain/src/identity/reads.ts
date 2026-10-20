import "server-only";
import { z } from "zod";
import type { Database, Transaction } from "@everyfield/db/client";
import { and, eq, sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { sessionResult } from "@everyfield/contracts/identity";
export const userRow = z.object({
	id: z.uuid(),
	auth_user_id: z.uuid(),
	registration_state: z.enum(["pending_domain", "active"]),
	registration_kind: z.string(),
	registration_digest: z.string().nullable(),
});

export async function readIdentityAccount(db: Database, authUser: string) {
	const rows = await db.select().from(tables.account).where(eq(tables.account.auth_user_id, authUser));
	if (!rows.length) return null;
	const account = userRow.parse(rows[0]);
	const blocked = await db
		.select({ id: tables.lifecycle_witness.id })
		.from(tables.lifecycle_witness)
		.where(
			and(
				eq(tables.lifecycle_witness.opaque_subject_id, account.id),
				sql<boolean>`(${tables.lifecycle_witness.state} IN ('pending_deletion', 'purging', 'purged', 'revoked'))`,
			),
		);
	return blocked.length ? null : account;
}

/** Domain registration and lifecycle attached to an already validated native session. */
export async function readIdentitySession(
	db: Database,
	native: {
		user: { id: string };
		session: { id: string; expiresAt: Date };
	},
) {
	const account = await readIdentityAccount(db, native.user.id);
	return sessionResult.parse(
		account
			? {
					status: account.registration_state,
					accountId: account.id,
					sessionId: native.session.id,
					expiresAt: native.session.expiresAt.toISOString(),
				}
			: { status: "unauthenticated" },
	);
}

export async function readAccountContact(tx: Transaction, accountId: string) {
	const result = await tx.execute(sql`SELECT * FROM access_account_contact(${accountId})`);
	return z.object({ email: z.email() }).parse(result.rows[0]).email;
}

export async function readAccountContacts(
	tx: Transaction,
	accounts: readonly string[],
): Promise<ReadonlyMap<string, string>> {
	const result = await tx.execute(
		sql`SELECT a.id,c.email FROM account a CROSS JOIN LATERAL access_account_contact(a.id) c WHERE a.id=ANY(${sql.param(accounts)}::uuid[])`,
	);
	const rows = z.array(z.object({ id: z.uuid(), email: z.email() })).parse(result.rows);
	return new Map(rows.map((row) => [row.id, row.email]));
}
