import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { verifySources } from "../verify.mjs";

const root = new URL("../../../", import.meta.url);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const write = process.argv.includes("--write");
const frozen = JSON.parse(await readFile(new URL("freeze.json", import.meta.url), "utf8"));
const manifestBytes = await readFile(new URL("docs/reference/manifest.json", root));
const sourceManifestSha256 = hash(manifestBytes);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
let catalogSha256 = frozen.catalogSha256;
if (write) {
	// A reviewed catalog identity is an operation input, never an implicit refreeze.
	const index = process.argv.indexOf("--catalog-sha256");
	const expected = index === -1 ? frozen.catalogSha256 : process.argv[index + 1];
	if (!/^[a-f0-9]{64}$/.test(expected ?? "")) throw Error("Expected catalog SHA-256 required");
	const report = await verifySources(fileURLToPath(root));
	if (!report.ok) throw Error("Source verification failed");
	if (report.catalog.sha256 !== expected) throw Error("catalog_digest_mismatch");
	catalogSha256 = expected;
} else if (sourceManifestSha256 !== frozen.sourceManifestSha256) {
	throw Error("Frozen reference differs: source manifest");
}
const sources = await Promise.all(
	[
		...manifest.files,
		{ path: "docs/reference/manifest.json", sha256: sourceManifestSha256, bytes: manifestBytes.length },
	].map(async (f) => {
		const bytes = await readFile(new URL(f.path, root));
		if (hash(bytes) !== f.sha256 || bytes.length !== f.bytes) throw Error("Frozen reference differs: " + f.path);
		return { path: f.path, sha256: f.sha256, body: bytes.toString("utf8") };
	}),
);
// Extract only literals, never evaluate historical code or resolve its imports.
function literal(node) {
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	if (ts.isNumericLiteral(node)) return Number(node.text);
	if (node.kind === ts.SyntaxKind.NullKeyword) return null;
	if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
	if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
	if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
	if (ts.isObjectLiteralExpression(node))
		return Object.fromEntries(
			node.properties.map((p) => {
				if (!ts.isPropertyAssignment(p) || !p.name || !("text" in p.name)) throw Error("Nonliteral property");
				return [p.name.text, literal(p.initializer)];
			}),
		);
	if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return literal(node.expression);
	throw Error("Executable catalog initializer refused");
}
function catalog(path, name) {
	const source = sources.find((s) => s.path === "docs/reference/" + path);
	const ast = ts.createSourceFile(path, source.body, ts.ScriptTarget.Latest, true);
	let value;
	for (const statement of ast.statements)
		if (ts.isVariableStatement(statement)) {
			for (const d of statement.declarationList.declarations)
				if (d.name.getText(ast) === name) value = literal(d.initializer);
		}
	if (!value) throw Error("Missing literal catalog: " + name);
	return value;
}
const criterionSource = sources.find((s) => s.path === "docs/reference/phase-exit-criteria.ts").body;
const criterionAst = ts.createSourceFile("criteria.ts", criterionSource, ts.ScriptTarget.Latest, true);
const criteria = [];
for (const statement of criterionAst.statements)
	if (ts.isVariableStatement(statement)) {
		for (const d of statement.declarationList.declarations)
			if (d.name.getText(criterionAst) === "PHASE_EXIT_CRITERIA") {
				for (const phase of d.initializer.properties)
					for (const row of phase.initializer.elements) {
						const pick = (key) =>
							literal(row.properties.find((p) => p.name?.getText(criterionAst) === key).initializer);
						criteria.push({ phase: Number(phase.name.getText(criterionAst)), key: pick("key") });
					}
			}
	}
if (criteria.length !== 19) throw Error("Criterion identity inventory changed");
const data = {
	sources,
	catalogs: {
		tasks: catalog("task-templates.ts", "TASK_TEMPLATES"),
		teams: catalog("ministry-role-templates.ts", "TEAM_TEMPLATES"),
		documents: catalog("document-templates.ts", "DOCUMENT_TEMPLATES"),
		launch: catalog("launch-milestone-templates.ts", "LAUNCH_MILESTONE_TEMPLATES"),
		criteria,
		phases: [
			...sources.find((s) => s.path === "docs/reference/rubric-v1.md").body.matchAll(/^### Phase (\d) · (.+)$/gm),
		].map((m) => ({ phase: Number(m[1]), name: m[2] })),
	},
};
const artifact = JSON.stringify(data, null, 2) + "\n";
const freeze =
	JSON.stringify({ version: 1, sourceManifestSha256, catalogSha256, artifactSha256: hash(artifact) }, null, 2) + "\n";
if (write) {
	await writeFile(new URL("artifacts.json", import.meta.url), artifact);
	await writeFile(new URL("freeze.json", import.meta.url), freeze);
	console.log("Reference freeze: expected catalog digest and source archive agree.");
} else {
	if (
		(await readFile(new URL("artifacts.json", import.meta.url), "utf8")) !== artifact ||
		hash(artifact) !== frozen.artifactSha256
	)
		throw Error("Frozen reference differs: artifacts.json");
	console.log("Reference sources: exact source bytes and literal catalogs agree.");
}
