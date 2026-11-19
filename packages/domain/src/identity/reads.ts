import "server-only";
import { z } from "zod";
import type { Database, Transaction } from "@everyfield/db/client";
import { eq, sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { liveRead } from "../access/session.ts";
import type { Owner, sessionId } from "@everyfield/contracts/common";
import { sessionResult } from "@everyfield/contracts/identity";
export const userRow = z.object({
	id: z.uuid(),
	auth_user_id: z.uuid(),
	registration_state: z.enum(["pending_domain", "active"]),
	registration_kind: z.string(),
	registration_digest: z.string().nullable(),
});

export async function lookupIdentityAccount(db: Database, authUser: string) {
	const [row] = await db
		.select({
			account: tables.account,
			blocked: sql<boolean>`EXISTS(SELECT FROM lifecycle_witness w WHERE w.opaque_subject_id=account.id
 AND w.state IN ('pending_deletion', 'purging', 'purged', 'revoked'))`,
		})
		.from(tables.account)
		.where(eq(tables.account.auth_user_id, authUser))
		.limit(1);
	return row ? { account: userRow.parse(row.account), blocked: row.blocked } : null;
}

export async function readIdentityAccount(db: Database, authUser: string) {
	const found = await lookupIdentityAccount(db, authUser);
	return found && !found.blocked ? found.account : null;
}

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

export async function readPlantSetupComplete(
	db: Pick<Database, "execute">,
	session: z.infer<typeof sessionId>,
	plant: Owner & { kind: "plant" },
) {
	const result = await db.execute(
		sql`SELECT (onboarding_completed_at IS NOT NULL) AS complete FROM plant WHERE id=${plant.id}::uuid AND ${liveRead({ session, owner: plant })}`,
	);
	return result.rows[0] ? z.object({ complete: z.boolean() }).parse(result.rows[0]).complete : false;
}
