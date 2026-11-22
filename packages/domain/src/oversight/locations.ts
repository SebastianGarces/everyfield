import * as C from "@everyfield/contracts/oversight";
import { sql } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { liveRows, type RequestActor } from "../access/session.ts";
import { linkActive, type Reader } from "../organizations/core.ts";
import { areaOf } from "../organizations/geography.ts";
import { seatOf } from "../organizations/seat.ts";

const iso = (column: string) => sql.raw(`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
const row = z.object({
	name: z.string().nullable(),
	timezone: z.string(),
	locations: z.array(
		z.object({
			city: z.string().nullable(),
			state_province: z.string().nullable(),
			country: z.string().nullable(),
			region_key: z.string().nullable(),
			effective_at: z.string(),
			runs: z.array(z.string()),
		}),
	),
});

export async function readLocationHistory(
	db: Reader,
	authority: RequestActor,
	plantId: string,
): Promise<C.LocationHistory | null> {
	const seat = seatOf(authority);
	if (!seat || !z.uuid().safeParse(plantId).success) return null;
	const o = sql`${seat.organization}::uuid`;
	const rows = await liveRows(
		db,
		seat.live,
		sql`WITH link AS (SELECT DISTINCT ON (k.plant_id) k.plant_id, k.shared_findings FROM affiliation k
		WHERE k.organization_id=${o} AND k.plant_id=${plantId}::uuid AND ${linkActive("k")} ORDER BY k.plant_id),
	geo AS (SELECT x.id, x.city, x.state_province, x.country, ri.canonical_key AS region_key, x.effective_at,
		lead(x.effective_at) OVER (ORDER BY x.effective_at, x.id) AS until
		FROM plant_geography x JOIN link l ON l.plant_id=x.plant_id
		LEFT JOIN reference_item ri ON ri.id=x.region_item_id AND ri.kind='geography_region')
	SELECT (SELECT p.name FROM plant p JOIN link l ON l.plant_id=p.id) AS name,
	(SELECT timezone FROM organization WHERE id=${o}) AS timezone,
	(SELECT coalesce(json_agg(json_build_object('city', g.city, 'state_province', g.state_province, 'country', g.country,
		'region_key', g.region_key, 'effective_at', ${iso("g.effective_at")},
		'runs', (SELECT coalesce(json_agg(${iso("r.ran_at")} ORDER BY r.ran_at DESC, r.id DESC), '[]')
			FROM network_intelligence_run r JOIN network_intelligence_plant c ON c.run_id=r.id AND c.plant_id=${plantId}::uuid
			JOIN link l ON l.shared_findings
			WHERE r.organization_id=${o} AND r.ran_at>=g.effective_at AND (g.until IS NULL OR r.ran_at<g.until)))
		ORDER BY g.effective_at DESC, g.id DESC), '[]') FROM geo g) AS locations`,
	);
	const r = rows?.[0] ? row.parse(rows[0]) : null;
	if (!r?.name) return null;
	return C.locationHistory.parse({
		plantId,
		name: r.name,
		timeZone: r.timezone,
		locations: r.locations.map((l) => ({
			city: l.city,
			stateProvince: l.state_province,
			country: l.country,
			region: areaOf(l.region_key),
			effectiveAt: l.effective_at,
			runs: l.runs,
		})),
	});
}
