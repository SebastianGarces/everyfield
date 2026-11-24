import "../runs-in/render-module-mocks.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock, test } from "node:test";

const at = (path: string) => new URL(`../../../apps/web/src/${path}`, import.meta.url).href;
const web = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");

const PAIRS = { items: [{ person: { id: "p1", displayName: "Casey Lee" } }], completeness: "complete" };
let seat: object | null = null;
let reply: object = {};
let reads = 0;
mock.module(at("server/request-context.ts"), { namedExports: { organizationSeatOf: () => seat } });
mock.module(at("server/sign-in.ts"), { namedExports: { requireActor: async () => ({}) } });
mock.module(at("features/organizations/pipeline-mount.ts"), {
	namedExports: {
		pipelinePeopleRead: async () => {
			reads += 1;
			return reply;
		},
	},
});
mock.module(new URL("../../../packages/domain/src/people/index.ts", import.meta.url).href, {
	namedExports: { listOrganizationDuplicatePairs: () => assert.fail("the mount runs the read") },
});
mock.module(at("features/organizations/data/DuplicatesScreen.tsx"), {
	namedExports: {
		DuplicatesScreen: ({ pairs }: { pairs?: unknown }) =>
			createElement("div", { "data-duplicates": "" }, JSON.stringify(pairs)),
	},
});
const { DuplicatesPage } = await import("../../../apps/web/src/features/organizations/data/routes.tsx");
const render = async (): Promise<string> => renderToStaticMarkup(await DuplicatesPage());

test("INV-tenancy: the pipeline duplicates page shows the pairs only on an allowed read; a refused or lost read, or no organization seat, shows only the not-available page", async () => {
	seat = { seatId: "s" };
	reply = { status: "ok", value: PAIRS };
	assert.match(await render(), /data-duplicates.*Casey Lee/);

	for (const refused of [{ status: "refused", error: { code: "unavailable" }, value: PAIRS }, { status: "lost" }]) {
		reply = refused;
		const html = await render();
		assert.doesNotMatch(html, /data-duplicates|Casey/, JSON.stringify(refused));
		assert.match(html, /not available/i);
	}

	seat = null;
	reply = { status: "ok", value: PAIRS };
	reads = 0;
	const html = await render();
	assert.doesNotMatch(html, /data-duplicates|Casey/);
	assert.match(html, /not available/i);
	assert.equal(reads, 0);
});
