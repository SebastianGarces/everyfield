import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import type { EvryActor } from "../context/actor.ts";
import { currentAuthority } from "../context/authority.ts";
import { EvryRefusal } from "../context/errors.ts";
import { LIMITS } from "../context/limits.ts";
import type { ReadAdapter, SourceResult } from "./types.ts";

/**
 * evry.invokeRead: one native read under the actor's live authority (C13). The transaction's first statement checks
 * the live session, seat, role and lifecycle and holds share locks on the session and seat rows, so ending the seat,
 * changing its role or revoking the session waits until this read has committed; once it has happened, the check
 * refuses. The same statement sets the 30-second read timeout, so the read costs no extra statement.
 */
export async function invokeRead<I>(
	db: Database,
	actor: EvryActor,
	adapter: ReadAdapter<I>,
	input: I,
): Promise<SourceResult> {
	if (!adapter.allowed(actor)) throw new EvryRefusal("access_denied");
	const holder =
		actor.owner.kind === "account"
			? sql`SELECT 1 FROM account a WHERE a.id=${actor.accountId}::uuid AND ${currentAuthority(actor)} FOR SHARE OF a`
			: sql`SELECT 1 FROM seat s WHERE s.account_id=${actor.accountId}::uuid AND coalesce(s.plant_id,s.organization_id)=${actor.owner.id}::uuid
				AND s.ended_at IS NULL AND s.role=${actor.role} AND ${currentAuthority(actor)} FOR SHARE OF s`;
	return db.transaction(async (tx) => {
		const live = await tx.execute(
			sql`SELECT set_config('statement_timeout', ${String(LIMITS.readTimeoutMs)}, true) FROM (${holder}) live`,
		);
		if (!live.rows.length) throw new EvryRefusal("access_denied");
		return adapter.invoke(tx, actor, input);
	});
}
