import type { RegionArea } from "@everyfield/contracts/oversight";
import type { Transaction } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import "server-only";
import { z } from "zod";
import { liveAccess, liveRead, liveRows, type RequestActor } from "../access/session.ts";
import omb from "../../../../docs/reference/geography/omb-23-01/areas.json" with { type: "json" };
import type { GeographyReference } from "./profile.ts";

// Reporting Regions (REQ-PI-044): the official July 2023 OMB Bulletin 23-01 metropolitan and micropolitan statistical
// areas, built word for word from the Census delineation files in docs/reference/geography/omb-23-01 (build.py). The
// database holds the validated reference release, its dataset version and one geography_region item per area, keyed
// `omb-23-01/<CBSA code>`; titles, types, counties and principal cities stay in the packaged list. A place matches an
// area only where the official list names it as a principal city: nothing is geocoded, and a place that matches more
// than one area is never resolved to the first one.

type Area = (typeof omb.areas)[number];
const GLOBAL = "00000000-0000-0000-0000-000000000000";
export const RELEASE_KEY = "geography/omb-23-01";
const DATASET_KEY = "omb-23-01";
const BY_CODE = new Map<string, Area>(omb.areas.map((a) => [a.code, a]));

/** The reference item key of the area with CBSA `code`. */
export const regionKey = (code: string) => `${DATASET_KEY}/${code}`;
/** The area a region item key names, or null for any other key. */
export function areaOf(key: string | null): RegionArea | null {
	const code = key?.startsWith(`${DATASET_KEY}/`) ? key.slice(DATASET_KEY.length + 1) : null;
	const a = code ? BY_CODE.get(code) : undefined;
	return a ? { code: a.code, title: a.title, type: a.type as RegionArea["type"] } : null;
}
/** The states an area's counties lie in (a multistate area stays one Region). */
export const statesOf = (code: string) => BY_CODE.get(code)?.states ?? [];

const STATES: Record<string, string> = {
	alabama: "AL",
	alaska: "AK",
	arizona: "AZ",
	arkansas: "AR",
	california: "CA",
	colorado: "CO",
	connecticut: "CT",
	delaware: "DE",
	"district of columbia": "DC",
	florida: "FL",
	georgia: "GA",
	hawaii: "HI",
	idaho: "ID",
	illinois: "IL",
	indiana: "IN",
	iowa: "IA",
	kansas: "KS",
	kentucky: "KY",
	louisiana: "LA",
	maine: "ME",
	maryland: "MD",
	massachusetts: "MA",
	michigan: "MI",
	minnesota: "MN",
	mississippi: "MS",
	missouri: "MO",
	montana: "MT",
	nebraska: "NE",
	nevada: "NV",
	"new hampshire": "NH",
	"new jersey": "NJ",
	"new mexico": "NM",
	"new york": "NY",
	"north carolina": "NC",
	"north dakota": "ND",
	ohio: "OH",
	oklahoma: "OK",
	oregon: "OR",
	pennsylvania: "PA",
	"rhode island": "RI",
	"south carolina": "SC",
	"south dakota": "SD",
	tennessee: "TN",
	texas: "TX",
	utah: "UT",
	vermont: "VT",
	virginia: "VA",
	washington: "WA",
	"west virginia": "WV",
	wisconsin: "WI",
	wyoming: "WY",
	"puerto rico": "PR",
};
const CODES = new Set(Object.values(STATES));
const NAMES = new Map(
	Object.entries(STATES).map(([name, code]) => [code, name.replace(/\b\w/g, (c) => c.toUpperCase())]),
);
/** "Texas" for "TX"; "District of Columbia" keeps its lowercase "of". */
export const stateName = (code: string) => (NAMES.get(code) ?? code).replace(" Of ", " of ");
const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").trim().toLowerCase().replace(/\s+/g, " ");
/** The two-letter code of a US state written as "TX", "tx" or "Texas"; null for anything else. */
export function stateCode(raw: string | null): string | null {
	if (!raw) return null;
	const f = fold(raw).replace(/\./g, "");
	if (CODES.has(f.toUpperCase())) return f.toUpperCase();
	return STATES[f] ?? null;
}
/** Blank, "US", "USA" or "United States": the only country the official list covers. */
export function inUnitedStates(country: string | null): boolean {
	const f = fold(country ?? "").replace(/\./g, "");
	return ["", "us", "usa", "united states", "united states of america"].includes(f);
}
/** "US" for the United States, else the country as written; null when blank. */
export function countryKey(country: string | null): string | null {
	if (!country?.trim()) return null;
	return inUnitedStates(country) ? "US" : country.trim();
}

/**
 * The areas whose official principal cities include this place. With a state, only that state's place; without one,
 * every state's place of that name, so a name several states share makes the planter choose.
 */
export function matchAreas(locality: {
	city: string | null;
	stateProvince: string | null;
	country: string | null;
}): RegionArea[] {
	const city = fold(locality.city ?? "");
	if (!city || !inUnitedStates(locality.country)) return [];
	const typed = locality.stateProvince?.trim() ? stateCode(locality.stateProvince) : null;
	if (locality.stateProvince?.trim() && !typed) return [];
	return omb.areas
		.filter((a) => a.principalCities.some((p) => fold(p.name) === city && (!typed || p.state === typed)))
		.map((a) => ({ code: a.code, title: a.title, type: a.type as RegionArea["type"] }));
}

/** The validated dataset version of the OMB release, or null before it is installed. */
export const datasetVersion = sql`(SELECT v.id FROM reference_version v JOIN reference_item i ON i.id=v.item_id
	JOIN reference_release r ON r.id=v.release_id WHERE i.kind='geography_dataset' AND i.canonical_key=${DATASET_KEY}
	AND i.tenant_id=${GLOBAL}::uuid AND r.state='validated' AND r.validated_at IS NOT NULL LIMIT 1)`;

/**
 * The organizations adapter's candidate check for organizations.correctReportingLocation: the region item ids the
 * official list offers for this place, so a save can only pick one of them.
 */
export const geographyReference: GeographyReference = {
	async candidates(tx: Transaction, input) {
		const keys = matchAreas(input.locality).map((a) => regionKey(a.code));
		if (!keys.length) return [];
		const { rows } = await tx.execute<{ id: string }>(sql`SELECT i.id FROM reference_item i
			WHERE i.kind='geography_region' AND i.tenant_id=${GLOBAL}::uuid AND i.canonical_key = ANY(${sql.param(keys)}::text[])
			AND ${input.referenceVersionId}::uuid = ${datasetVersion}`);
		return rows.map((r) => r.id);
	},
};

const SOURCE = new URL("../../../../docs/reference/geography/omb-23-01/areas.json", import.meta.url);
/**
 * Installs the OMB 23-01 release once: a validated global reference release whose manifest hash is the packaged list's
 * SHA-256, its dataset item and version, and one geography_region item per area. A second run changes nothing. It
 * writes global reference rows, so it runs with the owner login (the development seed and tests), never a request.
 */
export async function installGeographyRelease(db: Pick<Transaction, "execute">) {
	const hash = createHash("sha256").update(readFileSync(SOURCE)).digest("hex");
	const regions = omb.areas.map((a) => regionKey(a.code));
	await db.execute(sql`WITH r AS (INSERT INTO reference_release (release_key,artifact_locator,manifest_hash,state,
		complete_at,validated_at,approval_locator,approval_hash,chunker_version,embedding_profile,embedding_dimensions,
		tenant_id,expected_passages)
	VALUES (${RELEASE_KEY},'docs/reference/geography/omb-23-01/areas.json',${hash},'validated',clock_timestamp(),
		clock_timestamp(),'docs/reference/geography/omb-23-01/README.md',${hash},'none','none',1,${GLOBAL}::uuid,0)
	ON CONFLICT (release_key) DO NOTHING RETURNING id),
	d AS (INSERT INTO reference_item (kind,canonical_key,tenant_id) VALUES ('geography_dataset',${DATASET_KEY},${GLOBAL}::uuid)
		ON CONFLICT (kind,canonical_key) DO NOTHING RETURNING id),
	v AS (INSERT INTO reference_version (item_id,release_id,version_number,artifact_path,content_hash,source_credit)
		SELECT d.id,r.id,1,'docs/reference/geography/omb-23-01/areas.json',${hash},
			${"U.S. Census Bureau, delineation files for OMB Bulletin 23-01 (July 2023)"} FROM d,r RETURNING id)
	INSERT INTO reference_item (kind,canonical_key,tenant_id)
		SELECT 'geography_region',k,${GLOBAL}::uuid FROM unnest(${sql.param(regions)}::text[]) k
		ON CONFLICT (kind,canonical_key) DO NOTHING`);
}

/** The latest reporting location row of plant `p` (an SQL plant id), for a LATERAL join: locality and Region. */
export const latestGeography = (p: SQL) => sql`(SELECT x.* FROM plant_geography x WHERE x.plant_id=${p}
	ORDER BY x.effective_at DESC, x.id DESC LIMIT 1)`;

const reportingRow = z.object({
	revision: z.string(),
	admin: z.boolean(),
	profile_city: z.string().nullable(),
	profile_state: z.string().nullable(),
	profile_country: z.string().nullable(),
	has_location: z.boolean(),
	city: z.string().nullable(),
	state_province: z.string().nullable(),
	country: z.string().nullable(),
	region_key: z.string().nullable(),
	version_id: z.string().nullable(),
});
/**
 * The church settings' reporting location (geography.listReportingRegionCandidates' seat read): the plant's latest
 * reporting city, state and country (its profile's until one is saved), the chosen Region, the plant revision a save
 * expects, the installed official dataset version and whether this seat may change it (Owner or Admin). Null for any
 * actor but a live seat of this plant. One statement.
 */
export async function readReportingLocation(db: Pick<Transaction, "execute">, authority: RequestActor) {
	const context = authority.actor.context;
	if (context.kind !== "seat" || context.owner.kind !== "plant") return null;
	const p = sql`${context.owner.id}::uuid`;
	const rows = await liveRows(
		db,
		liveRead(liveAccess(authority)),
		sql`SELECT pl.revision::text AS revision, ${context.role !== "member"}::boolean AS admin, pl.city AS profile_city,
			pl.state_province AS profile_state, pl.country AS profile_country, g.id IS NOT NULL AS has_location,
			g.city, g.state_province, g.country, i.canonical_key AS region_key, ${datasetVersion} AS version_id
		FROM plant pl LEFT JOIN LATERAL ${latestGeography(sql`pl.id`)} g ON true
		LEFT JOIN reference_item i ON i.id=g.region_item_id AND i.kind='geography_region'
		WHERE pl.id=${p}`,
	);
	if (!rows?.[0]) return null;
	const r = reportingRow.parse(rows[0]);
	const locality = r.has_location
		? { city: r.city, stateProvince: r.state_province, country: r.country }
		: { city: r.profile_city, stateProvince: r.profile_state, country: r.profile_country };
	return {
		revision: r.revision,
		canEdit: r.admin,
		locality,
		region: areaOf(r.region_key),
		referenceVersionId: r.version_id,
	};
}

/**
 * The official areas a typed place matches, with the region item ids a save names. Empty when the place is not a
 * principal city in the list. Needs a live seat of a plant; reads only global reference rows. One statement.
 */
export async function suggestRegions(
	db: Pick<Transaction, "execute">,
	authority: RequestActor,
	locality: { city: string | null; stateProvince: string | null; country: string | null },
) {
	const context = authority.actor.context;
	if (context.kind !== "seat" || context.owner.kind !== "plant") return null;
	const areas = matchAreas(locality);
	const keys = areas.map((a) => regionKey(a.code));
	const rows = await liveRows(
		db,
		liveRead(liveAccess(authority)),
		sql`SELECT i.id, i.canonical_key FROM reference_item i WHERE i.kind='geography_region'
			AND i.tenant_id=${GLOBAL}::uuid AND i.canonical_key = ANY(${sql.param(keys)}::text[])`,
	);
	if (!rows) return null;
	const ids = new Map(rows.map((r) => [String(r.canonical_key), String(r.id)]));
	return areas.flatMap((a) => {
		const id = ids.get(regionKey(a.code));
		return id ? [{ regionItemId: id, area: a }] : [];
	});
}
