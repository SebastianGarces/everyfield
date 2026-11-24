import "../runs-in/render-module-mocks.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock, test } from "node:test";
import { pathToFileURL } from "node:url";

const web = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");
let viewer = "";
mock.module(pathToFileURL(web.resolve("next/navigation")).href, {
	namedExports: {
		useSearchParams: () => new URLSearchParams({ as: viewer }),
		useRouter: () => ({ replace: () => {} }),
		usePathname: () => "/design/access/staff-notes",
	},
});
const { AccessPreview } = await import("../../../apps/web/src/features/access/preview/AccessPreview.tsx");
const main = (as: string): string => {
	viewer = as;
	const html: string = renderToStaticMarkup(createElement(AccessPreview, { flow: "staff-notes" }));
	return /<main[^>]*>(.*)<\/main>/s.exec(html)![1]!;
};

test("INV-privacy: a program director's person page holds no staff note and no staff notes panel; a viewer who may read them gets the panel", () => {
	assert.doesNotMatch(main("director"), /staff notes|staff only|data-note/i);
	assert.match(main("director"), /Program director/);
	for (const as of ["admin", "staff", "admin-and-director"]) assert.match(main(as), /Staff notes.*Staff only/s, as);
});
