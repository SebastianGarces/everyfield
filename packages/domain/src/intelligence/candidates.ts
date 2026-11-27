import { z } from "zod";

const journeyPhase = z.int().min(0).max(6);
const phase = journeyPhase.nullable();
export const methodologyCandidates = z.object({
	phase: journeyPhase,
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

const FUSION_K = 60;

export function fuseCandidates(picked: PickedCandidates): string[] {
	const score = new Map<string, number>();
	for (const ids of [picked.dense_ids, picked.sparse_ids])
		ids.forEach((id, at) => score.set(id, (score.get(id) ?? 0) + 1 / (FUSION_K + at + 1)));
	return [...score.keys()].sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0));
}
