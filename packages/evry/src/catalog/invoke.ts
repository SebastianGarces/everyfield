import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import type { EvryActor } from "../context/actor.ts";
import { liveAuthority } from "../context/authority.ts";
import { EvryRefusal } from "../context/errors.ts";
import { LIMITS } from "../context/limits.ts";
import type { ReadAdapter, SourceResult } from "./types.ts";

/**
 * evry.invokeRead: one native read under the actor's live authority (C13, C22). Its first statement checks the live
 * session, seat, role and lifecycle with the shared lock-free check (C27), so a seat end, role change or sign-out never
 * waits for a read. The native read then runs in its own short transaction with the 30-second read timeout and checks
 * access again in its own statements.
 */
export async function invokeRead<I>(
	db: Database,
	actor: EvryActor,
	adapter: ReadAdapter<I>,
	input: I,
): Promise<SourceResult> {
	if (!adapter.allowed(actor)) throw new EvryRefusal("access_denied");
	const live = await db.execute(sql`SELECT ${liveAuthority(actor)} AS live`);
	if (live.rows[0]?.live !== true) throw new EvryRefusal("access_denied");
	return db.transaction(async (tx) => {
		await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${LIMITS.readTimeoutMs}`));
		return adapter.invoke(tx, actor, input);
	});
}
