import { z } from "zod";

const phase = z.int().min(1).nullable();
export const methodologyCandidates = z.object({
	phase: z.int().min(1),
	dense_candidates: z.array(z.object({ passage: z.string().min(1), phase })),
	sparse_candidates: z.array(z.object({ passage: z.string().min(1), phase, fts_rank: z.int().min(1) })),
	candidate_source: z.literal("activated-global-generation"),
	ended_org_body: z.string().nullable(),
});
export type MethodologyCandidates = z.input<typeof methodologyCandidates>;

export type PickedCandidates = {
	dense_ids: string[];
	sparse_ids: string[];
	source: "activated-global-generation";
	ended_org_body: null;
};

const phaseBoostWithinSameRank = (plantPhase: number, candidatePhase: number | null) =>
	candidatePhase === plantPhase ? 0 : candidatePhase === null ? 1 : 2;

export function pickMethodologyCandidates(input: MethodologyCandidates): PickedCandidates {
	const given = methodologyCandidates.parse(input);
	const dense = given.dense_candidates.filter((d) => d.phase === null || d.phase === given.phase);
	const sparse = given.sparse_candidates
		.map((s, order) => ({ ...s, order, boost: phaseBoostWithinSameRank(given.phase, s.phase) }))
		.sort((a, b) => a.fts_rank - b.fts_rank || a.boost - b.boost || a.order - b.order);
	return {
		dense_ids: [...new Set(dense.map((d) => d.passage))],
		sparse_ids: [...new Set(sparse.map((s) => s.passage))],
		source: given.candidate_source,
		ended_org_body: null,
	};
}
