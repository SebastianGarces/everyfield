import { readFile } from "node:fs/promises";
import { loadStarter } from "../../../packages/reference/src/starter.ts";
import { planGeneration, chunkEntries, completeGeneration } from "../../../packages/reference/src/bundle.ts";
import { loadApprovedSnapshot } from "../../../packages/reference/src/starter/verify/snapshot.ts";
import type { ValidationPolicy } from "../../../packages/reference/src/bundle.ts";
import { hash, canonical } from "../../../packages/reference/src/hash.ts";
export const starter = await loadStarter();
export const wiki = await loadApprovedSnapshot();
const freeze = JSON.parse(
	await readFile(new URL("../../../packages/reference/src/freeze.json", import.meta.url), "utf8"),
);
// The catalog digest is an operation input, not a frozen value, so fixtures name a synthetic reviewed digest.
export const identities = {
	sourceManifestSha256: freeze.sourceManifestSha256 as string,
	catalogSha256: hash("synthetic-reviewed-catalog-v1"),
};
// Explicit synthetic profile. No provider call or model semantics are claimed.
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
