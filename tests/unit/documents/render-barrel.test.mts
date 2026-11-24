import "../runs-in/domain.mjs";
import assert from "node:assert/strict";
import { globSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const documents = fileURLToPath(new URL("../../../packages/domain/src/documents/", import.meta.url));
const load = async (file: string) =>
	(await import(pathToFileURL(documents + file).href)) as Readonly<Record<string, unknown>>;

const modules = [
	"render.ts",
	"doc-render.ts",
	"library-render.ts",
	"pdf-post.ts",
	...globSync("layouts/*.tsx", { cwd: documents }),
];
const renderers = new Map<unknown, string>();
for (const file of modules)
	for (const [name, value] of Object.entries(await load(file)))
		if (typeof value === "function") renderers.set(value, `${file} ${name}`);

const reachable = (exported: Readonly<Record<string, unknown>>) =>
	Object.entries(exported).flatMap(([name, value]) => [
		[name, value] as const,
		...(value && typeof value === "object"
			? Object.entries(value).map(([key, inner]) => [`${name}.${key}`, inner] as const)
			: []),
	]);

test("INV-structure: the documents barrel hands out no function of a render module, under any name, so a server action that imports it cannot render directly", async () => {
	assert.ok([...renderers.values()].includes("doc-render.ts renderDocFile"), "the render modules were read");
	assert.deepEqual(
		reachable(await load("index.ts"))
			.filter(([, value]) => renderers.has(value))
			.map(([name, value]) => `${name} is ${renderers.get(value)}`),
		[],
	);
});
