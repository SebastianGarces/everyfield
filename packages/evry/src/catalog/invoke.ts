import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import type { EvryActor } from "../context/actor.ts";
import { EvryRefusal } from "../context/errors.ts";
import { LIMITS } from "../context/limits.ts";
import type { ReadAdapter, SourceResult } from "./types.ts";

/**
 * evry.invokeRead: one native read under the actor's live authority. The native read runs in its own short transaction
 * with the 30-second read timeout, and each of its statements checks the live session, seat and lifecycle with the
 * shared lock-free check (C13, C27), so a sign-out or seat end never waits for it and stops it. A read whose access
 * ended returns no tenant data.
 */
export async function invokeRead<I>(
	db: Database,
	actor: EvryActor,
	adapter: ReadAdapter<I>,
	input: I,
): Promise<SourceResult> {
	if (!adapter.allowed(actor)) throw new EvryRefusal("access_denied");
	return db.transaction(async (tx) => {
		await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${LIMITS.readTimeoutMs}`));
		return adapter.invoke(tx, actor, input);
	});
}
