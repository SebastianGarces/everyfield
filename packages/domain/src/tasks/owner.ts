import { sql, type SQL } from "@everyfield/db/query";
import "server-only";

export const COMMITTED = sql`('core_group','launch_team','leader')`;
const seatOf = (account: SQL, plant: SQL) => sql`EXISTS(SELECT FROM seat s WHERE s.account_id=${account}
	AND s.plant_id=${plant} AND s.ended_at IS NULL AND s.accepted_at<=clock_timestamp())`;
const linked = (account: SQL, plant: SQL) => sql`SELECT FROM person e WHERE e.tenant_id=${plant}
	AND e.plant_id IS NOT NULL AND e.state='live' AND e.linked_account_id=${account}`;

export const ownerReason = (account: SQL, plant: SQL) => sql`(CASE
	WHEN NOT ${seatOf(account, plant)} THEN 'no_seat'
	WHEN NOT EXISTS(${linked(account, plant)}) THEN 'no_person'
	WHEN NOT EXISTS(${linked(account, plant)} AND e.stage IN ${COMMITTED}) THEN 'not_committed' END)`;
export const lockOwner = (account: SQL, plant: SQL) => sql`((SELECT count(*) FROM (SELECT 1 FROM seat s
	WHERE s.account_id=${account} AND s.plant_id=${plant} FOR SHARE OF s) a)
	+ (SELECT count(*) FROM (SELECT 1 FROM person e WHERE e.tenant_id=${plant} AND e.linked_account_id=${account}
	FOR SHARE OF e) b))`;
export const eligibleOwner = (account: SQL, plant: SQL) => sql`(${ownerReason(account, plant)} IS NULL)`;

export const ownerView = (account: SQL, plant: SQL, rule: "committed" | "seated" = "committed") => sql`(SELECT
	CASE WHEN ${account} IS NULL THEN NULL ELSE jsonb_build_object('accountId', ${account}, 'displayName',
	coalesce((SELECT display_name FROM seat_identity(${account})), ''), 'eligible', r.reason IS NULL, 'reason', r.reason) END
	FROM (SELECT ${rule === "committed" ? ownerReason(account, plant) : sql`(CASE WHEN NOT ${seatOf(account, plant)} THEN 'no_seat' END)`} AS reason) r)`;
