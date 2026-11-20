import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { REFUSAL_MECHANISMS, WEB_SQL_HOLDERS } from "../../scripts/lint/everyfield-plugin.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const OXLINT = join(repo, "packages/evry/node_modules/.bin/oxlint");
const PLUGIN = join(repo, "scripts/lint/everyfield-plugin.mjs");
const CHECK = join(repo, "scripts/lint/check-comments.mjs");
const CONFIGS = [".oxlintrc.json", "apps/web/.oxlintrc.json", "tools/.oxlintrc.json"];
const DISABLE = ["eslint", "disable-next-line"].join("-");
const OX_DISABLE = ["oxlint", "disable"].join("-");
const EXPECT_ERROR = ["@ts", "expect-error"].join("-");

const SCRIPTS = {
	lint: "pnpm -r --if-present lint && pnpm run lint:web && pnpm run lint:repo && pnpm run lint:tools",
	"lint:web": `cd apps/web && ${OXLINT} -c .oxlintrc.json --max-warnings=0 .`,
	"lint:repo": `${OXLINT} -c .oxlintrc.json --max-warnings=0 packages tests/unit`,
	"lint:tools": `${OXLINT} -c tools/.oxlintrc.json --max-warnings=0 tools`,
};

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
	for (const data of ["exemptions.json", "boundaries/_layout.json"])
		put(dir, `scripts/lint/${data}`, JSON.parse(readFileSync(join(repo, "scripts/lint", data), "utf8")));
	put(dir, "package.json", { scripts: SCRIPTS });
	put(dir, "scripts/lint/lint-scripts.json", { "package.json": SCRIPTS });
	put(dir, "pnpm-workspace.yaml", "packages: []\n");
	for (const root of ["packages/ui/src/index.ts", "tests/unit/index.ts", "tools/index.ts"])
		put(dir, root, "export {};\n");
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

function lintIn(dir, paths, code = /^everyfield\(([\w-]+)\)$/) {
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
			const rule = code.exec(d.code ?? "")?.[1];
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

test("INV-sql-name: a value pasted into sql.raw is a fixed name, never string, in product code", () => {
	const reach = `import { sql, sql as s, type SqlLiteral } from "@everyfield/db/query";
export const a = (alias: string) => sql.raw(\`\${alias}.id\`);
export const b = (alias) => sql.raw(alias);
export const c = <A extends string>(alias: SqlLiteral<A>) => sql.raw(\`\${alias}.id\`);
export const d = (alias: "m" | "n") => sql.raw(alias);
export const e = (on: boolean) => sql.raw(on ? "x" : "y");
const literal = (v: string) => v;
export const f = (v: string) => sql.raw(literal(v));
export const g = (row: { from: string }) => sql.raw(row.from);
export const h = <F extends string>(row: { from: SqlLiteral<F> }) => sql.raw(row.from);
export function i(col: string) { return sql\`\${sql.raw(\`r.\${col}\`)}\`; }
export const j = (v: string) => sql.raw(String(v));
export const k = (v: string) => sql.raw(\`\${String(v)}.id\`);
export const l = (v: string) => s.raw(v);
const r = sql.raw;
export const m = (v: string) => r(v);
type Row = { name: string };
export const n = (v: Row["name"]) => sql.raw(v);
export const o = (v: keyof Record<string, 1>) => sql.raw(v);
export const p = (v: string) => { const x = v; return sql.raw(x); };
export const q = () => { let y = "a"; return sql.raw(y); };
const COLS = ["a", "b"] as const;
export const t = (v: (typeof COLS)[number]) => sql.raw(v);
export const u = () => { const z = \`\${COLS[0]}.id\`; return sql.raw(z); };
`;
	const reported = [2, 3, 9, 11, 12, 13, 14, 16, 18, 19, 20, 21];
	assert.deepEqual(
		lint({
			"packages/domain/src/people/reach.ts": reach,
			"apps/web/src/features/x/reach.ts": reach,
			"tests/integration/x/reach.test.mts": reach,
		}),
		[
			"apps/web/src/features/x/reach.ts:1 web-database-imports",
			...["apps/web/src/features/x/reach.ts", "packages/domain/src/people/reach.ts"].flatMap((file) =>
				reported.map((line) => `${file}:${line} raw-sql-literal`),
			),
		].sort(),
	);
});

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

test("INV-privacy: server code logs only through the log module", () => {
	const reach = `export const a = (error) => console.error(String(error));
export const b = () => console.log("warm");
const c = console;
const { warn } = console;
import nodeConsole from "node:console";
import { error as err } from "console";
export const e = () => globalThis.console.error("x");
export const f = () => globalThis["console"].error("x");
export const g = () => self.console.error("x");
export const h = () => window.console.error("x");
export const i = () => process.stderr.write("x");
export const j = () => process.stdout.write("x");
export const k = () => require("node:console");
export const l = () => import("node:console");
export const m = () => globalThis.process.stderr.write("x");
import proc from "node:process";
export const n = () => proc.stderr.write("x");
import { stderr } from "process";
const { stdout } = process;
const { error } = console;
export const d = [c, warn, nodeConsole, err, stderr, stdout, error];
`;
	const lines = [...Array.from({ length: 15 }, (_, n) => n + 1), 17, 18, 19, 20];
	assert.deepEqual(
		lint({
			"apps/web/src/features/x/server.ts": reach,
			"packages/domain/src/people/reach.ts": reach,
			"packages/evry/src/runtime/reach.ts": reach,
			"apps/web/src/features/x/Panel.tsx": `"use client";\n${reach}`,
			"packages/domain/src/log.ts": reach,
			"tests/integration/x/reach.test.mts": reach,
		}).filter((hit) => hit.endsWith(" server-log")),
		["apps/web/src/features/x/server.ts", "packages/domain/src/people/reach.ts", "packages/evry/src/runtime/reach.ts"]
			.flatMap((file) => lines.map((line) => `${file}:${line} server-log`))
			.sort(),
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

test("INV-mint: only the settings credentials module reaches the restricted deletion session mint, in product code", () => {
	const reach = `import { issueRestrictedDeletionSession as mint } from "./deletion.ts";
export { issueRestrictedDeletionSession } from "./deletion.ts";
import * as deletion from "./deletion.ts";
export const a = deletion.issueRestrictedDeletionSession;
export const b = deletion["issueRestrictedDeletionSession"];
export const c = async () => (await import("./deletion.ts")).issueRestrictedDeletionSession;
export const d = mint;
`;
	assert.deepEqual(
		lint({
			"packages/domain/src/settings/reach.ts": reach,
			"apps/web/src/features/x/reach.ts": reach,
			"packages/domain/src/settings/credentials.ts": reach,
			"packages/domain/src/settings/deletion.ts": "export async function issueRestrictedDeletionSession() {}\n",
			"tests/integration/x/reach.test.mts": reach,
		}).filter((hit) => hit.endsWith(" mint-callers")),
		[1, 2, 4, 5, 6]
			.flatMap((line) => [
				`apps/web/src/features/x/reach.ts:${line} mint-callers`,
				`packages/domain/src/settings/reach.ts:${line} mint-callers`,
			])
			.sort(),
	);
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
			<a href="/x" onClick={on}>c</a>
			<a onClick={on}>d</a>
			<label onClick={on}>
				<input type="text" />
			</label>
		</ul>
	);
}
`;
	assert.deepEqual(lint({ "apps/web/src/features/x/Row.tsx": source, "packages/ui/src/Row.tsx": source }), [
		"apps/web/src/features/x/Row.tsx:1 no-cursor-utility",
		"apps/web/src/features/x/Row.tsx:10 clickable-host",
		"apps/web/src/features/x/Row.tsx:6 clickable-host",
		"apps/web/src/features/x/Row.tsx:6 no-cursor-utility",
		"apps/web/src/features/x/Row.tsx:9 clickable-host",
		"packages/ui/src/Row.tsx:1 no-cursor-utility",
		"packages/ui/src/Row.tsx:6 no-cursor-utility",
	]);
});

test("INV-lint: a pointer handler on a motion element or in its capture phase is a clickable host like any other", () => {
	const source = `import { motion } from "motion/react";
import { m } from "@/components/motion/m";
export function Card({ on }) {
	return (
		<section>
			<motion.div onClick={on} />
			<m.span onPointerDownCapture={on} />
			<div onClickCapture={on} />
			<motion.button onClick={on} />
			<m.a href="/x" onClickCapture={on} />
			<motion.div role="button" onClick={on} />
		</section>
	);
}
`;
	assert.deepEqual(lint({ "apps/web/src/features/x/Card.tsx": source }), [
		"apps/web/src/features/x/Card.tsx:6 clickable-host",
		"apps/web/src/features/x/Card.tsx:7 clickable-host",
		"apps/web/src/features/x/Card.tsx:8 clickable-host",
	]);
});

test("INV-lint: history writes, popstate, the Navigation API, the address fragment and an in-app address carrying a one-time link value are reported outside the location store, in every spelling", () => {
	const source = `export function go(mode, href) {
	window.history.pushState(null, "", href);
	history.replaceState(null, "", href);
	window.history[mode === "push" ? "pushState" : "replaceState"](null, "", href);
	onTraversal("popstate");
	window.onpopstate = null;
	const { pushState } = window.history;
	listen(\`popstate\`);
	history["push" + "State"](null, "", href);
	window.navigation.navigate(href);
	navigation.addEventListener("navigate", go);
	const proof = window.location.hash.slice(1) || location.hash || document.location.hash;
	const links = ["/invitation#proof=" + proof, \`/reset-password?token=\${proof}\`, "/connections/respond?invitation=1#x", "/invitation", "/reset-password?step=2", \`\${origin}/invitation#proof=\${proof}\`];
	const built = ["/reset-password?" + "token=" + proof, links]; const { hash } = location;
	return pushState;
}
`;
	assert.deepEqual(
		lint({
			"apps/web/src/features/x/go.ts": source,
			"packages/ui/src/foundations/go.ts": source,
			"apps/web/src/components/location.ts": source,
			"apps/web/src/components/one-time-link.ts": `export const take = () => (window.history.replaceState(null, "", "/"), location.hash);\n`,
			"apps/web/src/server/mail/link.ts":
				"export const link = (origin, proof) => `${origin}/invitation#proof=${proof}`;\n",
		}),
		[
			"apps/web/src/features/x/go.ts:2 no-raw-history",
			"apps/web/src/features/x/go.ts:3 no-raw-history",
			"apps/web/src/features/x/go.ts:4 no-raw-history",
			"apps/web/src/features/x/go.ts:4 no-raw-history",
			"apps/web/src/features/x/go.ts:4 no-raw-history",
			"apps/web/src/features/x/go.ts:5 no-raw-history",
			"apps/web/src/features/x/go.ts:6 no-raw-history",
			"apps/web/src/features/x/go.ts:6 no-global-listeners",
			"apps/web/src/features/x/go.ts:7 no-raw-history",
			"apps/web/src/features/x/go.ts:8 no-raw-history",
			"apps/web/src/features/x/go.ts:9 no-raw-history",
			"apps/web/src/features/x/go.ts:10 no-raw-history",
			"apps/web/src/features/x/go.ts:10 no-raw-history",
			"apps/web/src/features/x/go.ts:11 no-raw-history",
			"apps/web/src/features/x/go.ts:12 no-raw-history",
			"apps/web/src/features/x/go.ts:12 no-raw-history",
			"apps/web/src/features/x/go.ts:12 no-raw-history",
			"apps/web/src/features/x/go.ts:13 no-raw-history",
			"apps/web/src/features/x/go.ts:13 no-raw-history",
			"apps/web/src/features/x/go.ts:13 no-raw-history",
			"apps/web/src/features/x/go.ts:13 no-raw-history",
			"apps/web/src/features/x/go.ts:14 no-raw-history",
			"apps/web/src/features/x/go.ts:14 no-raw-history",
			...[2, 3, 4, 4, 4, 5, 6, 7, 8, 9, 10, 10, 11, 12, 12, 12, 13, 13, 13, 13, 14, 14].map(
				(line) => `packages/ui/src/foundations/go.ts:${line} no-raw-history`,
			),
			"packages/ui/src/foundations/go.ts:6 no-global-listeners",
		].sort(),
	);
});

test("INV-lint: an in-app address carrying a one-time link value is reported when it names an origin, or is built with URL, URLSearchParams or a pathname object", () => {
	const source = `export function links(proof) {
	const absolute = ["https://everyfield.app/invitation#proof=" + proof, "//everyfield.app/reset-password?token=1", "https://everyfield.app/reset-password?step=2"];
	const reset = new URL("/reset-password", window.location.origin);
	reset.searchParams.set("token", proof);
	const verify = new URL("https://everyfield.app/verify-email");
	verify.search = \`?token=\${proof}\`;
	const invite = new URL(\`\${origin}/invitation\`);
	invite.hash = \`proof=\${proof}\`;
	const query = new URLSearchParams({ token: proof });
	const later = new URLSearchParams();
	later.append("token", proof);
	const step = new URLSearchParams({ step: "2" });
	const built = ["/reset-password?" + query, \`/verify-email?\${later.toString()}\`, \`/reset-password?\${new URLSearchParams([["token", proof]])}\`, "/reset-password?" + step];
	const pages = [{ pathname: "/verify-email", query: { token: proof } }, { pathname: "/invitation", hash: proof }, { pathname: "/reset-password", query: { step: 2 } }];
	const other = new URL("/documents", origin);
	other.searchParams.set("token", proof);
	return [absolute, reset, verify, invite, built, pages, other];
}
`;
	assert.deepEqual(
		lint({
			"apps/web/src/features/x/links.ts": source,
			"apps/web/src/server/mail/links.ts": source,
		}),
		[
			"apps/web/src/features/x/links.ts:2 no-raw-history",
			"apps/web/src/features/x/links.ts:2 no-raw-history",
			"apps/web/src/features/x/links.ts:4 no-raw-history",
			"apps/web/src/features/x/links.ts:6 no-raw-history",
			"apps/web/src/features/x/links.ts:8 no-raw-history",
			"apps/web/src/features/x/links.ts:13 no-raw-history",
			"apps/web/src/features/x/links.ts:13 no-raw-history",
			"apps/web/src/features/x/links.ts:13 no-raw-history",
			"apps/web/src/features/x/links.ts:14 no-raw-history",
			"apps/web/src/features/x/links.ts:14 no-raw-history",
		].sort(),
	);
});

test("INV-lint: window and document listeners, and onTraversal or onNavigation held for a component's lifetime, are reported outside the location store and the page-event registry", () => {
	const source = `export function mount(node, run) {
	window.addEventListener("keydown", run);
	document.removeEventListener("click", run);
	const add = globalThis.addEventListener;
	addEventListener("beforeunload", run);
	window.document.addEventListener("click", run);
	node.addEventListener("click", run);
	const w = window;
	w.addEventListener("resize", run);
	document.body.addEventListener("click", run);
	const { addEventListener: listen } = window;
	window.onresize = run;
	document.onclick = run;
	node.ownerDocument.addEventListener("keydown", run);
	window.visualViewport.addEventListener("resize", run);
	const scroller = node.root ?? window;
	scroller.addEventListener("scroll", run);
	(node.scrolls ? node : window).removeEventListener("scroll", run);
	const view = (node.root || document.defaultView) as Window;
	view.addEventListener("resize", run);
	let later;
	later = node.root ?? window;
	later.addEventListener("scroll", run);
	(0, window).addEventListener("scroll", run);
	const frame = node.ownerDocument?.defaultView;
	frame.addEventListener("resize", run);
	return [add, listen];
}
`;
	const registries = `import { addAddressRule, onNavigation, onTraversal } from "../../components/location.ts";
addAddressRule("ok", () => null);
export function Screen() {
	addAddressRule("bad", () => null);
	const go = () => onTraversal(() => {});
	onNavigation(() => {});
	const leave = () => onNavigation(() => {});
	return <button ref={(node) => (node ? onTraversal(() => {}) : undefined)} onClick={go} onBlur={leave} />;
}
`;
	assert.deepEqual(
		lint({
			"apps/web/src/features/x/mount.ts": source,
			"apps/web/src/features/x/Screen.tsx": registries,
			"apps/web/src/components/save/leave.ts": source,
			"apps/web/src/components/location.ts": source,
		}),
		[
			...[2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14, 15, 17, 18, 20, 23, 24, 26].map(
				(line) => `apps/web/src/features/x/mount.ts:${line} no-global-listeners`,
			),
			"apps/web/src/features/x/Screen.tsx:4 no-global-listeners",
			"apps/web/src/features/x/Screen.tsx:8 no-effects",
			"apps/web/src/features/x/Screen.tsx:6 no-global-listeners",
			"apps/web/src/features/x/Screen.tsx:8 no-global-listeners",
		].sort(),
	);
});

test("INV-lint: zustand is reached only through store files and the store helper, never at module level", () => {
	const store = `import { createStore } from "zustand/vanilla";
export const shared = createStore()(() => ({}));
export const createPanelStore = () => createStore()(() => ({}));
`;
	const evasions = `import { createStore as make } from "zustand/vanilla";
import * as z from "zustand/vanilla";
export { createStore } from "zustand/vanilla";
export const a = make()(() => ({}));
export const b = z.createStore()(() => ({}));
export const c = (() => make()(() => ({})))();
export const createOtherStore = () => make()(() => ({}));
const alias = make;
export const d = alias()(() => ({}));
export const e = createOtherStore();
`;
	const component = `import { create } from "zustand";
import { createStore } from "zustand/vanilla";
import { persist } from "zustand/middleware";
import { useStore } from "zustand";
import { createPanelStore } from "./Panel.store.ts";
import * as Panel from "./Panel.store.ts";
export const used = [create, createStore, persist, useStore];
export const viaSpace = Panel.createPanelStore();
export const shared = createPanelStore();
export function Panel() {
	return createPanelStore();
}
`;
	assert.deepEqual(
		lint({
			"apps/web/src/features/x/Panel.store.ts": store,
			"apps/web/src/features/x/Other.store.ts": evasions,
			"apps/web/src/features/x/Panel.tsx": component,
			"apps/web/src/components/store.ts": `import { useStore } from "zustand";\nexport { useShallow } from "zustand/react/shallow";\nexport { useStore };\n`,
		}),
		[
			"apps/web/src/features/x/Other.store.ts:3 zustand-shape",
			"apps/web/src/features/x/Other.store.ts:4 zustand-shape",
			"apps/web/src/features/x/Other.store.ts:5 zustand-shape",
			"apps/web/src/features/x/Other.store.ts:6 zustand-shape",
			"apps/web/src/features/x/Other.store.ts:9 zustand-shape",
			"apps/web/src/features/x/Other.store.ts:10 zustand-shape",
			"apps/web/src/features/x/Panel.store.ts:2 zustand-shape",
			"apps/web/src/features/x/Panel.tsx:1 zustand-shape",
			"apps/web/src/features/x/Panel.tsx:2 zustand-shape",
			"apps/web/src/features/x/Panel.tsx:3 zustand-shape",
			"apps/web/src/features/x/Panel.tsx:4 zustand-shape",
			"apps/web/src/features/x/Panel.tsx:8 zustand-shape",
			"apps/web/src/features/x/Panel.tsx:9 zustand-shape",
		].sort(),
	);
});

test("INV-lint: a model module that imports React, the server or the database, or reads the clock or the browser, is reported", () => {
	const impure = `"use client";
import { useState } from "react";
import "server-only";
import type { Database } from "@everyfield/db/client";
import { db } from "@everyfield/db/client";
export const at = () => Date.now();
export const day = () => new Date();
export const stored = () => window.localStorage;
export const parsed = (iso: string, d: Database) => [new Date(iso), d, useState, db];
`;
	const pure = `import type { ReactNode } from "react";
import { parse } from "../../components/dates.ts";
export const later = (now: Date, ms: number) => new Date(now.getTime() + ms);
export const label = (node: ReactNode) => [node, parse];
`;
	assert.deepEqual(lint({ "apps/web/src/components/save/model.ts": impure }), [
		"apps/web/src/components/save/model.ts:1 model-module",
		"apps/web/src/components/save/model.ts:2 model-module",
		"apps/web/src/components/save/model.ts:3 model-module",
		"apps/web/src/components/save/model.ts:5 model-module",
		"apps/web/src/components/save/model.ts:6 model-module",
		"apps/web/src/components/save/model.ts:7 model-module",
		"apps/web/src/components/save/model.ts:8 model-module",
	]);
	assert.deepEqual(lint({ "apps/web/src/components/save/model.ts": pure }), []);
	for (const file of ["apps/web/src/features/tasks/fresh-model.ts", "apps/web/src/features/wiki/page-state.ts"])
		assert.deepEqual(lint({ [file]: "export const at = () => Date.now();\n" }), [`${file}:1 model-module`]);
	const disguised = `const D = Date;
const { now } = performance;
const tick = Date.now;
export const reads = () => [
	Date(),
	D.now(),
	new D(),
	Date["now"](),
	now(),
	tick(),
	new globalThis.Date(),
	self.performance.now(),
	location.href,
	history.length,
];
export const typed = (node: import("react").ReactNode, at: number) => [node, Date.UTC(2026, 0, 1), new Date(at)];
`;
	assert.deepEqual(lint({ "apps/web/src/components/save/model.ts": disguised }), [
		"apps/web/src/components/save/model.ts:10 model-module",
		"apps/web/src/components/save/model.ts:11 model-module",
		"apps/web/src/components/save/model.ts:11 model-module",
		"apps/web/src/components/save/model.ts:12 model-module",
		"apps/web/src/components/save/model.ts:12 model-module",
		"apps/web/src/components/save/model.ts:13 model-module",
		"apps/web/src/components/save/model.ts:14 model-module",
		"apps/web/src/components/save/model.ts:5 model-module",
		"apps/web/src/components/save/model.ts:6 model-module",
		"apps/web/src/components/save/model.ts:7 model-module",
		"apps/web/src/components/save/model.ts:8 model-module",
		"apps/web/src/components/save/model.ts:9 model-module",
	]);
});

test("INV-lint: a createRead or useLocalRead loader only loads its key: a call of a read, optionally mapped, and nothing else", () => {
	const source = `import { createRead } from "../../components/read.tsx";
import { loadThing, markSeen } from "./actions.ts";
export const a = createRead((id) => loadThing(id), { failed: () => null });
export const b = createRead((id) => fetch("/x?id=" + id).then((r) => r.json()), { failed: () => null });
export const c = createRead(() => loadThing().catch(() => null), { failed: () => null });
export const d = createRead(async (id) => { markSeen(id); return loadThing(id); }, { failed: () => null });
export const e = createRead(loadThing, { failed: () => null });
export const f = createRead((id) => (markSeen(id), loadThing(id)), { failed: () => null });
export const g = createRead((id) => loadThing(id).then((r) => { markSeen(id); return r; }), { failed: () => null });
export const useH = (id) => useLocalRead((key) => loadThing(key), { failed: () => null }, id);
export const useI = (id) => useLocalRead(async (key) => { markSeen(key); return loadThing(key); }, { failed: () => null }, id);
`;
	assert.deepEqual(lint({ "apps/web/src/features/x/reads.ts": source }), [
		"apps/web/src/features/x/reads.ts:11 read-loader",
		"apps/web/src/features/x/reads.ts:6 read-loader",
		"apps/web/src/features/x/reads.ts:8 read-loader",
		"apps/web/src/features/x/reads.ts:9 read-loader",
	]);
});

test("INV-link: a one-time link value never keys a read, directly or through a value derived from it", () => {
	const source = `import { useOneTimeLinkValue, currentOneTimeLinkValue } from "../../components/location.ts";
import { createRead, useLocalRead, useRead, useReadWith } from "../../components/read.tsx";
import { people } from "./reads.ts";
const reads = createRead((id) => load(id, currentOneTimeLinkValue("invitation")), { failed: () => null });
export function A({ id }) {
	const linked = useOneTimeLinkValue("invitation");
	const proof = linked ?? "";
	const { value } = { value: proof };
	const a = useRead(reads, id, proof);
	const b = useRead(reads, id, value);
	const c = useLocalRead(load, options, useOneTimeLinkValue("invitation"));
	const d = useRead(reads, id, currentOneTimeLinkValue("invitation"));
	const e = useReadWith(reads, [id, linked]);
	let later;
	later = linked;
	const f = useRead(reads, id, later);
	const readAs = useRead;
	const g = readAs(reads, id, linked);
	reads.prefetch(id, linked);
	people.get(id, proof);
	const [held] = useState(linked);
	const h = useRead(reads, id, held);
	const fine = useRead(reads, id);
	const alsoFine = useLocalRead((key) => load(key, currentOneTimeLinkValue("invitation")), options, id);
	reads.prefetch(id);
	return [a, b, c, d, e, f, g, h, fine, alsoFine, proof];
}
`;
	assert.deepEqual(
		lint({ "apps/web/src/features/x/Respond.tsx": source }),
		[9, 10, 11, 12, 13, 16, 18, 19, 20, 22]
			.map((line) => `apps/web/src/features/x/Respond.tsx:${line} link-value-key`)
			.sort(),
	);
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

test("INV-cursor: the base pointer rule covers exactly the hosts and roles clickable-host accepts, plus labels, which take no handler", async () => {
	const { INTERACTIVE_HOSTS, INTERACTIVE_ROLES } = await import(PLUGIN);
	const css = readFileSync(join(repo, "packages/ui/src/controls/controls.css"), "utf8");
	const hostOf = (item) => item.match(/^[a-z]+(?:\[href\])?/)?.[0];
	const roleOf = (item) => item.match(/^\[role="([a-z]+)"\]$/)?.[1];
	const pointer = cursorRuleSelectors(css, "pointer");
	const pointerHosts = [...new Set(pointer.map(hostOf).filter(Boolean))].sort();
	assert.deepEqual(pointerHosts, [...INTERACTIVE_HOSTS, "label"].sort());
	assert.deepEqual(pointer.map(roleOf).filter(Boolean).sort(), [...INTERACTIVE_ROLES].sort());
	const disabled = cursorRuleSelectors(css, "not-allowed");
	const disabledHosts = new Set(disabled.map(hostOf).filter(Boolean));
	assert.deepEqual(
		INTERACTIVE_HOSTS.filter((host) => !disabledHosts.has(host)),
		[],
	);
	assert.deepEqual(disabled.map(roleOf).filter(Boolean).sort(), [...INTERACTIVE_ROLES].sort());
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

const BOUNDARY_DATA = {
	"boundaries/_layout.json": {
		layers: { contracts: [], domain: ["contracts"] },
		compositionFeatures: { shell: "the product frame composes every feature" },
		compositionRoots: { "apps/web/src/server/jobs/scheduled.ts": "the scheduler runs every feature's step" },
		exceptions: [],
		platformFolders: { jobs: "jobs every feature schedules through" },
		thickRoutes: {},
		packages: {
			domain: { kernel: { access: "the authority kernel every module checks with" }, entries: ["index.ts"] },
		},
	},
	"boundaries/apps-web-features-tasks.json": { public: { "model.ts": "task texts other features show" } },
	"boundaries/packages-domain.json": { public: ["people/core.ts"] },
};

test("INV-lint: imports across feature, route, platform and package boundaries are reported unless they go through a public file", () => {
	const files = {
		"packages/domain/package.json": { name: "@everyfield/domain", exports: { "./people": "./src/people/index.ts" } },
		"packages/contracts/package.json": { name: "@everyfield/contracts", exports: { ".": "./src/index.ts" } },
		"apps/web/src/features/tasks/model.ts": "export const a = 1;\n",
		"apps/web/src/features/tasks/private.ts": "export const b = 1;\n",
		"apps/web/src/features/shell/Frame.tsx": "export const d = 1;\n",
		"apps/web/src/components/dates.ts": `import { a } from "../features/tasks/model";\nexport const c = a;\n`,
		"apps/web/src/features/people/Panel.tsx": `import { a } from "../tasks/model";
import { b } from "@/features/tasks/private";
import { c } from "../../components/dates";
import { d } from "../shell/Frame";
import { e } from "@everyfield/domain/people/internal";
import type { F } from "../../app/x/page";
export const all: F[] = [a, b, c, d, e];
`,
		"apps/web/src/app/x/page.tsx": `import { a } from "@/features/tasks/model";
import { all } from "@/features/people/Panel";
export const dynamic = "force-dynamic";
export default function Page() {
	return [a, all];
}
`,
		"apps/web/src/features/people/Hidden.ts": `type T = typeof import("@/features/tasks/private");
import legacy = require("../tasks/private");
export const load = () => import(\`@/features/tasks/private\`);
export const typed: T | typeof legacy | null = null;
`,
		"apps/web/src/app/x/helpers.tsx": `import { a } from "@/features/tasks/model";\nimport { all } from "@/features/people/Panel";\nexport const both = [a, all];\n`,
		"apps/web/src/app/x/opengraph-image.tsx": `import { a } from "@/features/tasks/model";\nimport { all } from "@/features/people/Panel";\nexport default function Image() {\n\treturn [a, all];\n}\n`,
		"apps/web/src/server/jobs/mail.ts": `import { a } from "../../features/tasks/model";\nexport const m = a;\n`,
		"apps/web/src/server/jobs/scheduled.ts": `import { a } from "../../features/tasks/model";\nexport const s = a;\n`,
		"apps/web/src/server/tasks/index.ts": "export const t = 1;\n",
		"packages/domain/src/people/core.ts": `import { a } from "../../../../apps/web/src/features/tasks/model";
import { contract } from "@everyfield/contracts";
export const core = [a, contract];
`,
		"packages/domain/src/people/rows.ts": "export const q = 1;\n",
		"packages/domain/src/access/session.ts": "export const s = 1;\n",
		"packages/contracts/src/index.ts": `import { core } from "@everyfield/domain/people";\nexport const contract = core;\n`,
		"packages/domain/src/tasks/writes.ts": `import { core } from "../people/core";
import { q } from "../people/rows";
import { s } from "../access/session";
import { contract } from "../../../contracts/src/index";
export const w = [core, q, s, contract];
`,
	};
	assert.deepEqual(
		lint(files, BOUNDARY_DATA),
		[
			"apps/web/src/app/x/helpers.tsx:1",
			"apps/web/src/app/x/helpers.tsx:2",
			"apps/web/src/app/x/opengraph-image.tsx:2",
			"apps/web/src/app/x/page.tsx:2",
			"apps/web/src/app/x/page.tsx:4",
			"apps/web/src/components/dates.ts:1",
			"apps/web/src/features/people/Hidden.ts:1",
			"apps/web/src/features/people/Hidden.ts:2",
			"apps/web/src/features/people/Hidden.ts:3",
			"apps/web/src/features/people/Panel.tsx:2",
			"apps/web/src/features/people/Panel.tsx:4",
			"apps/web/src/features/people/Panel.tsx:5",
			"apps/web/src/features/people/Panel.tsx:6",
			"apps/web/src/server/jobs/mail.ts:1",
			"apps/web/src/server/tasks/index.ts:1",
			"packages/contracts/src/index.ts:1",
			"packages/domain/src/people/core.ts:1",
			"packages/domain/src/tasks/writes.ts:2",
			"packages/domain/src/tasks/writes.ts:4",
		].map((at) => `${at} feature-boundaries`),
	);
});

test("INV-lint: the boundary data check refuses a public entry that names nothing, a kernel outside the layout file and a package dependency its layer forbids", () => {
	const dir = sandbox(
		{
			"apps/web/src/features/tasks/model.ts": "export const a = 1;\n",
			"packages/domain/src/index.ts": "export {};\n",
			"packages/domain/package.json": {
				name: "@everyfield/domain",
				dependencies: { "@everyfield/contracts": "workspace:*" },
			},
			"packages/contracts/package.json": {
				name: "@everyfield/contracts",
				dependencies: { "@everyfield/domain": "workspace:*" },
			},
		},
		{
			...BOUNDARY_DATA,
			"boundaries/packages-domain.json": { kernel: { tasks: "a kernel outside the gated layout file" }, public: [] },
			"boundaries/apps-web-features-tasks.json": { public: { "gone.ts": "a file that was moved away" } },
		},
	);
	const ran = spawnSync(process.execPath, [join(repo, "scripts/lint/check-boundaries.mjs")], {
		cwd: dir,
		encoding: "utf8",
		env: env(dir),
	});
	assert.equal(ran.status, 1);
	assert.match(ran.stderr, /apps-web-features-tasks\.json public gone\.ts: names nothing/);
	assert.match(ran.stderr, /packages-domain\.json: unknown key kernel/);
	assert.match(
		ran.stderr,
		/packages\/contracts\/package\.json depends on @everyfield\/domain, which .* does not allow/,
	);
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

test("INV-lint: the comment check finds CSS, JSONC, YAML, shell, Python, plist, ignore-file and new migration comments and every directive", () => {
	const files = {
		"packages/ui/src/a.css": `a { color: red; } /* why */\n.b::after { content: "/* not */"; }\n`,
		"tsconfig.x.json": `{\n\t// why\n\t"a": "http://x"\n}\n`,
		".github/workflows/x.yml": `name: x # why\non: "#not"\n`,
		"bin/tool": `#!/bin/sh\n# why\necho "#not"\n`,
		".gitignore": `# why\nnode_modules\n`,
		"packages/db/migrations/20990101000000_new.sql": `select '--not';\n-- why\n`,
		"packages/ui/src/b.ts": `export const a = 1;\n// ${DISABLE} x\n/* ${OX_DISABLE} */\n`,
		"docs/x.css": `/* exempt */\n`,
		"tools/x.py": `#!/usr/bin/env python3\nprint(f"PR #{1}", '#not', """\n# not\n""")  # why\n`,
		"ops/x.plist": `<plist><string>&lt;!-- not --&gt;</string>\n<!-- why -->\n</plist>\n`,
		"docs/x.py": `# exempt\n`,
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
		"ops/x.plist:2: 1",
		"packages/db/migrations/20990101000000_new.sql:2: 1",
		"packages/ui/src/a.css:1: 1",
		"packages/ui/src/b.ts: 2",
		"tools/x.py:4: 1",
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

test("INV-mail: only the two mail modules that read or store the mail_request row name ProviderKey, in product code", () => {
	const source = `import type { ProviderKey as PK } from "@everyfield/contracts/common";
import type * as common from "@everyfield/contracts/common";
import { type ProviderKey } from "@everyfield/contracts/common";
export type { ProviderKey } from "@everyfield/contracts/common";
type Local = PK;
export const a = "x" as Local;
export const b = "x" as unknown as common.ProviderKey[];
export const c = (k: string): k is import("@everyfield/contracts/common").ProviderKey => k.length > 0;
export const d = (k: unknown) => k as ProviderKey | undefined;
export const e: string = "x";
`;
	const hits = (path) =>
		lint({ [path]: source, "tests/integration/x.test.mts": source })
			.filter((hit) => hit.endsWith("provider-key-mint"))
			.map((hit) => Number.parseInt(hit.split(":")[1], 10));
	assert.deepEqual(hits("packages/domain/src/notifications/x.ts"), [1, 3, 4, 7, 8]);
	assert.deepEqual(hits("apps/web/src/features/x/mail.ts"), [1, 3, 4, 7, 8]);
	assert.deepEqual(hits("packages/domain/src/communication/delivery.ts"), []);
	assert.deepEqual(hits("packages/domain/src/jobs/mail.ts"), []);
});

test("INV-actor: only the session module builds a RequestActor from a session, in product code; tests may forge one", () => {
	const forge = `import { RequestActor, RequestActor as RA } from "@everyfield/domain/access";
import * as access from "@everyfield/domain/access";
import type { RequestActor as Typed } from "@everyfield/domain/access";
export const a = (s: string, x: never) => RequestActor.of(s, x);
export const b = (s: string, x: never) => RequestActor["of"](s, x);
export const c = (s: string, x: never) => RA.of(s, x);
export const d = (s: string, x: never) => access.RequestActor.of(s, x);
export const e = (s: string, x: never) => RequestActor[\`of\`](s, x);
export const f = (k: "of") => RequestActor[k];
export const g = () => Reflect.get(RequestActor, "of");
export const { of } = RequestActor;
export const h = RA;
export const i = access.RequestActor;
export const j = (s: string) => RequestActor.resolve({} as never, s);
export const k = (s: string) => access.RequestActor.claimWrite({} as never, s, {} as never);
export type Held = Typed | RequestActor;
export { RequestActor as Authority } from "@everyfield/domain/access";
export { RA as Authority2, RequestActor };
export const l = async () => (await import("@everyfield/domain/access")).RequestActor.claimWrite;
export const m = async () => {
	const { RequestActor: R } = await import("@everyfield/domain/access");
	return R;
};
export const n = () => Reflect.construct(RequestActor.prototype.constructor, []);
`;
	const reported = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 17, 18, 21, 24];
	assert.deepEqual(
		lint({
			"packages/domain/src/wiki/forge.ts": forge,
			"apps/web/src/features/x/forge.ts": forge,
			"packages/domain/src/access/session.ts": forge,
			"tests/integration/x/forge.test.mts": forge,
		}),
		["apps/web/src/features/x/forge.ts", "packages/domain/src/wiki/forge.ts"]
			.flatMap((file) => reported.map((line) => `${file}:${line} request-actor`))
			.sort(),
	);
});

test("INV-lint: a survivor whose reason marks it temporary must name the evf task that removes it", () => {
	const path = "packages/ui/src/Panel.tsx";
	const run = (reason) => {
		const dir = sandbox(
			{ [path]: "export {};\n" },
			{ "survivors/packages-ui.json": { "no-effects": { [path]: [{ function: "Panel", count: 1, reason }] } } },
		);
		git(dir, "init", "-q");
		return check(dir, ["--no-base"]);
	};
	const refused = run("Temporary: the effect goes once the shared hook lands");
	assert.equal(refused.status, 1);
	assert.match(
		refused.out,
		/packages-ui\.json: no-effects packages\/ui\/src\/Panel\.tsx: a temporary entry must name the evf task/,
	);
	assert.match(run("Temporary: the effect goes once the shared hook lands (T-123)").out, /check-comments: passed/);
	assert.match(run("The effect follows the panel's lifetime, so it stays").out, /check-comments: passed/);
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

test("INV-storage: only the storage module reaches the object store client and its URL signer, in product code", () => {
	const reach = `import { S3Client } from "@aws-sdk/client-s3";
export { getSignedUrl } from "@aws-sdk/s3-request-presigner";
export const later = () => import("@aws-sdk/client-s3");
export type Client = import("@aws-sdk/client-s3").S3Client;
export const client = S3Client;
`;
	assert.deepEqual(
		lint({
			"packages/domain/src/documents/reach.ts": reach,
			"apps/web/src/features/x/reach.ts": reach,
			"packages/db/src/schema/storage.ts": reach,
			"tests/integration/x/reach.test.mts": reach,
		}),
		[
			"apps/web/src/features/x/reach.ts:1 storage-client",
			"apps/web/src/features/x/reach.ts:2 storage-client",
			"apps/web/src/features/x/reach.ts:3 storage-client",
			"apps/web/src/features/x/reach.ts:4 storage-client",
			"packages/domain/src/documents/reach.ts:1 storage-client",
			"packages/domain/src/documents/reach.ts:2 storage-client",
			"packages/domain/src/documents/reach.ts:3 storage-client",
			"packages/domain/src/documents/reach.ts:4 storage-client",
		],
	);
});

test("INV-deployment: only the deployment module reads VERCEL or VERCEL_ENV, in product code", () => {
	const reach = `export const a = process.env.VERCEL_ENV === "production";
export const b = process.env["VERCEL"] === "1";
export const c = (env) => env.VERCEL_ENV;
const { VERCEL_ENV: named } = process.env;
export const d = process.env[\`VERCEL_ENV\`];
const key = "VERCEL_ENV";
export const e = z.object({ VERCEL: z.literal("1") }).safeParse(process.env).success;
export const f = [named, key, process.env.VERCEL_URL];
`;
	const lines = [1, 2, 3, 4, 5, 6, 7];
	assert.deepEqual(
		lint({
			"packages/domain/src/mail/reach.ts": reach,
			"apps/web/src/features/x/reach.ts": reach,
			"packages/db/src/deployment.ts": "export const named = (env) => env.VERCEL_ENV ?? env.VERCEL;\n",
			"tests/integration/x/reach.test.mts": reach,
		}).filter((hit) => hit.endsWith(" deployment-env")),
		["apps/web/src/features/x/reach.ts", "packages/domain/src/mail/reach.ts"]
			.flatMap((file) => lines.map((line) => `${file}:${line} deployment-env`))
			.sort(),
	);
});

test("INV-config: web code reads the server environment only through the config module, and never parses all of it per call", () => {
	const reach = `import { serverEnv } from "../../server/config.ts";
export const a = process.env.IDENTITY_DATABASE_URL;
export const b = process.env["CRON_SECRET"];
const { PGOPTIONS } = process.env;
export const c = globalThis.process.env.IDENTITY_ORIGIN;
export const d = z.object({ CRON_SECRET: z.string() }).safeParse(serverEnv());
export const e = schema.parse(serverEnv());
export const f = process.env.NEXT_RUNTIME === "nodejs";
export const g = serverEnv().CRON_SECRET;
export const h = (process) => process.env.X;
export function i(source = serverEnv()) {
	return schema.safeParse(source);
}
const copy = serverEnv();
export const j = schema.parse(copy);
export const k = schema.parse({ ...serverEnv(), EXTRA: "1" });
export const l = Reflect.get(process, "env");
const { env } = process;
export const m = process.cwd();
export const n = schema.parse({ CRON_SECRET: serverEnv().CRON_SECRET });
export const o = { process: 1 };
`;
	const imports = `import nodeProcess from "node:process";
import { env as named } from "process";
export const p = require("node:process").env;
`;
	assert.deepEqual(
		lint({
			"apps/web/src/features/x/reach.ts": reach,
			"apps/web/src/server/config.ts":
				"export const serverEnv = () => process.env;\nexport const all = schema.parse(process.env);\n",
			"packages/domain/src/x/reach.ts": "export const a = process.env.IDENTITY_DATABASE_URL;\n",
			"apps/web/src/features/x/imports.ts": imports,
			"tests/integration/x/reach.test.mts": reach,
		}),
		[
			...[1, 2, 3].map((line) => `apps/web/src/features/x/imports.ts:${line} server-config`),
			...[2, 3, 4, 5, 6, 7, 12, 15, 16, 17, 18].map((line) => `apps/web/src/features/x/reach.ts:${line} server-config`),
		].sort(),
	);
});

test("INV-web-sql: apps/web imports no database module outside the files that still hold SQL", () => {
	const code = `import { sql } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import { eq } from "drizzle-orm";
export { and } from "drizzle-orm/sql";
export type Q = import("@everyfield/db/query").SQL;
import type { Database } from "@everyfield/db/client";
import { privateStorage } from "@everyfield/db/schema";
export const later = () => import("@everyfield/db/query");
export const used = [sql, t, eq, privateStorage, pgTable] as unknown as Database;
import { pgTable } from "@everyfield/db/columns";
`;
	const [holder] = Object.keys(WEB_SQL_HOLDERS);
	const reported = (files) => lint(files).filter((hit) => hit.endsWith(" web-database-imports"));
	assert.deepEqual(
		reported({
			"apps/web/src/features/x/server.ts": code,
			[holder]: code,
			"packages/domain/src/x/index.ts": code,
		}),
		[1, 2, 3, 4, 5, 8, 10].map((line) => `apps/web/src/features/x/server.ts:${line} web-database-imports`).sort(),
	);
	assert.deepEqual(reported({ [holder]: "export const none = 1;\n" }), [`${holder}:1 web-database-imports`]);
	assert.ok(Object.keys(WEB_SQL_HOLDERS).length <= 8, "WEB_SQL_HOLDERS only shrinks");
});

test("INV-failures: a server catch rethrows, returns the error handed on, or logs without answering lost", () => {
	const code = `import "server-only";
import { logFailure, logLine } from "@everyfield/domain/log";
export async function a(run) {
	try {
		return await run();
	} catch {
		return null;
	}
}
export const b = (run) => run().catch(() => null);
export const c = (run, handler) => run().catch(handler);
export const d = (run) => run().then((v) => v, () => null);
export async function e(run) {
	try {
		return await run();
	} catch (error) {
		void String(error);
		return null;
	}
}
export async function f(run) {
	try {
		return await run();
	} catch (error) {
		return null;
		throw error;
	}
}
export async function g(run) {
	try {
		return await run();
	} catch (error) {
		logFailure({ component: "x", outcome: "failed" }, error);
		return { status: "lost" };
	}
}
export async function h(run) {
	try {
		return await run();
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
		return null;
	}
}
export async function i(run) {
	try {
		return await run();
	} catch (error) {
		logFailure({ component: "x", outcome: "failed" }, error);
		return { status: "unknown" };
	}
}
export const j = (run, answer) => run().catch((error) => answer(error));
export const k = (run) => run().catch(() => logLine({ component: "x", outcome: "error" }));
export const l = (schema) => schema.catch("fallback");
export async function m(run, refusalOf) {
	try {
		return await run();
	} catch (error) {
		return refusalOf(error);
	}
}
`;
	const hits = [6, 10, 11, 12, 16, 24, 32];
	assert.deepEqual(
		lint({
			"apps/web/src/features/x/server.ts": code,
			"apps/web/src/server/jobs/x.ts": code.replace('import "server-only";\n', ""),
			"packages/domain/src/jobs/x.ts": code.replace('import "server-only";\n', ""),
			"packages/domain/src/people/x.ts": code.replace('import "server-only";\n', ""),
			"apps/web/src/features/x/Client.tsx": `"use client";\n${code.replace('import "server-only";\n', "")}`,
			"apps/web/src/server/platform/transient.ts": code,
		}),
		[
			...hits.map((line) => `apps/web/src/features/x/server.ts:${line} no-silent-catch`),
			...hits.map((line) => `apps/web/src/server/jobs/x.ts:${line - 1} no-silent-catch`),
			...hits.map((line) => `packages/domain/src/jobs/x.ts:${line - 1} no-silent-catch`),
		].sort(),
	);
});

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

test("INV-lint: a rule new against main is held to what it reports on main's tree, so merging main and regenerating stays legal", () => {
	const dir = sandbox({ "packages/ui/src/Panel.tsx": "export {};\n" });
	git(dir, "init", "-q", "-b", "main");
	commitAll(dir, "main without the rule");
	git(dir, "switch", "-q", "-c", "feature");
	commitAll(dir, "branch work");
	git(dir, "switch", "-q", "main");
	put(dir, "packages/ui/src/Panel.tsx", "export const later = () => setTimeout(() => {}, 1);\n");
	commitAll(dir, "main gains a timer");
	git(dir, "switch", "-q", "feature");
	git(dir, "merge", "-q", "--no-edit", "main");
	put(dir, "scripts/lint/baseline/no-timers/packages-ui.json", { "packages/ui/src/Panel.tsx": 1 });
	commitAll(dir, "regenerate after merging main");
	const main = git(dir, "rev-parse", "main");
	const regenerated = check(dir, ["--base", main]).out;
	assert.match(
		regenerated,
		/no-timers: the rule is new against \w+; its baseline is held to what the rule reports on that tree/,
	);
	assert.doesNotMatch(regenerated, /no-timers: .*(grew|new to the baseline)/);
	put(dir, "scripts/lint/baseline/no-timers/packages-ui.json", { "packages/ui/src/Panel.tsx": 2 });
	assert.match(check(dir, ["--base", main]).out, /no-timers: packages\/ui\/src\/Panel\.tsx grew from 1 to 2/);
	put(dir, "scripts/lint/baseline/no-timers/packages-ui.json", {
		"packages/ui/src/Panel.tsx": 1,
		"packages/ui/src/index.ts": 1,
	});
	assert.match(check(dir, ["--base", main]).out, /no-timers: packages\/ui\/src\/index\.ts is new to the baseline/);
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

test("INV-lint: baseline --shrink moves a renamed file's entries to its new path and area, and the growth check accepts them", () => {
	const effect = `import { useEffect } from "react";\nexport function Panel() {\n\tuseEffect(() => {});\n}\n`;
	const dir = sandbox(
		{ "packages/ui/src/Panel.tsx": effect },
		{ "baseline/no-effects/packages-ui.json": { "packages/ui/src/Panel.tsx": 1 } },
	);
	git(dir, "init", "-q", "-b", "main");
	const base = commitAll(dir, "base");
	mkdirSync(join(dir, "packages/ui/src/controls"));
	git(dir, "mv", "packages/ui/src/Panel.tsx", "packages/ui/src/controls/Panel.tsx");
	const shrink = spawnSync(process.execPath, [join(repo, "scripts/lint/baseline.mjs"), "--shrink", "--base", base], {
		cwd: dir,
		encoding: "utf8",
		env: env(dir),
	});
	assert.equal(shrink.status, 0, shrink.stderr);
	const baseline = join(dir, "scripts/lint/baseline/no-effects");
	assert.deepEqual(JSON.parse(readFileSync(join(baseline, "packages-ui-controls.json"), "utf8")), {
		"packages/ui/src/controls/Panel.tsx": 1,
	});
	assert.equal(existsSync(join(baseline, "packages-ui.json")), false);
	commitAll(dir, "move");
	assert.match(check(dir, ["--base", base]).out, /check-comments: passed/);
});

const configFails = (edit, pattern) => {
	const dir = sandbox();
	const path = join(dir, "apps/web/.oxlintrc.json");
	const config = JSON.parse(readFileSync(path, "utf8"));
	edit(config);
	put(dir, "apps/web/.oxlintrc.json", config);
	git(dir, "init", "-q");
	const { status, out } = check(dir, ["--no-base"]);
	assert.equal(status, 1, out);
	assert.match(out, pattern);
};

test("INV-lint: every override block is checked, so a second block with the same files cannot switch a rule off", () =>
	configFails((config) => {
		const blocks = config.overrides.filter((block) => block.files.join() === "src/**");
		assert.ok(blocks.length > 1);
		blocks[0].rules["everyfield/no-effects"] = "off";
	}, /override for src\/\*\*, rule everyfield\/no-effects needs its reason/));

test("INV-lint: any severity below error for an Everyfield rule needs its reason", () => {
	for (const severity of ["allow", 0, "warn", 1, ["off"], ["warn", {}]])
		configFails(
			(config) =>
				config.overrides.push({ files: ["src/features/x/**"], rules: { "everyfield/no-comments": severity } }),
			/override for src\/features\/x\/\*\*, rule everyfield\/no-comments needs its reason/,
		);
});

test("INV-lint: ignore files, ignored tracked files and lint flags cannot hide a file or a rule", () => {
	const fails = (files, pattern, scripts = {}, setup = () => {}) => {
		const dir = sandbox(files);
		put(dir, "package.json", { scripts: { ...SCRIPTS, ...scripts } });
		git(dir, "init", "-q");
		setup(dir);
		const { status, out } = check(dir, ["--no-base"]);
		assert.equal(status, 1, out);
		assert.match(out, pattern);
	};
	fails({ "apps/web/.eslintignore": "src/x/**\n" }, /apps\/web\/\.eslintignore: lint ignore files/);
	fails({ ".oxlintignore": "src/x/**\n" }, /^\.oxlintignore: lint ignore files/m);
	fails(
		{ "packages/ui/.oxlintrc.json": "{}\n" },
		/packages\/ui\/\.oxlintrc\.json: lint ignore files and extra Oxlint configs/,
	);
	fails(
		{ ".gitignore": "hidden/\n", "packages/ui/src/hidden/a.ts": "export {};\n" },
		/hidden\/a\.ts: git ignores this tracked file/,
		{},
		(dir) => git(dir, "add", "-f", "packages/ui/src/hidden/a.ts"),
	);
	for (const flag of [
		"-A everyfield/no-effects",
		"--allow everyfield/no-effects",
		"--ignore-path x",
		"--ignore-pattern x",
		"--no-ignore",
	])
		fails({}, /flag -/, { "lint:repo": `${OXLINT} -c .oxlintrc.json --max-warnings=0 ${flag} packages tests/unit` });
	fails({ "other.json": "{}\n" }, /must pass -c with one of/, {
		"lint:repo": `${OXLINT} -c other.json --max-warnings=0 packages tests/unit`,
	});
	fails({}, /needs --max-warnings=0/, { "lint:repo": `${OXLINT} -c .oxlintrc.json packages tests/unit` });
	fails({}, /must run every package's lint/, {
		lint: "pnpm run lint:web && pnpm run lint:repo && pnpm run lint:tools",
	});
});

test("INV-lint: a JS or TS file that no lint run covers fails", () => {
	const dir = sandbox({
		"tests/zzgroup/a.ts": "export {};\n",
		"lib/b.tsx": "export {};\n",
		"bin/zz.mjs": "export {};\n",
	});
	git(dir, "init", "-q");
	const { status, out } = check(dir, ["--no-base"]);
	assert.equal(status, 1, out);
	const uncovered = out
		.split("\n")
		.filter((line) => line.includes("no lint run covers"))
		.map((line) => line.split(":")[0]);
	assert.deepEqual(uncovered.sort(), ["bin/zz.mjs", "lib/b.tsx", "tests/zzgroup/a.ts"]);
});

test("INV-lint: effect, state and timer hooks are reported as references, not only as calls", () => {
	const source = `import React, * as R from "react";
import { useState as us } from "react";
const run = R.useEffect;
React["useEffect"](() => {});
export async function load() {
	(await import("react")).useLayoutEffect(() => {});
	return run;
}
const s = us;
export function Wide() {
	const a = s(0), b = React["useState"](0), c = us(0), d = us(0), e = s(0);
	return [a, b, c, d, e];
}
const t = setTimeout;
const { setTimeout: w } = window;
globalThis["setTimeout"](() => {}, 1);
setTimeout.call(null, () => {}, 1);
export const o = { schedule: requestAnimationFrame };
scheduler.postTask(() => {}, { delay: 10 });
scheduler.postTask(() => {});
AbortSignal.timeout(10);
export function own(setTimeout) {
	setTimeout(() => {});
}
export type Handle = ReturnType<typeof setTimeout>;
export { t, w };
`;
	assert.deepEqual(
		lint({ "packages/ui/src/sneaky.tsx": source }).map((hit) => hit.replace("packages/ui/src/sneaky.tsx:", "")),
		[
			"3 no-effects",
			"4 no-effects",
			"6 no-effects",
			"6 no-effects",
			"11 max-state",
			"14 no-timers",
			"15 no-timers",
			"16 no-timers",
			"17 no-timers",
			"18 no-timers",
			"19 no-timers",
		].sort(),
	);
});

test("INV-lint: an Oxlint config holds only known keys, so extends cannot pull in an override that turns rules off", () => {
	configFails((config) => {
		config.extends = ["../../tools/x.json"];
	}, /apps\/web\/\.oxlintrc\.json: the key extends is not allowed/);
	configFails((config) => {
		config.overrides.push({ files: ["src/**"], extends: ["x.json"], rules: {} });
	}, /the override for src\/\*\* may not set extends/);
});

test("INV-lint: ESLint configs carry no ignores beyond the expected ones and live only where expected", () => {
	const fails = (files, pattern) => {
		const dir = sandbox(files);
		git(dir, "init", "-q");
		const { status, out } = check(dir, ["--no-base"]);
		assert.equal(status, 1, out);
		assert.match(out, pattern);
	};
	fails(
		{ "apps/web/eslint.config.mjs": 'export default [{ ignores: ["src/features/x/**"] }];\n' },
		/apps\/web\/eslint\.config\.mjs:1: an ESLint ignore outside the expected ones/,
	);
	fails({ "lib/eslint.config.mjs": "export default [];\n" }, /lib\/eslint\.config\.mjs: an ESLint config outside/);
});

test("INV-lint: the lint scripts match their expected values exactly, so no step can be dropped, reordered or made optional", () => {
	for (const lint of [
		`${SCRIPTS.lint} || true`,
		`${SCRIPTS.lint}; true`,
		"pnpm -r --if-present lint && pnpm run lint:repo && pnpm run lint:web && pnpm run lint:tools",
		"pnpm -r --if-present lint && pnpm run lint:web && pnpm run lint:repo",
	]) {
		const dir = sandbox();
		put(dir, "package.json", { scripts: { ...SCRIPTS, lint } });
		git(dir, "init", "-q");
		const { status, out } = check(dir, ["--no-base"]);
		assert.equal(status, 1, out);
		assert.match(out, /package\.json: the lint script differs from scripts\/lint\/lint-scripts\.json/);
	}
	const step = " && node scripts/lint/check-comments.mjs";
	const dir = sandbox();
	put(dir, "scripts/lint/lint-scripts.json", {
		"package.json": { ...SCRIPTS, "lint:repo": SCRIPTS["lint:repo"] + step },
	});
	git(dir, "init", "-q");
	assert.match(check(dir, ["--no-base"]).out, /package\.json: the lint:repo script differs/);
});

test("INV-lint: the base tree is linted at its real path, so path exemptions hold on a symlinked TMPDIR", () => {
	const dir = sandbox({
		"packages/ui/src/a.ts": "// kept\nexport {};\n",
		"apps/web/scripts/render-share-images.mjs": "// exempt bytes\nexport {};\n",
	});
	git(dir, "init", "-q", "-b", "main");
	const base = commitAll(dir, "base");
	put(dir, "scripts/lint/baseline/no-comments/packages-ui.json", { "packages/ui/src/a.ts": 1 });
	commitAll(dir, "baseline");
	const real = realpathSync(mkdtempSync(join(tmpdir(), "lint-tmp-")));
	const linked = `${real}-link`;
	symlinkSync(real, linked);
	temps.push(real, linked);
	assert.match(check(dir, ["--base", base], { TMPDIR: linked }).out, /check-comments: passed/);
	put(dir, "scripts/lint/baseline/no-comments/apps-web.json", { "apps/web/scripts/render-share-images.mjs": 1 });
	assert.match(
		check(dir, ["--base", base], { TMPDIR: linked }).out,
		/no-comments: apps\/web\/scripts\/render-share-images\.mjs is new to the baseline/,
	);
});

test("INV-lint: in the app a caught failure never becomes an empty list, a zero or an ok result", () => {
	const source = `export async function f(read: () => Promise<string[]>) {
	try {
		return { status: "ok", value: await read() };
	} catch {
		return { status: "ok", value: [] } as const;
	}
}
export const g = (read: () => Promise<string[]>) => read().catch(() => []);
export const h = (read: () => Promise<number>) => read().catch(function () { return 0; });
export async function i(read: () => Promise<string[]>) {
	let names: string[] | null = null;
	try {
		names = await read();
	} catch {
		names = [];
	}
	try {
		return await read();
	} catch (e) {
		if (e) return [];
		throw e;
	}
}
export async function j(read: () => Promise<string[]>) {
	try {
		return await read();
	} catch {
		const none: string[] = [];
		return none;
	}
}
export async function k(read: () => Promise<string[]>) {
	try {
		return await read();
	} catch (e) {
		if ((e as { code?: string }).code === "ENOENT") return new Array<string>();
		return e ? [] : [];
	}
}
export const l = (read: () => Promise<string[]>) => read().then((x) => x, () => []);
export const m = (read: () => Promise<{ items: string[] }>) => read().catch(() => ({ items: [] }));
export const n = (read: () => Promise<string[]>) => read().catch(() => new Array<string>());
export async function o(read: () => Promise<string[]>) {
	try {
		return await read();
	} catch (error) {
		if (error instanceof RangeError) return [];
		return { status: "lost" } as const;
	}
}
export const p = (read: () => Promise<string[] | null>) => read().catch(() => null);
`;
	assert.deepEqual(
		lint({ "apps/web/src/features/x/server.ts": source, "packages/domain/src/x.ts": source }).filter((hit) =>
			hit.endsWith("failure-not-empty"),
		),
		[5, 8, 9, 15, 20, 28, 37, 40, 41, 42]
			.map((line) => `apps/web/src/features/x/server.ts:${line} failure-not-empty`)
			.sort(),
	);
});

test("INV-lint: product code that recognises a caught error by its message text, by comparison or pattern, is reported", () => {
	const source = `export function f(error: unknown, p: Promise<void>) {
	if (error instanceof Error && error.message === "unavailable") return 1;
	try {
		return 2;
	} catch (e) {
		if (["invalid_file"].includes(e.message)) return 3;
	}
	p.catch((err) => err.message.startsWith("stale"));
	const parsed = { message: "x" };
	if (error instanceof Error && /^[a-z_]+$/.test(error.message)) return 4;
	if (error instanceof Error && error.message.match(/stale/)) return 5;
	return /x/.test(parsed.message) && error instanceof Error && error.message;
}
`;
	assert.deepEqual(lint({ "packages/domain/src/m.ts": source, "tests/unit/m.test.mts": source }), [
		"packages/domain/src/m.ts:10 no-error-message-match",
		"packages/domain/src/m.ts:11 no-error-message-match",
		"packages/domain/src/m.ts:2 no-error-message-match",
		"packages/domain/src/m.ts:6 no-error-message-match",
		"packages/domain/src/m.ts:8 no-error-message-match",
	]);
});

test("INV-lint: a domain module that hand-builds a refusal class, retry or refusal reply is reported; defineRefusals and the listed mechanisms are not, and a listed file that no longer needs its entry is reported too", () => {
	const source = `import { defineRefusals } from "./operations/refusals.ts";
class Refusal extends Error {}
export const Other = class TaskRefused extends Error {};
const RETRY = { stale: "same_request", gone: "never" };
const retries = new Map([["stale", "refresh"]]);
export function reply(code: string, late: boolean) {
	if (late) return { status: "refused" as const, error: { code, retry: "never" } };
	return { status: late ? "ok" : "refused", error: { code, retry: late ? "refresh" : "never" } };
}
const refusals = defineRefusals(schema);
export const { deny, refused, settle } = refusals;
class RenderFailed extends Error {}
export const ok = { status: "ok", retry: refusals, retryAt: "never" };
export { Refusal, RETRY, retries, RenderFailed };
`;
	assert.deepEqual(
		lint({
			"packages/domain/src/m.ts": source,
			"packages/domain/src/operations/refusals.ts": source,
			"packages/domain/src/feedback/index.ts": source,
			"packages/domain/src/dashboard/index.ts": "export const none = 1;\n",
			"packages/evry/src/m.ts": source,
			"apps/web/src/features/x/server.ts": source,
		}).filter((hit) => hit.endsWith("domain-refusals")),
		[
			"packages/domain/src/dashboard/index.ts:1 domain-refusals",
			...[2, 3, 4, 5, 7, 7, 8, 8].map((line) => `packages/domain/src/m.ts:${line} domain-refusals`),
		],
	);
	assert.ok(Object.keys(REFUSAL_MECHANISMS).length <= 10, "REFUSAL_MECHANISMS only shrinks");
});

test("INV-lint: a hand-written sign-in redirect in web code is reported, signIn and other redirects are not", () => {
	const source = `import { redirect as go, notFound } from "next/navigation";
import * as nav from "next/navigation";
import { signIn } from "@/server/sign-in";
const TO = "/signin?returnTo=%2Fhome";
const BASE = "/signin";
let moving = "/signin?returnTo=%2Fx";
export function gate(path: string, out: boolean) {
	if (out) go(\`/signin?returnTo=\${encodeURIComponent(path)}\`);
	if (!path) go("/signin?returnTo=%2Fhome");
	if (path === "/x") go("/signin?returnTo=" + encodeURIComponent(path));
	if (path === "/a") nav.redirect(\`/signin?returnTo=\${path}\`);
	if (path === "/b") go(TO);
	if (path === "/c") go("/signin" + "?returnTo=" + path);
	if (path === "/d") nav.permanentRedirect(\`\${BASE}?returnTo=\${path}\`);
	if (path === "/y") go("/signin");
	if (path === "/z") go("/home");
	if (path === "/m") go(moving);
	if (out) signIn(path);
	notFound();
}
`;
	assert.deepEqual(lint({ "apps/web/src/features/x/routes.tsx": source, "apps/web/src/server/sign-in.ts": source }), [
		"apps/web/src/features/x/routes.tsx:10 sign-in-redirect",
		"apps/web/src/features/x/routes.tsx:11 sign-in-redirect",
		"apps/web/src/features/x/routes.tsx:12 sign-in-redirect",
		"apps/web/src/features/x/routes.tsx:13 sign-in-redirect",
		"apps/web/src/features/x/routes.tsx:14 sign-in-redirect",
		"apps/web/src/features/x/routes.tsx:8 sign-in-redirect",
		"apps/web/src/features/x/routes.tsx:9 sign-in-redirect",
	]);
});

test("INV-lint: a local generic Outcome type is reported unless it specializes the shared Outcome", () => {
	const specialized = `import type { Outcome as Shared } from "@everyfield/contracts/common";
export type Outcome<T> = Shared<T, "access_denied", { reason?: string }>;
`;
	const copy = `export type Outcome<T> = { status: "ok"; value: T } | { status: "lost" };\n`;
	const foreign = `import type { Outcome as Other } from "./other.ts";
export type Outcome<T> = Other<T>;
`;
	const plain = `export type Outcome = "lost" | "passed";\n`;
	assert.deepEqual(
		lint({
			"apps/web/src/features/x/types.ts": specialized,
			"apps/web/src/features/x/copy.ts": copy,
			"apps/web/src/features/x/foreign.ts": foreign,
			"apps/web/src/features/x/other.ts": copy.replace("Outcome", "Other"),
			"apps/web/src/features/x/plain.ts": plain,
			"packages/domain/src/m.ts": copy,
			"packages/contracts/src/common/values.ts": copy,
		}),
		[
			"apps/web/src/features/x/copy.ts:1 shared-outcome",
			"apps/web/src/features/x/foreign.ts:2 shared-outcome",
			"packages/domain/src/m.ts:1 shared-outcome",
		],
	);
});

test("INV-lint: a context value built during render is reported through aliases, casts, conditionals and outer bindings; every context and alias of one is a const named *Context; stable values are not", () => {
	const source = `import React, { createContext, useCallback, useMemo } from "react";
type T = { theme: string };
const ThemeContext = createContext<object | null>(null);
const Store = { Provider: ThemeContext };
export function A({ theme, on, children }: { theme: string; on: boolean; children: unknown }) {
	const stable = useMemo(() => ({ theme }), [theme]);
	const change = useCallback(() => theme, [theme]);
	const alias = { theme };
	const twice = alias;
	const pick = on ? stable : null;
	return (
		<>
			<ThemeContext value={{ theme }}>{children}</ThemeContext>
			<Store.Provider value={[theme]}>{children}</Store.Provider>
			<ThemeContext value={() => theme}>{children}</ThemeContext>
			<ThemeContext value={twice}>{children}</ThemeContext>
			<ThemeContext value={{ theme } as T}>{children}</ThemeContext>
			<ThemeContext value={on ? { theme } : null}>{children}</ThemeContext>
			<ThemeContext value={(on && [theme]) || null}>{children}</ThemeContext>
			<ThemeContext value={stable}>{children}</ThemeContext>
			<ThemeContext value={change}>{children}</ThemeContext>
			<ThemeContext value={pick}>{children}</ThemeContext>
			<Store.Provider value={theme}>{children}</Store.Provider>
		</>
	);
}
export function B({ children, ...rest }: { children: unknown; a: string }) {
	return <ThemeContext value={rest}>{children}</ThemeContext>;
}
export const Seat = createContext(null);
export const Flag = React.createContext(false);
export const SeatContext = createContext(null);
const Settled = { theme: "fixed" };
export function C({ items, theme, children }: { items: string[]; theme: string; children: unknown }) {
	const outer = { theme };
	const kept = useMemo(() => ({ theme }), [theme]);
	return items.map((item) => (
		<ThemeContext key={item} value={outer}>
			<ThemeContext value={kept}>{children}</ThemeContext>
			<ThemeContext value={Settled}>{children}</ThemeContext>
			{[item].map((outer) => <ThemeContext key={outer} value={outer}>{children}</ThemeContext>)}
		</ThemeContext>
	));
}
const Alias = ThemeContext;
const AliasContext = ThemeContext as typeof ThemeContext;
export default createContext(null);
export const contexts = { Ctx: createContext(null) };
export const CastContext = createContext(null) as object;
`;
	assert.deepEqual(lint({ "packages/ui/src/x.tsx": source }), [
		"packages/ui/src/x.tsx:13 stable-context-value",
		"packages/ui/src/x.tsx:14 stable-context-value",
		"packages/ui/src/x.tsx:15 stable-context-value",
		"packages/ui/src/x.tsx:16 stable-context-value",
		"packages/ui/src/x.tsx:17 stable-context-value",
		"packages/ui/src/x.tsx:18 stable-context-value",
		"packages/ui/src/x.tsx:19 stable-context-value",
		"packages/ui/src/x.tsx:28 stable-context-value",
		"packages/ui/src/x.tsx:30 stable-context-value",
		"packages/ui/src/x.tsx:31 stable-context-value",
		"packages/ui/src/x.tsx:38 stable-context-value",
		"packages/ui/src/x.tsx:45 stable-context-value",
		"packages/ui/src/x.tsx:47 stable-context-value",
		"packages/ui/src/x.tsx:48 stable-context-value",
	]);
});

test("INV-lint: comments inside SQL templates and query strings are reported, a listed marker is not", () => {
	const source = `import { sql as q } from "drizzle-orm";
export const sql = (s: TemplateStringsArray, ...v: unknown[]) => [s, v];
export const a = sql\`SELECT 1 -- why
 FROM x WHERE y = '-- not' /* also */\`;
export const b = q\`SELECT \${1} -- aliased\`;
export const run = (client: { query(text: string): void }) => {
	client.query("BEGIN /* evf:retry */");
	client.query(\`SELECT 2 -- in a query\`);
	client.query("SELECT '/* text */'");
};
`;
	assert.deepEqual(lint({ "packages/domain/src/q.ts": source }), [
		"packages/domain/src/q.ts:3 no-sql-comments",
		"packages/domain/src/q.ts:4 no-sql-comments",
		"packages/domain/src/q.ts:5 no-sql-comments",
		"packages/domain/src/q.ts:8 no-sql-comments",
	]);
});

test("INV-lint: an insert into a single-writer table is reported outside its owning module, in SQL text or through the query builder", () => {
	const source = `import { sql } from "drizzle-orm";
export const a = sql\`INSERT INTO phase_transition(plant_id) VALUES (1)\`;
export const b = (db, t) => db.insert(t.phase_transition).values({});
export const c = sql\`insert into "public"."phase_transition" (plant_id) select 1\`;
export const d = sql\`SELECT kind FROM phase_transition\`;
export const e = sql\`UPDATE phase_transition SET offer_answer = 'yes'\`;
`;
	const named = `import { phase_transition, plant } from "@everyfield/db/schema";
import * as t from "@everyfield/db/schema";
export const f = (db) => db.insert(phase_transition).values({});
const pt = t.phase_transition;
const { phase_transition: other } = t;
export const g = (db) => [db.insert(pt).values({}), db.insert(other).values({}), db.insert(plant).values({})];
`;
	assert.deepEqual(
		lint({
			"packages/domain/src/tasks/x.ts": source,
			"packages/domain/src/phases/x.ts": source,
			"packages/domain/src/tasks/named.ts": named,
			"packages/domain/src/phases/named.ts": named,
		}).filter((hit) => hit.endsWith("table-writers")),
		[
			"packages/domain/src/tasks/named.ts:3 table-writers",
			"packages/domain/src/tasks/named.ts:6 table-writers",
			"packages/domain/src/tasks/named.ts:6 table-writers",
			"packages/domain/src/tasks/x.ts:2 table-writers",
			"packages/domain/src/tasks/x.ts:3 table-writers",
			"packages/domain/src/tasks/x.ts:4 table-writers",
		],
	);
});

test("INV-lint: a React namespace alias, a class lifecycle method and a ref callback that never uses its node are effects", () => {
	const source = `import * as React from "react";
import { Component, useCallback } from "react";
const R = React;
R.useEffect(() => {});
export class Old extends Component {
	componentDidMount() {}
	componentDidUpdate = () => {};
	componentWillUnmount() {}
	componentDidCatch() {}
	render() {
		return null;
	}
}
export function Panel({ start, keep }) {
	const mount = useCallback(() => start(), [start]);
	const sized = (node) => keep(node);
	return (
		<div>
			<span ref={() => start()} />
			<span ref={(node) => { if (node) start(); }} />
			<span ref={(node) => (node ? start() : undefined)} />
			<span ref={mount} />
			<span ref={(node) => node?.focus()} />
			<span ref={sized} />
			<span ref={useCallback((node) => keep(node), [keep])} />
			<span ref={(node) => { if (node !== null) start(); }} />
			<span ref={React.useCallback(() => start(), [start])} />
			<span ref={attach} />
			<span ref={React.useCallback((node) => keep(node), [keep])} />
			<span ref={(node) => { if (node !== null) node.focus(); }} />
		</div>
	);
}
function attach(node) {
	if (undefined != node) report("attached");
}
`;
	assert.deepEqual(lint({ "apps/web/src/features/x/Old.tsx": source }), [
		"apps/web/src/features/x/Old.tsx:19 no-effects",
		"apps/web/src/features/x/Old.tsx:20 no-effects",
		"apps/web/src/features/x/Old.tsx:21 no-effects",
		"apps/web/src/features/x/Old.tsx:22 no-effects",
		"apps/web/src/features/x/Old.tsx:26 no-effects",
		"apps/web/src/features/x/Old.tsx:27 no-effects",
		"apps/web/src/features/x/Old.tsx:28 no-effects",
		"apps/web/src/features/x/Old.tsx:4 no-effects",
		"apps/web/src/features/x/Old.tsx:6 no-effects",
		"apps/web/src/features/x/Old.tsx:7 no-effects",
		"apps/web/src/features/x/Old.tsx:8 no-effects",
	]);
});

test("INV-lint: a timer on any window, motion's frame loop and an await of a value already there are timers", () => {
	const source = `import { frame, useAnimationFrame as useLoop, delay, cancelFrame } from "motion/react";
export async function run(node, input) {
	node.ownerDocument.defaultView.requestAnimationFrame(() => {});
	const view = window;
	view.setTimeout(() => {}, 1);
	const { setTimeout: later } = view;
	frame.update(() => {}, true);
	frame.render(() => {});
	delay(() => {}, 10);
	await null;
	await undefined;
	await Promise.resolve();
	Promise.resolve().then(() => {});
	await scheduler.yield();
	await Promise.resolve(input);
	await input;
	cancelFrame(run);
	return [later, useLoop];
}
`;
	assert.deepEqual(
		lint({ "apps/web/src/features/x/loop.ts": source }).map((hit) =>
			hit.replace("apps/web/src/features/x/loop.ts:", ""),
		),
		[
			"3 no-timers",
			"5 no-timers",
			"6 no-timers",
			"7 no-timers",
			"8 no-timers",
			"9 no-timers",
			"10 no-timers",
			"11 no-timers",
			"12 no-timers",
			"13 no-timers",
			"14 no-timers",
			"18 no-timers",
		].sort(),
	);
});

test("INV-lint: media query listeners, page observers and observers made at module load are global listeners, in packages/ui too", () => {
	const source = `const pages = new MutationObserver(() => {});
export function watch(node, run) {
	window.matchMedia("(min-width: 1px)").addEventListener("change", run);
	const query = matchMedia("(prefers-reduced-motion: reduce)");
	query.onchange = run;
	pages.observe(document.body, { childList: true });
	new ResizeObserver(run).observe(node.ownerDocument.documentElement);
	const own = new ResizeObserver(run);
	own.observe(node);
	own.observe(node.contentDocument.documentElement);
	return own;
}
`;
	const hits = lint({ "apps/web/src/features/x/watch.ts": source, "packages/ui/src/foundations/watch.ts": source });
	assert.deepEqual(
		hits,
		["apps/web/src/features/x/watch.ts", "packages/ui/src/foundations/watch.ts"]
			.flatMap((path) => [1, 3, 5, 6, 7].map((line) => `${path}:${line} no-global-listeners`))
			.sort(),
	);
});

test("INV-lint: a write to module state while rendering is reported, directly, through a module function or in a render-time initializer", () => {
	const source = `import { useMemo, useState } from "react";
import { unread } from "./reads.ts";
const shown = new Set();
let renders = 0;
const cache = { last: null };
function firstShow(id) {
	if (shown.has(id)) return false;
	shown.add(id);
	return true;
}
const markShown = (id) => firstShow(id);
export function Card({ id, count }) {
	renders++;
	cache.last = id;
	const [fresh] = useState(() => markShown(id));
	useState(() => unread.seed(count));
	const sorted = useMemo(() => [...shown].sort(), []);
	const onClick = () => {
		shown.delete(id);
		renders = 0;
	};
	return <button onClick={onClick}>{String(fresh) + sorted.length}</button>;
}
export function useCount() {
	const local = new Set();
	local.add(1);
	return firstShow(0);
}
markShown("boot");
function seedAll(ids) {
	ids.forEach((id) => shown.add(id));
}
export function List({ ids }) {
	ids.map((id) => [id]).forEach(([id]) => shown.add(id));
	useState(() => seedAll(ids));
	return <button onClick={() => ids.forEach((id) => shown.delete(id))}>{ids.length}</button>;
}
`;
	assert.deepEqual(
		lint({ "apps/web/src/features/x/Card.tsx": source, "packages/ui/src/Card.tsx": source }),
		[
			...["apps/web/src/features/x/Card.tsx", "packages/ui/src/Card.tsx"].flatMap((path) =>
				[13, 14, 15, 16, 27, 34, 35].map((line) => `${path}:${line} no-render-writes`),
			),
		].sort(),
	);
});

test("INV-lint: a module write that runs only later, in a handler, a subscription or a route handler, is not a render write", () => {
	const later = `import { useSyncExternalStore } from "react";
const listeners = new Set();
let value = 0;
function subscribe(cb) {
	listeners.add(cb);
	return () => listeners.delete(cb);
}
function useBump() {
	return () => {
		value++;
	};
}
function makeBump() {
	return () => listeners.clear();
}
function useValue() {
	return useSyncExternalStore((cb) => subscribe(cb), () => value);
}
export function Counter() {
	const bump = useBump();
	const reset = makeBump();
	const shown = useValue();
	return <button onClick={() => (bump(), reset())}>{shown}</button>;
}
`;
	const route = `const hits = new Map();
export async function POST() {
	hits.set("a", 1);
	return new Response(null);
}
export function Report() {
	hits.clear();
	return null;
}
`;
	assert.deepEqual(
		lint({ "apps/web/src/features/x/Counter.tsx": later, "apps/web/src/app/api/x/route.ts": route }).filter((hit) =>
			hit.endsWith("no-render-writes"),
		),
		[],
	);
});

test("INV-lint: a store read with getState() while rendering is reported, also through a destructured, defaulted, assigned, bound or passed getState; a read in a handler, a callback, a subscription snapshot or of the store's actions is not, and a same-named binding elsewhere is not an alias", () => {
	const source = `import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useStore } from "@/components/store";
export function Card({ store, ids }) {
	const count = store.getState().count;
	const [first] = useState(() => store.getState().first);
	const sorted = useMemo(() => store.getState().items.slice(), [store]);
	const rows = ids.map((id) => store.getState().rows[id]);
	const { actions } = store.getState();
	const save = store.getState().actions.save;
	const shown = useSyncExternalStore(store.subscribe, () => store.getState().shown);
	const picked = useStore(store, (s) => s.picked);
	const hold = useCallback(() => store.getState().actions.hold(), [store]);
	const latest = () => store.getState().count;
	return (
		<button key={store.getState().id} onClick={() => save(store.getState().draft)} onBlur={hold}>
			{String(count) + first + sorted + rows + actions + shown + picked + latest}
		</button>
	);
}
export function useDraft(store) {
	return store.getState().draft;
}
export function draftOf(store) {
	return store.getState().draft;
}
export function Aliased({ store }) {
	const { getState } = store;
	const read = store.getState;
	const onClick = () => read().count;
	return <button onClick={onClick}>{getState().count + read().count}</button>;
}
export function Bound({ store, getState: given }) {
	const bound = store.getState.bind(store);
	let later;
	later = store.getState;
	const { getState: fallback = null } = store;
	const onClick = () => bound().count + later().count;
	const a = store.getState.bind(store)().a;
	const b = bound().b;
	const c = later().c;
	const d = fallback().d;
	const e = given().e;
	const f = store.getState.call(store).f;
	return <button onClick={onClick}>{a + b + c + d + e + f}</button>;
}
export function Handler({ store }) {
	const pick = store.getState;
	return <button onClick={() => pick().count}>Go</button>;
}
export function Unrelated({ pick }) {
	return <p>{pick()}</p>;
}
`;
	assert.deepEqual(
		lint({ "apps/web/src/features/x/Card.tsx": source, "packages/ui/src/Card.tsx": source }).filter((hit) =>
			hit.endsWith("no-render-get-state"),
		),
		["apps/web/src/features/x/Card.tsx", "packages/ui/src/Card.tsx"]
			.flatMap((path) =>
				[4, 5, 6, 7, 15, 21, 30, 30, 38, 39, 40, 41, 42, 43].map((line) => `${path}:${line} no-render-get-state`),
			)
			.sort(),
	);
});

test("INV-lint: only an overlay's lazy entry imports it, so no static chain from a product page reaches it; the parts its sections share import freely", () => {
	const settings = "apps/web/src/features/settings";
	const files = {
		[`${settings}/ProductSettings.tsx`]:
			'import type { SettingsDialogProps } from "./SettingsDialog";\nexport const load = () => import("./SettingsDialog");\nexport type P = SettingsDialogProps;\n',
		[`${settings}/sections/ChurchSection.tsx`]:
			'import { SectionBody } from "../SettingsDialog";\nimport { SaveFooter } from "../SectionParts";\nexport const parts = [SectionBody, SaveFooter];\n',
		[`${settings}/brand/BrandSection.tsx`]:
			'import { SectionBody } from "../SettingsDialog";\nexport const parts = [SectionBody];\n',
		[`${settings}/preview/SettingsPreview.tsx`]:
			'import { SettingsDialog } from "../SettingsDialog";\nimport { LazySettingsDialog } from "../ProductSettings";\nexport const dialogs = [SettingsDialog, LazySettingsDialog];\n',
		"apps/web/src/features/evry/conversation/panel.tsx":
			'import { SettingsDialog } from "../../settings/SettingsDialog";\nexport const load = () => import("./EvryPanel.tsx");\nexport const dialog = SettingsDialog;\n',
		"apps/web/src/features/shell/Frame.tsx":
			'import { ChurchSection } from "../settings/sections/ChurchSection";\nexport const section = ChurchSection;\n',
	};
	assert.deepEqual(lintIn(sandbox(files), Object.keys(files), /^eslint\((no-restricted-imports)\)$/), [
		"apps/web/src/features/evry/conversation/panel.tsx:1 no-restricted-imports",
		`${settings}/brand/BrandSection.tsx:1 no-restricted-imports`,
		`${settings}/preview/SettingsPreview.tsx:1 no-restricted-imports`,
		`${settings}/sections/ChurchSection.tsx:1 no-restricted-imports`,
	]);
});

test("INV-lint: a page, a layout or a GET route handler that imports a server action module is reported, a route that also writes is not", () => {
	const actions = `"use server";\nexport async function save() {}\n`;
	const reads = `export async function load() {}\n`;
	assert.deepEqual(
		lint({
			"apps/web/src/features/x/actions.ts": actions,
			"apps/web/src/features/x/reads.ts": reads,
			"apps/web/src/app/x/page.tsx": `export { save as default } from "@/features/x/actions";\n`,
			"apps/web/src/app/x/layout.tsx": `export { load as default } from "@/features/x/reads";\n`,
			"apps/web/src/app/x/read/route.ts": `export { save as GET } from "../../../features/x/actions";\n`,
			"apps/web/src/app/x/write/route.ts": `export { save as GET, save as POST } from "@/features/x/actions";\n`,
		}).filter((hit) => hit.endsWith("route-reads")),
		["apps/web/src/app/x/page.tsx:1 route-reads", "apps/web/src/app/x/read/route.ts:1 route-reads"],
	);
});

test("INV-lint: a runtime or dynamic segment export that repeats Next's default is reported, one that changes behavior is not", () => {
	const get = `export async function GET() {\n\treturn new Response("ok");\n}\n`;
	assert.deepEqual(
		lint({
			"apps/web/src/app/(product)/x/page.tsx": `export const dynamic = "force-dynamic";\nexport default function Page() {\n\treturn null;\n}\n`,
			"apps/web/src/app/(product)/x/[id]/route.ts": `export const runtime = "nodejs";\nexport const dynamic = "force-dynamic";\n${get}`,
			"apps/web/src/app/api/x/route.ts": `export const dynamic = "force-dynamic";\n${get}export const POST = GET;\n`,
			"apps/web/src/app/api/auto/route.ts": `export const dynamic = "auto";\n${get}`,
			"apps/web/src/app/api/fixed/route.ts": `export const dynamic = "force-dynamic";\nexport const maxDuration = 60;\n${get}`,
			"apps/web/src/app/api/static/route.ts": `export const dynamic = "force-static";\n${get}`,
			"apps/web/src/app/(marketing)/y/page.tsx": `export const dynamic = "force-dynamic";\nexport default function Page() {\n\treturn null;\n}\n`,
		}).filter((hit) => hit.endsWith("route-segment-defaults")),
		[
			"apps/web/src/app/(product)/x/[id]/route.ts:1 route-segment-defaults",
			"apps/web/src/app/(product)/x/[id]/route.ts:2 route-segment-defaults",
			"apps/web/src/app/(product)/x/page.tsx:1 route-segment-defaults",
			"apps/web/src/app/api/auto/route.ts:1 route-segment-defaults",
			"apps/web/src/app/api/x/route.ts:1 route-segment-defaults",
		],
	);
});

test("INV-lint: a route module or server-only module that calls a server action is reported, one that passes it on or a client store that calls it is not", () => {
	const actions = `"use server";\nexport async function read() {}\nexport async function save() {}\n`;
	assert.deepEqual(
		lint({
			"apps/web/src/features/x/actions.ts": actions,
			"apps/web/src/features/x/routes.tsx": `import { read, save } from "./actions";\nexport async function Page() {\n\tawait read();\n\treturn save;\n}\n`,
			"apps/web/src/features/x/server.ts": `import "server-only";\nimport * as A from "./actions";\nexport const load = () => A.read();\n`,
			"apps/web/src/features/x/store.ts": `import { read } from "./actions";\nexport const load = () => read();\n`,
		}).filter((hit) => hit.endsWith("render-reads")),
		["apps/web/src/features/x/routes.tsx:3 render-reads", "apps/web/src/features/x/server.ts:3 render-reads"],
	);
});

test("INV-lint: a read exported from a server action module, under its own name or renamed, or declared as an inline server action is reported, a write or a server-only read is not", () => {
	assert.deepEqual(
		lint({
			"apps/web/src/features/x/actions.ts": `"use server";\nexport async function readThing() {}\nexport const listThings = async () => [];\nexport async function saveThing() {}\nexport async function reader() {}\nasync function loadInner() {}\nexport { loadInner as loadAlias };\nexport const { findOne, saveOne } = { findOne: async () => 1, saveOne: async () => 2 };\n`,
			"apps/web/src/features/x/default.ts": `"use server";\nexport default async function readDefault() {}\n`,
			"apps/web/src/features/x/hidden.ts": `"use server";\nasync function readHidden() {}\nasync function reloadRow() {}\nexport { readHidden as default, reloadRow as saveRow };\nexport async function downloadFile() {}\n`,
			"apps/web/src/features/x/all.ts": `"use server";\nexport * from "./reads.ts";\n`,
			"apps/web/src/features/x/reads.ts": `export async function readFromAll() {}\n`,
			"apps/web/src/features/x/Card.tsx": `export function Card() {\n\tasync function readInline() {\n\t\t"use server";\n\t}\n\tasync function saveInline() {\n\t\t"use server";\n\t}\n\treturn [readInline, saveInline];\n}\n`,
			"apps/web/src/features/x/server.ts": `import "server-only";\nexport async function readThing() {}\n`,
		}).filter((hit) => hit.endsWith("no-read-actions")),
		[
			"apps/web/src/features/x/Card.tsx:2 no-read-actions",
			"apps/web/src/features/x/actions.ts:2 no-read-actions",
			"apps/web/src/features/x/actions.ts:3 no-read-actions",
			"apps/web/src/features/x/actions.ts:7 no-read-actions",
			"apps/web/src/features/x/actions.ts:8 no-read-actions",
			"apps/web/src/features/x/all.ts:2 no-read-actions",
			"apps/web/src/features/x/default.ts:2 no-read-actions",
			"apps/web/src/features/x/hidden.ts:4 no-read-actions",
			"apps/web/src/features/x/hidden.ts:4 no-read-actions",
			"apps/web/src/features/x/hidden.ts:5 no-read-actions",
		],
	);
});

test("INV-lint: a server action parameter typed as a trusted shape is reported, also wrapped in a call or re-exported, unknown, primitives, FormData and their unions are not", () => {
	assert.deepEqual(
		lint({
			"apps/web/src/features/x/actions.ts": `"use server";\ntype Input = { id: string };\nexport async function save(input: Input) {}\nexport async function mode(kind: "a" | "b") {}\nexport async function list(ids: string[]) {}\nexport const arrow = async ({ id }: { id: string }) => id;\nasync function hidden(input: Input) {}\nexport { hidden as renamed };\nexport async function fine(a: unknown, b: string, c: number | null, d?: boolean, e: FormData = new FormData(), f = "now") {}\nasync function local(input: Input) {}\n`,
			"apps/web/src/features/x/Card.tsx": `export function Card() {\n\tasync function inline(input: { id: string }) {\n\t\t"use server";\n\t}\n\treturn inline;\n}\n`,
			"apps/web/src/features/x/server.ts": `import "server-only";\nexport async function save(input: { id: string }) {}\n`,
			"apps/web/src/features/x/wrapped.ts": `"use server";\nconst wrap = <T>(f: T) => f;\nexport const saved = wrap(async (input: { id: string }) => input);\nconst inner = wrap(async (ids: string[]) => ids);\nexport { inner };\nexport const fine = wrap(async (input: unknown) => input);\n`,
			"apps/web/src/features/x/again.ts": `"use server";\nexport { save } from "./server.ts";\nexport * from "./server.ts";\n`,
		}).filter((hit) => hit.endsWith("action-params-unknown")),
		[
			"apps/web/src/features/x/Card.tsx:2 action-params-unknown",
			"apps/web/src/features/x/actions.ts:3 action-params-unknown",
			"apps/web/src/features/x/actions.ts:4 action-params-unknown",
			"apps/web/src/features/x/actions.ts:5 action-params-unknown",
			"apps/web/src/features/x/actions.ts:6 action-params-unknown",
			"apps/web/src/features/x/actions.ts:7 action-params-unknown",
			"apps/web/src/features/x/again.ts:2 action-params-unknown",
			"apps/web/src/features/x/again.ts:3 action-params-unknown",
			"apps/web/src/features/x/wrapped.ts:3 action-params-unknown",
			"apps/web/src/features/x/wrapped.ts:4 action-params-unknown",
		],
	);
});
