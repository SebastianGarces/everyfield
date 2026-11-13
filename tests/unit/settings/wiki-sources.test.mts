// The Wiki sources section of Settings (apps/web/src/features/settings/sections/wikiOrder.ts and the Settings access
// rule). No browser, no database: the order read and save are wiki.setSourceOrder's, covered in tests/integration/wiki.
//   INV-wiki-sources-offered: only a plant Owner or Admin is offered "Wiki sources", directly after Sharing.
//   INV-wiki-sources-order: Move up and Move down change the draft only, and stop at either end.
//   INV-wiki-sources-refusal: every refused or failed save says it did not save.
import assert from "node:assert/strict";
import { test } from "node:test";
import { offeredSections, sectionAt, sectionRequest } from "../../../apps/web/src/features/settings/model.ts";
import {
	moved,
	orderNeeded,
	orderOf,
	rowsInOrder,
	savedView,
	saveRefusal,
	type WikiOrderView,
} from "../../../apps/web/src/features/settings/sections/wikiOrder.ts";

const PLANT = { kind: "plant", id: "00000000-0000-4000-8000-000000000001" } as const;
const ORG = {
	kind: "organization",
	id: "00000000-0000-4000-8000-000000000002",
	organizationKind: "sending_network",
} as const;
const PAGES = ["seats", "sharing"] as const;

const view = (revision: string, churches: string[], networks: string[] = ["N"]): WikiOrderView => ({
	status: "ok",
	revision,
	churches: churches.map((id) => ({ id, name: `Church ${id}` })),
	networks: networks.map((id) => ({ id, name: `Network ${id}` })),
});

test("INV-wiki-sources-offered: a plant Owner or Admin sees Wiki sources right after Sharing and privacy", () => {
	for (const role of ["owner", "admin"] as const) {
		const sections = offeredSections({ context: "plant", accountId: "a", plant: PLANT, role }, PAGES);
		assert.equal(sections[sections.indexOf("sharing") + 1], "wiki", role);
	}
});

test("INV-wiki-sources-offered: a Member, a sending church or network seat and an account are not offered it", () => {
	const viewers = [
		{ context: "plant", accountId: "a", plant: PLANT, role: "member" },
		{ context: "organization", accountId: "a", organization: ORG, role: "owner" },
		{
			context: "organization",
			accountId: "a",
			organization: { ...ORG, organizationKind: "sending_church" },
			role: "admin",
		},
		{ context: "account", accountId: "a" },
	] as const;
	for (const viewer of viewers) assert.ok(!offeredSections(viewer, PAGES).includes("wiki"), JSON.stringify(viewer));
});

test("INV-wiki-sources-offered: /settings/wiki opens the section and makes no settings-section read", () => {
	const owner = { context: "plant", accountId: "a", plant: PLANT, role: "owner" } as const;
	assert.equal(sectionAt("/settings/wiki", owner), "wiki");
	assert.equal(sectionRequest(owner, "wiki"), null);
});

test("INV-wiki-sources-order: moving an entry swaps it with its neighbour and stops at either end", () => {
	assert.deepEqual(moved(["A", "B", "C"], 2, -1), ["A", "C", "B"]);
	assert.deepEqual(moved(["A", "B", "C"], 0, 1), ["B", "A", "C"]);
	const ids = ["A", "B"];
	assert.equal(moved(ids, 0, -1), ids);
	assert.equal(moved(ids, 1, 1), ids);
});

test("INV-wiki-sources-order: the rows follow the draft, and a saved order becomes the view's order", () => {
	const loaded = view("0", ["A", "B"]);
	assert.deepEqual(orderOf(loaded), { churches: ["A", "B"], networks: ["N"] });
	assert.deepEqual(
		rowsInOrder(loaded.churches, ["B", "A", "gone"]).map((row) => row.name),
		["Church B", "Church A"],
	);
	const after = savedView(loaded, { churches: ["B", "A"], networks: ["N"] }, "1");
	assert.equal(after.revision, "1");
	assert.deepEqual(orderOf(after), { churches: ["B", "A"], networks: ["N"] });
});

test("INV-wiki-sources-order: 'no order set yet' shows only with two or more churches and no stored order", () => {
	assert.equal(orderNeeded(view("0", ["A", "B"])), true);
	assert.equal(orderNeeded(view("2", ["A", "B"])), false);
	assert.equal(orderNeeded(view("0", ["A"])), false);
	assert.equal(orderNeeded(view("0", [], [])), false);
});

test("INV-wiki-sources-refusal: a conflict says the order changed elsewhere; a failure says it did not save", () => {
	const conflict = saveRefusal({ status: "conflict", revision: "4" });
	assert.equal(conflict.code, "conflict");
	assert.match(conflict.message, /changed elsewhere/);
	assert.match(saveRefusal({ status: "lost" }).message, /did not save/);
	for (const status of ["denied", "required", "invalid"] as const)
		assert.match(saveRefusal({ status }).message, /not saved/, status);
});
