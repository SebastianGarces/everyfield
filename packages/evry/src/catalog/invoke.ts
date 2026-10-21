import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import type { EvryActor } from "../context/actor.ts";
import { currentAuthority } from "../context/authority.ts";
import { EvryRefusal } from "../context/errors.ts";
import { LIMITS } from "../context/limits.ts";
import type { ReadAdapter, SourceResult } from "./types.ts";

/**
 * evry.invokeRead: one native read under the actor's live authority (C13, C22). The read transaction's first
 * statement checks the live session, seat, role and lifecycle as a plain predicate and sets the 30-second read
 * timeout, so the check costs no extra statement. Evry adds no lock: only access_session()'s own share lock on the
 * session row lasts until this short read commits. The gap between the check and the native read closes with the
 * WP-011 root fix (C21).
 */
export async function invokeRead<I>(
	db: Database,
	actor: EvryActor,
	adapter: ReadAdapter<I>,
	input: I,
): Promise<SourceResult> {
	if (!adapter.allowed(actor)) throw new EvryRefusal("access_denied");
	return db.transaction(async (tx) => {
		const live = await tx.execute(
			sql`SELECT set_config('statement_timeout', ${String(LIMITS.readTimeoutMs)}, true) WHERE ${currentAuthority(actor)}`,
		);
		if (!live.rows.length) throw new EvryRefusal("access_denied");
		return adapter.invoke(tx, actor, input);
	});
}
