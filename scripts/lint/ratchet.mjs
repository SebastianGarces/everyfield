import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, matchesGlob, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const root = process.env.EVERYFIELD_ROOT ?? fileURLToPath(new URL("../..", import.meta.url));
export const lintDir = process.env.EVERYFIELD_LINT_DIR ?? join(root, "scripts/lint");
export const baselineDir = join(lintDir, "baseline");
export const survivorsDir = join(lintDir, "survivors");
export const exemptionsFile = join(lintDir, "exemptions.json");
export const ignoreBaseline = process.env.EVERYFIELD_LINT_BASELINE === "off";

export const SCRIPT_RULES = ["lint-directives"];

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const jsonFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : []);

export function readBaseline(dir = baselineDir) {
	const byRule = {};
	if (!existsSync(dir)) return byRule;
	for (const rule of readdirSync(dir)) {
		byRule[rule] = {};
		for (const name of jsonFiles(join(dir, rule))) Object.assign(byRule[rule], readJson(join(dir, rule, name)));
	}
	return byRule;
}

export function readSurvivors(dir = survivorsDir) {
	const byRule = {};
	for (const name of jsonFiles(dir))
		for (const [rule, files] of Object.entries(readJson(join(dir, name))))
			for (const [path, entries] of Object.entries(files)) (byRule[rule] ??= {})[path] = entries;
	return byRule;
}

export const readExemptions = () => (existsSync(exemptionsFile) ? readJson(exemptionsFile) : {});

const exemptions = readExemptions();
const commentExemptions = Object.keys(exemptions.comments ?? {});
export const sqlMarkers = new Set(Object.keys(exemptions.sqlMarkers ?? {}));
export const commentsExempt = (path) => commentExemptions.some((glob) => matchesGlob(path, glob));

const baseline = ignoreBaseline ? {} : readBaseline();
const survivors = readSurvivors();

export const repoPath = (filename) => relative(root, filename).split(sep).join("/");

const slug = (...parts) =>
	parts
		.join("-")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

const TIPTAP = "apps/web/src/features/documents/church/editor/tiptap/";

export function area(path) {
	const p = path.split("/");
	const directory = (at) => (p.length > at + 1 ? p[at] : null);
	if (path.startsWith(TIPTAP)) return "apps-web-tiptap";
	if (p.length === 1) return "root";
	if (p[0] === "apps") {
		if (p[2] !== "src") return slug("apps", p[1]);
		if (!directory(3)) return slug("apps", p[1], "src");
		if (p[3] === "features") return slug("apps", p[1], "features", directory(4) ?? "", directory(5) ?? "");
		return slug("apps", p[1], p[3], directory(4) ?? "");
	}
	if (p[0] === "packages")
		return p[2] === "src" && directory(3) ? slug("packages", p[1], p[3]) : slug("packages", p[1] ?? "");
	if (p[0] === "tests") return slug("tests", directory(1) ?? "", directory(2) ?? "");
	if (p[0] === "tools") return slug("tools", directory(1) ?? "");
	return slug(p[0]);
}

const loc = { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } };
export function ratchet(context, rule, violations) {
	const path = repoPath(context.filename);
	let rest = violations;
	for (const survivor of survivors[rule]?.[path] ?? []) {
		const inside = rest.filter((v) => v.fn === survivor.function);
		const kept = inside.slice(0, survivor.count);
		rest = rest.filter((v) => !kept.includes(v));
		if (!ignoreBaseline && kept.length < survivor.count)
			context.report({
				loc,
				message: `${path} has ${kept.length} ${rule} hits in ${survivor.function}, fewer than its survivor entry allows (${survivor.count}): lower or delete the entry in scripts/lint/survivors/${area(path)}.json.`,
			});
	}
	const allowed = baseline[rule]?.[path] ?? 0;
	if (rest.length > allowed)
		for (const { fn: _fn, message, ...where } of rest)
			context.report({
				...where,
				message:
					allowed === 0
						? message
						: `${message} (${path} has ${rest.length}; its baseline allows ${allowed}, and a baseline only shrinks.)`,
			});
	else if (allowed > 0 && rest.length === 0)
		context.report({
			loc,
			message: `${path} no longer breaks ${rule}: run node scripts/lint/baseline.mjs --shrink to delete its baseline entry.`,
		});
}
