import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { basePendingFromGit, checkFeatureMaps, writeDocs, type BasePending } from "../feature-maps.ts";

const SCHEMA = fileURLToPath(new URL("../../../apps/web/feature-map.schema.json", import.meta.url));
const TEST_NAME = "AC:CASE-THING-1 an Owner opens a thing";
const MAP = "apps/web/src/features/things/feature-map.json";

const thingsMap = () => ({
	feature: "things",
	catalog: ["THG-001"],
	surfaces: [
		{
			id: "things.list",
			says: "Every thing of the church.",
			routes: ["/things"],
			reach: [{ rail: "Things", personas: ["owner", "admin"] } as Record<string, unknown>],
			personas: { owner: "write", admin: "read", visitor: "none" } as Record<string, string>,
			states: [
				{
					id: "populated",
					reach: { persona: "owner", open: "/things", seed: "qa" } as Record<string, unknown>,
					expect: [{ role: "heading", name: "All things" }] as Record<string, unknown>[],
				},
				{
					id: "loading",
					file: "apps/web/src/app/(product)/things/loading.tsx",
					reach: { manual: "only while the server renders" } as Record<string, unknown>,
					expect: [{ text: "Loading things" }],
				},
			],
			behaviors: [
				{
					id: "open",
					says: "An Owner opens a thing from the list.",
					catalog: ["THG-001"],
					operations: ["things.open"] as string[],
					noOperation: undefined as string | undefined,
					proof: {
						tests: [{ file: "tests/integration/things.test.mts", name: TEST_NAME }],
						cases: ["CASE-THING-1"],
						browser: {
							kind: "behavior",
							state: "populated",
							steps: [{ click: { role: "button", name: "Open thing" } }] as Record<string, unknown>[],
							expect: [{ text: "The Gym", match: "contains" }] as Record<string, unknown>[],
						},
					},
				},
			],
		},
	],
});
type ThingsMap = ReturnType<typeof thingsMap>;

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "feature-maps-"));
	const put = (file: string, content: string | object) => {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), typeof content === "string" ? content : JSON.stringify(content, null, "\t"));
	};
	put("apps/web/feature-map.schema.json", "");
	copyFileSync(SCHEMA, join(root, "apps/web/feature-map.schema.json"));
	put("apps/web/feature-maps.pending.json", { routes: ["/later"] });
	put(
		"apps/web/src/app/(product)/things/page.tsx",
		'export { ThingsPage as default } from "@/features/things/routes";\n',
	);
	put(
		"apps/web/src/app/(product)/things/loading.tsx",
		'export { ThingsLoading as default } from "@/features/things/routes";\n',
	);
	put("apps/web/src/app/(product)/later/page.tsx", "export default function Later() {}\n");
	put(
		"apps/web/src/features/things/routes.tsx",
		"export const ThingsPage = () => (\n\t<>\n\t\t<h1>All things</h1>\n\t\t<button>Open thing</button>\n\t\t<p>Loading things</p>\n\t</>\n);\n// Close the thing\n",
	);
	put(MAP, thingsMap());
	put(
		"apps/web/src/features/shell/nav.ts",
		'export const shellNav = (viewer: { context: string }) => ({ main: viewer.context === "plant" ? [{ label: "Things", href: "/things" }] : [{ label: "Wiki", href: "/wiki" }], pages: [] });\n',
	);
	put(
		"packages/core/src/things.ts",
		'export const OPS = ["things.open"];\nexport const delivery = { thing_link: `${origin}/things/${id}` };\n',
	);
	put("docs/catalog/index.json", {
		feature_source: "docs/catalog/features.json",
		operation_source: "docs/catalog/operations.json",
		requirement_files: ["docs/catalog/requirements/things.json"],
		case_files: ["docs/acceptance/things.json"],
	});
	put("docs/catalog/features.json", [{ id: "THG-001" }, { id: "OTH-001" }]);
	put("docs/catalog/operations.json", {
		operations: [
			{ id: "things.open", feature_ids: ["THG-001"] },
			{ id: "things.close", feature_ids: ["THG-001"] },
			{ id: "other.make", feature_ids: ["OTH-001"] },
		],
	});
	put("packages/core/src/other.ts", 'export const MORE = ["other.make"];\n');
	put("docs/catalog/requirements/things.json", { requirements: [{ id: "REQ-THG-001", text: "Things open." }] });
	put("docs/acceptance/things.json", { cases: [{ id: "CASE-THING-1" }, { id: "CASE-THING-2" }] });
	put(
		"tools/qa/qa-guard.ts",
		'export const QA_LOGINS = {\n\towner: "delivered+qa-owner@resend.dev",\n\tadmin: "delivered+qa-admin@resend.dev",\n} as const;\n',
	);
	put(
		"tools/qa/qa-seed.ts",
		[
			'const PLACES = ["The Gym"];',
			'const owner = await account("Olive Owner", QA_LOGINS.owner);',
			'const helper = await account("Ada Admin", QA_LOGINS.admin);',
			'const plantId = await church(CHURCH, "Austin", owner, QA_LOGINS.owner, "");',
			'for (const [accountId, role, name] of [[helper, "admin", "Ada Admin"]]) {}',
			"",
		].join("\n"),
	);
	put("tools/qa/personas.json", {
		owner: { says: "Olive Owner, the Owner", context: "plant", role: "owner", seed: "qa" },
		admin: { says: "Ada Admin, an Admin", context: "plant", role: "admin", seed: "qa" },
		visitor: { says: "Nobody", context: "signed-out" },
	});
	put("tests/integration/things.test.mts", `test(${JSON.stringify(TEST_NAME)}, () => {});\n`);
	assert.deepEqual(writeDocs(root), []);
	return root;
}

const NO_BASE: BasePending = { skip: "fixture" };
async function problems(root: string, base: BasePending = { routes: ["/later"] }, ci = true) {
	try {
		return (await checkFeatureMaps(root, { base, ci })).problems;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function editMap(root: string, change: (map: ThingsMap) => void, valid = true) {
	const map = JSON.parse(readFileSync(join(root, MAP), "utf8")) as ThingsMap;
	change(map);
	writeFileSync(join(root, MAP), JSON.stringify(map));
	if (valid) assert.deepEqual(writeDocs(root), []);
}
const surface = (map: ThingsMap) => map.surfaces[0]!;
const behavior = (map: ThingsMap) => surface(map).behaviors[0]!;
const at = (message: string) => `${MAP}: ${message}`;

test("INV-feature-maps: a fixture whose maps, routes, tests, cases, names, rail and diagrams agree has no problem", async () => {
	assert.deepEqual(await problems(fixture()), []);
});

test("INV-feature-maps: a route owned by no map and not pending fails, naming the route file", async () => {
	const root = fixture();
	mkdirSync(join(root, "apps/web/src/app/(product)/fresh"), { recursive: true });
	writeFileSync(join(root, "apps/web/src/app/(product)/fresh/page.tsx"), "export default function Fresh() {}\n");
	assert.deepEqual(await problems(root), [
		"apps/web/src/app/(product)/fresh/page.tsx: /fresh is owned by no feature map; add it to a surface in its feature's feature-map.json",
		"docs/feature-maps/README.md: is stale; run node tools/ci/feature-maps.ts --write",
	]);
});

test("INV-feature-maps: a pending route that a map now owns, and a route added to the pending list, both fail", async () => {
	const root = fixture();
	writeFileSync(join(root, "apps/web/feature-maps.pending.json"), JSON.stringify({ routes: ["/later", "/things"] }));
	assert.deepEqual(writeDocs(root), []);
	assert.deepEqual(await problems(root), [
		"apps/web/feature-maps.pending.json: /things is mapped by things.list; remove it from the pending list",
		"apps/web/feature-maps.pending.json: /things was added to the pending list; the list only shrinks, so map the route instead",
	]);
});

test("INV-feature-maps: under CI a pending list that cannot be read at the merge base fails; off CI it is only skipped", async () => {
	const error: BasePending = { error: "git merge-base HEAD origin/main failed (is origin/main fetched?)" };
	assert.deepEqual(await problems(fixture(), error, true), [
		"apps/web/feature-maps.pending.json: cannot read the pending list at the merge base with origin/main: git merge-base HEAD origin/main failed (is origin/main fetched?)",
	]);
	assert.deepEqual(await problems(fixture(), error, false), []);
});

test("INV-feature-maps: the merge base's pending list comes from git, is empty once the base has maps, and is skipped before maps exist", () => {
	const repo = mkdtempSync(join(tmpdir(), "feature-maps-git-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
	const commit = (file: string, content: string) => {
		mkdirSync(dirname(join(repo, file)), { recursive: true });
		writeFileSync(join(repo, file), content);
		git("add", "-A");
		git("-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-qm", file);
	};
	try {
		git("init", "-q", "-b", "main");
		assert.deepEqual(basePendingFromGit(repo), {
			error: "git merge-base HEAD origin/main failed (is origin/main fetched?)",
		});
		commit("README.md", "x\n");
		git("update-ref", "refs/remotes/origin/main", "HEAD");
		assert.deepEqual(basePendingFromGit(repo), { skip: "the merge base with origin/main has no feature maps yet" });
		commit("apps/web/src/features/things/feature-map.json", "{}\n");
		git("update-ref", "refs/remotes/origin/main", "HEAD");
		assert.deepEqual(basePendingFromGit(repo), { routes: [] });
		commit("apps/web/feature-maps.pending.json", JSON.stringify({ routes: ["/later"] }));
		git("update-ref", "refs/remotes/origin/main", "HEAD");
		git("switch", "-qc", "stacked");
		commit("apps/web/feature-maps.pending.json", JSON.stringify({ routes: ["/later", "/more"] }));
		assert.deepEqual(basePendingFromGit(repo), { routes: ["/later"] });
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("INV-feature-maps: a test name that does not exist in the named file fails", async () => {
	const root = fixture();
	editMap(root, (map) => {
		behavior(map).proof.tests[0]!.name = "AC:CASE-THING-1 an Owner opens a thing quickly";
	});
	assert.deepEqual(await problems(root), [
		at(
			'things.list#open: tests/integration/things.test.mts has no test named "AC:CASE-THING-1 an Owner opens a thing quickly"',
		),
	]);
});

test("INV-feature-maps: a case that exists but no listed test name carries as AC: fails", async () => {
	const root = fixture();
	editMap(root, (map) => {
		behavior(map).proof.cases = ["CASE-THING-2"];
	});
	assert.deepEqual(await problems(root), [at("things.list#open: no listed test name carries AC:CASE-THING-2")]);
});

test("INV-feature-maps: an operation missing from the catalog, never named in code, or serving another feature fails", async () => {
	const root = fixture();
	editMap(root, (map) => {
		behavior(map).operations = ["things.share", "things.close", "other.make"];
	});
	assert.deepEqual(await problems(root), [
		at("things.list#open: operation things.share is not in docs/catalog/operations.json"),
		at(
			"things.list#open: operation things.close is neither quoted nor declared in packages/*/src or apps/web/src/server",
		),
		at("things.list#open: operation other.make serves OTH-001, none of the behavior's catalog THG-001"),
	]);
});

test("INV-feature-maps: an operation id with more than one dot, as the catalog writes some, is checked like any other", async () => {
	const root = fixture();
	const operations = JSON.parse(readFileSync(join(root, "docs/catalog/operations.json"), "utf8"));
	operations.operations.push({ id: "things.pins.exportPin", feature_ids: ["THG-001"] });
	writeFileSync(join(root, "docs/catalog/operations.json"), JSON.stringify(operations));
	writeFileSync(join(root, "packages/core/src/pins.ts"), "export function exportPin(id: string) {\n\treturn id;\n}\n");
	editMap(root, (map) => {
		behavior(map).operations = ["things.open", "things.pins.exportPin", "things.pins.set"];
	});
	assert.deepEqual(await problems(root), [
		at("things.list#open: operation things.pins.set is not in docs/catalog/operations.json"),
	]);
});

test("INV-feature-maps: a known defect is printed as one and must be scripted", async () => {
	const root = fixture();
	editMap(root, (map) => {
		Object.assign(surface(map).states[0]!, { defect: "a church-less account is sent to sign-in" });
		Object.assign(surface(map).states[1]!, { defect: "it never ends" });
	});
	const doc = readFileSync(join(root, "docs/feature-maps/things.md"), "utf8");
	assert.match(
		doc,
		/- \*\*populated\*\*: heading "All things"\. Known defect, so this state shows what is wrong: a church-less account is sent to sign-in\. As `owner`/,
	);
	assert.deepEqual(await problems(root), [
		at("things.list state loading: a known defect needs a script that shows it, so each run sees it until it is fixed"),
	]);
});

test("INV-feature-maps: a behavior with no operation must say why", async () => {
	const root = fixture();
	editMap(root, (map) => {
		behavior(map).operations = [];
	});
	assert.deepEqual(await problems(root), [
		at('things.list#open: lists no operation; name one or say why in "noOperation"'),
	]);
});

test("INV-feature-maps: a name must equal a whole string or JSX text in scope; part of one, or a comment, does not count", async () => {
	const root = fixture();
	editMap(root, (map) => {
		behavior(map).proof.browser.steps = [{ click: { role: "button", name: "Open" } }];
		surface(map).states[0]!.expect = [{ role: "heading", name: "Close the thing" }];
	});
	const scope = "apps/web/src/features/things (and what it imports), packages/ui/src, the shell or tools/qa/qa-seed.ts";
	assert.deepEqual(await problems(root), [
		at(`things.list state populated: no string literal or JSX text in ${scope} equals "Close the thing"`),
		at(`things.list#open: no string literal or JSX text in ${scope} equals "Open"`),
	]);
});

test("INV-feature-maps: seed data a step names must be in the QA seed, and a login must be a QA login", async () => {
	const root = fixture();
	editMap(root, (map) => {
		behavior(map).proof.browser.expect = [{ text: "The Pool", match: "contains" }];
		behavior(map).proof.browser.steps = [
			{ type: "$login:nobody", into: "Open thing" },
			{ click: { role: "button", name: "Open thing" } },
		];
	});
	const scope = "apps/web/src/features/things (and what it imports), packages/ui/src, the shell or tools/qa/qa-seed.ts";
	assert.deepEqual(await problems(root), [
		at("things.list#open: $login:nobody is no QA_LOGINS key in tools/qa/qa-guard.ts"),
		at(`things.list#open: no string literal or JSX text in ${scope} contains "The Pool"`),
	]);
});

test("INV-feature-maps: a state with neither seed data nor setup steps is refused", async () => {
	const root = fixture();
	editMap(
		root,
		(map) => {
			surface(map).states[0]!.reach = { persona: "owner", open: "/things" };
		},
		false,
	);
	assert.deepEqual(await problems(root), [
		at('/surfaces/0/states/0/reach: is missing "seed"'),
		"apps/web/src/app/(product)/things/page.tsx: /things is owned by no feature map; add it to a surface in its feature's feature-map.json",
		"docs/feature-maps/README.md: is stale; run node tools/ci/feature-maps.ts --write",
		"docs/feature-maps/things.md: belongs to no feature map; run node tools/ci/feature-maps.ts --write",
	]);
});

test("INV-feature-maps: a behavior proof must act before it observes", async () => {
	const root = fixture();
	editMap(root, (map) => {
		behavior(map).proof.browser.steps = [];
	});
	assert.deepEqual(await problems(root), [
		at("things.list#open: a behavior proof acts (click, type, press or upload) before it observes"),
	]);
});

test("INV-feature-maps: a committed diagram that differs from the maps fails as stale", async () => {
	const root = fixture();
	writeFileSync(join(root, "docs/feature-maps/things.md"), "# Feature map: things\n\nEdited by hand.\n");
	assert.deepEqual(await problems(root), [
		"docs/feature-maps/things.md: is stale; run node tools/ci/feature-maps.ts --write",
	]);
});

test("INV-feature-maps: a route in two surfaces, and a state file the surface does not declare, fail", async () => {
	const root = fixture();
	editMap(root, (map) => {
		const first = surface(map);
		first.states = first.states.filter((s) => s.id !== "loading");
		map.surfaces.push({ ...first, id: "things.again", reach: [{ link: "/things" }] });
	});
	assert.deepEqual(await problems(root), [
		at("/things is owned by things.list and things.again"),
		at("things.list declares no state for apps/web/src/app/(product)/things/loading.tsx, which renders on /things"),
		at("things.again declares no state for apps/web/src/app/(product)/things/loading.tsx, which renders on /things"),
	]);
});

test("INV-feature-maps: a rail reach the rail does not offer fails, also for a signed-out persona", async () => {
	const root = fixture();
	editMap(root, (map) => {
		surface(map).personas.visitor = "read";
		surface(map).reach = [{ rail: "Things", personas: ["owner", "admin", "visitor"] }];
	});
	assert.deepEqual(await problems(root), [
		at('things.list reach 1: the rail offers "visitor" no "Things" (apps/web/src/features/shell/nav.ts)'),
	]);
});

test("INV-feature-maps: a rail item a persona has fails when the surface gives that persona no access or no rail reach", async () => {
	const root = fixture();
	editMap(root, (map) => {
		surface(map).personas.owner = "none";
		surface(map).reach = [{ rail: "Things", personas: ["admin"] }];
		surface(map).states[0]!.reach = { persona: "visitor", open: "/things", seed: "qa" };
	});
	assert.deepEqual(await problems(root), [
		at(
			'the rail offers "owner" "Things" (apps/web/src/features/shell/nav.ts), but things.list gives "owner" no access',
		),
	]);
});

test("INV-feature-maps: an email reach must name a template key in code that builds the link's path", async () => {
	const root = fixture();
	editMap(root, (map) => {
		surface(map).reach.push({ link: "/things/{id}", email: "link", fill: { id: "the id" } });
		surface(map).reach.push({ link: "/things/{id}", email: "thing_link", fill: { id: "the id" } });
	});
	assert.deepEqual(await problems(root), [
		at('things.list reach 2: no file in packages/*/src or apps/web/src/server names email "link" and builds /things'),
	]);
});

test("INV-feature-maps: off CI with no base, growth is not compared", async () => {
	const root = fixture();
	writeFileSync(join(root, "apps/web/feature-maps.pending.json"), JSON.stringify({ routes: ["/later"] }));
	assert.deepEqual(await problems(root, NO_BASE), []);
});

test("INV-feature-maps: a persona whose context, role or name differs from the QA seed fails", async () => {
	const root = fixture();
	const file = join(root, "tools/qa/personas.json");
	const personas = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, unknown>>;
	personas.admin!.role = "member";
	personas.owner!.says = "Somebody Else, the Owner";
	writeFileSync(file, JSON.stringify(personas));
	assert.deepEqual(writeDocs(root), []);
	assert.deepEqual(await problems(root), [
		'tools/qa/personas.json: persona "owner": says "Somebody Else, the Owner", but the QA seed names QA_LOGINS.owner "Olive Owner"',
		'tools/qa/personas.json: persona "admin": is plant member here, but the QA seed makes QA_LOGINS.admin plant admin',
	]);
});

test("INV-feature-maps: a behavior proof whose only check after acting is the address fails", async () => {
	const root = fixture();
	editMap(root, (map) => {
		behavior(map).proof.browser.expect = [{ url: "/things?open=1" }];
	});
	assert.deepEqual(await problems(root), [
		at("things.list#open: a behavior proof checks something besides the address after it acts"),
	]);
});

test("INV-feature-maps: an absent observable names something that must not be on the page", async () => {
	const root = fixture();
	editMap(root, (map) => {
		behavior(map).proof.browser.expect = [{ absent: { role: "button", name: "Shut thing" } }];
	});
	const scope = "apps/web/src/features/things (and what it imports), packages/ui/src, the shell or tools/qa/qa-seed.ts";
	assert.deepEqual(await problems(root), [
		at(`things.list#open: no string literal or JSX text in ${scope} equals "Shut thing"`),
	]);
});
