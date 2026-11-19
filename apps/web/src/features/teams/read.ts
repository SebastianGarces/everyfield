import { getViewer } from "@/server/request-context";
import "server-only";
import { z } from "zod";
import { defineReads } from "../../server/platform/reads.ts";
import { listResponsibilities, previewResponsibilities } from "./responsibilities/server.ts";
import { loadTeam, loadTeams, outcome, readCatalog, readExport, readHistory, readRevision } from "./server.ts";
import { loadPersonTraining, loadTraining } from "./training/server.ts";

const team = z.strictObject({ teamId: z.string() });

export const GET = defineReads(
	async () => (await getViewer()).people ?? null,
	"unavailable",
	(get) => ({
		team: get(team, async (v, { teamId }) => {
			const view = await loadTeam(v, teamId);
			if (view.status === "failed") return { status: "lost" } as const;
			return { status: "ok", value: view.status === "found" ? view : null } as const;
		}),
		history: get(team, async (v, { teamId }) => outcome(await readHistory(v, teamId))),
		catalog: get(z.undefined(), async (v) => outcome(await readCatalog(v))),
		teams: get(z.undefined(), async (v) => ({ status: "ok", value: await loadTeams(v) }) as const),
		chart: get(z.strictObject({ includeArchived: z.boolean() }), async (v, { includeArchived }) => {
			const r = outcome(await readExport(v, includeArchived));
			return r.status === "ok" ? ({ status: "ok", value: { svg: r.value.svg, pdf: r.value.pdf } } as const) : r;
		}),
		responsibilities: get(team.extend({ page: z.int() }), (v, { teamId, page }) =>
			listResponsibilities(v, teamId, page),
		),
		offer: get(team, (v, { teamId }) => previewResponsibilities(v, teamId)),
		revision: get(team, async (v, { teamId }) => outcome(await readRevision(v, teamId))),
		training: get(team, (v, { teamId }) => loadTraining(v, teamId)),
		person: get(z.strictObject({ personId: z.string() }), (v, { personId }) => loadPersonTraining(v, personId)),
	}),
);
