// T-67 (Nora QA 2026-11-05, Ask F, WP-026): the phase checklist preview names the checklist it shows. Above its task
// list sits a visible heading, "Tasks in <checklist name>", below the sheet's title in the outline, and the list is
// labelled by that heading so a screen reader announces the words the eye sees. While the preview loads or after it
// fails, no heading shows.
//
// It renders the real PreviewBody in node from the fixed catalog, with no browser and no database. Next.js swaps every
// "use server" module for a network stub in the browser; this test does the same for the tasks actions with node's
// module mocks. It runs from packages/domain's test:unit: tsx --experimental-test-module-mocks --test <this file>.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
mock.module(pathToFileURL(root + "apps/web/src/features/tasks/actions.ts").href, {
	exports: {
		importTemplate: async () => {
			throw new Error("No server action runs in this test.");
		},
	},
});

const web = createRequire(root + "apps/web/package.json");
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");
const { PreviewBody } = await import("../../../apps/web/src/features/tasks/Templates.tsx");
const { CATALOG } = await import("../../../packages/domain/src/tasks/catalog.ts");

const ANCHOR = "2026-11-05";
/** The preview the server answers for one catalog checklist, with each task due on the anchor date. */
function previewOf(key: string) {
	const k = CATALOG.checklists.find((c) => c.key === key);
	assert.ok(k, `the catalog has ${key}`);
	return {
		catalogVersion: CATALOG.version,
		anchorDate: ANCHOR,
		checklist: {
			key: k.key,
			name: k.name,
			description: k.description,
			phase: k.phase,
			category: k.category,
			taskCount: k.items.length,
			tasks: k.items.map((i) => ({
				key: i.key,
				title: i.title,
				description: i.description,
				priority: i.priority,
				due: ANCHOR,
			})),
		},
	};
}

const text = (html: string) =>
	html
		.replace(/<[^>]+>/g, " ")
		.replaceAll("&#x27;", "'")
		.replaceAll("&quot;", '"')
		.replaceAll("&amp;", "&")
		.replace(/\s+/g, " ")
		.trim();

/** The preview body as rendered: every heading with its id, level and text, and the task list's opening tag. */
function render(state: unknown, shown: unknown) {
	const markup: string = renderToStaticMarkup(
		createElement(PreviewBody, { state, shown, year: 2026, problem: null, onRetry() {} }),
	);
	const headings = [...markup.matchAll(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/g)].map((m) => ({
		level: Number(m[1]),
		id: m[2]!.match(/\sid="([^"]+)"/)?.[1],
		text: text(m[3]!),
	}));
	const list = markup.match(/<ol\b[^>]*>/)?.[0] ?? null;
	return { markup, headings, list };
}

/** The ok preview for a checklist: the heading that names it, and the list labelled by that heading's id. */
function assertNamed(key: string, name: string) {
	const value = previewOf(key);
	assert.equal(value.checklist.name, name);
	const { headings, list } = render({ status: "ok", value }, value);
	const heading = headings.find((h) => h.text.startsWith("Tasks in"));
	assert.ok(heading, `a heading over the tasks: ${JSON.stringify(headings)}`);
	assert.equal(heading.text, `Tasks in ${name}`);
	// Below the sheet's title, which Radix renders as an h2.
	assert.equal(heading.level, 3);
	assert.ok(heading.id, "the heading has an id");
	assert.ok(list, "the task list renders");
	assert.match(list, new RegExp(`\\saria-labelledby="${heading.id}"`), list);
	assert.doesNotMatch(list, /\saria-label=/, "no hidden label competes with the visible heading");
}

test("T-67: the Vision Meeting Preparation preview shows Tasks in Vision Meeting Preparation over a list labelled by it", () => {
	assertNamed("vision-meeting-preparation", "Vision Meeting Preparation");
});

test("T-67: another phase's checklist names itself in the heading", () => {
	const other = CATALOG.checklists.find((c) => c.phase !== 1 && c.name.includes("&"));
	assert.ok(other, "a checklist from another phase whose name needs escaping");
	assertNamed(other.key, other.name);
});

test("T-67: loading and failed previews show no task heading", () => {
	const loading = render({ status: "loading" }, null);
	assert.deepEqual(loading.headings, []);
	assert.match(text(loading.markup), /^Loading the checklist$/);
	const failed = render({ status: "failed", message: "Check your connection and try again." }, null);
	assert.deepEqual(
		failed.headings.map((h) => h.text),
		["This checklist did not load"],
	);
	assert.ok(!failed.markup.includes("Tasks in"));
});
