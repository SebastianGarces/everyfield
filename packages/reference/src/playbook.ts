import { loadStarter, referenceArtifactSha256 } from "./starter.ts";

export type PlaybookTeam = { description: string | null; version: string };

export { referenceArtifactSha256 };

/** One team's description from the frozen catalog. `version` is the catalog artifact sha256. */
export async function playbookTeam(teamKey: string): Promise<PlaybookTeam> {
	const starter = await loadStarter();
	const version = await referenceArtifactSha256();
	const row = starter.catalogs.teams.find((team) => team.teamKey === teamKey);
	const description = typeof row?.description === "string" ? row.description : null;
	return { description, version };
}
