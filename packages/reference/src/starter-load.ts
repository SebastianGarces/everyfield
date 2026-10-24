import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { hash } from "./hash.ts";

const source = z.strictObject({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), body: z.string() });
// Literal catalog extraction is frozen with its source bytes. Feature consumers refine their own fields.
const literal = z.record(z.string(), z.unknown());
const artifact = z.strictObject({
	sources: z.array(source),
	catalogs: z.strictObject({
		tasks: z.array(literal),
		teams: z.array(literal),
		documents: z.array(literal),
		launch: z.array(literal),
		phases: z.array(z.strictObject({ phase: z.number().int().min(0).max(6), name: z.string() })).length(7),
		criteria: z.array(z.strictObject({ phase: z.number().int().min(0).max(5), key: z.string() })),
	}),
});
export type Starter = z.infer<typeof artifact>;
type FrozenStarter = { starter: Starter; artifactSha256: string };

let frozen: Promise<FrozenStarter> | null = null;

function loadFrozen(): Promise<FrozenStarter> {
	frozen ??= readFrozen().catch((error: unknown) => {
		frozen = null;
		throw error;
	});
	return frozen;
}

function catalogFile(name: string): string {
	// Turbopack's file reader rejects a URL from another realm (`instanceof URL` fails). A string path is accepted.
	return fileURLToPath(new URL(name, import.meta.url).href);
}

async function readFrozen(): Promise<FrozenStarter> {
	const freeze = JSON.parse(await readFile(catalogFile("freeze.json"), "utf8"));
	const bytes = await readFile(catalogFile("artifacts.json"));
	if (typeof freeze.artifactSha256 !== "string" || hash(bytes) !== freeze.artifactSha256) {
		throw Error("reference_artifact_mismatch");
	}
	const result = artifact.parse(JSON.parse(bytes.toString("utf8")));
	for (const s of result.sources) if (hash(s.body) !== s.sha256) throw Error("reference_source_mismatch");
	return { starter: result, artifactSha256: freeze.artifactSha256 };
}

export async function loadStarter(): Promise<Starter> {
	return (await loadFrozen()).starter;
}

/** Artifact sha256 from the same cached read as `loadStarter`. */
export async function referenceArtifactSha256(): Promise<string> {
	return (await loadFrozen()).artifactSha256;
}
