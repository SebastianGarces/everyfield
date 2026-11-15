import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { lintDir, root } from "./ratchet.mjs";

export const boundariesDir = join(lintDir, "boundaries");
export const LAYOUT_FILE = "_layout.json";
export const FEATURES = "apps/web/src/features/";
export const SERVER = "apps/web/src/server/";
const SRC = "apps/web/src/";
const APP = "apps/web/src/app/";

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

export function readBoundaries(dir = boundariesDir) {
	const layout = existsSync(join(dir, LAYOUT_FILE)) ? readJson(join(dir, LAYOUT_FILE)) : {};
	const features = {};
	const modules = {};
	for (const name of existsSync(dir) ? readdirSync(dir) : []) {
		const feature = /^apps-web-features-(.+)\.json$/.exec(name)?.[1];
		const pkg = /^packages-(.+)\.json$/.exec(name)?.[1];
		if (feature) features[feature] = readJson(join(dir, name));
		else if (pkg) modules[pkg] = { public: readJson(join(dir, name)).public ?? [] };
	}
	for (const [pkg, rules] of Object.entries(layout.packages ?? {})) modules[pkg] = { ...modules[pkg], ...rules };
	return {
		layers: layout.layers ?? {},
		compositionFeatures: Object.keys(layout.compositionFeatures ?? {}),
		compositionRoots: Object.keys(layout.compositionRoots ?? {}),
		exceptions: (layout.exceptions ?? []).map(({ from, to }) => `${from} ${to}`),
		platformFolders: Object.keys(layout.platformFolders ?? {}),
		thickRoutes: Object.keys(layout.thickRoutes ?? {}),
		features,
		modules,
	};
}

const data = readBoundaries();

const packages = new Map();
export function packageOf(name) {
	if (packages.has(name)) return packages.get(name);
	const dir = name === "@everyfield/web" ? "apps/web" : `packages/${name.slice("@everyfield/".length)}`;
	const file = join(root, dir, "package.json");
	const found = existsSync(file) ? { dir, exports: readJson(file).exports ?? {} } : null;
	packages.set(name, found);
	return found;
}

const CANDIDATES = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", "/index.ts", "/index.tsx", "/index.mts"];
const isFile = (path) => existsSync(join(root, path)) && statSync(join(root, path)).isFile();
function existing(path) {
	const bare = path.replace(/\.[cm]?js$/, "");
	for (const candidate of [path, ...CANDIDATES.map((ending) => bare + ending)])
		if (isFile(candidate)) return posix.normalize(candidate);
	return posix.normalize(path);
}

const exportTarget = (value) =>
	typeof value === "string" ? value : value && (value.import ?? value.default ?? value.types);

export function resolveImport(from, spec) {
	if (spec.startsWith("@/"))
		return from.startsWith("apps/web/") ? { to: existing(SRC + spec.slice(2)) } : { app: true };
	if (spec.startsWith(".")) return { to: existing(posix.join(posix.dirname(from), spec)), relative: true };
	const named = /^(@everyfield\/[^/]+)(\/.*)?$/.exec(spec);
	if (!named) return {};
	const pkg = packageOf(named[1]);
	if (!pkg) return {};
	if (named[1] === "@everyfield/web") return { to: `${pkg.dir}/package.json`, name: named[1] };
	const target = exportTarget(pkg.exports[`.${named[2] ?? ""}`]);
	if (!target) return { to: existing(pkg.dir + (named[2] ?? "")), deep: true, name: named[1] };
	return { to: existing(posix.join(pkg.dir, target)), name: named[1] };
}

export function zone(path) {
	let m;
	if ((m = /^apps\/web\/src\/features\/([^/]+)\/(.+)$/.exec(path))) return { kind: "feature", name: m[1], rest: m[2] };
	if (path.startsWith(APP)) return { kind: "app" };
	if ((m = /^apps\/web\/src\/(server|components|marketing|access)\//.exec(path)))
		return { kind: "platform", name: m[1] };
	if (path.startsWith("apps/")) return { kind: "platform", name: "apps/web/src" };
	if ((m = /^packages\/evry\/src\/(adapters\/[^/.]+)(?:\.[cm]?[jt]sx?)?(?:\/(.*))?$/.exec(path)))
		return { kind: "package", pkg: "evry", module: m[1], rest: m[2] ?? "" };
	if ((m = /^packages\/([^/]+)\/src\/([^/]+?)(?:\.[cm]?[jt]sx?)?(?:\/(.*))?$/.exec(path)))
		return { kind: "package", pkg: m[1], module: m[2], rest: m[3] ?? "" };
	if ((m = /^packages\/([^/]+)\//.exec(path))) return { kind: "package", pkg: m[1], module: null, rest: "" };
	return { kind: "other" };
}

const ROUTE_FILE = /\/(?:page|layout|route|loading|error|not-found|global-error|template|default)\.[cm]?[jt]sx?$/;
export const isRouteFile = (path) => path.startsWith(APP) && ROUTE_FILE.test(path);
const METADATA_FILE = /\/(?:opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\.[cm]?[jt]sx?$/;

const plain = (e) =>
	!e ||
	e.type === "Identifier" ||
	e.type === "Literal" ||
	e.type === "MemberExpression" ||
	(e.type === "TemplateLiteral" && e.expressions.length === 0) ||
	((e.type === "TSAsExpression" || e.type === "TSSatisfiesExpression") && plain(e.expression)) ||
	(e.type === "ArrayExpression" && e.elements.every(plain)) ||
	(e.type === "ObjectExpression" && e.properties.every((p) => p.type === "Property" && !p.computed && plain(p.value)));
const plainDeclaration = (d) => d?.type === "VariableDeclaration" && d.declarations.every((v) => plain(v.init));

const delegates = (s) =>
	s.type === "ImportDeclaration" ||
	s.type === "ExportAllDeclaration" ||
	s.type === "TSTypeAliasDeclaration" ||
	(s.type === "ExpressionStatement" && typeof s.directive === "string") ||
	(s.type === "ExportDefaultDeclaration" && s.declaration.type === "Identifier") ||
	(s.type === "ExportNamedDeclaration" && (!s.declaration || plainDeclaration(s.declaration))) ||
	plainDeclaration(s);

const publicFiles = (feature) => Object.keys(data.features[feature]?.public ?? {});

function modulePublic(pkg, module, rest) {
	const config = data.modules[pkg];
	if (!config) return true;
	if (rest === "" || Object.hasOwn(config.kernel ?? {}, module)) return true;
	return (config.entries ?? []).includes(rest) || (config.public ?? []).includes(`${module}/${rest}`);
}

export function importProblem(from, spec, here = zone(from)) {
	const t = resolveImport(from, spec);
	if (here.kind === "package" && (t.app || t.name === "@everyfield/web" || t.to?.startsWith("apps/")))
		return [
			"package-to-app",
			`Packages never import the app (${spec}). Move the code the package needs into a package.`,
		];
	if (!t.to) return null;
	const there = zone(t.to);
	if (t.deep)
		return [
			"package-deep",
			`${spec} is not in the exports map of ${t.name}. Import a subpath that packages/${t.name.slice(12)}/package.json exports, or export the module there first.`,
		];
	if (there.kind === "package" && here.kind !== "package" && t.relative)
		return [
			"package-deep",
			`${spec} reaches into packages/${there.pkg} by path. Import @everyfield/${there.pkg} by name.`,
		];
	if (here.kind === "package" && there.kind === "package") {
		if (here.pkg !== there.pkg) {
			if (t.relative)
				return [
					"package-deep",
					`${spec} climbs out of packages/${here.pkg} by path. Import @everyfield/${there.pkg} by name.`,
				];
			const allowed = data.layers[here.pkg];
			if (allowed && !allowed.includes(there.pkg))
				return [
					"layer",
					`packages/${here.pkg} sits below packages/${there.pkg} and may depend only on ${allowed.join(", ") || "no workspace package"}. Move the shared code down into a package both may use.`,
				];
			return null;
		}
		if (here.module === there.module || !there.module || modulePublic(there.pkg, there.module, there.rest)) return null;
		return [
			`${here.pkg}-module`,
			`${here.module} reaches into ${there.module}/${there.rest}, a file private to ${there.module}. Import ${there.module}'s index.ts or a file listed in scripts/lint/boundaries/packages-${there.pkg}.json, or add it to that list.`,
		];
	}
	if (there.kind === "app" && here.kind !== "app")
		return [
			"into-app",
			`Only app/ imports app/ (${spec}). Move the code you need out of the route into the feature it serves.`,
		];
	if (there.kind !== "feature" || here.kind === "app") return null;
	const roots = data.compositionRoots.includes(from);
	if (here.kind === "platform") {
		if (roots) return publicFiles(there.name).includes(there.rest) ? null : deep(there);
		return [
			"platform-to-feature",
			`${here.name}/ sits below the features and may not import features/${there.name} (${spec}). Move this code into features/${there.name}, or move what both need down into ${here.name}/ or a package.`,
		];
	}
	if (there.name === here.name || there.name === "shared") return null;
	if (here.name === "shared")
		return [
			"shared-leaf",
			`features/shared imports no feature (${spec}). Move what it needs into features/shared too.`,
		];
	if (data.compositionFeatures.includes(there.name)) {
		if (data.exceptions.includes(`${from} ${t.to}`)) return null;
		return [
			"into-composition",
			`features/${there.name} composes the features; no feature imports it (${spec}). Move what you need out of features/${there.name} into the feature that owns it, and let features/${there.name} provide it.`,
		];
	}
	return publicFiles(there.name).includes(there.rest) ? null : deep(there);
}

const deep = ({ name, rest }) => [
	"feature-deep",
	`features/${name}/${rest} is private to features/${name}. Import a file features/${name} lists as public in scripts/lint/boundaries/apps-web-features-${name}.json, add this file to that list with its reason if other features are meant to use it, or move code several features share down into features/shared, apps/web/src/components or a package.`,
];

export function fileProblems(from, program) {
	const problems = [];
	const folder = from.startsWith(SERVER) ? from.slice(SERVER.length).split("/") : null;
	if (folder && folder.length > 1 && !data.platformFolders.includes(folder[0]))
		problems.push([
			program,
			"platform-folder",
			`server/${folder[0]}/ is not a platform folder. Code one feature owns lives in features/<feature>/; apps/web/src/server holds only ${data.platformFolders.join(", ")}.`,
		]);
	if (from.startsWith(APP) && !isRouteFile(from) && !METADATA_FILE.test(from))
		problems.push([
			program,
			"app-file",
			"app/ holds route files and Next metadata files only. Move this module into the feature it serves (or features/shared) and import it from there.",
		]);
	if (
		isRouteFile(from) &&
		!data.thickRoutes.some((path) => from === path || (path.endsWith("/") && from.startsWith(path)))
	)
		for (const statement of program.body)
			if (!delegates(statement))
				problems.push([
					statement,
					"route-thin",
					"A route file only imports, re-exports and sets route config. Move this code into the feature it serves and re-export it here.",
				]);
	return problems;
}

export function routeFeatures(from, imports) {
	if (!from.startsWith(APP) || data.compositionRoots.includes(from)) return null;
	const features = new Map();
	for (const [node, spec] of imports) {
		const there = zone(resolveImport(from, spec).to ?? "");
		if (there.kind === "feature" && there.name !== "shared" && !features.has(there.name))
			features.set(there.name, node);
	}
	if (features.size < 2) return null;
	const [, [, node]] = [...features];
	return [
		node,
		"route-features",
		`A file under app/ delegates to one feature; this one imports ${[...features.keys()].join(", ")}. Compose them inside one feature (or features/shell) and import that.`,
	];
}
