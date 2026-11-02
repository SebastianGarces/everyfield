// WP-032: a deployed server bundle holds only the files in each route's trace (`.nft.json`). The reference loader
// reads freeze.json and artifacts.json at run time, so every route whose server chunks contain the loader must trace
// both files. Run after `pnpm build`; CI runs it right after the production build step.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const app = path.join(root, "apps/web/.next/server/app");
const REQUIRED = ["packages/reference/src/freeze.json", "packages/reference/src/artifacts.json"];
// The loader's own error code. It survives minification, so it marks each chunk that holds the loader.
const LOADER_MARK = "reference_artifact_mismatch";
const DOCUMENT_ROUTES = ["(product)/(frame)/documents/page", "(product)/(frame)/documents/preview/route"];

function traces(dir) {
	return readdirSync(dir, { recursive: true })
		.filter((name) => name.endsWith(".js.nft.json"))
		.map((name) => {
			const file = path.join(dir, name);
			const base = path.dirname(file);
			const { files } = JSON.parse(readFileSync(file, "utf8"));
			const resolved = files.map((entry) => path.resolve(base, entry));
			return { route: name.slice(0, -".js.nft.json".length), files: resolved };
		});
}

const chunkHolds = new Map();
function holdsLoader(file) {
	if (!chunkHolds.has(file)) {
		chunkHolds.set(file, file.endsWith(".js") && readFileSync(file, "utf8").includes(LOADER_MARK));
	}
	return chunkHolds.get(file);
}

test("every route that bundles the reference loader traces freeze.json and artifacts.json", () => {
	assert.ok(existsSync(app), `no production build at ${app}: run pnpm build first`);
	const loaderRoutes = traces(app).filter(({ files }) =>
		files.some(
			(file) => file.includes(`${path.sep}.next${path.sep}server${path.sep}chunks${path.sep}`) && holdsLoader(file),
		),
	);
	const names = loaderRoutes.map(({ route }) => route);
	// Guards the detection itself: the Documents page and its PDF route always load the starter catalog.
	for (const route of DOCUMENT_ROUTES)
		assert.ok(names.includes(route), `${route} does not bundle the reference loader`);

	const missing = loaderRoutes.flatMap(({ route, files }) =>
		REQUIRED.filter((need) => !files.includes(path.join(root, need))).map((need) => `${route}: ${need}`),
	);
	assert.deepEqual(missing, [], "routes whose deployed bundle would throw ENOENT");
});
