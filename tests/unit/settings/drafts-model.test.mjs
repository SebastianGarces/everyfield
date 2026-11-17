import assert from "node:assert/strict";
import { test } from "node:test";
import {
	begin,
	edit,
	emptyBook,
	finish,
	isDirty,
	isSaving,
	rebase,
	visible,
} from "../../../apps/web/src/features/settings/drafts.ts";

const KEY = "church";
const VALUES = ["A", "B", "C", "A ", "B "];

function rng(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

function world() {
	return {
		server: { value: "A", revision: 1 },
		cache: { value: "A", revision: 1 },
		book: emptyBook(),
		intent: null,
		pending: null,
		requests: 0,
	};
}

const step = {
	edit(w, value) {
		w.book = edit(w.book, KEY, value, w.cache.value);
		w.intent = w.pending === null && value === w.cache.value ? null : value;
	},
	save(w) {
		const started = begin(w.book, KEY, w.cache.value);
		if (!started) return assert.ok(w.pending, "a save is refused only while one is in flight");
		assert.equal(w.pending, null, "a second save never starts while one is in flight");
		w.book = started.book;
		w.pending = { sent: started.sent, expected: w.cache.revision };
		w.requests += 1;
	},
	switchSection() {},
	reply(w) {
		if (!w.pending) return;
		const { sent, expected } = w.pending;
		w.pending = null;
		if (expected === w.server.revision) {
			w.server = { value: String(sent).trim(), revision: w.server.revision + 1 };
			w.cache = { ...w.server };
			w.book = finish(w.book, KEY, { ok: true }, w.cache.value);
			if (w.intent === sent) w.intent = null;
		} else {
			w.book = finish(w.book, KEY, { ok: false, refusal: "conflict" }, w.cache.value);
		}
		if (w.intent === w.cache.value) w.intent = null;
	},
	otherPerson(w) {
		w.server = { value: "X", revision: w.server.revision + 1 };
	},
	loadLatest(w) {
		if (w.pending) return;
		w.cache = { ...w.server };
	},
};

function check(w, trail) {
	const shown = visible(w.book, KEY, w.cache.value);
	const expected = w.intent ?? w.cache.value;
	assert.equal(shown, expected, `visible value after: ${trail.join(" > ")}`);
	assert.equal(
		isDirty(w.book, KEY, w.cache.value),
		w.intent !== null && w.intent !== w.cache.value,
		`dirty after: ${trail.join(" > ")}`,
	);
	assert.equal(isSaving(w.book, KEY), w.pending !== null, `one save in flight after: ${trail.join(" > ")}`);
}

test("BUG-PR114: saving an earlier edit keeps the typed-back value dirty", () => {
	const w = world();
	const trail = [];
	const run = (name, ...args) => {
		trail.push(name + (args.length ? `(${args.join()})` : ""));
		step[name](w, ...args);
		check(w, trail);
	};
	run("edit", "B");
	run("save");
	run("switchSection");
	run("switchSection");
	run("edit", "C");
	run("save");
	run("edit", "A");
	run("reply");
	assert.equal(w.requests, 1);
	assert.deepEqual(w.cache, { value: "B", revision: 2 });
	assert.equal(visible(w.book, KEY, w.cache.value), "A", "the typed-back A is still shown");
	assert.equal(isDirty(w.book, KEY, w.cache.value), true, "A differs from the saved B");
});

test("INV-draft-model: random interleavings keep the invariant", () => {
	const names = [
		"edit",
		"edit",
		"edit",
		"save",
		"save",
		"switchSection",
		"reply",
		"reply",
		"otherPerson",
		"loadLatest",
	];
	for (let seed = 1; seed <= 4000; seed++) {
		const random = rng(seed);
		const w = world();
		const trail = [];
		for (let i = 0; i < 40; i++) {
			const name = names[Math.floor(random() * names.length)];
			const value = VALUES[Math.floor(random() * VALUES.length)];
			trail.push(name === "edit" ? `edit(${JSON.stringify(value)})` : name);
			step[name](w, value);
			check(w, [`seed ${seed}`, ...trail]);
		}
	}
});

test("INV-draft-rebase: Load latest after a conflict keeps the fields the person changed and shows the rest", () => {
	const opened = { city: "Austin", street: "", warningDays: "14" };
	const latest = { city: "Austin", street: "1 Main St", warningDays: "14" };
	let book = edit(emptyBook(), KEY, { ...opened, city: "Round Rock" }, opened);
	book = finish(begin(book, KEY, opened).book, KEY, { ok: false, refusal: "conflict" }, opened);
	book = rebase(book, KEY, opened, latest);
	assert.deepEqual(visible(book, KEY, latest), { city: "Round Rock", street: "1 Main St", warningDays: "14" });
	assert.equal(book.refusals[KEY], undefined, "the refusal that asked for the reload is gone");
	book = rebase(edit(emptyBook(), KEY, { ...opened, street: "1 Main St" }, opened), KEY, opened, latest);
	assert.equal(isDirty(book, KEY, latest), false);
});
