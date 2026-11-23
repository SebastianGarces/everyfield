import { plantSeat } from "@/server/request-context";
import "server-only";
import { z } from "zod";
import { defineReads } from "../../server/platform/reads.ts";
import { listResponsibilities, previewResponsibilities } from "./responsibilities/server.ts";
import { outcomeOf } from "@everyfield/contracts/common";
import { loadTeam, loadTeams, readCatalog, readExport, readHistory, readRevision } from "./server.ts";
import { loadPersonTraining, loadTraining } from "./training/server.ts";

const team = z.strictObject({ teamId: z.string() });

export const GET = defineReads(plantSeat, "unavailable", (get) => ({
	team: get(team, async (v, { teamId }) => {
		const view = await loadTeam(v, teamId);
		if (view.status === "failed") return { status: "lost" } as const;
		return { status: "ok", value: view.status === "found" ? view : null } as const;
	}),
	history: get(team, async (v, { teamId }) => outcomeOf(await readHistory(v, teamId))),
	catalog: get(z.undefined(), async (v) => outcomeOf(await readCatalog(v))),
	teams: get(z.undefined(), async (v) => ({ status: "ok", value: await loadTeams(v) }) as const),
	chart: get(z.strictObject({ includeArchived: z.boolean() }), async (v, { includeArchived }) => {
		const r = outcomeOf(await readExport(v, includeArchived));
		return r.status === "ok" ? ({ status: "ok", value: { svg: r.value.svg, pdf: r.value.pdf } } as const) : r;
	}),
	responsibilities: get(team.extend({ page: z.int() }), (v, { teamId, page }) => listResponsibilities(v, teamId, page)),
	offer: get(team, (v, { teamId }) => previewResponsibilities(v, teamId)),
	revision: get(team, async (v, { teamId }) => outcomeOf(await readRevision(v, teamId))),
	training: get(team, (v, { teamId }) => loadTraining(v, teamId)),
	person: get(z.strictObject({ personId: z.string() }), (v, { personId }) => loadPersonTraining(v, personId)),
}));
