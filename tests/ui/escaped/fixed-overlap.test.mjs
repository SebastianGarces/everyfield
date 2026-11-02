// Escaped from PR #393 ("top nav drawn over the document"). The app header is fixed or sticky; at load it must sit
// above the page, never on top of its first visible content. The test checks the bug class on every signed-in shell
// route the people seed reaches, at 390 and 1440 px, in each engine. The routes are the links of the shell's own
// navigation and, for each of them, its first link to a deeper page (a person, a meeting, a church document).
// It runs against a running preview through the shared setup (tests/ui/setup.mjs) and signs in with the people
// seed's owner, so seed that preview first (tests/ui/people/seed.mts up <preview url>).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

const START = "/people";

/** The people seed's owner cookie, refused when the fixture belongs to another preview. */
function ownerCookie() {
	const seed = fixture("people");
	assert.equal(
		new URL(seed.origin).origin,
		new URL(BASE).origin,
		`The people fixture was seeded for ${seed.origin}, not ${BASE}. Seed this preview: tests/ui/people/seed.mts up ${BASE}`,
	);
	return seed.owner.cookie;
}

/** The same-origin paths the shell's navigation links to, from the start page at full width. */
async function shellRoutes(page) {
	await page.goto(BASE + START, { waitUntil: "networkidle" });
	await hydrated(page);
	const paths = await page.evaluate(() =>
		[...document.querySelectorAll("nav a[href], header a[href]")]
			.map((a) => new URL(a.href, location.href))
			.filter((u) => u.origin === location.origin && u.pathname !== "/")
			.map((u) => u.pathname),
	);
	return [...new Set([START, ...paths])].sort();
}

/** The first link in <main> of the current page to a page below `route` that is not in `known`, if any. */
const childRoute = (page, route, known) =>
	page.evaluate(
		([route, known]) =>
			[...document.querySelectorAll("main a[href]")]
				.map((a) => new URL(a.href, location.href))
				.find((u) => u.origin === location.origin && u.pathname.startsWith(`${route}/`) && !known.includes(u.pathname))
				?.pathname ?? null,
		[route, known],
	);

/**
 * The fixed or sticky app header and the first visible content box in <main>, in viewport pixels at scroll 0. The
 * content box is the first element in document order that has a size, is visible and paints text or media.
 */
function measure() {
	const box = (r) => ({
		top: Math.round(r.top),
		right: Math.round(r.right),
		bottom: Math.round(r.bottom),
		left: Math.round(r.left),
	});
	const header = [...document.querySelectorAll("header")].find((h) => {
		const s = getComputedStyle(h);
		const r = h.getBoundingClientRect();
		return ["fixed", "sticky"].includes(s.position) && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
	});
	const main = document.querySelector("main");
	const media = new Set(["IMG", "SVG", "VIDEO", "CANVAS", "INPUT", "TEXTAREA", "SELECT", "BUTTON"]);
	const content = main
		? [...main.querySelectorAll("*")].find((e) => {
				const r = e.getBoundingClientRect();
				const s = getComputedStyle(e);
				if (r.width === 0 || r.height === 0 || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
				if (e.closest("[aria-hidden='true'], .sr-only")) return false;
				return (
					media.has(e.tagName.toUpperCase()) ||
					[...e.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim())
				);
			})
		: null;
	return {
		header: header ? box(header.getBoundingClientRect()) : null,
		content: content ? { ...box(content.getBoundingClientRect()), tag: content.tagName.toLowerCase() } : null,
	};
}

const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const show = (b) => `top ${b.top} right ${b.right} bottom ${b.bottom} left ${b.left}`;

for (const [name, engine] of ENGINES) {
	test(
		`ESC-393-overlap (${name}): the app header never covers the first content on a shell route`,
		{ timeout: 600_000 },
		(t) =>
			withPage(engine, async (page, context) => {
				await signIn(context, ownerCookie());
				const routes = await shellRoutes(page);
				assert.ok(routes.length > 1, `The shell on ${START} links to other routes (found ${routes.join(", ")}).`);
				const failures = [];
				const check = async (route, width) => {
					await page.goto(BASE + route, { waitUntil: "networkidle" });
					await hydrated(page);
					const where = `${route} at ${width} px (${name}, ${new URL(page.url()).pathname})`;
					const m = await page.evaluate(measure);
					if (!m.header) failures.push(`${where}: no fixed or sticky app header`);
					else if (!m.content) failures.push(`${where}: no visible content in <main>`);
					else if (overlaps(m.header, m.content))
						failures.push(
							`${where}: header box ${show(m.header)} overlaps first content <${m.content.tag}> box ${show(m.content)}`,
						);
				};
				// The wide pass also finds each route's first deeper page; the narrow pass checks the same set.
				const children = [];
				for (const route of routes) {
					await check(route, 1440);
					const child = await childRoute(page, route, [...routes, ...children]);
					if (child) children.push(child);
				}
				for (const child of children) await check(child, 1440);
				t.diagnostic(`routes: ${[...routes, ...children].join(" ")}`);
				await page.setViewportSize({ width: 390, height: 900 });
				for (const route of [...routes, ...children]) await check(route, 390);
				assert.deepEqual(failures, [], `${failures.length} header overlap(s):\n${failures.join("\n")}`);
			}),
	);
}
