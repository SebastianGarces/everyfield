import "../runs-in/domain.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	pickMethodologyCandidates,
	type MethodologyCandidates,
} from "../../../packages/domain/src/intelligence/candidates.ts";

type Case = {
	id: string;
	given: Record<string, { value?: unknown }>;
	action: { operation: string; arguments: MethodologyCandidates & { subject: string } };
	expected: { state: Record<string, unknown>; result: Record<string, unknown>; event: unknown };
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../docs/acceptance/intelligence.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const K = cases.find((c) => c.id === "PI-CASE-011");
assert.ok(K, "PI-CASE-011 is in docs/acceptance/intelligence.json");
const given = <T,>(name: string) => K.given[name]!.value as T;

test("AC:PI-CASE-011 retrieveMethodology keeps dense candidates of the plant's phase or no phase, sparse candidates of every phase with the phase boost only within the same fts_rank, carries the activated global generation and never returns an ended organization's body", () => {
	assert.equal(K.action.operation, "intelligence.retrieveMethodology");
	const { subject, ...args } = K.action.arguments;
	assert.equal(subject, "P");
	assert.equal(args.phase, given<number>("phase"));
	assert.deepEqual(args.dense_candidates, given("dense_candidates"));
	assert.deepEqual(args.sparse_candidates, given("sparse_candidates"));
	assert.equal(args.candidate_source, given("candidate_source"));
	assert.equal(args.ended_org_body, given("ended_org_body"));

	const before = structuredClone(args);
	const result = pickMethodologyCandidates(args);
	const changed = Object.fromEntries(
		Object.entries(args).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(before[k as keyof typeof before])),
	);

	assert.deepEqual(result.dense_ids, K.expected.result.dense_ids);
	assert.ok(!result.dense_ids.includes("C"), "the phase-1 dense candidate is dropped");
	assert.ok(result.dense_ids.includes("B"), "the no-phase dense candidate is kept");

	assert.deepEqual(result.sparse_ids, K.expected.result.sparse_ids);
	assert.ok(result.sparse_ids.includes("C"), "the phase-1 sparse candidate is kept");

	assert.equal(result.source, given("candidate_source"));
	assert.equal(result.source, "activated-global-generation");

	assert.equal(result.ended_org_body, K.expected.result.ended_org_body);
	assert.equal(result.ended_org_body, null);
	const body = given<string>("ended_org_body");
	assert.ok(!JSON.stringify(result).includes(`"${body}"`), "the ended organization's body is not in the result");
	assert.ok(!Object.values(result).flat().includes(body));

	assert.deepEqual(K.expected.state, {});
	assert.deepEqual(changed, K.expected.state, "the step changes none of its inputs");
	assert.deepEqual(Object.keys(result).sort(), ["dense_ids", "ended_org_body", "source", "sparse_ids"]);
	assert.equal(K.expected.event, null);
	assert.equal((result as { event?: unknown }).event ?? null, K.expected.event, "the step emits no event");
});

test("the sparse phase boost orders equal fts_rank candidates by plant phase, then no phase, then other phases", () => {
	const picked = pickMethodologyCandidates({
		phase: 2,
		dense_candidates: [],
		sparse_candidates: [
			{ passage: "other", phase: 4, fts_rank: 1 },
			{ passage: "general", phase: null, fts_rank: 1 },
			{ passage: "plant", phase: 2, fts_rank: 1 },
			{ passage: "worse", phase: 2, fts_rank: 2 },
		],
		candidate_source: "activated-global-generation",
		ended_org_body: null,
	});
	assert.deepEqual(picked.sparse_ids, ["plant", "general", "other", "worse"]);
});

test("a candidate source other than the activated global generation is refused", () => {
	assert.throws(() =>
		pickMethodologyCandidates({
			phase: 1,
			dense_candidates: [],
			sparse_candidates: [],
			candidate_source: "church-draft" as never,
			ended_org_body: null,
		}),
	);
});
