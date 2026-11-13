import { sql, type SQL, type SQLWrapper } from "@everyfield/db/query";
import { seatHeld } from "../access/session.ts";

// The SQL that decides whose account photo a workspace sees (REQ-IDN-006). The byte read (avatar.ts), the Seats roster
// and the People list share it. It imports nothing from settings/core, so those reads stay light.

/** A lifecycle witness that is hiding something now. `alias` is a fixed table alias, never input. */
export const hiding = (alias: string, condition: SQL) =>
	sql`EXISTS(SELECT FROM lifecycle_witness ${sql.raw(alias)} WHERE ${sql.raw(alias)}.state NOT IN ('active','cancelled') AND ${condition})`;
/**
 * The account's current photo version as the people of one workspace (a plant or organization id) see it, as one
 * scalar subquery: set only while the account is active, holds a live seat there and no lifecycle witness hides the
 * account, that seat or the workspace (REQ-IDN-006). It names no viewer: the caller's own statement checks that the
 * viewer still holds a live seat in that workspace. The aliases are its own, so it nests inside a query on seat.
 */
export function workspaceAvatar(account: SQLWrapper, workspace: SQLWrapper) {
	return sql<string | null>`(SELECT av_a.avatar_object_id FROM account av_a JOIN seat av_s ON av_s.account_id=av_a.id
		WHERE av_a.id=${account} AND coalesce(av_s.plant_id,av_s.organization_id)=${workspace}
			AND av_a.registration_state='active' AND ${seatHeld("av_s")}
			AND NOT ${hiding("av_w", sql`(av_w.seat_id=av_s.id OR (av_w.kind='account' AND av_w.opaque_subject_id=av_a.id) OR (av_w.kind='plant' AND av_w.opaque_subject_id=${workspace}))`)}
		LIMIT 1)`;
}
/**
 * Whether one workspace (a plant or organization id) sees the account's current photo through oversight: a current
 * plant affiliation links that workspace to another where the account holds a live seat, so a sending church's or
 * network's seat holders see the planter and plant staff, and the plant's seat holders see the directors (Nora, Nov 12:
 * the photo shows where the name already shows). No lifecycle witness hides the affiliation or its plant, and
 * workspaceAvatar applies its own account and seat checks on the other side. Lock-free, so a seat or link that ends
 * stops the next read at once.
 */
export function oversightAvatar(account: SQLWrapper, workspace: SQLWrapper, version: SQLWrapper) {
	return sql<boolean>`EXISTS(SELECT FROM affiliation av_f
		WHERE av_f.plant_id IS NOT NULL AND ${workspace} IN (av_f.plant_id, av_f.organization_id)
			AND av_f.ended_at IS NULL AND av_f.accepted_at <= clock_timestamp()
			AND NOT ${hiding("av_fw", sql`(av_fw.affiliation_id=av_f.id OR (av_fw.kind='plant' AND av_fw.opaque_subject_id=av_f.plant_id))`)}
			AND ${workspaceAvatar(account, sql`(CASE WHEN av_f.plant_id=${workspace} THEN av_f.organization_id ELSE av_f.plant_id END)`)}=${version})`;
}
