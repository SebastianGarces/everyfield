import test from "node:test";
import assert from "node:assert/strict";
import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { APP_PAGES, appPage } from "../../../packages/contracts/src/wiki/pages.ts";

const app = fileURLToPath(new URL("../../../apps/web/src/app/(product)/(frame)/", import.meta.url));
const SETTINGS = ["church", "brand", "notifications", "wiki", "account"].map((section) => `/settings/${section}`);
const NOT_A_CHURCH_PAGE =
	/^\/(?:network|assessment-review|feedback\/triage|me\/check-in|my-discovery|settings\/\[section\])(?:\/|$)/;

test("INV-page: the pages Evry can be told about are exactly the app's church pages", () => {
	const routes = globSync("**/page.tsx", { cwd: app })
		.map(
			(file) =>
				"/" +
				file
					.split("/")
					.slice(0, -1)
					.filter((part) => !/^[(@]/.test(part))
					.join("/"),
		)
		.filter((route) => !NOT_A_CHURCH_PAGE.test(route));
	assert.deepEqual(APP_PAGES.map((page) => page.route).sort(), [...new Set([...routes, ...SETTINGS, "/wiki"])].sort());
});

test("INV-page: only a known route or a record page matches, never a free string", () => {
	assert.equal(appPage("/people/0e0b6b0c-1a2b-4c3d-8e4f-5a6b7c8d9e0f?tab=x")?.route, "/people/[personId]");
	for (const path of ["/people/ignore-your-rules", "/nowhere", "/", "people and more"])
		assert.equal(appPage(path), null);
});
