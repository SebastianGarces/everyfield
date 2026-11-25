import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeDraft, pickField, pickTyped } from "../../../apps/web/src/components/save/conflict.ts";

const fields = [
	{ key: "name", label: "Name", text: (d) => d.name },
	{ key: "phone", label: "Phone", text: (d) => d.phone },
	{ key: "city", label: "City", text: (d) => d.city },
];
const base = { name: "Ana", phone: "1", city: "Austin" };

test("INV-conflict: a field both people changed shows both values, keeps the typed text and waits for a choice", () => {
	const mine = { ...base, name: "Ana Ruiz", city: "Dallas" };
	const latest = { ...base, name: "Anna", phone: "2" };
	const shown = mergeDraft({ base, mine, latest, picks: {}, fields });
	assert.deepEqual(shown, {
		values: { name: "Ana Ruiz", phone: "2", city: "Dallas" },
		rows: [
			{ field: "name", label: "Name", saved: "Anna", mine: "Ana Ruiz", pick: null },
			{ field: "phone", label: "Phone", saved: "2", mine: "1", pick: "saved" },
		],
		unchosen: true,
	});
});

test("INV-conflict: the choice decides each field, and text typed after the conflict is the person's own version", () => {
	const mine = { ...base, name: "Ana Ruiz" };
	const latest = { ...base, name: "Anna" };
	const saved = mergeDraft({ base, mine, latest, picks: pickField({}, latest, "name", "saved"), fields });
	assert.deepEqual([saved.values.name, saved.unchosen], ["Anna", false]);
	const own = mergeDraft({ base, mine, latest, picks: pickField({}, latest, "name", "mine"), fields });
	assert.deepEqual([own.values.name, own.unchosen], ["Ana Ruiz", false]);
	const typed = mergeDraft({
		base,
		mine: { ...mine, name: "Ana R." },
		latest,
		picks: pickTyped({}, latest, { name: "Ana R." }),
		fields,
	});
	assert.deepEqual([typed.values.name, typed.unchosen], ["Ana R.", false]);
	const back = mergeDraft({ base, mine: base, latest, picks: pickField({}, latest, "name", "mine"), fields });
	assert.deepEqual(back.values, base, "choosing the opened value undoes the other person's change");
});

test("INV-conflict: a choice made against one saved version does not stand for a newer one", () => {
	const mine = { ...base, name: "Ana Ruiz" };
	const picks = pickField({}, { ...base, name: "Anna" }, "name", "mine");
	const newer = mergeDraft({ base, mine, latest: { ...base, name: "Hannah" }, picks, fields });
	assert.deepEqual(newer.rows, [{ field: "name", label: "Name", saved: "Hannah", mine: "Ana Ruiz", pick: null }]);
	assert.equal(newer.unchosen, true);
});

test("INV-conflict: the same change saved by both people needs no choice", () => {
	const both = { ...base, name: "Anna" };
	assert.deepEqual(mergeDraft({ base, mine: both, latest: both, picks: {}, fields }), {
		values: both,
		rows: [],
		unchosen: false,
	});
});
