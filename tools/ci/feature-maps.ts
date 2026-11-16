import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { testNames } from "./test-names.ts";

export const SCHEMA_FILE = "apps/web/feature-map.schema.json";
export const PENDING_FILE = "apps/web/feature-maps.pending.json";
export const PERSONAS_FILE = "tools/qa/personas.json";
export const NAV_MODULE = "apps/web/src/features/shell/nav.ts";
export const SEED_FILE = "tools/qa/qa-seed.ts";
export const LOGINS_FILE = "tools/qa/qa-guard.ts";
export const DOCS_DIR = "docs/feature-maps";
const APP_DIR = "apps/web/src/app";
const FEATURES_DIR = "apps/web/src/features";
const SHELL_DIR = `${FEATURES_DIR}/shell`;
const UI_DIR = "packages/ui/src";
const APP_MAP = `${APP_DIR}/feature-map.json`;
const SHOW_BUDGET = 6144;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = { [key: string]: Json };

type Match = "exact" | "contains";
type Target = { role: string; name: string; match?: Match } | { text: string; match?: Match };
type RoleTarget = { role: string; name: string; match?: Match };
type Observable = Target | { noText: string } | { url: string } | { absent: RoleTarget };
type Step =
	{ open: string } | { click: Target } | { type: string; into: string } | { press: string } | { upload: string };
type Reach =
	| { rail: string; personas: string[] }
	| { from: string; persona: string; path: Step[] }
	| { link: string; fill?: Record<string, string>; email?: string };
type StateReach =
	| { persona: string; open: string; path?: Step[]; seed: "qa" }
	| { persona: string; setup: Step[]; open?: string; path?: Step[] }
	| { manual: string };
type State = { id: string; file?: string; reach: StateReach; expect: Observable[] };
type TestRef = { file: string; name: string };
type Browser = { kind: "behavior" | "presence"; state: string; steps: Step[]; expect: Observable[] };
type Behavior = {
	id: string;
	says: string;
	catalog: string[];
	operations: string[];
	noOperation?: string;
	proof: { tests: TestRef[]; cases?: string[]; browser?: Browser };
};
type Access = "write" | "read" | "none";
type Surface = {
	id: string;
	says: string;
	routes: string[];
	endpoints?: string[];
	catalog?: string[];
	reach: Reach[];
	personas: Record<string, Access>;
	states: State[];
	behaviors: Behavior[];
};
export type FeatureMap = { feature: string; catalog: string[]; surfaces: Surface[] };
type Persona = {
	says: string;
	context: "plant" | "organization" | "account" | "signed-out";
	role?: "owner" | "admin" | "member";
	residencyLinked?: boolean;
	seed?: "qa";
};
type LoadedMap = { file: string; map: FeatureMap };
type Route = { url: string; kind: "page" | "handler"; file: string };
type NavItem = { label: string; href: string };
type ShellNav = (viewer: unknown) => { main: readonly NavItem[]; pages: readonly NavItem[] };

export type BasePending = { routes: string[] } | { skip: string } | { error: string };
export type CheckOptions = { base: BasePending; ci: boolean; changed?: string[] };
export type CheckResult = { problems: string[]; summary: string };

export function validate(schema: Schema, value: Json, root: Schema, at = ""): string[] {
	const here = at || "/";
	if (typeof schema.$ref === "string") {
		const target = schema.$ref
			.replace(/^#\//, "")
			.split("/")
			.reduce<Json>(
				(node, key) => (node && typeof node === "object" && !Array.isArray(node) ? node[key]! : null),
				root,
			);
		return validate(target as Schema, value, root, at);
	}
	if (Array.isArray(schema.oneOf)) {
		const results = schema.oneOf.map((option) => validate(option as Schema, value, root, at));
		const passing = results.filter((r) => r.length === 0).length;
		if (passing === 1) return [];
		if (passing > 1) return [`${here}: matches more than one allowed shape`];
		const closest = results.reduce((best, r) => (r.length < best.length ? r : best));
		return closest.length === 1 ? closest : [`${here}: matches no allowed shape (${closest.join("; ")})`];
	}
	if (Array.isArray(schema.enum))
		return schema.enum.includes(value as never)
			? []
			: [`${here}: ${JSON.stringify(value)} is not one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`];
	const type = schema.type;
	if (type === "string") {
		if (typeof value !== "string") return [`${here}: must be a string`];
		if (typeof schema.minLength === "number" && value.length < schema.minLength) return [`${here}: must not be empty`];
		if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value))
			return [`${here}: ${JSON.stringify(value)} does not match ${schema.pattern}`];
		return [];
	}
	if (type === "boolean") return typeof value === "boolean" ? [] : [`${here}: must be true or false`];
	if (type === "array") {
		if (!Array.isArray(value)) return [`${here}: must be an array`];
		if (typeof schema.minItems === "number" && value.length < schema.minItems)
			return [`${here}: needs at least ${schema.minItems} item(s)`];
		return value.flatMap((item, i) => validate(schema.items as Schema, item, root, `${at}/${i}`));
	}
	if (type === "object") {
		if (!value || typeof value !== "object" || Array.isArray(value)) return [`${here}: must be an object`];
		const properties = (schema.properties ?? {}) as Record<string, Schema>;
		const problems: string[] = [];
		for (const key of (schema.required ?? []) as string[])
			if (!(key in value)) problems.push(`${here}: is missing "${key}"`);
		if (typeof schema.minProperties === "number" && Object.keys(value).length < schema.minProperties)
			problems.push(`${here}: needs at least ${schema.minProperties} entry`);
		for (const [key, item] of Object.entries(value)) {
			const path = `${at}/${key}`;
			const names = schema.propertyNames as Schema | undefined;
			if (names) problems.push(...validate({ type: "string", ...names }, key, root, path));
			if (key in properties) problems.push(...validate(properties[key]!, item, root, path));
			else if (schema.additionalProperties === false) problems.push(`${path}: is not an allowed field`);
			else if (schema.additionalProperties && typeof schema.additionalProperties === "object")
				problems.push(...validate(schema.additionalProperties as Schema, item, root, path));
		}
		return problems;
	}
	return [];
}

function walk(root: string, dir: string, keep: (file: string) => boolean): string[] {
	const abs = join(root, dir);
	if (!existsSync(abs)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(abs, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
		const rel = `${dir}/${entry.name}`;
		if (entry.isDirectory()) out.push(...walk(root, rel, keep));
		else if (keep(rel)) out.push(rel);
	}
	return out.sort();
}

const SPECIAL_ROUTES: Record<string, string> = {
	robots: "robots.txt",
	sitemap: "sitemap.xml",
	manifest: "manifest.webmanifest",
};
const ROUTE_FILE = /^(page|route|robots|sitemap|manifest|icon|apple-icon|opengraph-image|twitter-image)\.(tsx?|jsx?)$/;
const isGroup = (segment: string) => /^\(.+\)$/.test(segment);

export function appRoutes(root: string): Route[] {
	return walk(root, APP_DIR, (file) => ROUTE_FILE.test(file.slice(file.lastIndexOf("/") + 1))).map((file) => {
		const parts = file.slice(APP_DIR.length + 1).split("/");
		const base = parts.pop()!.replace(/\.[^.]+$/, "");
		const segments = parts.filter((s) => !isGroup(s));
		if (base !== "page" && base !== "route") segments.push(SPECIAL_ROUTES[base] ?? base);
		return { url: "/" + segments.join("/"), kind: base === "page" ? "page" : "handler", file };
	});
}

const STATE_FILE = /^(loading|error|not-found)\.tsx$/;

export function stateFilesFor(root: string, routeFile: string): string[] {
	const files: string[] = [];
	let dir = dirname(routeFile);
	while (dir.startsWith(APP_DIR + "/")) {
		const segments = dir.slice(APP_DIR.length + 1).split("/");
		if (segments.every(isGroup)) break;
		const abs = join(root, dir);
		for (const name of readdirSync(abs)) if (STATE_FILE.test(name)) files.push(`${dir}/${name}`);
		dir = dirname(dir);
	}
	return files.sort();
}

export function sourceStrings(source: string, jsx: boolean): string[] {
	const out: string[] = [];
	const n = source.length;
	const push = (text: string) => {
		const t = text.replace(/\s+/g, " ").trim();
		if (t) out.push(t);
	};
	const skipNested = (from: number): number => {
		let j = from;
		let depth = 1;
		while (j < n && depth > 0) {
			const c = source[j];
			if (c === "'" || c === '"' || c === "`") {
				j++;
				while (j < n && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
			} else if (c === "{") depth++;
			else if (c === "}") depth--;
			j++;
		}
		return j;
	};
	let i = 0;
	while (i < n) {
		const c = source[i];
		if (c === "/" && source[i + 1] === "/") {
			const end = source.indexOf("\n", i);
			i = end < 0 ? n : end;
		} else if (c === "/" && source[i + 1] === "*") {
			const end = source.indexOf("*/", i + 2);
			i = end < 0 ? n : end + 2;
		} else if (c === "'" || c === '"') {
			let j = i + 1;
			let text = "";
			while (j < n && source[j] !== c && source[j] !== "\n") {
				if (source[j] === "\\") {
					text += source[j + 1] ?? "";
					j += 2;
				} else text += source[j++];
			}
			push(text);
			i = j + 1;
		} else if (c === "`") {
			let j = i + 1;
			let text = "";
			while (j < n && source[j] !== "`") {
				if (source[j] === "\\") {
					text += source[j + 1] ?? "";
					j += 2;
				} else if (source[j] === "$" && source[j + 1] === "{") {
					push(text);
					text = "";
					j = skipNested(j + 2);
				} else text += source[j++];
			}
			push(text);
			i = j + 1;
		} else if (c === ">" && jsx) {
			let j = i + 1;
			while (j < n && !'<{}`";='.includes(source[j] ?? "")) j++;
			if (/[A-Za-z]/.test(source.slice(i + 1, j))) push(source.slice(i + 1, j));
			i = j;
		} else i++;
	}
	return out;
}

const SOURCE_FILE = /\.(tsx?|mts)$/;
export const isTest = (f: string) => /\.test\.|\.d\.ts$/.test(f);
export const featureOf = (file: string) =>
	file.startsWith(`${FEATURES_DIR}/`) ? (/^([^/]+)\//.exec(file.slice(FEATURES_DIR.length + 1))?.[1] ?? null) : null;
export const featureMapFile = (feature: string) => `${FEATURES_DIR}/${feature}/feature-map.json`;

function stringsOf(root: string, files: string[]): Set<string> {
	return new Set(files.flatMap((f) => sourceStrings(readFileSync(join(root, f), "utf8"), f.endsWith(".tsx"))));
}

function withImports(root: string, dir: string): string[] {
	const files = walk(root, dir, (f) => SOURCE_FILE.test(f) && !isTest(f));
	const imported = files.flatMap((file) =>
		[...readFileSync(join(root, file), "utf8").matchAll(/from\s+"(\.\.?\/[^"]+)"/g)].flatMap((m) => {
			const target = posix.normalize(posix.join(posix.dirname(file), m[1]!));
			return [target, `${target}.ts`, `${target}.tsx`].filter((f) => SOURCE_FILE.test(f) && existsSync(join(root, f)));
		}),
	);
	return [...new Set([...files, ...imported])];
}

type SeedPersona = Omit<Persona, "says" | "seed"> & { name: string };
const describePersona = (p: Omit<Persona, "says" | "seed">) =>
	`${p.context}${p.role ? ` ${p.role}` : ""}${p.residencyLinked ? " with a residency link" : ""}`;

export function personasFromSeed(source: string): Map<string, SeedPersona> {
	const names = new Map<string, string>();
	for (const m of source.matchAll(/account\("([^"]+)",\s*QA_LOGINS\.(\w+)/g)) names.set(m[2]!, m[1]!);
	for (const m of source.matchAll(/name:\s*"([^"]+)",\s*login:\s*QA_LOGINS\.(\w+)/g)) names.set(m[2]!, m[1]!);
	for (const m of source.matchAll(/login:\s*QA_LOGINS\.(\w+),\s*person:\s*"([^"]+)"/g)) names.set(m[1]!, m[2]!);
	const byName = new Map([...names].map(([login, name]) => [name, login] as const));
	const out = new Map<string, SeedPersona>();
	for (const [login, name] of names) out.set(login, { name, context: "account" });
	const organization = /login:\s*QA_LOGINS\.(\w+),(?:\s*person:\s*"[^"]+",)?\s*role:\s*"(?:owner|admin|member)"/g;
	for (const m of source.matchAll(organization))
		out.set(m[1]!, { name: names.get(m[1]!) ?? m[1]!, context: "organization" });
	for (const m of source.matchAll(/QA_LOGINS\.(\w+)\s*\}\s*as const/g))
		if (/RESIDENT\s*=\s*\{[^}]*$/.test(source.slice(0, m.index! + m[0].indexOf("}"))))
			out.set(m[1]!, { name: names.get(m[1]!) ?? m[1]!, context: "account", residencyLinked: true });
	for (const m of source.matchAll(/account\((\w+)\.name,\s*\1\.login,\s*\{\s*kind:\s*"sending_/g)) {
		const login = new RegExp(`const ${m[1]} = \\{[^}]*login: QA_LOGINS\\.(\\w+)`).exec(source)?.[1];
		if (login) out.set(login, { name: names.get(login) ?? login, context: "organization" });
	}
	for (const m of source.matchAll(/church\([^)]*QA_LOGINS\.(\w+)/g))
		out.set(m[1]!, { name: names.get(m[1]!) ?? m[1]!, context: "plant", role: "owner" });
	for (const m of source.matchAll(/\[\w+,\s*"(owner|admin|member)",\s*"([^"]+)"/g)) {
		const login = byName.get(m[2]!);
		if (login) out.set(login, { name: m[2]!, context: "plant", role: m[1] as "owner" | "admin" | "member" });
	}
	return out;
}

export function qaLogins(root: string): Set<string> {
	const block = /export const QA_LOGINS = \{([^}]*)\}/.exec(readFileSync(join(root, LOGINS_FILE), "utf8"))?.[1] ?? "";
	return new Set([...block.matchAll(/^\s*([A-Za-z0-9]+):/gm)].map((m) => m[1]!));
}

function codeCorpus(root: string): Array<{ file: string; text: string }> {
	const dirs = readdirSync(join(root, "packages"), { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => `packages/${d.name}/src`);
	return [...dirs, "apps/web/src/server"]
		.flatMap((dir) => walk(root, dir, (f) => /\.(tsx?|mts|mjs|js)$/.test(f) && !isTest(f)))
		.map((file) => ({ file, text: readFileSync(join(root, file), "utf8") }));
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function implemented(code: Array<{ text: string }>, op: string): boolean {
	const name = op.slice(op.indexOf(".") + 1);
	const quoted = [`"${op}"`, `'${op}'`, `\`${op}\``];
	const declared = new RegExp(`(?:function\\s+|(?:const|let)\\s+|async\\s+)${escape(name)}\\s*[=(<]`);
	return code.some(({ text }) => quoted.some((q) => text.includes(q)) || declared.test(text));
}

const readJson = (root: string, file: string): Json => JSON.parse(readFileSync(join(root, file), "utf8")) as Json;

export function mapFiles(root: string): string[] {
	const features = existsSync(join(root, FEATURES_DIR))
		? readdirSync(join(root, FEATURES_DIR), { withFileTypes: true })
				.filter((d) => d.isDirectory() && existsSync(join(root, FEATURES_DIR, d.name, "feature-map.json")))
				.map((d) => `${FEATURES_DIR}/${d.name}/feature-map.json`)
		: [];
	return [...features.sort(), ...(existsSync(join(root, APP_MAP)) ? [APP_MAP] : [])];
}

export function loadMaps(root: string): { maps: LoadedMap[]; problems: string[] } {
	const schema = readJson(root, SCHEMA_FILE) as Schema;
	const maps: LoadedMap[] = [];
	const problems: string[] = [];
	for (const file of mapFiles(root)) {
		let value: Json;
		try {
			value = readJson(root, file);
		} catch (error) {
			problems.push(`${file}: is not JSON (${(error as Error).message})`);
			continue;
		}
		const found = validate(schema, value, schema);
		if (found.length) problems.push(...found.map((p) => `${file}: ${p}`));
		else maps.push({ file, map: value as unknown as FeatureMap });
	}
	return { maps, problems };
}

type Named = { value: string; match: Match; role?: string };
function named(observables: Observable[], steps: Step[]): Named[] {
	const fromTarget = (t: Target): Named =>
		"role" in t
			? { value: t.name, match: t.match ?? "exact", role: t.role }
			: { value: t.text, match: t.match ?? "exact" };
	return [
		...observables.flatMap((o) =>
			"noText" in o
				? [{ value: o.noText, match: "exact" as const }]
				: "url" in o
					? []
					: "absent" in o
						? [fromTarget(o.absent)]
						: [fromTarget(o)],
		),
		...steps.flatMap((s): Named[] =>
			"click" in s
				? [fromTarget(s.click)]
				: "into" in s
					? [{ value: s.into, match: "exact" }]
					: "expect" in s
						? named([(s as { expect: Observable }).expect], [])
						: [],
		),
	];
}
const typedIn = (steps: Step[]) => new Set(steps.flatMap((s) => ("type" in s ? [s.type] : [])));

export function viewerOf(persona: Persona): unknown {
	if (persona.context === "plant") return { context: "plant", role: persona.role };
	if (persona.context === "organization") return { context: "organization" };
	return { context: "account", residencyLinked: persona.residencyLinked === true };
}

export const SPECIAL_VALUE = /^\$(?:login:([A-Za-z0-9]+)|password)$/;

const routePattern = (route: string) =>
	new RegExp(
		"^" +
			(route
				.split("/")
				.filter(Boolean)
				.map((s) =>
					/^\[\[\.\.\..+\]\]$/.test(s)
						? "(?:/.*)?"
						: /^\[\.\.\..+\]$/.test(s)
							? "/.+"
							: /^\[.+\]$/.test(s)
								? "/[^/]+"
								: "/" + escape(s),
				)
				.join("") || "/") +
			"$",
	);
const opens = (surface: Surface, href: string) => surface.routes.some((route) => routePattern(route).test(href));
const staticPrefix = (link: string) => link.split(/[{?#]/)[0]!.replace(/\/$/, "") || "/";

export async function checkFeatureMaps(root: string, options: CheckOptions): Promise<CheckResult> {
	const problems: string[] = [];
	const schema = readJson(root, SCHEMA_FILE) as Schema;
	const loaded = loadMaps(root);
	problems.push(...loaded.problems);
	const maps = loaded.maps;

	const personasJson = readJson(root, PERSONAS_FILE);
	problems.push(...validate({ $ref: "#/$defs/personas" }, personasJson, schema).map((p) => `${PERSONAS_FILE}: ${p}`));
	const personas = (personasJson ?? {}) as Record<string, Persona>;
	const pendingJson = readJson(root, PENDING_FILE);
	problems.push(...validate({ $ref: "#/$defs/pending" }, pendingJson, schema).map((p) => `${PENDING_FILE}: ${p}`));
	const pending = ((pendingJson as { routes?: string[] }).routes ?? []).slice();

	const logins = qaLogins(root);
	const seedPersonas = personasFromSeed(readFileSync(join(root, SEED_FILE), "utf8"));
	for (const [id, persona] of Object.entries(personas)) {
		const at = `${PERSONAS_FILE}: persona "${id}"`;
		if (persona.context === "plant" && !persona.role) problems.push(`${at}: a plant persona needs a role`);
		if (persona.context !== "plant" && persona.role) problems.push(`${at}: only a plant persona has a role`);
		if (persona.context === "signed-out") {
			if (persona.seed) problems.push(`${at}: a signed-out persona has no seed`);
		} else if (persona.seed !== "qa") problems.push(`${at}: needs "seed": "qa", the seed that creates it`);
		else if (!logins.has(id)) problems.push(`${at}: is no QA_LOGINS key in ${LOGINS_FILE}, so nothing signs it in`);
		else {
			const seeded = seedPersonas.get(id);
			if (!seeded) problems.push(`${at}: ${SEED_FILE} does not say who QA_LOGINS.${id} is`);
			else {
				if (!persona.says.startsWith(seeded.name))
					problems.push(`${at}: says "${persona.says}", but the QA seed names QA_LOGINS.${id} "${seeded.name}"`);
				const mine = describePersona(persona);
				const theirs = describePersona(seeded);
				if (mine !== theirs) problems.push(`${at}: is ${mine} here, but the QA seed makes QA_LOGINS.${id} ${theirs}`);
			}
		}
	}

	const routes = appRoutes(root);
	const byUrl = new Map(routes.map((r) => [r.url, r] as const));
	const owner = new Map<string, { surface: Surface; map: LoadedMap; kind: "page" | "handler" }>();
	const surfaceIds = new Map<string, Surface>();
	for (const loadedMap of maps) {
		const { file, map } = loadedMap;
		const folder = file === APP_MAP ? "app" : file.split("/").at(-2)!;
		if (map.feature !== folder) problems.push(`${file}: feature is "${map.feature}" but the folder is "${folder}"`);
		for (const surface of map.surfaces) {
			if (!surface.id.startsWith(`${map.feature}.`))
				problems.push(`${file}: surface "${surface.id}" must start with "${map.feature}."`);
			if (surfaceIds.has(surface.id)) problems.push(`${file}: surface id "${surface.id}" is used twice`);
			surfaceIds.set(surface.id, surface);
			for (const [list, kind] of [
				[surface.routes, "page"],
				[surface.endpoints ?? [], "handler"],
			] as const)
				for (const url of list) {
					const route = byUrl.get(url);
					if (!route) problems.push(`${file}: ${surface.id} names ${url}, which is no ${kind} under ${APP_DIR}`);
					else if (route.kind !== kind)
						problems.push(
							`${file}: ${surface.id} lists ${url} under ${kind === "page" ? "routes" : "endpoints"}, but it is a ${route.kind}`,
						);
					else if (owner.has(url))
						problems.push(`${file}: ${url} is owned by ${owner.get(url)!.surface.id} and ${surface.id}`);
					else owner.set(url, { surface, map: loadedMap, kind });
				}
		}
	}

	for (const route of routes) {
		const owned = owner.get(route.url);
		const listed = pending.includes(route.url);
		if (owned && listed)
			problems.push(`${PENDING_FILE}: ${route.url} is mapped by ${owned.surface.id}; remove it from the pending list`);
		if (!owned && !listed)
			problems.push(
				`${route.file}: ${route.url} is owned by no feature map; add it to a surface in its feature's feature-map.json`,
			);
		if (owned && owned.map.file !== APP_MAP) {
			const feature = owned.map.map.feature;
			const imported = new Set(
				[...readFileSync(join(root, route.file), "utf8").matchAll(/from\s+["'][^"']*features\/([a-z][a-z-]*)/g)].map(
					(m) => m[1],
				),
			);
			for (const other of imported)
				if (other !== feature)
					problems.push(
						`${route.file}: is mapped in ${feature} but imports features/${other}; move it to that feature's map`,
					);
		}
	}
	for (const url of pending)
		if (!byUrl.has(url)) problems.push(`${PENDING_FILE}: ${url} is no route any more; remove it from the pending list`);
	if ("routes" in options.base) {
		const before = new Set(options.base.routes);
		for (const url of pending)
			if (!before.has(url))
				problems.push(
					`${PENDING_FILE}: ${url} was added to the pending list; the list only shrinks, so map the route instead`,
				);
	} else if ("error" in options.base && options.ci)
		problems.push(
			`${PENDING_FILE}: cannot read the pending list at the merge base with origin/main: ${options.base.error}`,
		);
	if (options.changed) {
		const routeOf = new Map(routes.map((r) => [r.file, r] as const));
		const unmapped = new Map<string, string[]>();
		for (const file of options.changed) {
			const route = routeOf.get(file);
			if (route && pending.includes(route.url))
				problems.push(
					`${file}: this branch changes ${route.url}, which is still in ${PENDING_FILE}; map its surface in its feature's feature-map.json and remove the route from the pending list`,
				);
			const feature = featureOf(file);
			if (
				feature &&
				!isTest(file) &&
				existsSync(join(root, FEATURES_DIR, feature)) &&
				!existsSync(join(root, featureMapFile(feature)))
			)
				unmapped.set(feature, [...(unmapped.get(feature) ?? []), file]);
		}
		for (const [feature, files] of unmapped)
			problems.push(
				`${FEATURES_DIR}/${feature}/: this branch changes ${files.join(", ")}, but feature "${feature}" has no feature-map.json; add ${featureMapFile(feature)} with at least the surface this change touches`,
			);
	}

	const code = codeCorpus(root);
	const catalog = readJson(root, "docs/catalog/index.json") as Record<string, Json>;
	const operations = new Map(
		(
			(readJson(root, catalog.operation_source as string) as { operations: { id: string; feature_ids?: string[] }[] })
				.operations ?? []
		).map((o) => [o.id, o.feature_ids ?? []] as const),
	);
	const featureIds = new Set((readJson(root, catalog.feature_source as string) as { id: string }[]).map((f) => f.id));
	const requirementText = new Set(
		(catalog.requirement_files as string[]).flatMap((f) =>
			(readJson(root, f) as { requirements: { text: string }[] }).requirements.map((r) => r.text.trim()),
		),
	);
	const caseIds = new Set(
		(catalog.case_files as string[]).flatMap((f) =>
			(readJson(root, f) as { cases: { id: string }[] }).cases.map((c) => c.id),
		),
	);
	const namesByFile = new Map<string, Set<string>>();
	const namesIn = (file: string) => {
		if (!namesByFile.has(file))
			namesByFile.set(
				file,
				existsSync(join(root, file))
					? new Set(testNames(readFileSync(join(root, file), "utf8")).map((t) => t.name))
					: new Set(),
			);
		return namesByFile.get(file)!;
	};
	const shared = stringsOf(root, [
		...walk(root, UI_DIR, (f) => SOURCE_FILE.test(f) && !isTest(f)),
		...withImports(root, SHELL_DIR),
	]);
	const seeded = stringsOf(root, [SEED_FILE]);

	const navModule = (await import(pathToFileURL(join(root, NAV_MODULE)).href)) as { shellNav: ShellNav };
	const railOf = (persona: Persona) => {
		if (persona.context === "signed-out") return [];
		const nav = navModule.shellNav(viewerOf(persona));
		return [...nav.main, ...nav.pages].map((i) => ({ label: i.label, href: i.href.replace(/#.*$/, "") }));
	};

	for (const { file, map } of maps) {
		const at = (where: string) => `${file}: ${where}`;
		const own = stringsOf(root, withImports(root, dirname(file)));
		const scope = `${dirname(file)} (and what it imports), ${UI_DIR}, the shell or ${SEED_FILE}`;
		const checkCatalog = (where: string, ids: string[] | undefined) => {
			for (const id of ids ?? [])
				if (!featureIds.has(id))
					problems.push(at(`${where} cites catalog feature ${id}, which is not in features.json`));
		};
		const checkPersona = (where: string, persona: string, surface: Surface) => {
			if (!(persona in personas))
				problems.push(at(`${where} names persona "${persona}", which is not in ${PERSONAS_FILE}`));
			else if ((surface.personas[persona] ?? "none") === "none")
				problems.push(at(`${where} reaches it as "${persona}", but the surface gives that persona no access`));
		};
		const checkSteps = (where: string, steps: Step[], observables: Observable[], typed: Set<string>) => {
			for (const step of steps) {
				if ("upload" in step && !existsSync(join(root, step.upload)))
					problems.push(at(`${where}: upload file ${step.upload} does not exist`));
				if ("type" in step) {
					const special = SPECIAL_VALUE.exec(step.type);
					if (step.type.startsWith("$") && !special)
						problems.push(at(`${where}: "${step.type}" is no $login:<persona> or $password`));
					if (special?.[1] && !logins.has(special[1]))
						problems.push(at(`${where}: $login:${special[1]} is no QA_LOGINS key in ${LOGINS_FILE}`));
				}
			}
			for (const { value, match } of named(observables, steps)) {
				if (typed.has(value)) continue;
				const found = [own, shared, seeded].some((set) =>
					match === "exact" ? set.has(value) : [...set].some((s) => s.includes(value)),
				);
				if (!found)
					problems.push(
						at(
							match === "exact"
								? `${where}: no string literal or JSX text in ${scope} equals "${value}"`
								: `${where}: no string literal or JSX text in ${scope} contains "${value}"`,
						),
					);
			}
		};
		checkCatalog("the map", map.catalog);
		for (const surface of map.surfaces) {
			const s = surface.id;
			checkCatalog(s, surface.catalog);
			if (requirementText.has(surface.says.trim()))
				problems.push(at(`${s} says a requirement's text; say it in user words`));
			for (const persona of Object.keys(surface.personas))
				if (!(persona in personas))
					problems.push(at(`${s} lists persona "${persona}", which is not in ${PERSONAS_FILE}`));
			for (const [i, reach] of surface.reach.entries()) {
				const where = `${s} reach ${i + 1}`;
				if ("rail" in reach) {
					for (const persona of reach.personas) {
						checkPersona(where, persona, surface);
						if (!(persona in personas)) continue;
						const item = railOf(personas[persona]!).find((n) => n.label === reach.rail);
						if (!item) problems.push(at(`${where}: the rail offers "${persona}" no "${reach.rail}" (${NAV_MODULE})`));
						else if (!opens(surface, item.href))
							problems.push(at(`${where}: rail "${reach.rail}" opens ${item.href}, which is not a route of ${s}`));
					}
				} else if ("from" in reach) {
					if (!surfaceIds.has(reach.from)) problems.push(at(`${where} starts from unknown surface "${reach.from}"`));
					checkPersona(where, reach.persona, surface);
					checkSteps(where, reach.path, [], typedIn(reach.path));
				} else if (reach.email) {
					const prefix = staticPrefix(reach.link);
					const key = new RegExp(`["'\`]${escape(reach.email)}["'\`]|\\b${escape(reach.email)}\\s*:`);
					if (!code.some(({ text }) => key.test(text) && text.includes(prefix)))
						problems.push(
							at(
								`${where}: no file in packages/*/src or apps/web/src/server names email "${reach.email}" and builds ${prefix}`,
							),
						);
				}
			}
			for (const state of surface.states) {
				const where = `${s} state ${state.id}`;
				if (state.file && !existsSync(join(root, state.file)))
					problems.push(at(`${where}: ${state.file} does not exist`));
				const reach = state.reach;
				if ("persona" in reach) {
					if (!(reach.persona in personas))
						problems.push(at(`${where} names persona "${reach.persona}", which is not in ${PERSONAS_FILE}`));
					const steps = [...("setup" in reach ? reach.setup : []), ...(reach.path ?? [])];
					checkSteps(where, steps, state.expect, typedIn(steps));
				} else checkSteps(where, [], state.expect, new Set());
			}
			if (new Set(surface.states.map((x) => x.id)).size !== surface.states.length)
				problems.push(at(`${s} has two states with one id`));
			for (const route of surface.routes) {
				const r = byUrl.get(route);
				if (!r) continue;
				for (const stateFile of stateFilesFor(root, r.file))
					if (!surface.states.some((x) => x.file === stateFile))
						problems.push(at(`${s} declares no state for ${stateFile}, which renders on ${route}`));
			}
			if (new Set(surface.behaviors.map((b) => b.id)).size !== surface.behaviors.length)
				problems.push(at(`${s} has two behaviors with one id`));
			for (const behavior of surface.behaviors) {
				const where = `${s}#${behavior.id}`;
				checkCatalog(where, behavior.catalog);
				if (requirementText.has(behavior.says.trim()))
					problems.push(at(`${where} says a requirement's text; say it in user words`));
				if (behavior.operations.length === 0 && !behavior.noOperation)
					problems.push(at(`${where}: lists no operation; name one or say why in "noOperation"`));
				if (behavior.operations.length > 0 && behavior.noOperation)
					problems.push(at(`${where}: lists operations and "noOperation"; keep one`));
				for (const op of behavior.operations) {
					const features = operations.get(op);
					if (!features) problems.push(at(`${where}: operation ${op} is not in docs/catalog/operations.json`));
					else {
						if (!implemented(code, op))
							problems.push(
								at(`${where}: operation ${op} is neither quoted nor declared in packages/*/src or apps/web/src/server`),
							);
						if (!features.some((f) => behavior.catalog.includes(f)))
							problems.push(
								at(
									`${where}: operation ${op} serves ${features.join(", ")}, none of the behavior's catalog ${behavior.catalog.join(", ")}`,
								),
							);
					}
				}
				for (const test of behavior.proof.tests) {
					if (!existsSync(join(root, test.file))) problems.push(at(`${where}: test file ${test.file} does not exist`));
					else if (!namesIn(test.file).has(test.name))
						problems.push(at(`${where}: ${test.file} has no test named "${test.name}"`));
				}
				for (const id of behavior.proof.cases ?? []) {
					if (!caseIds.has(id)) problems.push(at(`${where}: case ${id} is in no case file of docs/catalog/index.json`));
					const tag = new RegExp(`(^|\\s)AC:${id}(?![\\w-])`);
					if (!behavior.proof.tests.some((t) => tag.test(t.name)))
						problems.push(at(`${where}: no listed test name carries AC:${id}`));
				}
				const browser = behavior.proof.browser;
				if (browser) {
					const state = surface.states.find((x) => x.id === browser.state);
					if (!state) problems.push(at(`${where}: browser proof starts in unknown state "${browser.state}"`));
					else if ("manual" in state.reach)
						problems.push(at(`${where}: browser proof starts in state "${browser.state}", which no script reaches`));
					const acts = browser.steps.findIndex((st) => !("open" in st) && !("expect" in st));
					if (browser.kind === "behavior" && acts < 0)
						problems.push(at(`${where}: a behavior proof acts (click, type, press or upload) before it observes`));
					const after = [
						...browser.steps
							.slice(acts + 1)
							.flatMap((st) => ("expect" in st ? [(st as { expect: Observable }).expect] : [])),
						...browser.expect,
					];
					if (browser.kind === "behavior" && acts >= 0 && after.every((o) => "url" in o))
						problems.push(at(`${where}: a behavior proof checks something besides the address after it acts`));
					const before =
						state && "persona" in state.reach
							? [...("setup" in state.reach ? state.reach.setup : []), ...(state.reach.path ?? [])]
							: [];
					checkSteps(where, browser.steps, browser.expect, typedIn([...before, ...browser.steps]));
				}
			}
		}
	}

	for (const [id, persona] of Object.entries(personas))
		for (const item of railOf(persona)) {
			const owned = [...owner.values()].find((o) => o.kind === "page" && opens(o.surface, item.href));
			if (!owned) continue;
			const access = owned.surface.personas[id] ?? "none";
			const declared = owned.surface.reach.some((r) => "rail" in r && r.rail === item.label && r.personas.includes(id));
			if (access === "none" || !declared)
				problems.push(
					`${owned.map.file}: the rail offers "${id}" "${item.label}" (${NAV_MODULE}), but ${owned.surface.id} ${access === "none" ? `gives "${id}" no access` : `has no rail reach "${item.label}" for "${id}"`}`,
				);
		}

	const docs = renderDocs(maps, personas, pending.length, routes.length);
	const present = walk(root, DOCS_DIR, (f) => f.endsWith(".md"));
	for (const [path, content] of docs) {
		const current = existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null;
		if (current !== content)
			problems.push(`${path}: is ${current === null ? "missing" : "stale"}; run node tools/ci/feature-maps.ts --write`);
	}
	for (const path of present)
		if (!docs.has(path)) problems.push(`${path}: belongs to no feature map; run node tools/ci/feature-maps.ts --write`);
	for (const { map } of maps)
		for (const surface of map.surfaces) {
			const size = Buffer.byteLength(showSurface(surface));
			if (size > SHOW_BUDGET)
				problems.push(
					`${surface.id}: show prints ${size} bytes, over the ${SHOW_BUDGET}-byte budget; split the surface`,
				);
		}

	const surfaces = maps.flatMap((m) => m.map.surfaces);
	const states = surfaces.flatMap((s) => s.states);
	const behaviors = surfaces.flatMap((s) => s.behaviors);
	const kind = (k: Browser["kind"]) => behaviors.filter((b) => b.proof.browser?.kind === k).length;
	const summary =
		`feature-maps: ${maps.length} maps, ${surfaces.length} surfaces, ${behaviors.length} behaviors ` +
		`(browser proofs: ${kind("behavior")} behavior, ${kind("presence")} presence); ` +
		`${owner.size} of ${routes.length} routes mapped, ${pending.length} pending; ` +
		`${states.filter((x) => !("manual" in x.reach)).length} of ${states.length} states reachable by script`;
	return { problems: [...new Set(problems)], summary };
}

const q = (value: string) => JSON.stringify(value);
const shown = (value: string) => {
	const special = SPECIAL_VALUE.exec(value);
	return special ? (special[1] ? `<QA_LOGINS.${special[1]}>` : "<QA_PASSWORD>") : value;
};
const exact = (t: { match?: Match }) => ((t.match ?? "exact") === "exact" ? " --exact" : "");
const IDLE = "agent-browser wait --load networkidle";

function command(step: Step | Observable): string {
	if ("open" in step) return `agent-browser open ${q("$ORIGIN" + step.open)}`;
	if ("click" in step) {
		const t = step.click;
		return "role" in t
			? `agent-browser find role ${t.role} click --name ${q(t.name)}${exact(t)}`
			: `agent-browser find text ${q(t.text)} click${exact(t)}`;
	}
	if ("into" in step) return `agent-browser find label ${q(step.into)} fill ${q(shown(step.type))}`;
	if ("press" in step) return `agent-browser press ${step.press}`;
	if ("upload" in step) return `agent-browser upload "input[type=file]" ${q("$REPO/" + step.upload)}`;
	if ("expect" in step) return command((step as { expect: Observable }).expect);
	if ("absent" in step)
		return `! agent-browser find role ${step.absent.role} text --name ${q(step.absent.name)}${exact(step.absent)}`;
	if ("noText" in step) return `agent-browser wait --fn ${q(`!document.body.innerText.includes(${q(step.noText)})`)}`;
	if ("url" in step) return `agent-browser wait --url ${q("**" + step.url.replace(/\{[A-Za-z]+\}/g, "*"))}`;
	if ("role" in step) return `agent-browser find role ${step.role} text --name ${q(step.name)}${exact(step)}`;
	return (step.match ?? "exact") === "exact"
		? `agent-browser find text ${q(step.text)} text --exact`
		: `agent-browser wait --text ${q(step.text)}`;
}

function commands(steps: Step[], expect: Observable[] = []): string[] {
	return [
		...steps.flatMap((s) => ("expect" in s || "type" in s ? [command(s)] : [command(s), IDLE])),
		...expect.map(command),
	];
}
const block = (lines: string[]) => ["```bash", ...lines, "```"];

const describeTarget = (t: Target) => {
	const how = (t.match ?? "exact") === "contains" ? "containing " : "";
	return "role" in t ? `${t.role} ${how}"${t.name}"` : `text ${how}"${t.text}"`;
};
const describeObservable = (o: Observable): string =>
	"noText" in o
		? `no text "${o.noText}"`
		: "url" in o
			? `URL \`${o.url}\``
			: "absent" in o
				? `no ${describeTarget(o.absent)}`
				: describeTarget(o);

function stateLines(state: State): string[] {
	const file = state.file ? ` (\`${state.file.slice(state.file.lastIndexOf("/") + 1)}\`)` : "";
	const head = `- **${state.id}**${file}: ${state.expect.map(describeObservable).join("; ")}`;
	const reach = state.reach;
	if ("manual" in reach) return [`${head}. Not scripted: ${reach.manual}.`];
	const given = "setup" in reach ? "after the setup steps below, which create what no seed holds" : "on the QA seed";
	return [
		`${head}. As \`${reach.persona}\`, ${given}:`,
		"",
		...block(
			commands(
				[
					...("setup" in reach ? reach.setup : []),
					...(reach.open ? [{ open: reach.open }] : []),
					...(reach.path ?? []),
				],
				state.expect,
			),
		),
		"",
	];
}

function reachLines(reach: Reach): string[] {
	if ("rail" in reach) return [`- Rail "${reach.rail}" for ${reach.personas.map((p) => `\`${p}\``).join(", ")}`];
	if ("from" in reach) return [`- From ${reach.from} as \`${reach.persona}\`:`, "", ...block(commands(reach.path)), ""];
	const fill = reach.fill
		? ` where ${Object.entries(reach.fill)
				.map(([k, v]) => `\`{${k}}\` is ${v}`)
				.join(", ")}`
		: "";
	return [`- ${reach.email ? `Email \`${reach.email}\` links to` : "Link"} \`${reach.link}\`${fill}`];
}

export function showSurface(surface: Surface): string {
	const lines = [`### ${surface.id}`, "", surface.says, ""];
	lines.push(`- Routes: ${surface.routes.map((r) => `\`${r}\``).join(", ") || "none"}`);
	if (surface.endpoints) lines.push(`- Endpoints: ${surface.endpoints.map((r) => `\`${r}\``).join(", ")}`);
	lines.push(
		`- Personas: ${Object.entries(surface.personas)
			.map(([p, a]) => `\`${p}\` ${a}`)
			.join(", ")}`,
	);
	if (surface.catalog?.length) lines.push(`- Catalog: ${surface.catalog.join(", ")}`);
	lines.push(
		"",
		"Reach:",
		"",
		...surface.reach.flatMap(reachLines),
		"",
		"States:",
		"",
		...surface.states.flatMap(stateLines),
	);
	for (const behavior of surface.behaviors) {
		lines.push("", `#### ${surface.id}#${behavior.id}`, "", behavior.says, "");
		lines.push(
			behavior.operations.length
				? `- Operations: ${behavior.operations.join(", ")}`
				: `- No operation: ${behavior.noOperation ?? ""}`,
		);
		lines.push(`- Catalog: ${behavior.catalog.join(", ")}`);
		if (behavior.proof.cases?.length) lines.push(`- Cases: ${behavior.proof.cases.join(", ")}`);
		for (const test of behavior.proof.tests) lines.push(`- Test: \`${test.file}\`: \`${test.name}\``);
		const browser = behavior.proof.browser;
		if (browser)
			lines.push(
				browser.kind === "behavior"
					? `- Browser, behavior proof (acts and checks the result), from state ${browser.state}:`
					: `- Browser, presence proof only (the control is there; the tests prove the outcome), from state ${browser.state}:`,
				"",
				...block(commands(browser.steps, browser.expect)),
			);
	}
	return lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

const nodeLabel = (text: string) => text.replace(/"/g, "#quot;");

function featureDoc(map: FeatureMap, file: string): string {
	const ids = new Map(map.surfaces.map((s, i) => [s.id, `s${i}`] as const));
	const graph: string[] = [];
	const entries = new Set<string>();
	for (const surface of map.surfaces) {
		const node = ids.get(surface.id)!;
		graph.push(`  ${node}["${nodeLabel(`${surface.id}<br/>${surface.routes.join(" ") || "no page"}`)}"]`);
		for (const [i, reach] of surface.reach.entries()) {
			if ("rail" in reach) {
				entries.add(`  rail(["rail"])`);
				graph.push(`  rail -- "${nodeLabel(reach.rail)}" --> ${node}`);
			} else if ("from" in reach) {
				const from = ids.get(reach.from) ?? `x_${reach.from.replace(/\W/g, "_")}`;
				if (!ids.has(reach.from)) entries.add(`  ${from}(["${reach.from}"])`);
				const label = reach.path.flatMap((st) => ("click" in st ? [describeTarget(st.click)] : [])).join(", then ");
				graph.push(`  ${from} -- "${nodeLabel(label || "path")}" --> ${node}`);
			} else {
				const entry = `${node}_link${i}`;
				entries.add(`  ${entry}(["${nodeLabel(reach.email ? `email ${reach.email}` : `link ${reach.link}`)}"])`);
				graph.push(`  ${entry} --> ${node}`);
			}
		}
		for (const [i, state] of surface.states.entries())
			graph.push(
				`  ${node} -.- ${node}_st${i}(("${nodeLabel(`${state.id}${"manual" in state.reach ? " (manual)" : "setup" in state.reach ? " (setup)" : ""}`)}"))`,
			);
		for (const [i, behavior] of surface.behaviors.entries()) {
			const proof = [
				"tests",
				behavior.proof.cases?.length ? "cases" : "",
				behavior.proof.browser ? `browser ${behavior.proof.browser.kind}` : "",
			]
				.filter(Boolean)
				.join(" + ");
			graph.push(`  ${node} --- ${node}_b${i}["${nodeLabel(`${behavior.id}<br/>${proof}`)}"]`);
		}
	}
	return [
		`# Feature map: ${map.feature}`,
		"",
		`Generated from [\`${file}\`](../../${file}) by \`node tools/ci/feature-maps.ts --write\`. Do not edit by hand.`,
		"Personas, sign-in and what the checker cannot catch: [README](README.md).",
		"",
		"```mermaid",
		"flowchart LR",
		...[...entries].sort(),
		...graph,
		"```",
		"",
		"## Surfaces",
		"",
		...map.surfaces.map((s) => showSurface(s)),
	]
		.join("\n")
		.replace(/\n{3,}/g, "\n\n");
}

function overviewDoc(maps: LoadedMap[], personas: Record<string, Persona>, pending: number, routes: number): string {
	const graph = ["flowchart LR", `  rail(["rail"])`, `  links(["links and email"])`];
	const ids = new Map<string, string>();
	maps.forEach(({ map }, m) => map.surfaces.forEach((s, i) => ids.set(s.id, `f${m}s${i}`)));
	for (const [m, { map }] of maps.entries()) {
		graph.push(`  subgraph f${m}["${map.feature}"]`);
		for (const surface of map.surfaces) graph.push(`    ${ids.get(surface.id)}["${nodeLabel(surface.id)}"]`);
		graph.push("  end");
	}
	for (const { map } of maps)
		for (const surface of map.surfaces) {
			const node = ids.get(surface.id)!;
			for (const label of new Set(surface.reach.flatMap((r) => ("rail" in r ? [r.rail] : []))))
				graph.push(`  rail -- "${nodeLabel(label)}" --> ${node}`);
			for (const from of new Set(surface.reach.flatMap((r) => ("from" in r ? [r.from] : []))))
				if (ids.has(from)) graph.push(`  ${ids.get(from)} --> ${node}`);
			if (surface.reach.some((r) => "link" in r)) graph.push(`  links -.-> ${node}`);
		}
	const count = (map: FeatureMap) => map.surfaces.reduce((k, s) => k + s.routes.length + (s.endpoints?.length ?? 0), 0);
	const mapped = maps.reduce((n, { map }) => n + count(map), 0);
	const rows = maps.map(({ file, map }) => {
		const behaviors = map.surfaces.flatMap((s) => s.behaviors);
		const kind = (k: Browser["kind"]) => behaviors.filter((b) => b.proof.browser?.kind === k).length;
		return `| [${map.feature}](${map.feature}.md) | [\`${file}\`](../../${file}) | ${map.surfaces.length} | ${count(map)} | ${behaviors.length} | ${kind("behavior")} | ${kind("presence")} |`;
	});
	const personaRows = Object.entries(personas).map(
		([id, p]) =>
			`| \`${id}\` | ${p.context}${p.role ? ` ${p.role}` : ""}${p.residencyLinked ? ", residency linked" : ""} | ${p.says} | ${p.seed ? `\`QA_LOGINS.${id}\` and \`QA_PASSWORD\`` : "none"} |`,
	);
	return [
		"# Feature maps",
		"",
		"Generated by `node tools/ci/feature-maps.ts --write` from every `feature-map.json`. Do not edit by hand.",
		"",
		"Each feature directory under `apps/web/src/features/` describes its surfaces: the routes it owns, how each persona",
		"reaches them, the states a verifier can open and the tests, cases and browser steps that prove each behavior.",
		"Print one surface with `node tools/ci/feature-maps.ts show <surface-id>`.",
		"",
		`Routes mapped: ${mapped} of ${routes}. Not yet mapped: ${pending}, listed in [\`${PENDING_FILE}\`](../../${PENDING_FILE}).`,
		"",
		"```mermaid",
		...graph,
		"```",
		"",
		"| Feature | Map | Surfaces | Routes | Behaviors | Browser behavior proofs | Browser presence proofs |",
		"|---|---|---|---|---|---|---|",
		...rows,
		"",
		"## Become a persona",
		"",
		`Every map uses the QA seed ([\`${SEED_FILE}\`](../../${SEED_FILE})): it creates the personas below and the data the`,
		'steps name (for example "QA vision meeting" or "Maria Santos"). Run the app on a QA-seeded database, for example a',
		"local proof slot or a QA preview (`bin/qa`). Sign in at `/signin` with the persona's address and password, both in",
		`[\`${LOGINS_FILE}\`](../../${LOGINS_FILE}); a proof slot's \`login --persona <id>\` sets the same session cookie.`,
		"In commands, `$ORIGIN` is the app's address, `$REPO` the checkout, and `<QA_LOGINS.x>` and `<QA_PASSWORD>` are",
		"values from that file. Each step that opens, clicks, presses or uploads is followed by a network-idle wait, so the page",
		"has hydrated and the next check sees the result.",
		"A state marked setup creates its own data first; run its setup once per fresh seed.",
		"",
		"| Persona | Context | Who | Sign in with |",
		"|---|---|---|---|",
		...personaRows,
		"",
		"## What the check proves, and what it cannot",
		"",
		"`node tools/ci/feature-maps.ts` (CI: tooling job) proves the map is consistent with the code, not that the app",
		"behaves as the map says. It checks: every route belongs to one surface or the shrink-only pending list; route",
		"files import only their own feature; every `loading`, `error` and `not-found` file is a declared state; test",
		"names exist exactly; cases are `AC:` markers in those tests; operations are in the catalog, serve the behavior's",
		"catalog features and are quoted or declared in code; email links name a template that builds that path; rail",
		"reaches agree with `shellNav` both ways for every persona; personas are QA seed logins whose name, context, role",
		"and residency link match what the seed creates; a behavior proof checks more than the address after it acts;",
		"and every name, label",
		"and text in a step equals (or, for `contains`, is part of) a string literal or JSX text, comments excluded, in the",
		"feature's folder, `packages/ui/src`, the shell (each with the modules it imports directly) or the QA seed, or was",
		"typed earlier in the same steps.",
		"",
		"It cannot catch, and only running the browser steps catches:",
		"",
		"- a rename where the old text still exists elsewhere in that scope;",
		"- the wrong role for a name (a heading checked as a button);",
		"- whether a persona really has the access the map gives it, or a state's checks also pass on another screen;",
		"- whether the seed data the steps name is in the state the steps expect (each run needs a fresh seed);",
		"- a real test name that tests something other than the behavior it is listed under.",
		"",
		"A browser proof marked presence only shows that the control is there; the listed tests prove the outcome.",
		"",
		"The network-idle wait suits these pages, which go quiet after each action. On a page that keeps fetching (for",
		"example `/documents`, or import progress) it runs to its 25 s timeout and still succeeds, so it proves nothing there;",
		"a map for a polling page should wait on its next check instead (`wait --text`, `wait --url`).",
		"",
		"## Changing a feature, and the review proof",
		"",
		"On a branch the check also reads the files changed since the merge base with origin/main. A change to a page or",
		"handler file whose route is still pending fails until that route's surface is mapped and the route leaves the",
		"pending list. A change to a non-test file under `apps/web/src/features/<feature>/` fails while the feature has no",
		"`feature-map.json`. A partial map is enough: map the surface you touch and leave the feature's other routes pending.",
		"",
		"Every review of app code carries proof of the real app. The verifier reaches each changed surface as its map says,",
		"takes agent-browser screenshots at 390 and 1440 px (or a recording) into `<evidence>/proof/<surface-id>/` and runs",
		"`pnpm review-proof --base <merge-base> --evidence <dir> [--head <checkout>] <surface-id>...`. It derives the",
		"surfaces the diff needs: each changed mapped route's surface, one proved surface per changed mapped feature, and one",
		"for any other product code under `apps/web/` or `packages/*/src/`. It refuses a missing width, a PNG that is not",
		"exactly 390 or 1440 px wide and an unknown surface id, and prints each proved surface's map entry as the review's",
		"Proof table. A diff of only tooling, docs, tests or agent instructions needs no app proof.",
		"",
	].join("\n");
}

export function renderDocs(
	maps: LoadedMap[],
	personas: Record<string, Persona>,
	pending: number,
	routes: number,
): Map<string, string> {
	const docs = new Map<string, string>([[`${DOCS_DIR}/README.md`, overviewDoc(maps, personas, pending, routes)]]);
	for (const { file, map } of maps) docs.set(`${DOCS_DIR}/${map.feature}.md`, featureDoc(map, file));
	return docs;
}

export function writeDocs(root: string): string[] {
	const { maps, problems } = loadMaps(root);
	if (problems.length) return problems;
	const pending = ((readJson(root, PENDING_FILE) as { routes?: string[] }).routes ?? []).length;
	const personas = readJson(root, PERSONAS_FILE) as Record<string, Persona>;
	const docs = renderDocs(maps, personas, pending, appRoutes(root).length);
	for (const path of walk(root, DOCS_DIR, (f) => f.endsWith(".md"))) if (!docs.has(path)) rmSync(join(root, path));
	mkdirSync(join(root, DOCS_DIR), { recursive: true });
	for (const [path, content] of docs) writeFileSync(join(root, path), content);
	return [];
}

const gitIn =
	(root: string) =>
	(...args: string[]) =>
		execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

export function mergeBase(root: string, ref = "origin/main"): string | null {
	try {
		return gitIn(root)("merge-base", "HEAD", ref);
	} catch {
		return null;
	}
}

export function changedFiles(root: string, base: string, head?: string): string[] {
	const git = gitIn(root);
	const lines = (text: string) => text.split("\n").filter(Boolean);
	const diff = lines(git("diff", "--name-only", "--no-renames", base, ...(head ? [head] : [])));
	const untracked = head ? [] : lines(git("ls-files", "--others", "--exclude-standard"));
	return [...new Set([...diff, ...untracked])].sort();
}

export function basePendingFromGit(root: string, ref = "origin/main"): BasePending {
	const git = gitIn(root);
	const base = mergeBase(root, ref);
	if (!base) return { error: `git merge-base HEAD ${ref} failed (is ${ref} fetched?)` };
	try {
		const files = git("ls-tree", "-r", "--name-only", base, "--", "apps/web").split("\n");
		if (files.includes(PENDING_FILE))
			return { routes: (JSON.parse(git("show", `${base}:${PENDING_FILE}`)) as { routes: string[] }).routes };
		return files.some((f) => f.endsWith("/feature-map.json"))
			? { routes: [] }
			: { skip: `the merge base with ${ref} has no feature maps yet` };
	} catch {
		return { error: `git could not read ${PENDING_FILE} at ${base}` };
	}
}

if (import.meta.main) {
	const root = process.cwd();
	const [command, arg] = process.argv.slice(2);
	if (command === "--write") {
		const problems = writeDocs(root);
		for (const p of problems) console.error(p);
		if (problems.length) process.exit(1);
		console.log(`feature-maps: wrote ${DOCS_DIR}/`);
	} else if (command === "show") {
		const { maps } = loadMaps(root);
		const found = maps.flatMap(({ map }) => map.surfaces).find((s) => s.id === arg);
		if (!found) {
			console.error(
				`feature-maps: no surface "${arg ?? ""}". Surfaces: ${maps.flatMap(({ map }) => map.surfaces.map((s) => s.id)).join(", ")}`,
			);
			process.exit(2);
		}
		process.stdout.write(showSurface(found));
	} else if (command === undefined || command === "--check") {
		const base = basePendingFromGit(root);
		const ci = process.env.CI === "true";
		const at = mergeBase(root);
		const changed = at ? changedFiles(root, at) : undefined;
		const { problems, summary } = await checkFeatureMaps(root, { base, ci, changed });
		for (const p of problems) console.error(p);
		if ("skip" in base) console.log(`feature-maps: pending-list growth not checked: ${base.skip}`);
		if ("error" in base && !ci) console.log(`feature-maps: pending-list growth not checked: ${base.error}`);
		if (!changed) console.log("feature-maps: changed routes and features not checked: no merge base with origin/main");
		if (problems.length) {
			console.error(`feature-maps: ${problems.length} problem(s).`);
			process.exit(1);
		}
		console.log(summary);
	} else {
		console.error("Usage: node tools/ci/feature-maps.ts [--check | --write | show <surface-id>]");
		process.exit(2);
	}
}
