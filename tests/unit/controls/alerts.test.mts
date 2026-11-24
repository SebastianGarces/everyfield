import "../runs-in/render.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const web = createRequire(root + "apps/web/package.json");
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");
const { Alert, Field, InlineAlert, Input, PageState, ProblemText } =
	await import("../../../packages/ui/src/controls/index.ts");

const html = (props: Record<string, unknown>, children?: unknown) =>
	renderToStaticMarkup(createElement(InlineAlert, props, children));

test("INV-a11y: an inline alert keeps its live region in the accessibility tree, with no box, before the problem appears, so the problem is announced", () => {
	for (const [live, expected] of [
		[undefined, "assertive"],
		["polite", "polite"],
	] as const) {
		for (const empty of [null, undefined, false, ""]) {
			assert.equal(
				html({ live, id: "p" }, empty),
				`<div id="p" aria-live="${expected}" aria-atomic="true" class="empty:sr-only"></div>`,
			);
		}
		const shown = html({ live }, "The meeting was not saved.");
		assert.match(shown, new RegExp(`^<div aria-live="${expected}" aria-atomic="true" class="empty:sr-only"><div `));
		assert.match(shown, /The meeting was not saved\./);
		assert.doesNotMatch(shown, /role="alert"/);
	}
});

test("AC: a warning notice is amber, keeps its title and actions, and can show its own icon in place of the warning sign", () => {
	const notice = (props: Record<string, unknown>) =>
		renderToStaticMarkup(
			createElement(
				Alert,
				{ tone: "warning", title: "Connection lost", actions: "Reconnect", ...props },
				"Evry keeps working.",
			),
		);
	const shown = notice({});
	assert.match(shown, /^<div data-tone="warning" class="[^"]*\bbg-amber-50 text-amber-600"/);
	assert.match(
		shown,
		/<p class="font-semibold text-amber-600">Connection lost<\/p>Evry keeps working\.<div[^>]*>Reconnect<\/div>/,
	);
	const { WifiDisconnected01Icon } = web("@hugeicons/core-free-icons");
	const svg = (html: string) => html.match(/<svg[\s\S]*?<\/svg>/)?.[0];
	assert.notEqual(svg(notice({ icon: WifiDisconnected01Icon })), svg(shown));
	assert.equal(svg(notice({ tone: "error" })), svg(shown));
});

test("AC: a success notice is green and shows the check mark, not the warning sign", () => {
	const notice = (tone: string) => renderToStaticMarkup(createElement(Alert, { tone }, "Another link is on its way."));
	const shown = notice("success");
	assert.match(shown, /^<div data-tone="success" class="[^"]*\bbg-green-50 text-green-700"/);
	assert.match(shown, /Another link is on its way\./);
	const svg = (html: string) => html.match(/<svg[\s\S]*?<\/svg>/)?.[0];
	assert.notEqual(svg(shown), svg(notice("error")));
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

test("INV-a11y: a problem line under a control is announced as an alert, keeps its id for aria-describedby, and comes in two sizes", () => {
	const line = (props: Record<string, unknown>, text: string) =>
		renderToStaticMarkup(createElement(ProblemText, props, text));
	assert.equal(
		line({ id: "date-problem" }, "Choose a date."),
		'<p id="date-problem" role="alert" class="text-xs font-medium text-magenta-600">Choose a date.</p>',
	);
	assert.equal(
		line({ size: "sm", as: "span" }, "The search did not load. Try again."),
		'<span role="alert" class="text-sm text-magenta-600">The search did not load. Try again.</span>',
	);
});

test("INV-a11y: a field error is read out through the field's own live region and names the control it describes", () => {
	const shown = renderToStaticMarkup(
		createElement(Field, { label: "Date", error: "Choose a date." }, createElement(Input, { type: "date" })),
	);
	const describedBy = shown.match(/<input[^>]*aria-describedby="([^"]+)"/)?.[1];
	assert.ok(describedBy);
	assert.match(
		shown,
		new RegExp(
			`<div aria-live="polite" class="empty:sr-only"><p id="${describedBy}" class="text-xs font-medium text-magenta-600">Choose a date\\.</p></div>`,
		),
	);
	assert.doesNotMatch(shown, /role="alert"/);
	assert.match(
		renderToStaticMarkup(createElement(Field, { label: "Date" }, createElement(Input, { type: "date" }))),
		/<div aria-live="polite" class="empty:sr-only"><\/div>/,
	);
});
