import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
export type { Starter } from "./starter-load.ts";
export { loadStarter, referenceArtifactSha256 } from "./starter-load.ts";

export async function verifyCheckout(
	root: URL,
	expectedCatalogSha256?: string,
): Promise<{ ok: boolean; issues: { code: string; path: string }[] }> {
	// WP-001 deliberately reports catalog identity; consumers must compare their reviewed expectation.
	const { verifySources } = await import("../verify.mjs");
	const report = await verifySources(fileURLToPath(root));
	const freeze = JSON.parse(await readFile(new URL("freeze.json", import.meta.url), "utf8"));
	const issues = [...report.issues];
	if (report.catalog?.sha256 !== (expectedCatalogSha256 ?? freeze.catalogSha256))
		issues.push({ code: "catalog_digest_mismatch", path: "docs/catalog/index.json" });
	if (report.manifestSha256 !== freeze.sourceManifestSha256)
		issues.push({ code: "source_manifest_mismatch", path: "docs/reference/manifest.json" });
	return { ok: issues.length === 0, issues };
}
