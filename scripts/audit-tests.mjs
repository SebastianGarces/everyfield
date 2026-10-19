// Audit metadata and measurements stay outside the checkout. This checks the declared test inventory.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const require = createRequire(new URL("../packages/domain/package.json", import.meta.url));
const ts = require("typescript");
const [base, decisionsFile] = process.argv.slice(2);
if (!base || !decisionsFile) throw new Error("Usage: node scripts/audit-tests.mjs <base-ref> <decisions.json>");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trimEnd();
const root = git("rev-parse", "--show-toplevel");
const testFile = (p) => /^(tests|packages|tools|\.github)\//.test(p) && /\.test\.(?:m?[jt]s|cjs)$/.test(p);
function inventory(ref) {
	const paths = (
		ref ? git("ls-tree", "-r", "--name-only", ref) : git("ls-files", "--cached", "--others", "--exclude-standard")
	)
		.split("\n")
		.filter(testFile)
		.filter((p) => ref || existsSync(resolve(root, p)))
		.sort();
	const rows = [];
	for (const file of paths) {
		const source = ref ? git("show", `${ref}:${file}`) : readFileSync(resolve(root, file), "utf8");
		const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
		function visit(node) {
			if (
				ts.isCallExpression(node) &&
				/^(?:test|it|test\.skip|test\.only|t\.test|test\.test)$/.test(node.expression.getText(tree))
			) {
				const title = node.arguments[0];
				if (title && node.arguments.some((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a)))
					rows.push({
						file,
						line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
						name: title.text ?? title.getText(tree),
					});
			}
			ts.forEachChild(node, visit);
		}
		visit(tree);
	}
	return rows;
}
const decisions = JSON.parse(readFileSync(decisionsFile, "utf8"));
assert.ok(Array.isArray(decisions), "Decisions must be an array");
const original = inventory(base),
	current = inventory();
const key = (r) => `${r.file}:${r.line}`;
const byCase = new Map(decisions.map((r) => [key(r), r]));
assert.equal(byCase.size, decisions.length, "Duplicate audit decision");
assert.equal(original.length, decisions.length, "Every original declaration needs a decision");
const expected = [];
for (const row of original) {
	const decision = byCase.get(key(row));
	assert.equal(decision?.name, row.name, `Missing or stale decision for ${key(row)}`);
	assert.ok(["keep", "rewrite", "delete"].includes(decision.verdict), `Unknown verdict at ${key(row)}`);
	assert.ok(typeof decision.reason === "string" && decision.reason.trim(), `Missing reason at ${key(row)}`);
	if (decision.verdict !== "delete") expected.push({ file: row.file, name: decision.afterName ?? row.name });
}
assert.deepEqual(
	current.map(({ file, name }) => ({ file, name })),
	expected,
	"Unexpected added, deleted, renamed or reordered test",
);
const counts = Object.fromEntries(
	["keep", "rewrite", "delete"].map((v) => [v, decisions.filter((r) => r.verdict === v).length]),
);
console.log(
	JSON.stringify(
		{
			base: git("rev-parse", base),
			head: git("rev-parse", "HEAD"),
			before: original.length,
			after: current.length,
			...counts,
			added: 0,
		},
		null,
		2,
	),
);
