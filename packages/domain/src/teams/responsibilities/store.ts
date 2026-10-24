import { RESPONSIBILITY_CATALOG_KEY, RESPONSIBILITY_ITEM_KIND } from "@everyfield/contracts/teams/responsibilities";
import { sql, type SQL } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";

const GLOBAL = "00000000-0000-0000-0000-000000000000";
const tuples = (rows: SQL[]) => sql.join(rows, sql`, `);

/** Latest Playbook release. The offer stamps this id. Line text stays in the contract. */
export const catalogVersion = () => sql`(SELECT v.id FROM reference_version v
	JOIN reference_item i ON i.id = v.item_id
	WHERE i.kind = ${RESPONSIBILITY_ITEM_KIND} AND i.canonical_key = ${RESPONSIBILITY_CATALOG_KEY}
		AND i.tenant_id = ${GLOBAL}::uuid
	ORDER BY v.version_number DESC, v.id DESC
	LIMIT 1)`;

type VersionLine = { teamId: string; sourceVersionId: string; sourceLine: string; text: string };

/** The only insert used by team import. Same row shape as before this package. */
export function insertVersionLines(plantId: string, lines: readonly VersionLine[]): SQL | null {
	if (!lines.length) return null;
	return sql`INSERT INTO responsibility
		(id, plant_id, team_id, source_version_id, source_line, text, sort_order)
		SELECT v.id, ${plantId}::uuid, v.team_id, v.version, v.line, v.text, v.ord
		FROM (VALUES ${tuples(
			lines.map(
				(line, index) =>
					sql`(${randomUUID()}::uuid, ${line.teamId}::uuid, ${line.sourceVersionId}::uuid, ${line.sourceLine}, ${line.text}, ${index + 1}::int)`,
			),
		)}) AS v(id, team_id, version, line, text, ord)
		WHERE NOT EXISTS (SELECT 1 FROM responsibility r
			WHERE r.team_id = v.team_id AND r.source_version_id = v.version AND r.source_line = v.line)`;
}

export type OfferLine = { id: string; key: string; text: string; sortOrder: number; active: boolean };

/**
 * One source line per team, across catalog versions. A removed or edited line is already stored,
 * so a later version does not insert it again.
 */
export function insertOfferLines(
	plantId: string,
	teamId: string,
	versionId: string,
	lines: readonly OfferLine[],
): SQL | null {
	if (!lines.length) return null;
	return sql`INSERT INTO responsibility
		(id, plant_id, team_id, source_version_id, source_line, text, sort_order, removed_at)
		SELECT v.id, ${plantId}::uuid, ${teamId}::uuid, ${versionId}::uuid, v.line, v.text, v.ord,
			CASE WHEN v.active THEN NULL ELSE clock_timestamp() END
		FROM (VALUES ${tuples(
			lines.map(
				(line) => sql`(${line.id}::uuid, ${line.key}, ${line.text}, ${line.sortOrder}::int, ${line.active}::boolean)`,
			),
		)}) AS v(id, line, text, ord, active)
		WHERE NOT EXISTS (SELECT 1 FROM responsibility r
			WHERE r.team_id = ${teamId}::uuid AND r.plant_id = ${plantId}::uuid AND r.source_line = v.line)`;
}

export function stampOffer(
	plantId: string,
	teamId: string,
	decision: "accepted" | "declined",
	versionId: string,
	revision: string,
) {
	return sql`UPDATE team SET responsibility_offer = ${decision},
		responsibility_offer_version_id = ${versionId}::uuid, revision = revision + 1
		WHERE id = ${teamId}::uuid AND plant_id = ${plantId}::uuid AND revision = ${revision}::bigint`;
}

export function insertCustom(
	plantId: string,
	teamId: string,
	versionId: string,
	id: string,
	sourceLine: string,
	text: string,
	sortOrder: number,
) {
	return sql`INSERT INTO responsibility
		(id, plant_id, team_id, source_version_id, source_line, text, sort_order)
		VALUES (${id}::uuid, ${plantId}::uuid, ${teamId}::uuid, ${versionId}::uuid, ${sourceLine}, ${text}, ${sortOrder}::int)`;
}

export function saveText(plantId: string, id: string, text: string) {
	return sql`UPDATE responsibility SET text = ${text}, revision = revision + 1
		WHERE id = ${id}::uuid AND plant_id = ${plantId}::uuid AND removed_at IS NULL`;
}

export function saveCompleted(plantId: string, id: string, done: boolean, today: string) {
	return sql`UPDATE responsibility
		SET completed_on = CASE WHEN ${done}::boolean THEN ${today}::date ELSE NULL END, revision = revision + 1
		WHERE id = ${id}::uuid AND plant_id = ${plantId}::uuid AND removed_at IS NULL`;
}

export function markRemoved(plantId: string, id: string) {
	return sql`UPDATE responsibility SET removed_at = clock_timestamp(), revision = revision + 1
		WHERE id = ${id}::uuid AND plant_id = ${plantId}::uuid AND removed_at IS NULL`;
}
