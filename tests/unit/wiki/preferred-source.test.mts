// "Set as preferred" on the article's Source menu (apps/web/src/features/wiki/model.ts). No browser, no database: the
// save is wiki.setSourceOrder's, covered in tests/integration/wiki.
//   INV-wiki-prefer-head: the chosen source moves to the head of its own list, the rest keep their order and the
//   other list is unchanged.
//   INV-wiki-prefer-offered: the item is offered only with an order to change, never for Global, the preferred
//   source or a source already first, except a church while two or more churches have no stored order.
import assert from "node:assert/strict";
import { test } from "node:test";
import { preferredOrder, toHead, type SourceOrder } from "../../../apps/web/src/features/wiki/model.ts";

const stored: SourceOrder = { revision: "4", churches: ["A", "B", "C"], networks: ["N1", "N2", "N3"] };
const church = (id: string) => ({ id, kind: "church" as const });
const network = (id: string) => ({ id, kind: "network" as const });

test("INV-wiki-prefer-head: toHead moves the head, a middle and the last entry first and keeps the rest in order", () => {
	assert.deepEqual(toHead(["A", "B", "C"], "A"), ["A", "B", "C"]);
	assert.deepEqual(toHead(["A", "B", "C"], "B"), ["B", "A", "C"]);
	assert.deepEqual(toHead(["A", "B", "C"], "C"), ["C", "A", "B"]);
});

test("INV-wiki-prefer-head: setting church C preferred stores C, A, B and leaves the networks as they were", () => {
	assert.deepEqual(preferredOrder(stored, church("C"), "A"), {
		revision: "4",
		list: "churches",
		churches: ["C", "A", "B"],
		networks: ["N1", "N2", "N3"],
	});
});

test("INV-wiki-prefer-head: setting network N2 preferred moves it first among networks only", () => {
	assert.deepEqual(preferredOrder(stored, network("N2"), "A"), {
		revision: "4",
		list: "networks",
		churches: ["A", "B", "C"],
		networks: ["N2", "N1", "N3"],
	});
});

test("INV-wiki-prefer-offered: no item for the first entry, the preferred source, Global, an unknown id or no order", () => {
	assert.equal(preferredOrder(stored, church("A"), "N1"), null, "first church");
	assert.equal(preferredOrder(stored, network("N1"), "A"), null, "first network");
	assert.equal(preferredOrder(stored, church("B"), "B"), null, "already preferred here");
	assert.equal(preferredOrder(stored, { id: "G", kind: "global" }, "A"), null, "Global");
	assert.equal(preferredOrder(stored, church("X"), "A"), null, "not in the list");
	assert.equal(preferredOrder(null, church("B"), "A"), null, "Member: no order to change");
});

test("INV-wiki-prefer-offered: with two churches and no stored order, either church can be made preferred", () => {
	const unordered: SourceOrder = { revision: "0", churches: ["A", "B"], networks: ["N1", "N2"] };
	assert.deepEqual(preferredOrder(unordered, church("A"), "N1")?.churches, ["A", "B"]);
	assert.deepEqual(preferredOrder(unordered, church("B"), "N1")?.churches, ["B", "A"]);
	assert.equal(preferredOrder(unordered, network("N1"), "G"), null, "the first network stays without an item");
	const single: SourceOrder = { revision: "0", churches: ["A"], networks: [] };
	assert.equal(preferredOrder(single, church("A"), "G"), null, "one church needs no order");
});
