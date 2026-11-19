import "server-only";
import { z } from "zod";
import { defineReads } from "../../../server/platform/reads.ts";
import { loadPipelineBoard, loadPipelineGoals, loadPipelinePerson, pipelineActor } from "../pipeline-mount";

export const GET = defineReads(
	async () => {
		const who = await pipelineActor();
		return who.kind === "seat" ? who.authority : null;
	},
	"unavailable",
	(get) => ({
		goals: get(z.undefined(), (authority) => loadPipelineGoals(authority)),
		board: get(z.unknown(), (authority, query) => loadPipelineBoard(authority, query)),
		person: get(z.strictObject({ personId: z.string() }), (authority, v) => loadPipelinePerson(authority, v.personId)),
	}),
);
