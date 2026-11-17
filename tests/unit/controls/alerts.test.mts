import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const web = createRequire(root + "apps/web/package.json");
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");
const { InlineAlert, PageState } = await import("../../../packages/ui/src/controls/index.ts");

const html = (props: Record<string, unknown>, children?: unknown) =>
	renderToStaticMarkup(createElement(InlineAlert, props, children));

test("INV-a11y: an inline alert keeps its live region in the page before the problem appears, so the problem is announced", () => {
	for (const [live, expected] of [
		[undefined, "assertive"],
		["polite", "polite"],
	] as const) {
		for (const empty of [null, undefined, false, ""]) {
			assert.equal(
				html({ live, id: "p" }, empty),
				`<div id="p" aria-live="${expected}" aria-atomic="true" class="empty:hidden"></div>`,
			);
		}
		const shown = html({ live }, "The meeting was not saved.");
		assert.match(shown, new RegExp(`^<div aria-live="${expected}" aria-atomic="true" class="empty:hidden"><div `));
		assert.match(shown, /The meeting was not saved\./);
		assert.doesNotMatch(shown, /role="alert"/);
	}
});

test("INV-a11y: an inline alert asked to take focus can be focused by script but stays out of the tab order", () => {
	assert.match(html({ focus: 1 }, "Choose a stage."), /tabindex="-1"/);
	assert.doesNotMatch(html({}, "Choose a stage."), /tabindex/);
});

test("INV-a11y: a route state names the page in its h1 and the state in its h2, and a failed load is an alert", () => {
	const failed = renderToStaticMarkup(
		createElement(PageState, { page: "Documents", tone: "error", title: "We could not load documents" }, "Try again."),
	);
	assert.match(failed, /<h1[^>]*>Documents<\/h1>/);
	assert.match(failed, /role="alert"[^>]*>.*<h2[^>]*>We could not load documents<\/h2>/);
	const locked = renderToStaticMarkup(
		createElement(PageState, { page: "Documents", tone: "lock", title: "Not available" }, "Sign in."),
	);
	assert.doesNotMatch(locked, /role="alert"/);
});
