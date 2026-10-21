import { sql, type SQL } from "@everyfield/db/query";
import { liveRead, writeVisibility } from "@everyfield/domain/access";
import type { EvryActor } from "./actor.ts";

/**
 * The actor still holds the exact context right now (C13): a live session of the same account, and its own account
 * context or a live seat in that plant or organization with the same role, with no lifecycle witness hiding any of them.
 * Every write statement includes it and share-locks the session (C27), so a sign-out waits for the write to commit.
 */
export function currentAuthority(actor: EvryActor): SQL {
	const session = sql`EXISTS(SELECT FROM access_session(${actor.session}::uuid) i WHERE i.account_id=${actor.accountId}::uuid AND i.registration_state='active')`;
	const seat =
		actor.owner.kind === "account"
			? sql`${actor.owner.id}::uuid=${actor.accountId}::uuid`
			: sql`EXISTS(SELECT FROM seat s WHERE s.account_id=${actor.accountId}::uuid AND coalesce(s.plant_id,s.organization_id)=${actor.owner.id}::uuid AND s.ended_at IS NULL AND s.role=${actor.role})`;
	return sql`(${session} AND ${seat} AND ${writeVisibility(actor.accountId, actor.owner)})`;
}

/**
 * The same exact context and role for a read, through the shared lock-free check (C27): a read takes no session lock,
 * so a sign-out never waits for it, and a stream or worker still loses access the moment the session or seat ends.
 */
export function liveAuthority(actor: EvryActor): SQL {
	const context = actor.authority.actor.context;
	return liveRead(
		context.kind === "seat"
			? { session: actor.session, owner: actor.owner, seatId: context.seatId, role: context.role }
			: { session: actor.session, owner: actor.owner },
	);
}
