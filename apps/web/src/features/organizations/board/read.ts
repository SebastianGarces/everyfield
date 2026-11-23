import "server-only";
import { organizationSeat } from "@/server/request-context";
import { z } from "zod";
import { defineReads } from "../../../server/platform/reads.ts";
import { loadMergeReview, loadPipelineBoard, loadPipelineGoals, loadPipelinePerson } from "../pipeline-mount";

export const GET = defineReads(
	async () => (await organizationSeat())?.authority ?? null,
	"unavailable",
	(get) => ({
		goals: get(z.undefined(), (authority) => loadPipelineGoals(authority)),
		board: get(z.unknown(), (authority, query) => loadPipelineBoard(authority, query)),
		person: get(z.strictObject({ personId: z.string() }), (authority, v) => loadPipelinePerson(authority, v.personId)),
		merge: get(z.unknown(), (authority, input) => loadMergeReview(authority, input)),
	}),
);
