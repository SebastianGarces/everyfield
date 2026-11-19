import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const OXLINT = join(repo, "packages/evry/node_modules/.bin/oxlint");
const PLUGIN = join(repo, "scripts/lint/everyfield-plugin.mjs");
const CSS_CHECK = join(repo, "apps/web/scripts/check-slop-styling.mjs");
const CONFIGS = [".oxlintrc.json", "apps/web/.oxlintrc.json"];

const temps = [];
test.after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const put = (dir, path, content) => {
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), typeof content === "string" ? content : `${JSON.stringify(content, null, "\t")}\n`);
};

function sandbox(files, lintData = {}) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "slop-styling-")));
	temps.push(dir);
	for (const config of CONFIGS)
		put(dir, config, { ...JSON.parse(readFileSync(join(repo, config), "utf8")), jsPlugins: [PLUGIN] });
	for (const data of ["exemptions.json", "boundaries/_layout.json"])
		put(dir, `scripts/lint/${data}`, JSON.parse(readFileSync(join(repo, "scripts/lint", data), "utf8")));
	for (const root of ["packages/ui/src/index.ts", "apps/web/src/features/index.ts"]) put(dir, root, "export {};\n");
	for (const [path, content] of Object.entries(files)) put(dir, path, content);
	for (const [path, content] of Object.entries(lintData)) put(dir, `scripts/lint/${path}`, content);
	return dir;
}

const env = (dir) => ({ ...process.env, EVERYFIELD_ROOT: dir, EVERYFIELD_LINT_DIR: join(dir, "scripts/lint") });
const KIND = /everyfield\/no-slop-styling (\S+),/;

function lintCode(dir, paths) {
	const hits = [];
	for (const [config, cwd, mine] of [
		["apps/web/.oxlintrc.json", "apps/web", paths.filter((p) => p.startsWith("apps/web/"))],
		[".oxlintrc.json", ".", paths.filter((p) => !p.startsWith("apps/web/"))],
	]) {
		if (!mine.length) continue;
		const at = join(dir, cwd);
		const ran = spawnSync(
			OXLINT,
			["-c", relative(at, join(dir, config)), "-f", "json", ...mine.map((p) => relative(at, join(dir, p)))],
			{ cwd: at, encoding: "utf8", env: env(dir) },
		);
		for (const d of JSON.parse(ran.stdout.slice(ran.stdout.indexOf("{"))).diagnostics)
			if (d.code === "everyfield(no-slop-styling)")
				hits.push(
					`${relative(dir, resolve(at, d.filename))}:${d.labels?.[0]?.span.line ?? 1} ${KIND.exec(d.message)?.[1] ?? d.message}`,
				);
	}
	return hits.sort();
}

const lint = (files, lintData) => lintCode(sandbox(files, lintData), Object.keys(files));

function checkCss(dir) {
	const ran = spawnSync(process.execPath, [CSS_CHECK], { cwd: dir, encoding: "utf8", env: env(dir) });
	const hits = ran.stderr
		.split("\n")
		.map((line) => /^(\S+?):(\d+): .*\(everyfield\/no-slop-styling (\S+),/.exec(line))
		.filter(Boolean)
		.map(([, path, line, kind]) => `${path}:${line} ${kind}`);
	return {
		status: ran.status,
		hits: hits.map((h) => h.slice(h.lastIndexOf(":") + 1)).sort(byLine),
		stderr: ran.stderr,
	};
}

const byLine = (a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10) || a.localeCompare(b);
const at = (path, hits) => hits.map((hit) => hit.replace(`${path}:`, "")).sort(byLine);

test("INV-lint: a small uppercase or tracked label directly above a heading is an eyebrow; the same label below a heading or above body text is not", () => {
	const path = "apps/web/src/features/x/Hero.tsx";
	const source = `export function Hero({ CardTitle }) {
	return (
		<section>
			<div>
				<p className="text-xs font-semibold uppercase text-text-3">Overview</p>
				<h1>Welcome</h1>
			</div>
			<header>
				<span className="section-label">Step one</span>
				<CardTitle>Plan the launch</CardTitle>
			</header>
			<div>
				<p className="text-sm tracking-[0.1em]">Kicker</p>
				<p className="font-title text-title-md">Big line</p>
			</div>
			<div>
				<h2>Heading</h2>
				<p className="section-label">Below the heading</p>
			</div>
			<div>
				<p className="section-label">Section</p>
				<p className="text-sm">Body text</p>
			</div>
		</section>
	);
}
`;
	const hits = at(path, lint({ [path]: source }));
	assert.deepEqual(
		hits.filter((h) => h.endsWith("eyebrow")),
		["5 eyebrow", "9 eyebrow", "13 eyebrow"],
	);
});

test("INV-lint: monospace with uppercase is reported in classes, style objects and CSS; monospace alone passes", () => {
	const path = "packages/ui/src/display/Code.tsx";
	const source = `export const Ref = () => <code className="font-mono text-xs uppercase">id</code>;
export const Styled = () => <code style={{ fontFamily: "ui-monospace, monospace", textTransform: "uppercase" }}>id</code>;
export const Plain = () => <code className="font-mono text-xs">a1b2c3</code>;
`;
	assert.deepEqual(at(path, lint({ [path]: source })), ["1 mono-uppercase", "2 mono-uppercase"]);
	const css = "apps/web/src/features/x/code.css";
	const dir = sandbox({
		[css]: `.tag {\n\tfont-family: ui-monospace, monospace;\n\ttext-transform: uppercase;\n}\n.ref {\n\tfont-family: ui-monospace, monospace;\n}\n`,
	});
	assert.deepEqual(checkCss(dir).hits, ["3 mono-uppercase"]);
});

test("INV-lint: wide letter tracking is reported in every form outside the section label; negative and normal tracking pass", () => {
	const path = "apps/web/src/features/x/Labels.tsx";
	const source = `export const A = () => <p className="tracking-wide">a</p>;
export const B = () => <p className="md:tracking-wider">b</p>;
export const C = () => <p className="tracking-widest">c</p>;
export const D = () => <p className="tracking-[0.08em]">d</p>;
export const E = () => <p style={{ letterSpacing: "0.1em" }}>e</p>;
export const F = () => <p className="tracking-[-0.02em] tracking-normal tracking-tight">f</p>;
export const G = () => <p className="section-label">g</p>;
export const H = () => <p style={{ letterSpacing: "-0.01em" }}>h</p>;
`;
	assert.deepEqual(at(path, lint({ [path]: source })), [
		"1 tracking",
		"2 tracking",
		"3 tracking",
		"4 tracking",
		"5 tracking",
	]);
	const css = "packages/ui/src/controls/labels.css";
	const dir = sandbox({
		[css]: `.a {\n\tletter-spacing: 0.1em;\n}\n.b {\n\tletter-spacing: -0.02em;\n}\n.c {\n\tletter-spacing: 0;\n}\n.d {\n\tletter-spacing: var(--ef-label-tracking);\n}\n.e {\n\tletter-spacing: 2px;\n}\n`,
	});
	assert.deepEqual(checkCss(dir).hits, ["2 tracking", "14 tracking"]);
});

test("INV-lint: a serif that does not come from the display or title font is reported; font-display, font-title and their tokens pass", () => {
	const path = "apps/web/src/features/x/Quote.tsx";
	const source = `export const A = () => <blockquote className="font-serif">a</blockquote>;
export const B = () => <p className="font-['Georgia',serif]">b</p>;
export const C = () => <p style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>c</p>;
export const D = () => <h2 className="font-display text-display-md">d</h2>;
export const E = () => <h3 className="font-title">e</h3>;
export const F = () => <p style={{ fontFamily: "var(--ef-font-display)" }}>f</p>;
export const G = () => <p style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>g</p>;
`;
	assert.deepEqual(at(path, lint({ [path]: source })), ["1 serif", "2 serif", "3 serif"]);
	const css = "apps/web/src/features/x/quote.css";
	const dir = sandbox({
		[css]: `.a {\n\tfont-family: "Playfair Display", serif;\n}\n.b {\n\tfont-family: var(--ef-font-title);\n}\n.c {\n\tfont-family: var(--ef-font-body), sans-serif;\n}\n`,
	});
	assert.deepEqual(checkCss(dir).hits, ["2 serif"]);
});

test("INV-lint: beige palettes are reported as utilities and literals; the cream token and the amber attention tokens pass", () => {
	const path = "packages/ui/src/display/Paper.tsx";
	const source = `export const A = () => <div className="bg-stone-100 text-stone-700">a</div>;
export const B = () => <div className="bg-[#F5F5DC]">b</div>;
export const C = () => <div style={{ background: "#F6F0E9" }}>c</div>;
export const D = () => <div className="bg-cream text-ink">d</div>;
export const E = () => <div className="bg-amber-100 text-amber-600">e</div>;
export const F = () => <div style={{ backgroundColor: "beige" }}>f</div>;
`;
	assert.deepEqual(at(path, lint({ [path]: source })), ["1 beige", "1 beige", "2 beige", "3 beige", "6 beige"]);
	const css = "apps/web/src/features/x/paper.css";
	const dir = sandbox({
		[css]: `.a {\n\tbackground: #faf0e6;\n}\n.b {\n\tbackground-color: beige;\n}\n.c {\n\tbackground: var(--ef-surface-2);\n}\n`,
	});
	assert.deepEqual(checkCss(dir).hits, ["2 beige", "5 beige"]);
});

test("INV-lint: zero-padded step counters are reported; padStart in date and time formatting passes", () => {
	const path = "apps/web/src/features/x/Steps.tsx";
	const source = `const STEPS = ["01", "02", "03"];
export const Steps = ({ items }) => (
	<ol>
		{items.map((item, index) => (
			<li key={item}>
				<span>{String(index + 1).padStart(2, "0")}</span>
				{item}
			</li>
		))}
		<li><span>01</span> Plan</li>
		<li>{STEPS[1]}</li>
	</ol>
);
export const step = { step: "04", label: "Launch" };
export const clock = (h, m) => \`\${h % 12 || 12}:\${String(m).padStart(2, "0")}\`;
const p = (n) => String(n).padStart(2, "0");
export const stamp = (d) => \`\${d.getFullYear()}-\${p(d.getMonth() + 1)}-\${p(d.getDate())}\`;
export function today(now, i) {
	const day = String(now.getDate() + i).padStart(2, "0");
	return \`2026-11-\${day}\`;
}
export const Time = ({ m }) => <span>{String(m).padStart(2, "0")}</span>;
export function headingNumbers(headings) {
	const numbers = new Map();
	let h2 = 0;
	for (const pos of headings) numbers.set(pos, String((h2 += 1)).padStart(2, "0"));
	return numbers;
}
`;
	assert.deepEqual(at(path, lint({ [path]: source })), ["1 counter", "6 counter", "10 counter", "14 counter", "26 counter"]);
});

test("INV-lint: glowing orbs and decorative gradients are reported; the named surfaces and rings pass", () => {
	const path = "apps/web/src/features/x/Glow.tsx";
	const source = `export const Orb = () => <div className="absolute size-96 rounded-full bg-green-500 blur-3xl" />;
export const Glow = () => <div className="shadow-[0_0_40px_var(--ef-green-500)]" />;
export const Fade = () => <div className="bg-linear-to-r from-green-500 to-blue-500" />;
export const Wash = () => <div className="bg-[radial-gradient(circle,var(--ef-green-300),transparent)]" />;
export const Ring = ({ pct }) => <div style={{ background: \`conic-gradient(var(--ef-blue-500) \${pct}%, transparent 0)\` }} />;
export const Blob = () => <div style={{ filter: "blur(48px)", borderRadius: "50%" }} />;
export const Edge = () => <div className="shadow-[0_0_0_1px_var(--ef-line)] shadow-[0_8px_24px_-12px_var(--ef-ink)] backdrop-blur-xl" />;
export const Named = () => <div className="ef-ring ef-top-fade ef-scroll-fade ef-skel hatch" />;
`;
	assert.deepEqual(at(path, lint({ [path]: source })), [
		"1 orb",
		"2 orb",
		"3 gradient",
		"4 gradient",
		"5 gradient",
		"6 orb",
	]);
	const css = "packages/ui/src/controls/glow.css";
	const dir = sandbox({
		[css]: `.orb {\n\tborder-radius: 50%;\n\tbackground: var(--ef-green-500);\n\tfilter: blur(60px);\n}\n.wash {\n\tbackground: linear-gradient(90deg, var(--ef-green-100), var(--ef-blue-100));\n}\n.halo {\n\tbox-shadow: 0 0 24px var(--ef-green-500);\n}\n.token {\n\t--wash: radial-gradient(var(--ef-green-100), transparent);\n}\n[data-product-root] .ef-insight::before {\n\tbackground: radial-gradient(in oklch circle at 82% 18%, var(--g5) 0%, transparent 22%);\n\tfilter: blur(52px);\n}\n.ef-skel {\n\tbackground: linear-gradient(90deg, var(--ef-surface-2), var(--ef-surface-3));\n}\n.ring {\n\tbox-shadow: 0 0 0 1px var(--ef-line), 0 8px 24px -12px var(--ef-ink);\n}\n`,
	});
	assert.deepEqual(checkCss(dir).hits, ["4 orb", "7 gradient", "10 orb", "13 gradient"]);
});

test("INV-lint: the approved foundations, the section label, the serif tokens and the named gradient surfaces pass, and paths outside features and packages/ui are not checked", () => {
	const dir = sandbox({});
	for (const path of ["packages/ui/src/foundations", "packages/ui/src/controls/controls.css"])
		cpSync(join(repo, path), join(dir, path), { recursive: true });
	const css = checkCss(dir);
	assert.equal(css.status, 0, css.stderr);
	const foundations = readdirSync(join(dir, "packages/ui/src/foundations"), { recursive: true })
		.filter((name) => /\.tsx?$/.test(name))
		.map((name) => `packages/ui/src/foundations/${name}`);
	assert.ok(foundations.length > 10);
	assert.deepEqual(lintCode(dir, foundations), []);
	const banned = `export const X = () => (
	<div>
		<p className="font-mono uppercase tracking-widest text-xs">01</p>
		<h1 className="font-serif bg-stone-100 blur-3xl bg-linear-to-r">Hello</h1>
	</div>
);
`;
	const hits = lint({
		"apps/web/src/marketing/home/Hero.tsx": banned,
		"apps/web/src/app/(product)/x/page.tsx": banned,
		"apps/web/src/features/x/Hero.tsx": banned,
	});
	assert.deepEqual(
		hits.filter((hit) => !hit.startsWith("apps/web/src/features/")),
		[],
	);
	assert.deepEqual(
		new Set(hits.map((hit) => hit.split(" ")[1])),
		new Set(["counter", "eyebrow", "mono-uppercase", "tracking", "serif", "beige", "orb", "gradient"]),
	);
	const outside = sandbox({
		"apps/web/src/marketing/mk.css": `.a {\n\tletter-spacing: 0.2em;\n\tfont-family: Georgia, serif;\n}\n`,
	});
	assert.equal(checkCss(outside).status, 0);
});

test("INV-lint: a CSS survivor entry keyed by its selector holds that many hits, and reports itself once the hits are gone", () => {
	const css = "apps/web/src/features/x/paper.css";
	const reason = "A document text style the church author picks; its printed look is the author's content.";
	const entry = { "no-slop-styling": { [css]: [{ function: ".kicker", count: 1, reason }] } };
	const held = sandbox(
		{ [css]: `.kicker {\n\tletter-spacing: 0.1em;\n}\n` },
		{ "survivors/apps-web-features-x.json": entry },
	);
	assert.equal(checkCss(held).status, 0);
	const gone = sandbox(
		{ [css]: `.kicker {\n\tletter-spacing: 0;\n}\n` },
		{ "survivors/apps-web-features-x.json": entry },
	);
	const ran = checkCss(gone);
	assert.equal(ran.status, 1);
	assert.match(ran.stderr, /\.kicker has 0 no-slop-styling hits, fewer than its survivor entry allows \(1\)/);
});
