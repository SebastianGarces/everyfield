import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import type { EvryActor } from "../context/actor.ts";
import { EvryRefusal } from "../context/errors.ts";
import { LIMITS } from "../context/limits.ts";
import type { ConversationFiles, ReadAdapter, SourceResult } from "./types.ts";

/**
 * evry.invokeRead: one native read under the actor's live authority. The native read runs in its own short transaction
 * with the 30-second read timeout, and each of its statements checks the live session, seat and lifecycle with the
 * shared lock-free check (C13, C27), so a sign-out or seat end never waits for it and stops it. A read whose access
 * ended returns no tenant data. A read of an attached file gets the turn's own conversation files.
 */
export async function invokeRead<I>(
	db: Database,
	actor: EvryActor,
	adapter: ReadAdapter<I>,
	input: I,
	files?: ConversationFiles,
): Promise<SourceResult> {
	if (!adapter.allowed(actor)) throw new EvryRefusal("access_denied");
	// A file is read before the transaction opens, so a slow bucket never holds a database connection.
	const loaded = adapter.load
		? await adapter.load(
				input,
				files ?? {
					read: async () => {
						throw new EvryRefusal("attachment_elsewhere");
					},
				},
			)
		: undefined;
	return db.transaction(async (tx) => {
		await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${LIMITS.readTimeoutMs}`));
		return adapter.invoke(tx, actor, input, loaded);
	});
}
