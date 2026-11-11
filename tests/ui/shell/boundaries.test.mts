// BUG-551 (audit appshell/web-7, T-165): the not-found and error boundaries. Unknown URLs and thrown renders show a branded Everyfield page: the product
// frame's boundaries inside the shell, the root ones outside it, and global-error with its own document. Each error
// boundary says "Something went wrong", shows the digest as a reference and never the error's message, and its Try again
// calls the reset Next hands it.
//
// It renders the real boundary components in node, with no browser and no database. Try again is found in the element
// tree the boundary returns and clicked by calling its handler, as React would. It runs from packages/domain's test:unit:
// tsx --tsconfig ../../tests/ui/render.tsconfig.json --test <this file>.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const web = createRequire(root + "apps/web/package.json");
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement, isValidElement } = web("react");
const { FrameNotFound, RootNotFound } = await import("../../../apps/web/src/features/boundaries/NotFound.tsx");
const { FrameError, RootError } = await import("../../../apps/web/src/features/boundaries/Errors.tsx");
const { default: GlobalError } = await import("../../../apps/web/src/app/global-error.tsx");

type Props = { error: Error & { digest?: string }; reset: () => void };
type Boundary = (props: Props) => unknown;

const ERRORS: [string, Boundary][] = [
	["frame error", FrameError],
	["root error", RootError],
	["global error", GlobalError],
];

/** The visible text of the markup, tags dropped and whitespace collapsed. */
function text(html: string) {
	return html
		.replace(/<style[\s\S]*?<\/style>/g, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** The text a React node renders, read from the element tree without rendering it. */
function label(node: unknown): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(label).join("");
	if (isValidElement(node)) return label((node.props as { children?: unknown }).children);
	return "";
}

/** The first element in the tree, searching every element-valued prop (children, actions …), whose label is `name` and
 *  that has a click handler. Component elements are not called: the boundaries pass Try again down as a prop. */
function clickable(node: unknown, name: string): { onClick: () => void } | undefined {
	if (Array.isArray(node)) {
		for (const n of node) {
			const hit = clickable(n, name);
			if (hit) return hit;
		}
		return undefined;
	}
	if (!isValidElement(node)) return undefined;
	const props = node.props as Record<string, unknown>;
	if (typeof props.onClick === "function" && label(node) === name) return props as { onClick: () => void };
	for (const value of Object.values(props)) {
		const hit = clickable(value, name);
		if (hit) return hit;
	}
	return undefined;
}

function boundaryError() {
	return Object.assign(new Error("db password=hunter2 at query.ts:42"), { digest: "4096123" });
}

test("BUG-551: the not-found pages name the page as not found, as the one h1, with a link to a start page", () => {
	for (const [name, Page, home] of [
		["frame", FrameNotFound, "/home"],
		["root", RootNotFound, "/"],
	] as const) {
		const html = renderToStaticMarkup(createElement(Page));
		assert.equal(html.match(/<h1[\s>]/g)?.length, 1, `${name}: one h1`);
		assert.match(html, /<h1[^>]*>Page not found<\/h1>/, `${name}: the h1`);
		assert.match(html, new RegExp(`<a [^>]*href="${home}"`), `${name}: links to ${home}`);
		assert.match(text(html), /The link may be out of date/, `${name}: says why`);
	}
});

test("BUG-551: an error boundary says something went wrong, shows the digest and never the error's message", () => {
	for (const [name, Boundary] of ERRORS) {
		const html = renderToStaticMarkup(createElement(Boundary, { error: boundaryError(), reset: () => {} }));
		const body = text(html);
		assert.match(html, /<h1[^>]*>Something went wrong<\/h1>/, `${name}: the h1`);
		assert.match(body, /Try again/, `${name}: offers Try again`);
		assert.match(body, /Error reference 4096123/, `${name}: the digest as a reference`);
		assert.doesNotMatch(body, /hunter2|query\.ts/, `${name}: no message or stack`);
		const plain = text(renderToStaticMarkup(createElement(Boundary, { error: new Error("x"), reset: () => {} })));
		assert.doesNotMatch(plain, /Error reference/, `${name}: no reference line without a digest`);
	}
});

test("BUG-551: Try again calls the boundary's reset once", () => {
	for (const [name, Boundary] of ERRORS) {
		let resets = 0;
		const tree = Boundary({ error: boundaryError(), reset: () => resets++ });
		const button = clickable(tree, "Try again");
		assert.ok(button, `${name}: has a Try again control`);
		button.onClick();
		assert.equal(resets, 1, `${name}: reset called once`);
	}
});

test("BUG-551: global-error renders its own html and body, so it needs nothing from the root layout", () => {
	const html = renderToStaticMarkup(createElement(GlobalError, { error: boundaryError(), reset: () => {} }));
	assert.match(html, /^<html lang="en"><head>/);
	assert.match(html, /<body>[\s\S]*<\/body><\/html>$/);
	assert.match(html, /<style>/, "brings its own styles");
});
