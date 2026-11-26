import { readFile } from "node:fs/promises";
import { loadStarter } from "../../../packages/reference/src/starter.ts";
import { planGeneration, chunkEntries, completeGeneration } from "../../../packages/reference/src/bundle.ts";
import { loadApprovedSnapshot } from "../../../packages/reference/src/starter/verify/snapshot.ts";
import type { ValidationPolicy } from "../../../packages/reference/src/bundle.ts";
import { hash, canonical, stableId } from "../../../packages/reference/src/hash.ts";
export const starter = await loadStarter();
export const wiki = await loadApprovedSnapshot();
const freeze = JSON.parse(
	await readFile(new URL("../../../packages/reference/src/freeze.json", import.meta.url), "utf8"),
);
export const identities = {
	sourceManifestSha256: freeze.sourceManifestSha256 as string,
	catalogSha256: hash("synthetic-reviewed-catalog-v1"),
};
export const profile = {
	chunker: "fixed-codepoints-1200-v1",
	model: "synthetic-reference-proof-v1",
	dimensions: 3,
} as const;
export function fixture(key = "synthetic-R1") {
	const plan = planGeneration(starter, wiki, key, profile);
	const vectors = new Map(chunkEntries(plan.entries).map((p) => [p.key, [0.1, 0.2, 0.3]]));
	const bundle = completeGeneration(plan, identities, vectors);
	const policy: ValidationPolicy = {
		identities,
		plan,
		editorial: { approved: true, originalAvailable: true, conflicts: [] },
	};
	return { bundle, policy, manifestHash: hash(canonical(bundle)) };
}

type Entry = ReturnType<typeof fixture>["policy"]["plan"]["entries"][number];
export function revised(
	key: string,
	edit: (entry: Entry, base: ReturnType<typeof fixture>) => Record<string, unknown> | null,
	vector: readonly number[] = [0.4, 0.5, 0.6],
): ReturnType<typeof fixture> {
	const base = fixture(key);
	const entries = base.policy.plan.entries.map((e) => {
		const change = edit(e, base);
		if (!change) return e;
		const body = JSON.stringify({ ...JSON.parse(e.body), ...change });
		const contentHash = hash(body);
		return { ...e, body, contentHash, revisionId: stableId(`${key}:${e.id}:${contentHash}`) };
	});
	const plan = { ...base.policy.plan, key, entries } as Parameters<typeof completeGeneration>[0];
	const bundle = completeGeneration(plan, identities, new Map(chunkEntries(entries).map((p) => [p.key, vector])));
	return { bundle, policy: { ...base.policy, plan }, manifestHash: hash(canonical(bundle)) };
}
