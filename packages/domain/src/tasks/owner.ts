import { sql, type SQL } from "@everyfield/db/query";
import "server-only";

/** The stages a Person must be in for their account to own a follow-up (REQ-TSK-012). */
export const COMMITTED = sql`('core_group','launch_team','leader')`;
const seatOf = (account: SQL, plant: SQL) => sql`EXISTS(SELECT FROM seat s WHERE s.account_id=${account}
	AND s.plant_id=${plant} AND s.ended_at IS NULL AND s.accepted_at<=clock_timestamp())`;
const linked = (account: SQL, plant: SQL) => sql`SELECT FROM person e WHERE e.tenant_id=${plant}
	AND e.plant_id IS NOT NULL AND e.state='live' AND e.linked_account_id=${account}`;

/**
 * Why `account` cannot own a follow-up in `plant` now, or null when it can (REQ-TSK-012): a current accepted seat and a
 * live Person of the church in a committed stage linked to that exact account. A shared email or an unlinked contact
 * never owns one. The only definition of eligibility; every other form below reads it.
 */
export const ownerReason = (account: SQL, plant: SQL) => sql`(CASE
	WHEN NOT ${seatOf(account, plant)} THEN 'no_seat'
	WHEN NOT EXISTS(${linked(account, plant)}) THEN 'no_person'
	WHEN NOT EXISTS(${linked(account, plant)} AND e.stage IN ${COMMITTED}) THEN 'not_committed' END)`;
/**
 * Share-locks the seat and the linked Persons `ownerReason` read, as a number to read beside it. A concurrent seat
 * removal or demotion then waits for the write that names the owner, or this write sees it.
 */
export const lockOwner = (account: SQL, plant: SQL) => sql`((SELECT count(*) FROM (SELECT 1 FROM seat s
	WHERE s.account_id=${account} AND s.plant_id=${plant} FOR SHARE OF s) a)
	+ (SELECT count(*) FROM (SELECT 1 FROM person e WHERE e.tenant_id=${plant} AND e.linked_account_id=${account}
	FOR SHARE OF e) b))`;
export const eligibleOwner = (account: SQL, plant: SQL) => sql`(${ownerReason(account, plant)} IS NULL)`;

/**
 * The owner view of a task's assignee as JSON `{accountId, displayName, eligible, reason}`, or null without an
 * assignee. A follow-up's owner is its task's assignee; eligibility is a warning on that person, not a second value.
 * A meeting evaluation keeps its seated rule: only a missing seat makes its owner ineligible.
 */
export const ownerView = (account: SQL, plant: SQL, rule: "committed" | "seated" = "committed") => sql`(SELECT
	CASE WHEN ${account} IS NULL THEN NULL ELSE jsonb_build_object('accountId', ${account}, 'displayName',
	coalesce((SELECT display_name FROM seat_identity(${account})), ''), 'eligible', r.reason IS NULL, 'reason', r.reason) END
	FROM (SELECT ${rule === "committed" ? ownerReason(account, plant) : sql`(CASE WHEN NOT ${seatOf(account, plant)} THEN 'no_seat' END)`} AS reason) r)`;
