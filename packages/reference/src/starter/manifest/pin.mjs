// Pins the app's approved Wiki source to the living seed. `--check` fails on drift; `--write` updates approved.ts.
// Run after `bin/wiki promote` so the promoted version reaches the app's next Wiki install.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../../../../../", import.meta.url);
const file = new URL("approved.ts", import.meta.url);
const manifestPath = "docs/reference/wiki/manifest.json";
const payloadPath = "docs/reference/wiki/seed.json";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = await readFile(new URL(manifestPath, root));
const payload = await readFile(new URL(payloadPath, root));
const seed = JSON.parse(payload.toString("utf8"));
const payloadSha256 = sha(payload);
const block = `export const approvedSource = {
	version: "wiki-seed-${payloadSha256.slice(0, 12)}",
	manifestPath: "${manifestPath}",
	payloadPath: "${payloadPath}",
	manifestSha256: "${sha(manifest)}",
	payloadSha256: "${payloadSha256}",
	articles: ${seed.articles.length},
	sections: ${seed.sections.length},
	systemTemplates: ${seed.templates.length},
} as const satisfies WikiSource;`;
const current = await readFile(file, "utf8");
const pinned = /export const approvedSource = \{[\s\S]*?\} as const satisfies WikiSource;/;
if (!pinned.test(current)) throw Error("approved.ts has no approvedSource block");
const next = current.replace(pinned, block);
if (process.argv.includes("--write")) {
	await writeFile(file, next);
	console.log(next === current ? "Wiki pins already match the living seed." : "Wiki pins updated to the living seed.");
} else if (next !== current) {
	console.error(
		"Wiki pins differ from the living seed. Run: node packages/reference/src/starter/manifest/pin.mjs --write",
	);
	process.exitCode = 1;
} else console.log("Wiki pins match the living seed.");
