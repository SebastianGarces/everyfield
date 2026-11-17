import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const web = createRequire(root + "apps/web/package.json");
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement, isValidElement } = web("react");
const { FrameNotFound, RootNotFound } = await import("../../../apps/web/src/features/boundaries/NotFound.tsx");
const { FrameError, GlobalErrorDocument, RootError } =
	await import("../../../apps/web/src/features/boundaries/Errors.tsx");

type Props = { error: Error & { digest?: string }; reset: () => void };
type Boundary = (props: Props) => unknown;

const ERRORS: [string, Boundary][] = [
	["frame error", FrameError],
	["root error", RootError],
	["global error", GlobalErrorDocument],
];

function text(html: string) {
	return html
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function label(node: unknown): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(label).join("");
	if (isValidElement(node)) return label((node.props as { children?: unknown }).children);
	return "";
}

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
	return typeof node.type === "function" ? clickable((node.type as (p: unknown) => unknown)(props), name) : undefined;
}

function boundaryError() {
	return Object.assign(new Error("db password=hunter2 at query.ts:42"), { digest: "4096123" });
}

test("BUG-PR551: the not-found pages name the page as not found, as the one h1, with a link to a start page", () => {
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

test("BUG-PR551: an error boundary says something went wrong, shows the digest and never the error's message", () => {
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

test("BUG-PR551: Try again calls the boundary's reset once", () => {
	for (const [name, Boundary] of ERRORS) {
		let resets = 0;
		const tree = Boundary({ error: boundaryError(), reset: () => resets++ });
		const button = clickable(tree, "Try again");
		assert.ok(button, `${name}: has a Try again control`);
		button.onClick();
		assert.equal(resets, 1, `${name}: reset called once`);
	}
});

test("BUG-PR551: global-error renders its own html and body, so it needs nothing from the root layout", () => {
	const html = renderToStaticMarkup(
		createElement(GlobalErrorDocument, { error: boundaryError(), reset: () => {}, className: "fonts" }),
	);
	assert.match(html, /^<html lang="en" class="fonts">/);
	assert.match(html, /<body>[\s\S]*<\/body><\/html>$/);
});
