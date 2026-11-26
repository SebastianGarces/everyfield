import { sql, type SQL, type SqlLiteral } from "@everyfield/db/query";
import { liveRead, writeVisibility } from "@everyfield/domain/access";
import type { Database } from "@everyfield/db/client";
import { owner } from "@everyfield/contracts/common";
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

export const fromDiscovery = <A extends string>(alias: SqlLiteral<A>) =>
	`(${alias}.context_kind='account' AND ${alias}.tenant_id=${alias}.account_id AND EXISTS(SELECT FROM discovery dc
		WHERE dc.account_id=${alias}.account_id AND dc.converted_at IS NOT NULL AND ${alias}.created_at<dc.converted_at))`;
export const discoveryChat = <A extends string>(alias: SqlLiteral<A>) => sql.raw(fromDiscovery(alias));

export function discoveryRead<A extends string>(actor: EvryActor, alias: SqlLiteral<A>): SQL {
	const account = owner.parse({ kind: "account", id: actor.accountId });
	return sql`(${sql.raw(alias)}.account_id=${actor.accountId}::uuid AND ${discoveryChat(alias)}
		AND ${liveRead({ session: actor.session, owner: account })})`;
}

export const discoveryHeld = (actor: EvryActor, conversation: SQL) =>
	sql`EXISTS(SELECT FROM conversation dh WHERE dh.id=${conversation} AND ${discoveryRead(actor, "dh")})`;

export async function refusedFor(db: Database, actor: EvryActor, conversation: SQL) {
	const r = await db.execute(
		sql`SELECT ${movedChurch(actor, conversation)} AS moved, ${discoveryHeld(actor, conversation)} AS discovery`,
	);
	const row = r.rows[0];
	return new EvryRefusal(
		row?.discovery === true ? "discovery_read_only" : row?.moved === true ? "church_changed" : "not_found",
	);
}
