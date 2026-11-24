import "../runs-in/render.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const web = createRequire(fileURLToPath(new URL("../../../apps/web/package.json", import.meta.url)));
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");
const { cn } = await import("../../../packages/ui/src/foundations/cn.ts");
const { Button } = await import("../../../packages/ui/src/controls/index.ts");

test("INV-cn: a call site's utility replaces the primitive's conflicting one, standard, named by the product or behind a variant", () => {
	assert.equal(cn("flex-none px-4", "flex-1"), "px-4 flex-1");
	assert.equal(cn("rounded-card shadow-card", "rounded-md shadow-none"), "rounded-md shadow-none");
	assert.equal(cn("text-title-md text-ink", "text-title-sm"), "text-ink text-title-sm");
	assert.equal(cn("p-5 max-app-sm:p-4", false, null, undefined, "max-app-sm:p-2"), "p-5 max-app-sm:p-2");
});

test("INV-cn: a class given to a Button wins over the Button's own", () => {
	const html: string = renderToStaticMarkup(createElement(Button, { className: "flex-1" }, "Save"));
	const classes = /class="([^"]*)"/.exec(html)?.[1]?.split(" ") ?? [];
	assert.ok(classes.includes("flex-1"));
	assert.ok(!classes.includes("flex-none"));
});
