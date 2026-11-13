import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { liveRead } from "@everyfield/domain/access";
import { z } from "zod";
import type { EvryActor } from "./actor.ts";

/**
 * evry.resolveSelf: the signed-in account's own live person row in the actor's church, or null. One statement per
 * turn, with the lock-free live access check (C13, C27) in it, so a sign-out or seat end returns no row. In the account
 * context, or with no linked live person (never linked, or archived), the user has no row. The id is the only result.
 */
export async function resolveSelf(db: Pick<Database, "execute">, actor: EvryActor): Promise<string | null> {
	if (actor.owner.kind !== "plant" || actor.role === null) return null;
	const r = await db.execute(sql`
		SELECT p.id FROM person p
		WHERE p.linked_account_id=${actor.accountId}::uuid AND p.tenant_id=${actor.owner.id}::uuid
			AND p.plant_id=${actor.owner.id}::uuid AND p.state='live'
			AND ${liveRead({ session: actor.session, owner: actor.owner, seatId: actor.seatId ?? undefined })}
		LIMIT 1`);
	const first = r.rows[0];
	return first ? z.object({ id: z.uuid() }).parse(first).id : null;
}
