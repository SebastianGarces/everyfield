import { sql, type SQL, type SQLWrapper, type SqlLiteral } from "@everyfield/db/query";
import { seatHeld } from "../access/session.ts";

export const hiding = <AliasName extends string>(alias: SqlLiteral<AliasName>, condition: SQL) =>
	sql`EXISTS(SELECT FROM lifecycle_witness ${sql.raw(alias)} WHERE ${sql.raw(alias)}.state NOT IN ('active','cancelled') AND ${condition})`;
export function workspaceAvatar(account: SQLWrapper, workspace: SQLWrapper) {
	return sql<string | null>`(SELECT av_a.avatar_object_id FROM account av_a JOIN seat av_s ON av_s.account_id=av_a.id
		WHERE av_a.id=${account} AND coalesce(av_s.plant_id,av_s.organization_id)=${workspace}
			AND av_a.registration_state='active' AND ${seatHeld("av_s")}
			AND NOT ${hiding("av_w", sql`(av_w.seat_id=av_s.id OR (av_w.kind='account' AND av_w.opaque_subject_id=av_a.id) OR (av_w.kind='plant' AND av_w.opaque_subject_id=${workspace}))`)}
		LIMIT 1)`;
}
export function oversightAvatar(account: SQLWrapper, workspace: SQLWrapper, version: SQLWrapper) {
	return sql<boolean>`EXISTS(SELECT FROM affiliation av_f
		WHERE av_f.plant_id IS NOT NULL AND ${workspace} IN (av_f.plant_id, av_f.organization_id)
			AND av_f.ended_at IS NULL AND av_f.accepted_at <= clock_timestamp()
			AND NOT ${hiding("av_fw", sql`(av_fw.affiliation_id=av_f.id OR (av_fw.kind='plant' AND av_fw.opaque_subject_id=av_f.plant_id))`)}
			AND ${workspaceAvatar(account, sql`(CASE WHEN av_f.plant_id=${workspace} THEN av_f.organization_id ELSE av_f.plant_id END)`)}=${version})`;
}
