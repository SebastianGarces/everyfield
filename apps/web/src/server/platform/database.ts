import * as tables from "./tables.ts";
import { and, eq, gt } from "@everyfield/db/query";
import "server-only";
import { sql } from "@everyfield/db/query";
import type { Database, Transaction } from "@everyfield/db/client";
import { CommandScope } from "@everyfield/contracts/common/server";
import { accountId, sessionId, tenantId, instant } from "@everyfield/contracts/common";
import { Refusal } from "./boundary.ts";
import type { PlatformAuth } from "./auth.ts";

export async function transaction<T>(pool: Database, body: (tx: Transaction) => Promise<T>): Promise<T> {
	return pool.transaction(async (tx) => {
		await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
		return body(tx);
	});
}
export async function currentScope(tx: Transaction, auth: PlatformAuth, headers: Headers, ownerId: string) {
	const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
	if (!session) throw new Refusal("unavailable", 404);
	const owner = { kind: "plant" as const, id: tenantId.parse(ownerId) };
	const scope = await CommandScope.load(
		tx,
		sessionId.parse(session.session.id),
		owner,
		instant.parse(new Date().toISOString()),
		async () => {
			// Locks serialize grant revoke/lifecycle changes with this transaction's effect.
			const result = await tx
				.select({ role: tables.proof_grant.role, active: tables.proof_grant.active })
				.from(tables.proof_grant)
				.where(
					and(
						and(eq(tables.proof_grant.account_id, session.user.id), eq(tables.proof_grant.owner_id, owner.id)),
						tables.proof_grant.active,
					),
				)
				.for("share");
			const grant = result[0];
			if (!grant) return null;
			// Recheck the database session inside the mutation transaction, after locking grants.
			const live = await tx
				.select({ id: tables.auth_session.id })
				.from(tables.auth_session)
				.where(
					and(
						eq(tables.auth_session.id, session.session.id),
						gt(tables.auth_session.expires_at, sql`clock_timestamp()`),
					),
				)
				.for("share");
			if (live.length !== 1) return null;
			return {
				accountId: accountId.parse(session.user.id),
				sessionId: session.session.id,
				sessionExpiresAt: session.session.expiresAt.toISOString(),
				accountActive: true,
				context: { kind: "seat", owner, role: grant.role, active: true },
			};
		},
	);
	if (!scope) throw new Refusal("unavailable", 404);
	return scope;
}
