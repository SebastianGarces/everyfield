import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import type { EvryActor } from "../context/actor.ts";
import { EvryRefusal } from "../context/errors.ts";
import { LIMITS } from "../context/limits.ts";
import type { NativePorts } from "../proposals/types.ts";
import type { ReadAdapter, SourceResult } from "./types.ts";

export async function invokeRead<I>(
	db: Database,
	actor: EvryActor,
	adapter: ReadAdapter<I>,
	input: I,
	native: NativePorts | null = null,
): Promise<SourceResult> {
	if (!adapter.allowed(actor)) throw new EvryRefusal("access_denied");
	return db.transaction(async (tx) => {
		await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${LIMITS.readTimeoutMs}`));
		return adapter.invoke(tx, actor, input, native);
	});
}
