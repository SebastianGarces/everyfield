import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const OXLINT = join(repo, "packages/evry/node_modules/.bin/oxlint");
const PLUGIN = join(repo, "scripts/lint/everyfield-plugin.mjs");
const CHECK = join(repo, "scripts/lint/check-comments.mjs");
const CONFIGS = [".oxlintrc.json", "apps/web/.oxlintrc.json", "tools/.oxlintrc.json"];
const DISABLE = ["eslint", "disable-next-line"].join("-");
const OX_DISABLE = ["oxlint", "disable"].join("-");
const EXPECT_ERROR = ["@ts", "expect-error"].join("-");

const temps = [];
test.after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const put = (dir, path, content) => {
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), typeof content === "string" ? content : `${JSON.stringify(content, null, "\t")}\n`);
};

function sandbox(files = {}, lintData = {}) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "lint-rules-")));
	temps.push(dir);
	for (const config of CONFIGS)
		put(dir, config, { ...JSON.parse(readFileSync(join(repo, config), "utf8")), jsPlugins: [PLUGIN] });
	put(
		dir,
		"scripts/lint/exemptions.json",
		JSON.parse(readFileSync(join(repo, "scripts/lint/exemptions.json"), "utf8")),
	);
	for (const [path, content] of Object.entries(files)) put(dir, path, content);
	for (const [path, content] of Object.entries(lintData)) put(dir, `scripts/lint/${path}`, content);
	return dir;
}

const env = (dir, extra = {}) => {
	const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GITHUB_")));
	return { ...clean, EVERYFIELD_ROOT: dir, EVERYFIELD_LINT_DIR: join(dir, "scripts/lint"), ...extra };
};

const GROUPS = [
	{ config: "apps/web/.oxlintrc.json", cwd: "apps/web", owns: (path) => path.startsWith("apps/web/") },
	{ config: "tools/.oxlintrc.json", cwd: ".", owns: (path) => path.startsWith("tools/") },
	{ config: ".oxlintrc.json", cwd: ".", owns: () => true },
];

function lintIn(dir, paths) {
	const hits = [];
	for (const group of GROUPS) {
		const mine = paths.filter((path) => GROUPS.find((g) => g.owns(path)) === group);
		if (!mine.length) continue;
		const cwd = join(dir, group.cwd);
		const ran = spawnSync(
			OXLINT,
			["-c", relative(cwd, join(dir, group.config)), "-f", "json", ...mine.map((p) => relative(cwd, join(dir, p)))],
			{ cwd, encoding: "utf8", env: env(dir) },
		);
		for (const d of JSON.parse(ran.stdout.slice(ran.stdout.indexOf("{"))).diagnostics) {
			const rule = /^everyfield\(([\w-]+)\)$/.exec(d.code ?? "")?.[1];
			if (rule && rule !== "resend-senders")
				hits.push(`${relative(dir, resolve(cwd, d.filename))}:${d.labels?.[0]?.span.line ?? 1} ${rule}`);
		}
	}
	return hits.sort();
}

const lint = (files, lintData) => lintIn(sandbox(files, lintData), Object.keys(files));

const EFFECTS = `import * as R from "react";
import React2, { useEffect as ue, useLayoutEffect } from "react";
export { useInsertionEffect } from "react";
export * from "react";
const { useEffect: picked } = R;
const hook = ue;
const required = require("react").useLayoutEffect;
export function Panel() {
	ue(() => {}, []);
	useLayoutEffect(() => {});
	R.useEffect(() => {});
	React2.useInsertionEffect(() => {});
	return [hook, picked, required];
}
`;

test("INV-lint: every import form of an effect hook is reported", () => {
	const hits = lint({ "packages/ui/src/effects.tsx": EFFECTS });
	assert.deepEqual(
		hits.map((hit) => hit.replace("packages/ui/src/effects.tsx:", "")),
		[
			"11 no-effects",
			"12 no-effects",
			"3 no-effects",
			"4 no-effects",
			"5 no-effects",
			"6 no-effects",
			"7 no-effects",
			"9 no-effects",
			"10 no-effects",
		].sort(),
	);
});

test("INV-lint: a fifth state hook in a component or hook is reported, a nested callback's is not", () => {
	const five = (name) =>
		`export function ${name}() {\n\tconst a = useState(0);\n\tconst b = useState(0);\n\tconst c = React.useState(0);\n\tconst [d] = useReducer((s) => s, 0);\n\tconst [e] = useState(0);\n\tconst nested = () => useState(0);\n\treturn [a, b, c, d, e, nested];\n}\n`;
	const source = `import React, { useReducer, useState } from "react";\n${five("Panel")}${five("useThing")}${five("helper")}export default function () {\n\tconst a = useState(0), b = useState(0), c = useState(0), d = useState(0), e = useState(0);\n\treturn [a, b, c, d, e];\n}\n`;
	assert.deepEqual(lint({ "apps/web/src/features/x/state.tsx": source }), [
		"apps/web/src/features/x/state.tsx:16 max-state",
		"apps/web/src/features/x/state.tsx:30 max-state",
		"apps/web/src/features/x/state.tsx:7 max-state",
	]);
});

test("INV-lint: timers, fixed waits and flushSync are reported in product code and not in tests or tools", () => {
	const timers = `import { flushSync } from "react-dom";
import { setTimeout as sleep, scheduler } from "node:timers/promises";
import * as timers from "node:timers/promises";
export async function run() {
	setTimeout(() => {}, 0);
	window.requestAnimationFrame(() => {});
	globalThis.queueMicrotask(() => {});
	setImmediate(() => {});
	await sleep(10);
	await timers.setTimeout(10);
	await scheduler.wait(10);
	flushSync(() => {});
}
`;
	const lines = [5, 6, 7, 8, 9, 10, 11, 12];
	const places = [
		"apps/web/src/features/x/Panel.tsx",
		"apps/web/src/server/jobs/retry.ts",
		"packages/domain/src/retry.ts",
	];
	const files = Object.fromEntries(
		[...places, "tests/integration/retry.test.mts", "tools/ci/retry.ts", "apps/web/scripts/retry.mjs"].map((p) => [
			p,
			timers,
		]),
	);
	assert.deepEqual(lint(files), places.flatMap((p) => lines.map((line) => `${p}:${line} no-timers`)).sort());
});

test("INV-lint: every comment except a shebang and a bundler ignore inside import() is reported, JSX comments included", () => {
	const source = `#!/usr/bin/env node
// prose
/* block */
/** doc */
// ${DISABLE} no-console
// ${EXPECT_ERROR} reason
const view = <div>{/* jsx */}</div>;
export const load = () => import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "./x.mjs");
export const kept = () => [/* webpackIgnore: true */ view];
`;
	assert.deepEqual(
		lint({ "tools/x.tsx": source }),
		[2, 3, 4, 5, 6, 7, 9].map((line) => `tools/x.tsx:${line} no-comments`).sort(),
	);
});

test("INV-lint: call-site cursor classes and pointer handlers on non-control elements are reported", () => {
	const source = `export const ROW = "flex cursor-pointer";
export function Row({ on }) {
	return (
		<ul>
			<li role="option" aria-selected onClick={on} onKeyDown={on}>a</li>
			<div role="presentation" onClick={on} className={\`p-2 hover:cursor-default \${on}\`} />
			<button onClick={on} className="cursor-grab cursor-progress">b</button>
			<div role="region" aria-roledescription="carousel" onPointerDown={on} onPointerUp={on} />
			<div role="region" aria-roledescription="carousel" onClick={on} />
		</ul>
	);
}
`;
	assert.deepEqual(lint({ "apps/web/src/features/x/Row.tsx": source, "packages/ui/src/Row.tsx": source }), [
		"apps/web/src/features/x/Row.tsx:1 no-cursor-utility",
		"apps/web/src/features/x/Row.tsx:6 clickable-host",
		"apps/web/src/features/x/Row.tsx:6 no-cursor-utility",
		"apps/web/src/features/x/Row.tsx:9 clickable-host",
	]);
});

function cursorRuleSelectors(css, cursor) {
	const rule = css.match(new RegExp(`(:where\\((?:[^{}])*?)\\{\\s*cursor:\\s*${cursor};`));
	assert.ok(rule, `controls.css has a :where() rule that sets cursor: ${cursor}`);
	const text = rule[1].slice(":where(".length);
	const items = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length && depth >= 0; i++) {
		if (text[i] === "(") depth++;
		else if (text[i] === ")") depth--;
		if ((text[i] === "," && depth === 0) || depth < 0) {
			items.push(text.slice(start, i).trim());
			start = i + 1;
		}
	}
	return items;
}

test("INV-cursor: the base cursor rule covers every host and role the clickable-host lint rule accepts", async () => {
	const { INTERACTIVE_HOSTS, INTERACTIVE_ROLES } = await import(PLUGIN);
	const css = readFileSync(join(repo, "packages/ui/src/controls/controls.css"), "utf8");
	for (const cursor of ["pointer", "not-allowed"]) {
		const items = cursorRuleSelectors(css, cursor);
		const hosts = new Set(items.map((item) => item.match(/^[a-z]+/)?.[0]).filter(Boolean));
		const roles = items.map((item) => item.match(/^\[role="([a-z]+)"\]$/)?.[1]).filter(Boolean);
		assert.deepEqual(
			INTERACTIVE_HOSTS.filter((host) => !hosts.has(host)),
			[],
			`hosts missing from the ${cursor} rule`,
		);
		assert.deepEqual([...roles].sort(), [...INTERACTIVE_ROLES].sort(), `roles of the ${cursor} rule`);
	}
});

test("INV-lint: a baseline allows its count, refuses growth and refuses a stale entry; a survivor covers only its function", () => {
	const path = "packages/ui/src/Panel.tsx";
	const effects = (n) =>
		`import { useEffect } from "react";\nexport function Panel() {\n${"\tuseEffect(() => {});\n".repeat(n)}}\n`;
	const baseline = (n) => ({ "baseline/no-effects/packages-ui.json": { [path]: n } });
	assert.deepEqual(lint({ [path]: effects(2) }, baseline(2)), []);
	assert.deepEqual(lint({ [path]: effects(1) }, baseline(2)), []);
	assert.deepEqual(
		lint({ [path]: effects(3) }, baseline(2)),
		[3, 4, 5].map((l) => `${path}:${l} no-effects`),
	);
	assert.deepEqual(lint({ [path]: effects(0) }, baseline(2)), [`${path}:1 no-effects`]);
	const survivor = (fn) => ({
		"survivors/packages-ui.json": {
			"no-effects": { [path]: [{ function: fn, count: 1, reason: "a reason long enough to read" }] },
		},
	});
	assert.deepEqual(lint({ [path]: effects(1) }, survivor("Panel")), []);
	assert.deepEqual(lint({ [path]: effects(1) }, survivor("Other")), [`${path}:1 no-effects`, `${path}:3 no-effects`]);
});

function check(dir, args = [], extra = {}) {
	const ran = spawnSync(process.execPath, [CHECK, ...args], { cwd: dir, encoding: "utf8", env: env(dir, extra) });
	return { status: ran.status, out: ran.stdout + ran.stderr };
}

const git = (dir, ...args) =>
	execFileSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
		cwd: dir,
		encoding: "utf8",
	}).trim();

const commitAll = (dir, message) => {
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "--allow-empty", "-m", message);
	return git(dir, "rev-parse", "HEAD");
};

test("INV-lint: the comment check finds CSS, JSONC, YAML, shell, ignore-file and new migration comments and every directive", () => {
	const files = {
		"packages/ui/src/a.css": `a { color: red; } /* why */\n.b::after { content: "/* not */"; }\n`,
		"tsconfig.x.json": `{\n\t// why\n\t"a": "http://x"\n}\n`,
		".github/workflows/x.yml": `name: x # why\non: "#not"\n`,
		"bin/tool": `#!/bin/sh\n# why\necho "#not"\n`,
		".gitignore": `# why\nnode_modules\n`,
		"packages/db/migrations/20990101000000_new.sql": `select '--not';\n-- why\n`,
		"packages/ui/src/b.ts": `export const a = 1;\n// ${DISABLE} x\n/* ${OX_DISABLE} */\n`,
		"docs/x.css": `/* exempt */\n`,
	};
	const dir = sandbox();
	git(dir, "init", "-q");
	const base = commitAll(dir, "base");
	for (const [path, content] of Object.entries(files)) put(dir, path, content);
	const { status, out } = check(dir, ["--base", base]);
	assert.equal(status, 1);
	const failed = out
		.split("\n")
		.filter((line) => /^[\w./-]+(:\d+)?: \d+ /.test(line))
		.map((line) => line.replace(/;.*| comments.*| lint or.*/, ""))
		.sort();
	assert.deepEqual(failed, [
		".github/workflows/x.yml:1: 1",
		".gitignore:1: 1",
		"bin/tool:2: 1",
		"packages/db/migrations/20990101000000_new.sql:2: 1",
		"packages/ui/src/a.css:1: 1",
		"packages/ui/src/b.ts: 2",
		"tsconfig.x.json:2: 1",
	]);
});

test("INV-lint: an oxlint override that turns a rule off needs its reason, and the code rules stay on", () => {
	const dir = sandbox();
	const config = JSON.parse(readFileSync(join(dir, "apps/web/.oxlintrc.json"), "utf8"));
	config.overrides.push({ files: ["src/x.tsx"], rules: { "everyfield/no-effects": "off" } });
	config.rules["everyfield/max-state"] = "warn";
	put(dir, "apps/web/.oxlintrc.json", config);
	git(dir, "init", "-q");
	const { status, out } = check(dir, ["--no-base"]);
	assert.equal(status, 1);
	assert.match(out, /override for src\/x\.tsx, rule everyfield\/no-effects needs its reason/);
	assert.match(out, /everyfield\/max-state must be "error" in the top-level rules/);
});

function history() {
	const path = "packages/ui/src/Panel.tsx";
	const renamed = "packages/ui/src/Moved.tsx";
	const dir = sandbox({ [path]: "export {};\n", "packages/ui/src/Other.tsx": "export {};\n" }, {});
	git(dir, "init", "-q", "-b", "main");
	const write = (entries) => put(dir, "scripts/lint/baseline/no-effects/packages-ui.json", entries);
	write({ [path]: 2 });
	const base = commitAll(dir, "base");
	return { dir, path, renamed, write, base };
}

test("INV-lint: a baseline entry new to the base or larger than at the base fails, and a rename carries its entry", () => {
	const { dir, path, renamed, write, base } = history();
	const growth = (entries, ...moves) => {
		git(dir, "reset", "-q", "--hard", base);
		for (const [from, to] of moves) git(dir, "mv", from, to);
		write(entries);
		commitAll(dir, "change");
		return check(dir, ["--base", base]).out;
	};
	assert.match(growth({ [path]: 3 }), /no-effects: packages\/ui\/src\/Panel\.tsx grew from 2 to 3/);
	assert.match(growth({ [path]: 2, "packages/ui/src/Other.tsx": 1 }), /Other\.tsx is new to the baseline/);
	assert.match(growth({ [path]: 1 }), /check-comments: passed/);
	assert.match(growth({ [renamed]: 2 }, [path, renamed]), /check-comments: passed/);
	assert.match(growth({ [renamed]: 3 }, [path, renamed]), /Moved\.tsx grew from 2 to 3/);
});

test("INV-lint: a rule new against main is held to the commit that adds its baseline", () => {
	const { dir, path } = history();
	const main = git(dir, "rev-parse", "HEAD");
	git(dir, "switch", "-q", "-c", "feature");
	put(dir, "scripts/lint/baseline/max-state/packages-ui.json", { [path]: 2 });
	commitAll(dir, "add a rule");
	put(dir, "scripts/lint/baseline/max-state/packages-ui.json", { [path]: 3 });
	commitAll(dir, "grow it");
	assert.match(check(dir, ["--base", main]).out, /max-state: packages\/ui\/src\/Panel\.tsx grew from 2 to 3/);
});

test("INV-lint: in CI the growth check compares with main, through HEAD^1 or, for a stacked pull request, the merge base", () => {
	const { dir: origin, path, write } = history();
	git(origin, "switch", "-q", "-c", "lower");
	write({ [path]: 1 });
	commitAll(origin, "lower shrinks");
	git(origin, "switch", "-q", "-c", "upper");
	write({ [path]: 2 });
	commitAll(origin, "upper regrows within main");
	git(origin, "switch", "-q", "main");
	commitAll(origin, "main moves on");

	const clone = realpathSync(mkdtempSync(join(tmpdir(), "lint-clone-")));
	temps.push(clone);
	execFileSync("git", ["clone", "-q", "--depth", "2", "--no-local", "--branch", "upper", `file://${origin}`, clone]);
	const ci = (target) =>
		check(clone, [], { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: target }).out;
	const stacked = ci("lower");
	assert.match(stacked, /merge base of HEAD and main \(the pull request is stacked on lower\)/);
	assert.match(stacked, /check-comments: passed/);

	git(clone, "fetch", "-q", "origin", "main");
	git(clone, "switch", "-q", "--detach", "origin/main");
	git(clone, "merge", "-q", "--no-ff", "--no-edit", "upper");
	const direct = ci("main");
	assert.match(direct, /the first parent of the pull_request commit/);
	assert.match(direct, /check-comments: passed/);
});
