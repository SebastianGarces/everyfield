// T-274 Done 4-5 (REQ-IDN-006): an Evry result card draws each person row's photo from the photos the panel read for
// it now, never from the saved result. A person row without one, and every household, tag, skill, activity or file
// row, keeps its initials or icon. It renders the real ResultCard in node, with no browser and no database. It runs
// from packages/domain's test:unit: tsx --tsconfig ../../tests/ui/render.tsconfig.json --test <this file>.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const web = createRequire(root + "apps/web/package.json");
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");
const { AppRouterContext } = web("next/dist/shared/lib/app-router-context.shared-runtime");
const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
const { ResultCard } = await import("../../../apps/web/src/features/evry/conversation/ResultCard.tsx");

const LINKED = "22222222-2222-4222-8222-222222222222";
const PLAIN = "33333333-3333-4333-8333-333333333333";
const H = "11111111-1111-4111-8111-111111111111";
const result = (operation: string, rows: unknown[]) => ({
	operation,
	status: "available",
	rows,
	total: rows.length,
	page: 1,
	next: null,
	completeness: "complete",
	exclusions: [],
});
const person = (id: string, label: string) => ({
	kind: "person",
	id,
	label,
	fields: { city: null, stage: "prospect" },
});
const render = (operation: string, saved: ReturnType<typeof result>, photos: Record<string, string>) =>
	renderToStaticMarkup(
		createElement(
			AppRouterContext.Provider,
			{ value: router },
			createElement(ResultCard, { operation, result: saved, originalTotal: null, photos }),
		),
	);
const images = (html: string) => [...html.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1]);

test("AC:TARGET-IDN-006: a person row shows the photo read for it now; other rows keep initials", () => {
	const saved = result("people.listPeople", [person(LINKED, "Linked Holder"), person(PLAIN, "Plain Person")]);
	// The saved result carries no photo: the card shows only what the panel read.
	assert.doesNotMatch(JSON.stringify(saved), /photo|avatar|versionId/i);
	const first = `/api/accounts/${LINKED}/avatar/44444444-4444-4444-8444-444444444444`;
	assert.deepEqual(images(render("people.listPeople", saved, { [LINKED]: first })), [first]);
	// Reopened after the photo was replaced, the same saved result shows the new version; after it was removed or
	// the seat ended, the initials.
	const replaced = `/api/accounts/${LINKED}/avatar/55555555-5555-4555-8555-555555555555`;
	assert.deepEqual(images(render("people.listPeople", saved, { [LINKED]: replaced })), [replaced]);
	const html = render("people.listPeople", saved, {});
	assert.deepEqual(images(html), []);
	assert.match(html, /LH/);
});

test("household rows keep their icon, and member rows of a household card show their photo", () => {
	const photo = `/people/${LINKED}/photo/66666666-6666-4666-8666-666666666666`;
	const saved = result("people.getHousehold", [
		{ kind: "household", id: H, label: "Okafor household", fields: { memberCount: "2", city: null } },
		{ kind: "person", id: LINKED, label: "Linked Holder", fields: { role: "head", householdId: H } },
	]);
	// A photo keyed by the household's id is never drawn: only person rows ask for one.
	assert.deepEqual(images(render("people.getHousehold", saved, { [LINKED]: photo, [H]: "/not-a-photo" })), [photo]);
});
