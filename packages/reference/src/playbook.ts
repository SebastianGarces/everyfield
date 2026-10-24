import { readFileSync } from "node:fs";
import { hash } from "./hash.ts";

export type PlaybookTeam = { description: string | null; version: string };

type Cache = { version: string; descriptions: Map<string, string> };

let cache: Cache | null = null;

function load(): Cache {
	if (cache) return cache;
	const freeze = JSON.parse(readFileSync(new URL("./freeze.json", import.meta.url), "utf8")) as {
		artifactSha256?: unknown;
	};
	const version = freeze.artifactSha256;
	if (typeof version !== "string" || !/^[a-f0-9]{64}$/.test(version)) throw new Error("reference_artifact_mismatch");
	const bytes = readFileSync(new URL("./artifacts.json", import.meta.url));
	if (hash(bytes) !== version) throw new Error("reference_artifact_mismatch");
	const artifact = JSON.parse(bytes.toString("utf8")) as { catalogs?: { teams?: unknown } };
	const teams = artifact.catalogs?.teams;
	if (!Array.isArray(teams)) throw new Error("reference_artifact_mismatch");
	const descriptions = new Map<string, string>();
	for (const team of teams) {
		if (typeof team !== "object" || team === null) throw new Error("reference_artifact_mismatch");
		const row = team as { teamKey?: unknown; description?: unknown };
		if (typeof row.teamKey !== "string" || typeof row.description !== "string") {
			throw new Error("reference_artifact_mismatch");
		}
		descriptions.set(row.teamKey, row.description);
	}
	cache = { version, descriptions };
	return cache;
}

/** One team's description from the frozen catalog. `version` is the catalog artifact sha256. */
export function playbookTeam(teamKey: string): PlaybookTeam {
	const catalog = load();
	return { description: catalog.descriptions.get(teamKey) ?? null, version: catalog.version };
}
