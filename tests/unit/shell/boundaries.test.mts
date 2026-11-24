import "../runs-in/render.mjs";
import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const web = createRequire(root + "apps/web/package.json");
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement, isValidElement }: typeof import("react") = web("react");
type Viewer = { status: "unauthenticated" | "active" };
const viewer = globalThis as typeof globalThis & { notFoundViewer: Viewer };
viewer.notFoundViewer = { status: "unauthenticated" };
registerHooks({
	resolve: (specifier, context, next) =>
		specifier === "@/server/request-context"
			? {
					url: `data:text/javascript,${encodeURIComponent("export const getViewer = async () => globalThis.notFoundViewer;")}`,
					shortCircuit: true,
				}
			: next(specifier, context),
});
const { FrameNotFound, RootNotFound } = await import("../../../apps/web/src/features/boundaries/NotFound.tsx");
const { landingFor } = await import("../../../packages/contracts/src/identity/navigation.ts");
const { FrameError, GlobalErrorDocument, RootError } =
	await import("../../../apps/web/src/features/boundaries/Errors.tsx");

type Props = { error: Error & { digest?: string }; reset: () => void };
type Boundary = (props: Props) => import("react").ReactNode;

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

test("BUG-PR551: the not-found pages name the page as not found, as the one h1, with a link to a start page", async () => {
	for (const [name, page, home] of [
		["frame", createElement(FrameNotFound), "/home"],
		["root", await RootNotFound(), "/"],
	] as const) {
		const html = renderToStaticMarkup(page);
		assert.equal(html.match(/<h1[\s>]/g)?.length, 1, `${name}: one h1`);
		assert.match(html, /<h1[^>]*>Page not found<\/h1>/, `${name}: the h1`);
		assert.match(html, new RegExp(`<a [^>]*href="${home}"`), `${name}: links to ${home}`);
		assert.match(text(html), /The link may be out of date/, `${name}: says why`);
	}
});

test("the root not-found home button takes a signed-out visitor to / and a signed-in director or planter to their own app home", async () => {
	for (const [who, status, plant, lands] of [
		["signed-out visitor", "unauthenticated", null, "/"],
		["director", "active", "organization", "/network"],
		["planter", "active", "complete", "/overview"],
	] as const) {
		viewer.notFoundViewer = { status };
		const html = renderToStaticMarkup(await RootNotFound());
		const href = html.match(/<a [^>]*href="([^"]+)"[^>]*>Go to the home page<\/a>/)?.[1];
		assert.equal(href, plant ? "/home" : "/", `${who}: the button's link`);
		const landing = plant ? landingFor({ status, plant }) : href;
		assert.equal(landing, lands, `${who}: /home lands on ${lands}`);
	}
	viewer.notFoundViewer = { status: "unauthenticated" };
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
