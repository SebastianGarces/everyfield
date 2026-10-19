// INV-draft-model: the settings draft rules (apps/web/src/features/settings/drafts.ts) over random interleavings of
// edits, saves, section switches, a second person's change, Load latest, and server replies that accept or refuse
// a stale revision. After every step:
//   1. the visible value is the latest edit, or the server value when there is no edit;
//   2. the section is dirty exactly when the visible value differs from the latest server value the client holds;
//   3. at most one save per section is in flight, so a second Save never sends a second request.
// A successful save of an untouched draft takes the server's normalized value (trimmed here). No browser needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	begin,
	edit,
	emptyBook,
	finish,
	isDirty,
	isSaving,
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
		intent: null, // what the person last typed and still means; null follows the server
		pending: null, // the request on the wire: { sent, expected }
		requests: 0,
	};
}

const step = {
	edit(w, value) {
		w.book = edit(w.book, KEY, value, w.cache.value);
		// The rule, not the code: an edit equal to the saved value is no edit, unless a save is about to change
		// the saved value.
		w.intent = w.pending === null && value === w.cache.value ? null : value;
	},
	save(w) {
		const started = begin(w.book, KEY, w.cache.value);
		if (!started) return assert.ok(w.pending, "a save is refused only while one is in flight");
		w.book = started.book;
		w.pending = { sent: started.sent, expected: w.cache.revision };
		w.requests += 1;
	},
	// The section unmounts and mounts again. Everything that matters lives in the book, so nothing changes.
	switchSection() {},
	reply(w) {
		if (!w.pending) return;
		const { sent, expected } = w.pending;
		w.pending = null;
		if (expected === w.server.revision) {
			w.server = { value: String(sent).trim(), revision: w.server.revision + 1 };
			w.cache = { ...w.server };
			w.book = finish(w.book, KEY, { ok: true }, w.cache.value);
			if (w.intent === sent) w.intent = null; // the saved value, as the server normalized it, is what was meant
		} else {
			w.book = finish(w.book, KEY, { ok: false, refusal: "conflict" }, w.cache.value);
		}
		if (w.intent === w.cache.value) w.intent = null; // an edit that matches the saved value is no longer an edit
	},
	otherPerson(w) {
		w.server = { value: "X", revision: w.server.revision + 1 };
	},
	loadLatest(w) {
		if (w.pending) return;
		w.cache = { ...w.server }; // an unsaved edit survives Load latest; no edit follows the new saved value
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

test("BUG-114: saving an earlier edit keeps the typed-back value dirty", () => {
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
	run("save"); // refused locally: the first save is still in flight, so no second request
	run("edit", "A");
	run("reply"); // the first save commits B
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
