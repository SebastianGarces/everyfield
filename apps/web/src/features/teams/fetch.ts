import { readsFrom } from "../../components/get-reads.ts";
import type { GET } from "./read.ts";

const get = readsFrom<typeof GET>("/ministries/read");

export const reloadTeam = (teamId: string) => get("team", { teamId });
export const teamHistory = (teamId: string) => get("history", { teamId });
export const templateCatalog = () => get("catalog");
export const reloadTeams = () => get("teams");
export const exportChart = (includeArchived: boolean) => get("chart", { includeArchived });
export const listResponsibilities = (teamId: string, page: number) => get("responsibilities", { teamId, page });
export const previewResponsibilities = (teamId: string) => get("offer", { teamId });
export const readTeamRevision = (teamId: string) => get("revision", { teamId });
export const loadTraining = (teamId: string) => get("training", { teamId });

export async function loadPersonTraining(personId: string) {
	const r = await get("person", { personId });
	if ("summary" in r) return r;
	if (r.status === "lost") throw new Error("person training read lost");
	return { summary: r, credits: r };
}
