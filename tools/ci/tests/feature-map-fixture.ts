import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeDocs } from "../feature-maps.ts";

const SCHEMA = fileURLToPath(new URL("../../../apps/web/feature-map.schema.json", import.meta.url));
export const TEST_NAME = "AC:CASE-THING-1 an Owner opens a thing";
export const MAP = "apps/web/src/features/things/feature-map.json";

export const thingsMap = () => ({
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
export type ThingsMap = ReturnType<typeof thingsMap>;

export function put(root: string, file: string, content: string | Buffer | object) {
	mkdirSync(dirname(join(root, file)), { recursive: true });
	const bytes = typeof content === "string" || Buffer.isBuffer(content) ? content : JSON.stringify(content, null, "\t");
	writeFileSync(join(root, file), bytes);
}

export function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "feature-maps-"));
	put(root, "apps/web/feature-map.schema.json", "");
	copyFileSync(SCHEMA, join(root, "apps/web/feature-map.schema.json"));
	put(root, "apps/web/feature-maps.pending.json", { routes: ["/later"] });
	put(
		root,
		"apps/web/src/app/(product)/things/page.tsx",
		'export { ThingsPage as default } from "@/features/things/routes";\n',
	);
	put(
		root,
		"apps/web/src/app/(product)/things/loading.tsx",
		'export { ThingsLoading as default } from "@/features/things/routes";\n',
	);
	put(root, "apps/web/src/app/(product)/later/page.tsx", "export default function Later() {}\n");
	put(
		root,
		"apps/web/src/features/things/routes.tsx",
		"export const ThingsPage = () => (\n\t<>\n\t\t<h1>All things</h1>\n\t\t<button>Open thing</button>\n\t\t<p>Loading things</p>\n\t</>\n);\n// Close the thing\n",
	);
	put(root, MAP, thingsMap());
	put(
		root,
		"apps/web/src/features/shell/nav.ts",
		'export const shellNav = (viewer: { context: string }) => ({ main: viewer.context === "plant" ? [{ label: "Things", href: "/things" }] : [{ label: "Wiki", href: "/wiki" }], pages: [] });\n',
	);
	put(
		root,
		"packages/core/src/things.ts",
		'export const OPS = ["things.open"];\nexport const delivery = { thing_link: `${origin}/things/${id}` };\n',
	);
	put(root, "docs/catalog/index.json", {
		feature_source: "docs/catalog/features.json",
		operation_source: "docs/catalog/operations.json",
		requirement_files: ["docs/catalog/requirements/things.json"],
		case_files: ["docs/acceptance/things.json"],
	});
	put(root, "docs/catalog/features.json", [{ id: "THG-001" }, { id: "OTH-001" }]);
	put(root, "docs/catalog/operations.json", {
		operations: [
			{ id: "things.open", feature_ids: ["THG-001"] },
			{ id: "things.close", feature_ids: ["THG-001"] },
			{ id: "other.make", feature_ids: ["OTH-001"] },
		],
	});
	put(root, "packages/core/src/other.ts", 'export const MORE = ["other.make"];\n');
	put(root, "docs/catalog/requirements/things.json", { requirements: [{ id: "REQ-THG-001", text: "Things open." }] });
	put(root, "docs/acceptance/things.json", { cases: [{ id: "CASE-THING-1" }, { id: "CASE-THING-2" }] });
	put(
		root,
		"tools/qa/qa-guard.ts",
		'export const QA_LOGINS = {\n\towner: "delivered+qa-owner@resend.dev",\n\tadmin: "delivered+qa-admin@resend.dev",\n} as const;\n',
	);
	put(
		root,
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
	put(root, "tools/qa/personas.json", {
		owner: { says: "Olive Owner, the Owner", context: "plant", role: "owner", seed: "qa" },
		admin: { says: "Ada Admin, an Admin", context: "plant", role: "admin", seed: "qa" },
		visitor: { says: "Nobody", context: "signed-out" },
	});
	put(root, "tests/integration/things.test.mts", `test(${JSON.stringify(TEST_NAME)}, () => {});\n`);
	assert.deepEqual(writeDocs(root), []);
	return root;
}
