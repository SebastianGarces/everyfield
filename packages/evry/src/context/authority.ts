import { sql, type SQL } from "@everyfield/db/query";
import { liveRead, writeVisibility } from "@everyfield/domain/access";
import type { Database } from "@everyfield/db/client";
import type { EvryActor } from "./actor.ts";
import { EvryRefusal } from "./errors.ts";

const activeSession = (actor: EvryActor) =>
	sql`EXISTS(SELECT FROM access_session(${actor.session}::uuid) i WHERE i.account_id=${actor.accountId}::uuid AND i.registration_state='active')`;

export function currentAuthority(actor: EvryActor): SQL {
	const session = activeSession(actor);
	const seat =
		actor.owner.kind === "account"
			? sql`${actor.owner.id}::uuid=${actor.accountId}::uuid`
			: sql`EXISTS(SELECT FROM seat s WHERE s.account_id=${actor.accountId}::uuid AND coalesce(s.plant_id,s.organization_id)=${actor.owner.id}::uuid AND s.ended_at IS NULL AND s.role=${actor.role})`;
	const context =
		actor.owner.kind === "organization"
			? sql`EXISTS(SELECT FROM organization o WHERE o.id=${actor.owner.id}::uuid AND o.kind=${actor.contextKind} AND o.kind=${actor.owner.organizationKind})`
			: sql`${actor.contextKind === actor.owner.kind}::boolean`;
	return sql`(${session} AND ${seat} AND ${context} AND ${writeVisibility(actor.accountId, actor.owner)})`;
}

export function liveAuthority(actor: EvryActor): SQL {
	return liveRead(
		actor.seatId && actor.role
			? { session: actor.session, owner: actor.owner, seatId: actor.seatId, role: actor.role }
			: { session: actor.session, owner: actor.owner },
	);
}

export function movedChurch(actor: EvryActor, conversation: SQL): SQL {
	if (!actor.seatId) return sql`false`;
	const elsewhere = sql`EXISTS(SELECT FROM seat s WHERE s.account_id=m.account_id AND coalesce(s.plant_id,s.organization_id)<>m.tenant_id
		AND s.ended_at IS NULL AND s.accepted_at<=clock_timestamp())`;
	return sql`EXISTS(SELECT FROM conversation m WHERE m.id=${conversation} AND m.account_id=${actor.accountId}::uuid AND m.context_kind<>'account'
		AND CASE WHEN m.tenant_id<>${actor.owner.id}::uuid THEN ${currentAuthority(actor)}
			ELSE NOT EXISTS(SELECT FROM seat s WHERE s.id=${actor.seatId}::uuid AND s.ended_at IS NULL) AND ${activeSession(actor)} AND ${elsewhere} END)`;
}

export async function refusedFor(db: Database, actor: EvryActor, conversation: SQL) {
	const r = await db.execute(sql`SELECT ${movedChurch(actor, conversation)} AS moved`);
	return new EvryRefusal(r.rows[0]?.moved === true ? "church_changed" : "not_found");
}
