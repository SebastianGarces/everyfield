import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { boundariesDir, FEATURES, LAYOUT_FILE } from "./boundaries.mjs";
import { root } from "./ratchet.mjs";

const DATA = "scripts/lint/boundaries";
const failures = [];
const fail = (message) => failures.push(message);
const exists = (path) => existsSync(join(root, path));
const isDirectory = (path) => exists(path) && statSync(join(root, path)).isDirectory();
const readJson = (name) => JSON.parse(readFileSync(join(boundariesDir, name), "utf8"));

function reasons(where, entries, existing = () => true) {
	for (const [key, reason] of Object.entries(entries ?? {})) {
		if (typeof reason !== "string" || reason.trim().length < 20)
			fail(`${where} ${key}: needs a reason of 20 characters or more`);
		if (!existing(key)) fail(`${where} ${key}: names nothing in the repository; delete the entry`);
	}
}

function keys(where, json, allowed) {
	for (const key of Object.keys(json))
		if (!allowed.includes(key)) fail(`${where}: unknown key ${key}; allowed: ${allowed.join(", ")}`);
}

function sorted(where, list) {
	if (list.join("\n") !== [...list].sort().join("\n")) fail(`${where}: entries are not sorted`);
}

function checkLayout() {
	const where = `${DATA}/${LAYOUT_FILE}`;
	if (!existsSync(join(boundariesDir, LAYOUT_FILE))) return fail(`${where}: missing`);
	const layout = readJson(LAYOUT_FILE);
	keys(where, layout, [
		"layers",
		"compositionFeatures",
		"compositionRoots",
		"exceptions",
		"platformFolders",
		"thickRoutes",
	]);
	reasons(`${where} compositionFeatures`, layout.compositionFeatures, (name) => isDirectory(FEATURES + name));
	reasons(`${where} compositionRoots`, layout.compositionRoots, exists);
	reasons(`${where} platformFolders`, layout.platformFolders, () => true);
	reasons(`${where} thickRoutes`, layout.thickRoutes, exists);
	for (const { from, to, reason } of layout.exceptions ?? [])
		reasons(`${where} exceptions`, { [`${from} -> ${to}`]: reason }, () => exists(from) && exists(to));
	const packages = readdirSync(join(root, "packages")).filter((name) => exists(`packages/${name}/package.json`));
	for (const name of packages) {
		const allowed = layout.layers?.[name];
		if (!allowed) {
			fail(`${where} layers: packages/${name} has no entry; list the workspace packages it may depend on`);
			continue;
		}
		const json = JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8"));
		const declared = Object.keys({ ...json.dependencies, ...json.peerDependencies })
			.filter((dep) => dep.startsWith("@everyfield/"))
			.map((dep) => dep.slice("@everyfield/".length));
		for (const dep of declared)
			if (!allowed.includes(dep))
				fail(
					`packages/${name}/package.json depends on @everyfield/${dep}, which ${where} layers does not allow for ${name}`,
				);
	}
	for (const name of Object.keys(layout.layers ?? {}))
		if (!packages.includes(name)) fail(`${where} layers: packages/${name} does not exist; delete the entry`);
}

function checkFeature(name) {
	const feature = /^apps-web-features-(.+)\.json$/.exec(name)[1];
	const where = `${DATA}/${name}`;
	if (!isDirectory(FEATURES + feature)) return fail(`${where}: ${FEATURES}${feature} does not exist; delete the file`);
	const json = readJson(name);
	keys(where, json, ["public"]);
	sorted(where, Object.keys(json.public ?? {}));
	if (!Object.keys(json.public ?? {}).length) fail(`${where}: lists no public file; delete the file`);
	reasons(`${where} public`, json.public, (file) => exists(`${FEATURES}${feature}/${file}`));
}

function checkPackage(name) {
	const pkg = /^packages-(.+)\.json$/.exec(name)[1];
	const where = `${DATA}/${name}`;
	if (!isDirectory(`packages/${pkg}/src`)) return fail(`${where}: packages/${pkg}/src does not exist; delete the file`);
	const json = readJson(name);
	keys(where, json, ["kernel", "entries", "public"]);
	const src = `packages/${pkg}/src/`;
	const moduleExists = (module) => [module, `${module}.ts`, `${module}.tsx`].some((path) => exists(src + path));
	reasons(`${where} kernel`, json.kernel, moduleExists);
	sorted(`${where} public`, json.public ?? []);
	for (const file of json.public ?? [])
		if (!exists(src + file)) fail(`${where} public ${file}: names nothing in ${src}; delete the entry`);
}

if (import.meta.main) {
	checkLayout();
	for (const name of existsSync(boundariesDir) ? readdirSync(boundariesDir) : []) {
		if (name === LAYOUT_FILE) continue;
		if (/^apps-web-features-.+\.json$/.test(name)) checkFeature(name);
		else if (/^packages-.+\.json$/.test(name)) checkPackage(name);
		else
			fail(`${DATA}/${name}: not a boundary file; name it apps-web-features-<feature>.json or packages-<package>.json`);
	}
	if (failures.length) {
		console.error(`Feature boundary data checks failed (scripts/lint/check-boundaries.mjs):\n${failures.join("\n")}`);
		process.exit(1);
	}
	console.log("check-boundaries: passed");
}
