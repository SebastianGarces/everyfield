import { spawnSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";

export class UnitGroupError extends Error {
	name = "ToolError";
}

function fail(message: string): never {
	throw new UnitGroupError(message);
}

const RENDER = ["--tsconfig", "../../tests/unit/render.tsconfig.json"];
const QUIET = "--disable-warning=ExperimentalWarning";

export const UNIT_GROUPS = {
	"react-server": { package: "@everyfield/web", command: "node", flags: ["--conditions=react-server"] },
	web: { package: "@everyfield/web", command: "node", flags: [] },
	domain: { package: "@everyfield/domain", command: "tsx", flags: ["--conditions=react-server"] },
	render: { package: "@everyfield/domain", command: "tsx", flags: [...RENDER, QUIET] },
	"render-development": {
		package: "@everyfield/domain",
		command: "tsx",
		flags: [...RENDER, "--conditions=development", QUIET],
	},
	"render-module-mocks": {
		package: "@everyfield/domain",
		command: "tsx",
		flags: [...RENDER, "--conditions=development", "--experimental-test-module-mocks", QUIET],
	},
} as const satisfies Record<string, { package: string; command: "node" | "tsx"; flags: readonly string[] }>;

export type UnitGroup = keyof typeof UNIT_GROUPS;
export const DEFAULT_GROUP: UnitGroup = "web";
export const MARKER_DIR = "tests/unit/runs-in";
export const UNIT_TESTS = "tests/unit/**/*.test.{mjs,mts}";
export const RUNNER = "tools/ci/test-unit.ts";

const isGroup = (name: string): name is UnitGroup => Object.hasOwn(UNIT_GROUPS, name);
const SIDE_EFFECT_IMPORT = /^import\s+["']([^"']+)["'];?\s*$/gm;

export function groupOf(file: string, source: string): UnitGroup {
	const named = [...source.matchAll(SIDE_EFFECT_IMPORT)]
		.map(([, spec]) => posix.join(posix.dirname(file), spec!))
		.filter((path) => posix.dirname(path) === MARKER_DIR)
		.map((path) => posix.basename(path, ".mjs"));
	if (named.length > 1) fail(`${file} imports ${named.length} ${MARKER_DIR} markers. Keep one.`);
	const [name = DEFAULT_GROUP] = named;
	if (!isGroup(name)) fail(`${file} imports ${MARKER_DIR}/${name}.mjs, which is no group in ${RUNNER}.`);
	return name;
}

export function unitGroups(root: string): Map<UnitGroup, string[]> {
	const groups = new Map<UnitGroup, string[]>();
	for (const file of globSync(UNIT_TESTS, { cwd: root }).sort()) {
		const group = groupOf(file, readFileSync(join(root, file), "utf8"));
		(groups.get(group) ?? groups.set(group, []).get(group)!).push(file);
	}
	return groups;
}

export function unitPackages(root: string): Record<string, string> {
	return Object.fromEntries(
		[...unitGroups(root)].flatMap(([group, files]) => files.map((file) => [file, UNIT_GROUPS[group].package])),
	);
}

export function unitTestsOf(root: string, pkg: string): string[] {
	return [...unitGroups(root)].filter(([group]) => UNIT_GROUPS[group].package === pkg).flatMap(([, files]) => files);
}

export function listedTests(pkg: string, args: readonly string[]): Map<UnitGroup, string[]> {
	const listed = new Map<UnitGroup, string[]>();
	let group: UnitGroup | undefined;
	for (const arg of args) {
		if (arg.startsWith("--")) {
			const name = arg.slice(2);
			if (!isGroup(name) || UNIT_GROUPS[name].package !== pkg) fail(`${arg} is no ${pkg} group in ${RUNNER}.`);
			group = name;
		} else if (!group) fail(`Name a group before ${arg}, as in --${DEFAULT_GROUP} ${arg}.`);
		else if (posix.normalize(arg).includes("tests/unit/")) fail(`${arg} is found by ${RUNNER}; do not list it.`);
		else (listed.get(group) ?? listed.set(group, []).get(group)!).push(arg);
	}
	return listed;
}

function main(): void {
	const root = resolve(import.meta.dirname, "../..");
	const pkg: unknown = JSON.parse(readFileSync("package.json", "utf8"));
	const name = pkg && typeof pkg === "object" && "name" in pkg && typeof pkg.name === "string" ? pkg.name : "";
	const listed = listedTests(name, process.argv.slice(2));
	const found = unitGroups(root);
	const extra = (process.env.EVF_NODE_TEST_FLAGS ?? "").split(/\s+/).filter(Boolean);
	const groups = (Object.keys(UNIT_GROUPS) as UnitGroup[]).filter((group) => UNIT_GROUPS[group].package === name);
	if (!groups.length) fail(`${name || "This package"} has no group in ${RUNNER}.`);
	for (const group of groups) {
		const files = [
			...(listed.get(group) ?? []),
			...(found.get(group) ?? []).map((file) => relative(process.cwd(), join(root, file))),
		];
		if (!files.length) continue;
		const { command, flags } = UNIT_GROUPS[group];
		const result = spawnSync(command, [...flags, "--test", ...extra, ...files], { stdio: "inherit" });
		if (result.error) throw result.error;
		if (result.status !== 0) {
			process.exitCode = result.status ?? 1;
			return;
		}
	}
}

if (import.meta.main) {
	try {
		main();
	} catch (error) {
		if (!(error instanceof UnitGroupError)) throw error;
		console.error(`test-unit: ${error.message}`);
		process.exitCode = 1;
	}
}
