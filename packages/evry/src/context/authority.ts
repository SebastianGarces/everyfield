import { sql, type SQL } from "@everyfield/db/query";
import { writeVisibility } from "@everyfield/domain/access";
import type { EvryActor } from "./actor.ts";

/**
 * The actor still holds the exact context right now: a live session of the same account, and its own account context
 * or a live seat in that plant or organization, with no lifecycle witness hiding any of them. Every read and write
 * statement includes it, so a long-lived stream or worker loses access the moment the session or seat ends.
 */
export function currentAuthority(actor: EvryActor): SQL {
	const session = sql`EXISTS(SELECT FROM access_session(${actor.session}::uuid) i WHERE i.account_id=${actor.accountId}::uuid AND i.registration_state='active')`;
	const seat =
		actor.owner.kind === "account"
			? sql`${actor.owner.id}::uuid=${actor.accountId}::uuid`
			: sql`EXISTS(SELECT FROM seat s WHERE s.account_id=${actor.accountId}::uuid AND coalesce(s.plant_id,s.organization_id)=${actor.owner.id}::uuid AND s.ended_at IS NULL)`;
	return sql`(${session} AND ${seat} AND ${writeVisibility(actor.accountId, actor.owner)})`;
}
