import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync } from "node:fs";
import { basename, matchesGlob } from "node:path";
import { OWN_STEP } from "../../scripts/test-workflow.mjs";
import { RULES } from "./select.ts";

export const GATE_SCRIPT = "tools/ci/tooling-gate.ts";
export const FORMAL_TESTS: readonly string[] = ["tests/workflow/formal.test.ts"];
export const TYPECHECK_TESTS = "tools/ci/tests/typecheck*.test.ts";

function rulePaths(name: string): readonly string[] {
	const rule = RULES.find((r) => r.name === name);
	if (!rule) throw new Error(`tools/ci/select.ts has no "${name}" rule for the tooling gate`);
	return rule.paths;
}

export const FULL_PATHS: readonly string[] = [
	".github/workflows/**",
	".github/actions/**",
	GATE_SCRIPT,
	...rulePaths("shared input"),
];

export const GATES = {
	typecheck: {
		step: "INV-typecheck tests in the CI test coverage tool",
		paths: [
			"tools/ci/typecheck*",
			"tools/ci/tests/typecheck*",
			"**/tsconfig*.json",
			"**/package.json",
			"pnpm-workspace.yaml",
			"pnpm-lock.yaml",
		],
	},
	formal: {
		step: "INV-formal (TLC) tests in the local stack step",
		paths: [...rulePaths("formal checks"), ...FORMAL_TESTS],
	},
	qa: {
		step: "QA preview tool",
		paths: ["tools/qa/**", "bin/qa", "tools/prod-identity/**", "bin/prod-identity", "packages/db/migrations/**"],
	},
	wiki: { step: "wiki tool install, Chromium and tests", paths: ["tools/wiki/**"] },
	app: { step: "app verification tool and agent-browser", paths: ["tools/app/**", "bin/app"] },
	stack: { step: "local stack tests", paths: ["bin/**", "scripts/**", "tests/workflow/**"] },
} as const satisfies Record<string, { step: string; paths: readonly string[] }>;

export type GateId = keyof typeof GATES;
export type Decision = { run: boolean; reason: string };
export type Decisions = Record<GateId, Decision>;

const IDS = Object.keys(GATES) as GateId[];
const all = (reason: string): Decisions =>
	Object.fromEntries(IDS.map((id) => [id, { run: true, reason }])) as Decisions;

function firstMatch(changed: readonly string[], globs: readonly string[]): string | undefined {
	for (const path of changed) {
		const glob = globs.find((g) => matchesGlob(path, g));
		if (glob) return `${path} matches ${glob}`;
	}
	return undefined;
}

export function decide(event: string, changed: readonly string[] | null): Decisions {
	if (event !== "pull_request") return all(`a ${event || "non-PR"} event runs the full tooling set`);
	if (changed === null) return all("full set: the diff against the merge base could not be read");
	if (changed.length === 0) return all("full set: the diff against the merge base is empty");
	const wide = firstMatch(changed, FULL_PATHS);
	if (wide) return all(`full set: ${wide}, a tooling-wide input`);
	const decisions = Object.fromEntries(
		IDS.map((id): [GateId, Decision] => {
			const hit = firstMatch(changed, GATES[id].paths);
			return [
				id,
				hit
					? { run: true, reason: hit }
					: { run: false, reason: `no changed path matches ${GATES[id].paths.join(", ")}` },
			];
		}),
	) as Decisions;
	if (!decisions.stack.run && decisions.formal.run)
		decisions.stack = { run: true, reason: `the formal tests run in this step (${decisions.formal.reason})` };
	return decisions;
}

export function testFiles(
	decisions: Decisions,
	toolsCi: readonly string[],
	workflow: readonly string[],
): { toolsCi: string[]; workflow: string[] } {
	return {
		toolsCi: toolsCi.filter((file) => decisions.typecheck.run || !matchesGlob(file, TYPECHECK_TESTS)),
		workflow: workflow.filter(
			(file) => !OWN_STEP.has(basename(file)) && (decisions.formal.run || !FORMAL_TESTS.includes(file)),
		),
	};
}

function git(...args: string[]): string {
	return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function changedPaths(base: string, head: string): { mergeBase: string; paths: string[] } | null {
	try {
		const mergeBase = git("merge-base", base, head);
		const out = git("diff", "--name-only", "--no-renames", mergeBase, head);
		return { mergeBase, paths: out ? out.split("\n") : [] };
	} catch (error) {
		console.log(`tooling gate: cannot diff ${base}...${head}: ${(error as Error).message.split("\n")[0]}`);
		return null;
	}
}

const listTests = (dir: string, pattern: RegExp) =>
	readdirSync(dir)
		.filter((name) => pattern.test(name))
		.sort()
		.map((name) => `${dir}/${name}`);

if (import.meta.main) {
	const event = process.env.EVENT ?? "";
	const base = process.env.BASE_SHA ?? "";
	const head = process.env.HEAD_SHA ?? "";
	let changed: string[] | null = null;
	if (event === "pull_request") {
		const diff = base && head ? changedPaths(base, head) : null;
		if (diff) {
			console.log(
				`tooling gate: pull_request ${base.slice(0, 12)}...${head.slice(0, 12)}, merge base ${diff.mergeBase.slice(0, 12)}`,
			);
			console.log(`tooling gate: ${diff.paths.length} changed paths against the merge base`);
			changed = diff.paths;
		}
	} else console.log(`tooling gate: ${event || "no"} event, no path gate`);
	const decisions = decide(event, changed);
	const files = testFiles(
		decisions,
		listTests("tools/ci/tests", /\.test\.ts$/),
		listTests("tests/workflow", /\.test\.(mjs|ts)$/),
	);
	const outputs = [
		...IDS.map((id) => `${id}=${decisions[id].run}`),
		`tools-ci-tests=${files.toolsCi.join(" ")}`,
		`workflow-tests=${files.workflow.join(" ")}`,
	];
	for (const id of IDS)
		console.log(`${decisions[id].run ? "run " : "skip"} ${id} (${GATES[id].step}): ${decisions[id].reason}`);
	console.log(`CI test coverage tool files: ${files.toolsCi.join(" ")}`);
	console.log(`local stack files: ${decisions.stack.run ? files.workflow.join(" ") : "(step skipped)"}`);
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, outputs.join("\n") + "\n");
}
