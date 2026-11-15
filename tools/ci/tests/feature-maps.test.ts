import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkFeatureMaps, writeDocs } from "../feature-maps.ts";

const SCHEMA = fileURLToPath(new URL("../../../apps/web/feature-map.schema.json", import.meta.url));
const TEST_NAME = "AC:CASE-THING-1 an Owner opens a thing";

const thingsMap = () => ({
	feature: "things",
	catalog: ["THG-001"],
	surfaces: [
		{
			id: "things.list",
			says: "Every thing of the church.",
			routes: ["/things"],
			reach: [{ rail: "Things", personas: ["owner"] }],
			personas: { owner: "write" },
			states: [
				{
					id: "populated",
					reach: { persona: "owner", open: "/things" },
					expect: [{ role: "heading", name: "All things" }],
				},
				{
					id: "loading",
					file: "apps/web/src/app/(product)/things/loading.tsx",
					reach: { manual: "only while the server renders" },
					expect: [{ text: "Loading things" }],
				},
			],
			behaviors: [
				{
					id: "open",
					says: "An Owner opens a thing from the list.",
					catalog: ["THG-001"],
					operations: ["things.open"],
					proof: {
						tests: [{ file: "tests/integration/things.test.mts", name: TEST_NAME }],
						cases: ["CASE-THING-1"],
						browser: {
							state: "populated",
							steps: [{ click: { role: "button", name: "Open thing" } }],
							expect: [{ text: "$things:/owner/thing", match: "contains" }],
						},
					},
				},
			],
		},
	],
});

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
		"export const ThingsPage = () => <><h1>All things</h1><button>Open thing</button><p>Loading things</p></>;\n",
	);
	put("apps/web/src/features/things/feature-map.json", thingsMap());
	put(
		"apps/web/src/features/shell/nav.ts",
		'export const shellNav = (viewer: { context: string }) => ({ main: viewer.context === "plant" ? [{ label: "Things", href: "/things" }] : [], pages: [] });\n',
	);
	put("packages/core/src/things.ts", 'export const OPS = ["things.open"];\n');
	put("docs/catalog/index.json", {
		feature_source: "docs/catalog/features.json",
		operation_source: "docs/catalog/operations.json",
		requirement_files: ["docs/catalog/requirements/things.json"],
		case_files: ["docs/acceptance/things.json"],
	});
	put("docs/catalog/features.json", [{ id: "THG-001" }]);
	put("docs/catalog/operations.json", { operations: [{ id: "things.open" }, { id: "things.close" }] });
	put("docs/catalog/requirements/things.json", { requirements: [{ id: "REQ-THG-001", text: "Things open." }] });
	put("docs/acceptance/things.json", { cases: [{ id: "CASE-THING-1" }, { id: "CASE-THING-2" }] });
	put("tests/ui/seed-env.mts", 'export const SEEDS = ["things"] as const;\n');
	put("tests/ui/things/seed.mts", 'writeFixture("things", schema, { owner: { cookie, thing } });\n');
	put("tests/ui/personas.json", {
		owner: { says: "An Owner", context: "plant", role: "owner", seed: "things", cookie: "/owner/cookie" },
	});
	put("tests/integration/things.test.mts", `test(${JSON.stringify(TEST_NAME)}, () => {});\n`);
	assert.deepEqual(writeDocs(root), []);
	return root;
}

async function problems(root: string, basePending: string[] | null = ["/later"]) {
	try {
		return (await checkFeatureMaps(root, { basePending })).problems;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function editMap(root: string, change: (map: ReturnType<typeof thingsMap>) => void) {
	const file = join(root, "apps/web/src/features/things/feature-map.json");
	const map = JSON.parse(readFileSync(file, "utf8"));
	change(map);
	writeFileSync(file, JSON.stringify(map));
	assert.deepEqual(writeDocs(root), []);
}

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

test("INV-feature-maps: a test name that does not exist in the named file fails", async () => {
	const root = fixture();
	editMap(root, (map) => {
		map.surfaces[0]!.behaviors[0]!.proof.tests[0]!.name = "AC:CASE-THING-1 an Owner opens a thing quickly";
	});
	assert.deepEqual(await problems(root), [
		'apps/web/src/features/things/feature-map.json: things.list#open: tests/integration/things.test.mts has no test named "AC:CASE-THING-1 an Owner opens a thing quickly"',
	]);
});

test("INV-feature-maps: a case that exists but no listed test name carries as AC: fails", async () => {
	const root = fixture();
	editMap(root, (map) => {
		map.surfaces[0]!.behaviors[0]!.proof.cases = ["CASE-THING-2"];
	});
	assert.deepEqual(await problems(root), [
		"apps/web/src/features/things/feature-map.json: things.list#open: no listed test name carries AC:CASE-THING-2",
	]);
});

test("INV-feature-maps: an operation missing from the catalog, or in the catalog but never named in code, fails", async () => {
	const root = fixture();
	editMap(root, (map) => {
		map.surfaces[0]!.behaviors[0]!.operations = ["things.share", "things.close"];
	});
	assert.deepEqual(await problems(root), [
		"apps/web/src/features/things/feature-map.json: things.list#open: operation things.share is not in docs/catalog/operations.json",
		"apps/web/src/features/things/feature-map.json: things.list#open: operation things.close appears in no packages/*/src or apps/web/src/server source",
	]);
});

test("INV-feature-maps: an accessible name that occurs nowhere in the UI source fails", async () => {
	const root = fixture();
	editMap(root, (map) => {
		map.surfaces[0]!.behaviors[0]!.proof.browser!.steps = [{ click: { role: "button", name: "Open the thing" } }];
	});
	assert.deepEqual(await problems(root), [
		'apps/web/src/features/things/feature-map.json: things.list#open: "Open the thing" occurs nowhere in apps/web/src, packages/ui/src or packages/contracts/src',
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
		const surface = map.surfaces[0]!;
		surface.states = surface.states.filter((s) => s.id !== "loading");
		map.surfaces.push({ ...surface, id: "things.again", reach: [{ link: "/things" }] } as never);
	});
	assert.deepEqual(await problems(root), [
		"apps/web/src/features/things/feature-map.json: /things is owned by things.list and things.again",
		"apps/web/src/features/things/feature-map.json: things.list declares no state for apps/web/src/app/(product)/things/loading.tsx, which renders on /things",
		"apps/web/src/features/things/feature-map.json: things.again declares no state for apps/web/src/app/(product)/things/loading.tsx, which renders on /things",
	]);
});

test("INV-feature-maps: a rail reach the rail does not offer fails, and so does a rail item a persona has but the map omits", async () => {
	const root = fixture();
	editMap(root, (map) => {
		map.surfaces[0]!.reach = [{ rail: "Stuff", personas: ["owner"] }];
	});
	assert.deepEqual(await problems(root), [
		'apps/web/src/features/things/feature-map.json: things.list reach 1: the rail offers "owner" no "Stuff" (apps/web/src/features/shell/nav.ts)',
		'apps/web/src/features/things/feature-map.json: things.list has no rail reach "Things" for "owner", but the rail offers it (apps/web/src/features/shell/nav.ts)',
	]);
});

test("INV-feature-maps: a seed value whose fixture key the seed never writes fails", async () => {
	const root = fixture();
	editMap(root, (map) => {
		map.surfaces[0]!.behaviors[0]!.proof.browser!.expect = [{ text: "$things:/admin/thing", match: "contains" }];
	});
	assert.deepEqual(await problems(root), [
		'apps/web/src/features/things/feature-map.json: things.list#open: fixture key "admin" does not occur in the things seed\'s source',
	]);
});
