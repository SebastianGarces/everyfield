import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { testNames } from "./test-names.ts";

export const SCHEMA_FILE = "apps/web/feature-map.schema.json";
export const PENDING_FILE = "apps/web/feature-maps.pending.json";
export const PERSONAS_FILE = "tests/ui/personas.json";
export const NAV_MODULE = "apps/web/src/features/shell/nav.ts";
export const DOCS_DIR = "docs/feature-maps";
const APP_DIR = "apps/web/src/app";
const FEATURES_DIR = "apps/web/src/features";
const APP_MAP = `${APP_DIR}/feature-map.json`;
const SHOW_BUDGET = 4096;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = { [key: string]: Json };

type Match = "exact" | "contains";
type Target = { role: string; name: string; match?: Match } | { text: string; match?: Match };
type Observable = Target | { noText: string } | { url: string };
type Fill = Record<string, string>;
type Step = { open: string; fill?: Fill } | { click: Target } | { type: string; into: string } | { press: string };
type Reach =
	| { rail: string; personas: string[] }
	| { from: string; persona: string; path: Step[] }
	| { link: string; fill?: Fill; email?: string };
type StateReach = { persona: string; open: string; fill?: Fill } | { manual: string };
type State = { id: string; file?: string; reach: StateReach; expect: Observable[] };
type TestRef = { file: string; name: string };
type Behavior = {
	id: string;
	says: string;
	catalog?: string[];
	operations: string[];
	proof: { tests: TestRef[]; cases?: string[]; browser?: { state: string; steps: Step[]; expect: Observable[] } };
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
	seed?: string;
	cookie?: string;
	email?: string;
	password?: string;
};
type LoadedMap = { file: string; map: FeatureMap };
type Route = { url: string; kind: "page" | "handler"; file: string };
type NavItem = { label: string; href: string };
type ShellNav = (viewer: unknown) => { main: readonly NavItem[]; pages: readonly NavItem[] };

export type CheckOptions = { basePending: string[] | null };
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

const SEEDS_LIST = /export const SEEDS = \[([^\]]*)\]/;

function seedSources(root: string): Map<string, string> {
	const list = SEEDS_LIST.exec(readFileSync(join(root, "tests/ui/seed-env.mts"), "utf8"));
	const names = [...(list?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
	const sources = walk(root, "tests/ui", (f) => f.endsWith(".mts")).map((f) => readFileSync(join(root, f), "utf8"));
	return new Map(names.map((name) => [name, sources.find((s) => s.includes(`writeFixture("${name}"`)) ?? ""] as const));
}

function seedPointerProblem(seeds: Map<string, string>, seed: string, pointer: string): string | null {
	if (!seeds.has(seed)) return `seed "${seed}" is not in SEEDS (tests/ui/seed-env.mts)`;
	const first = pointer.split("/")[1] ?? "";
	if (!first) return `seed pointer "${pointer}" names no fixture key`;
	return new RegExp(`(^|[^\\w$])${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w$]|$)`).test(seeds.get(seed)!)
		? null
		: `fixture key "${first}" does not occur in the ${seed} seed's source`;
}

export const SEED_VALUE = /^\$([a-z][a-z-]*):(\/.*)$/;

function textCorpus(root: string): string {
	const keep = (f: string) => /\.(tsx?|mts)$/.test(f) && !/\.test\.|\.d\.ts$/.test(f);
	return ["apps/web/src", "packages/ui/src", "packages/contracts/src"]
		.flatMap((dir) => walk(root, dir, keep))
		.map((f) => readFileSync(join(root, f), "utf8"))
		.join("\n")
		.replace(/\s+/g, " ");
}

function operationCorpus(root: string): string {
	const dirs = readdirSync(join(root, "packages"), { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => `packages/${d.name}/src`);
	return [...dirs, "apps/web/src/server"]
		.flatMap((dir) => walk(root, dir, (f) => /\.(tsx?|mts|mjs|js)$/.test(f)))
		.map((f) => readFileSync(join(root, f), "utf8"))
		.join("\n");
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

function targets(steps: Step[]): Target[] {
	return steps.flatMap((s) => ("click" in s ? [s.click] : []));
}
function literals(observables: Observable[], steps: Step[]): string[] {
	const fromTarget = (t: Target) => ("role" in t ? t.name : t.text);
	return [
		...observables.flatMap((o) => ("noText" in o ? [o.noText] : "url" in o ? [] : [fromTarget(o)])),
		...targets(steps).map(fromTarget),
		...steps.flatMap((s) => ("into" in s ? [s.into] : [])),
	].filter((value) => !steps.some((s) => "type" in s && s.type === value));
}
function fills(steps: Step[]): Array<{ path: string; fill?: Fill }> {
	return steps.flatMap((s) => ("open" in s ? [{ path: s.open, fill: s.fill }] : []));
}

export function viewerOf(persona: Persona): unknown {
	if (persona.context === "plant") return { context: "plant", role: persona.role };
	if (persona.context === "organization") return { context: "organization" };
	return { context: "account", residencyLinked: persona.residencyLinked === true };
}

function placeholderProblems(path: string, fill: Fill | undefined): string[] {
	const wanted = [...path.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]!);
	return [
		...wanted.filter((w) => !fill || !(w in fill)).map((w) => `"${path}" has {${w}} but no fill for it`),
		...Object.keys(fill ?? {})
			.filter((k) => !wanted.includes(k))
			.map((k) => `fill "${k}" is not a {placeholder} of "${path}"`),
	];
}

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
								: "/" + s.replace(/[.*+?^$()|\\]/g, "\\$&"),
				)
				.join("") || "/") +
			"$",
	);
const opens = (surface: Surface, href: string) => surface.routes.some((route) => routePattern(route).test(href));

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

	const seeds = seedSources(root);
	for (const [id, persona] of Object.entries(personas)) {
		const at = `${PERSONAS_FILE}: persona "${id}"`;
		if (persona.context === "plant" && !persona.role) problems.push(`${at}: a plant persona needs a role`);
		if (persona.context !== "plant" && persona.role) problems.push(`${at}: only a plant persona has a role`);
		if (persona.context === "signed-out") {
			if (persona.seed) problems.push(`${at}: a signed-out persona has no seed`);
			continue;
		}
		if (!persona.seed) {
			problems.push(`${at}: needs a seed that signs it in`);
			continue;
		}
		if (!persona.cookie && !(persona.email && persona.password))
			problems.push(`${at}: needs a cookie pointer, or an email and a password pointer`);
		for (const pointer of [persona.cookie, persona.email, persona.password]) {
			const problem = pointer ? seedPointerProblem(seeds, persona.seed, pointer) : null;
			if (problem) problems.push(`${at}: ${problem}`);
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
				[...readFileSync(join(root, route.file), "utf8").matchAll(/@\/features\/([a-z][a-z-]*)/g)].map((m) => m[1]),
			);
			for (const other of imported)
				if (other !== feature)
					problems.push(
						`${route.file}: is mapped in ${feature} but imports @/features/${other}; move it to that feature's map`,
					);
		}
	}
	for (const url of pending)
		if (!byUrl.has(url)) problems.push(`${PENDING_FILE}: ${url} is no route any more; remove it from the pending list`);
	if (options.basePending) {
		const before = new Set(options.basePending);
		for (const url of pending)
			if (!before.has(url))
				problems.push(
					`${PENDING_FILE}: ${url} was added to the pending list; the list only shrinks, so map the route instead`,
				);
	}

	const corpus = textCorpus(root);
	const ops = operationCorpus(root);
	const catalog = readJson(root, "docs/catalog/index.json") as Record<string, Json>;
	const operationIds = new Set(
		((readJson(root, catalog.operation_source as string) as { operations: { id: string }[] }).operations ?? []).map(
			(o) => o.id,
		),
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

	const navModule = (await import(pathToFileURL(join(root, NAV_MODULE)).href)) as { shellNav: ShellNav };
	const railOf = (persona: Persona) => {
		const nav = navModule.shellNav(viewerOf(persona));
		return [...nav.main, ...nav.pages].map((i) => ({ label: i.label, href: i.href.replace(/#.*$/, "") }));
	};

	for (const { file, map } of maps) {
		const at = (where: string) => `${file}: ${where}`;
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
		const checkSeedValue = (where: string, value: string) => {
			const m = SEED_VALUE.exec(value);
			if (!value.startsWith("$")) return false;
			if (!m) problems.push(at(`${where}: "${value}" is not a seed value ($<seed>:/<pointer>)`));
			else {
				const problem = seedPointerProblem(seeds, m[1]!, m[2]!);
				if (problem) problems.push(at(`${where}: ${problem}`));
			}
			return true;
		};
		const checkTexts = (where: string, values: string[]) => {
			for (const value of values)
				if (!checkSeedValue(where, value) && !corpus.includes(value.replace(/\s+/g, " ")))
					problems.push(
						at(`${where}: "${value}" occurs nowhere in apps/web/src, packages/ui/src or packages/contracts/src`),
					);
		};
		const checkFills = (where: string, path: string, fill: Fill | undefined) => {
			problems.push(...placeholderProblems(path, fill).map((p) => at(`${where}: ${p}`)));
			for (const value of Object.values(fill ?? {})) checkSeedValue(where, value);
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
					checkTexts(where, literals([], reach.path));
					for (const f of fills(reach.path)) checkFills(where, f.path, f.fill);
				} else {
					checkFills(where, reach.link, reach.fill);
					if (reach.email && !ops.includes(reach.email) && !corpus.includes(reach.email))
						problems.push(at(`${where}: email "${reach.email}" is no string in the source`));
				}
			}
			for (const state of surface.states) {
				const where = `${s} state ${state.id}`;
				if (state.file && !existsSync(join(root, state.file)))
					problems.push(at(`${where}: ${state.file} does not exist`));
				if ("persona" in state.reach) {
					checkPersona(where, state.reach.persona, surface);
					checkFills(where, state.reach.open, state.reach.fill);
				}
				checkTexts(where, literals(state.expect, []));
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
				for (const op of behavior.operations) {
					if (!operationIds.has(op))
						problems.push(at(`${where}: operation ${op} is not in docs/catalog/operations.json`));
					else if (![`"${op}"`, `'${op}'`, `\`${op}\``].some((q) => ops.includes(q)))
						problems.push(at(`${where}: operation ${op} appears in no packages/*/src or apps/web/src/server source`));
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
					if (!surface.states.some((x) => x.id === browser.state))
						problems.push(at(`${where}: browser proof starts in unknown state "${browser.state}"`));
					checkTexts(where, literals(browser.expect, browser.steps));
					for (const f of fills(browser.steps)) checkFills(where, f.path, f.fill);
				}
			}
		}
	}

	for (const [id, persona] of Object.entries(personas)) {
		if (persona.context === "signed-out") continue;
		for (const item of railOf(persona)) {
			const owned = [...owner.values()].find((o) => o.kind === "page" && opens(o.surface, item.href));
			if (!owned || (owned.surface.personas[id] ?? "none") === "none") continue;
			const declared = owned.surface.reach.some((r) => "rail" in r && r.rail === item.label && r.personas.includes(id));
			if (!declared)
				problems.push(
					`${owned.map.file}: ${owned.surface.id} has no rail reach "${item.label}" for "${id}", but the rail offers it (${NAV_MODULE})`,
				);
		}
	}

	const docs = renderDocs(maps, pending.length, routes.length);
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
	const summary =
		`feature-maps: ${maps.length} maps, ${surfaces.length} surfaces, ${behaviors.length} behaviors ` +
		`(${behaviors.filter((b) => b.proof.browser).length} with browser steps); ` +
		`${owner.size} of ${routes.length} routes mapped, ${pending.length} pending; ` +
		`${states.filter((x) => !("manual" in x.reach)).length} of ${states.length} states reachable by script`;
	return { problems: [...new Set(problems)], summary };
}

const q = (value: string) => JSON.stringify(value);
const shown = (value: string) => {
	const m = SEED_VALUE.exec(value);
	return m ? `<${m[1]}:${m[2]}>` : value;
};
const exact = (t: { match?: Match }) => ((t.match ?? "exact") === "exact" ? " --exact" : "");

function command(step: Step | Observable): string {
	if ("open" in step) return `agent-browser open ${q("$ORIGIN" + step.open)}`;
	if ("click" in step) {
		const t = step.click;
		return "role" in t
			? `agent-browser find role ${t.role} click --name ${q(shown(t.name))}${exact(t)}`
			: `agent-browser find text ${q(shown(t.text))} click${exact(t)}`;
	}
	if ("into" in step) return `agent-browser find label ${q(step.into)} fill ${q(shown(step.type))}`;
	if ("press" in step) return `agent-browser press ${step.press}`;
	if ("noText" in step) return `agent-browser wait --fn ${q(`!document.body.innerText.includes(${q(step.noText)})`)}`;
	if ("url" in step) return `agent-browser wait --url ${q("**" + step.url.replace(/\{[A-Za-z]+\}/g, "*"))}`;
	if ("role" in step) return `agent-browser find role ${step.role} text --name ${q(shown(step.name))}${exact(step)}`;
	return (step.match ?? "exact") === "exact"
		? `agent-browser find text ${q(shown(step.text))} text --exact`
		: `agent-browser wait --text ${q(shown(step.text))}`;
}

const fillLine = (fill: Fill | undefined) =>
	fill
		? ` with ${Object.entries(fill)
				.map(([k, v]) => `\`{${k}}\` = \`${shown(v)}\``)
				.join(", ")}`
		: "";
const describeTarget = (t: Target) => ("role" in t ? `${t.role} "${shown(t.name)}"` : `text "${shown(t.text)}"`);
const describeObservable = (o: Observable) =>
	"noText" in o ? `no text "${o.noText}"` : "url" in o ? `URL \`${o.url}\`` : describeTarget(o);
const describeStep = (s: Step) =>
	"open" in s
		? `open \`${s.open}\``
		: "click" in s
			? `click ${describeTarget(s.click)}`
			: "into" in s
				? `type "${shown(s.type)}" into "${s.into}"`
				: `press ${s.press}`;

function describeReach(reach: Reach): string {
	if ("rail" in reach) return `rail "${reach.rail}" (${reach.personas.join(", ")})`;
	if ("from" in reach) return `from ${reach.from} as ${reach.persona}: ${reach.path.map(describeStep).join(", ")}`;
	return `${reach.email ? `email ${reach.email} link` : "link"} \`${reach.link}\`${fillLine(reach.fill)}`;
}

export function showSurface(surface: Surface): string {
	const lines = [`### ${surface.id}`, "", surface.says, ""];
	lines.push(`- Routes: ${surface.routes.map((r) => `\`${r}\``).join(", ") || "none"}`);
	if (surface.endpoints) lines.push(`- Endpoints: ${surface.endpoints.map((r) => `\`${r}\``).join(", ")}`);
	lines.push(
		`- Personas: ${Object.entries(surface.personas)
			.map(([p, a]) => `${p} ${a}`)
			.join(", ")}`,
	);
	if (surface.catalog?.length) lines.push(`- Catalog: ${surface.catalog.join(", ")}`);
	lines.push(
		"- Reach:",
		...surface.reach.map((r) => `  - ${describeReach(r)}`),
		"",
		"| State | Reach | Expect |",
		"|---|---|---|",
	);
	for (const state of surface.states) {
		const reach =
			"manual" in state.reach
				? `manual: ${state.reach.manual}`
				: `${state.reach.persona} opens \`${state.reach.open}\`${fillLine(state.reach.fill)}`;
		const file = state.file ? ` (\`${state.file.slice(state.file.lastIndexOf("/") + 1)}\`)` : "";
		lines.push(`| ${state.id}${file} | ${reach} | ${state.expect.map(describeObservable).join("; ")} |`);
	}
	for (const behavior of surface.behaviors) {
		lines.push("", `#### ${surface.id}#${behavior.id}`, "", behavior.says, "");
		if (behavior.operations.length) lines.push(`- Operations: ${behavior.operations.join(", ")}`);
		if (behavior.proof.cases?.length) lines.push(`- Cases: ${behavior.proof.cases.join(", ")}`);
		for (const test of behavior.proof.tests) lines.push(`- Test: \`${test.file}\`: \`${test.name}\``);
		const browser = behavior.proof.browser;
		if (browser) {
			const state = surface.states.find((x) => x.id === browser.state);
			const start =
				state && "persona" in state.reach
					? `As ${state.reach.persona}, from state ${browser.state} (\`${state.reach.open}\`${fillLine(state.reach.fill)}):`
					: `From state ${browser.state}:`;
			lines.push(
				`- Browser: ${start}`,
				"",
				"```bash",
				...browser.steps.map((s) => command(s)),
				...(browser.steps.length ? ["agent-browser wait --load networkidle"] : []),
				...browser.expect.map((s) => command(s)),
				"```",
			);
		}
	}
	return lines.join("\n") + "\n";
}

const nodeLabel = (text: string) => text.replace(/"/g, "#quot;");

function featureDoc(map: FeatureMap, file: string): string {
	const ids = new Map(map.surfaces.map((s, i) => [s.id, `s${i}`] as const));
	const graph = ["flowchart LR"];
	const entries = new Set<string>();
	for (const surface of map.surfaces) {
		const node = ids.get(surface.id)!;
		graph.push(`  ${node}["${nodeLabel(`${surface.id}<br/>${surface.routes.join(" ") || "no page"}`)}"]`);
		for (const [i, reach] of surface.reach.entries()) {
			if ("rail" in reach) {
				entries.add(`  rail(["rail"])`);
				graph.push(`  rail -- "${nodeLabel(reach.rail)}" --> ${node}`);
			} else if ("from" in reach) {
				const from = ids.get(reach.from);
				const last = reach.path.at(-1)!;
				const label = nodeLabel("click" in last ? describeTarget(last.click) : describeStep(last));
				if (from) graph.push(`  ${from} -- "${label}" --> ${node}`);
				else {
					entries.add(`  x_${reach.from.replace(/\W/g, "_")}(["${reach.from}"])`);
					graph.push(`  x_${reach.from.replace(/\W/g, "_")} -- "${label}" --> ${node}`);
				}
			} else {
				const entry = `${node}_link${i}`;
				entries.add(`  ${entry}(["${nodeLabel(reach.email ? `email ${reach.email}` : `link ${reach.link}`)}"])`);
				graph.push(`  ${entry} --> ${node}`);
			}
		}
		for (const [i, behavior] of surface.behaviors.entries()) {
			const proof = [
				behavior.proof.tests.length ? "tests" : "",
				behavior.proof.cases?.length ? "cases" : "",
				behavior.proof.browser ? "browser" : "",
			]
				.filter(Boolean)
				.join(" + ");
			graph.push(`  ${node} --- ${node}_b${i}["${nodeLabel(`${behavior.id}<br/>${proof}`)}"]`);
		}
	}
	const lines = [
		`# Feature map: ${map.feature}`,
		"",
		`Generated from [\`${file}\`](../../${file}) by \`node tools/ci/feature-maps.ts --write\`. Do not edit by hand.`,
		"",
		"```mermaid",
		...graph.slice(0, 1),
		...[...entries].sort(),
		...graph.slice(1),
		"```",
		"",
		"## Surfaces",
		"",
		...map.surfaces.map((s) => showSurface(s)),
	];
	return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function overviewDoc(maps: LoadedMap[], pending: number, routes: number): string {
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
			const rails = [...new Set(surface.reach.flatMap((r) => ("rail" in r ? [r.rail] : [])))];
			for (const label of rails) graph.push(`  rail -- "${nodeLabel(label)}" --> ${node}`);
			for (const from of new Set(surface.reach.flatMap((r) => ("from" in r ? [r.from] : []))))
				if (ids.has(from)) graph.push(`  ${ids.get(from)} --> ${node}`);
			if (surface.reach.some((r) => "link" in r)) graph.push(`  links -.-> ${node}`);
		}
	const mapped = maps.reduce(
		(n, { map }) => n + map.surfaces.reduce((k, s) => k + s.routes.length + (s.endpoints?.length ?? 0), 0),
		0,
	);
	const rows = maps.map(({ file, map }) => {
		const behaviors = map.surfaces.flatMap((s) => s.behaviors);
		const routeCount = map.surfaces.reduce((k, s) => k + s.routes.length + (s.endpoints?.length ?? 0), 0);
		return `| [${map.feature}](${map.feature}.md) | [\`${file}\`](../../${file}) | ${map.surfaces.length} | ${routeCount} | ${behaviors.length} | ${behaviors.filter((b) => b.proof.browser).length} |`;
	});
	return [
		"# Feature maps",
		"",
		"Generated by `node tools/ci/feature-maps.ts --write` from every `feature-map.json`. Do not edit by hand.",
		"",
		"Each feature directory under `apps/web/src/features/` describes its surfaces: the routes it owns, how each persona",
		"reaches them, the states a verifier can open and the tests, cases and browser steps that prove each behavior.",
		"Personas are in [`tests/ui/personas.json`](../../tests/ui/personas.json). Print one surface with",
		"`node tools/ci/feature-maps.ts show <surface-id>`.",
		"",
		`Routes mapped: ${mapped} of ${routes}. Not yet mapped: ${pending}, listed in [\`${PENDING_FILE}\`](../../${PENDING_FILE}).`,
		"",
		"```mermaid",
		...graph,
		"```",
		"",
		"| Feature | Map | Surfaces | Routes | Behaviors | Browser steps |",
		"|---|---|---|---|---|---|",
		...rows,
		"",
	].join("\n");
}

export function renderDocs(maps: LoadedMap[], pending: number, routes: number): Map<string, string> {
	const docs = new Map<string, string>([[`${DOCS_DIR}/README.md`, overviewDoc(maps, pending, routes)]]);
	for (const { file, map } of maps) docs.set(`${DOCS_DIR}/${map.feature}.md`, featureDoc(map, file));
	return docs;
}

export function writeDocs(root: string): string[] {
	const { maps, problems } = loadMaps(root);
	if (problems.length) return problems;
	const pending = ((readJson(root, PENDING_FILE) as { routes?: string[] }).routes ?? []).length;
	const docs = renderDocs(maps, pending, appRoutes(root).length);
	for (const path of walk(root, DOCS_DIR, (f) => f.endsWith(".md"))) if (!docs.has(path)) rmSync(join(root, path));
	mkdirSync(join(root, DOCS_DIR), { recursive: true });
	for (const [path, content] of docs) writeFileSync(join(root, path), content);
	return [];
}

export function basePendingFromGit(root: string): string[] | null {
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	try {
		const base = git("merge-base", "HEAD", "origin/main");
		return (JSON.parse(git("show", `${base}:${PENDING_FILE}`)) as { routes: string[] }).routes;
	} catch {
		return null;
	}
}

if (import.meta.main) {
	const root = process.cwd();
	const [command, arg] = process.argv.slice(2);
	if (command === "--write") {
		const problems = writeDocs(root);
		for (const p of problems) console.error(p);
		if (problems.length) process.exit(1);
		console.log(`feature-maps: wrote ${relative(root, join(root, DOCS_DIR))}/`);
	} else if (command === "show") {
		const { maps } = loadMaps(root);
		const found = maps.flatMap(({ map }) => map.surfaces.map((s) => ({ map, s }))).find(({ s }) => s.id === arg);
		if (!found) {
			console.error(
				`feature-maps: no surface "${arg ?? ""}". Surfaces: ${maps.flatMap(({ map }) => map.surfaces.map((s) => s.id)).join(", ")}`,
			);
			process.exit(2);
		}
		process.stdout.write(showSurface(found.s));
	} else if (command === undefined || command === "--check") {
		const basePending = basePendingFromGit(root);
		const { problems, summary } = await checkFeatureMaps(root, { basePending });
		for (const p of problems) console.error(p);
		if (basePending === null)
			console.log("feature-maps: no origin/main pending list to compare, so growth is not checked");
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
