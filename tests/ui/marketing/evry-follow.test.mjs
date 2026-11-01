// WP-097 Done 12: the pointer-to-gaze mapping of a `follow` bot, through the shared life loop that the landing kit
// EvryBot wraps (packages/ui/src/foundations/evry-life.ts). The loop runs in node on a minimal fake page: one bot, a
// controlled clock, frames on demand and pointermove events. The eyes turn toward the pointer on a damped spring, scale
// with the pointer distance (full turn at 300 px), stay inside the outline, read the box once per pointer event, and
// return to rest about 1.6 s after the pointer stops.
//   node --test tests/ui/marketing/evry-follow.test.mjs
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// evry-life imports "./evry-geo" without an extension, as the bundler resolves it.
registerHooks({
	resolve(spec, ctx, next) {
		try {
			return next(spec, ctx);
		} catch (error) {
			if (spec.startsWith(".")) return next(`${spec}.ts`, ctx);
			throw error;
		}
	},
});
const geo = await import("../../../packages/ui/src/foundations/evry-geo.ts");

// ---- the fake page: clock, frames, timers, listeners, one IntersectionObserver
let now = 1000;
let frames = [];
let timers = [];
const listeners = {};
let io = null;
performance.now = () => now;
globalThis.requestAnimationFrame = (cb) => frames.push(cb);
globalThis.cancelAnimationFrame = () => (frames = []);
globalThis.setTimeout = (cb, ms) => timers.push({ cb, at: now + ms }) && timers.length;
globalThis.clearTimeout = () => (timers = []);
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.IntersectionObserver = class {
	constructor(cb) {
		io = cb;
	}
	observe() {}
	unobserve() {}
	disconnect() {}
};
globalThis.MutationObserver = class {
	observe() {}
	disconnect() {}
};
globalThis.document = {
	hidden: false,
	addEventListener: (type, fn) => (listeners[type] = fn),
	removeEventListener: () => {},
};
// Seeded random, so the blink and act timings are the same every run.
let seed = 7;
Math.random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

const { mountEvry } = await import("../../../packages/ui/src/foundations/evry-life.ts");

const node = () => {
	const attrs = {};
	return {
		attrs,
		dataset: {},
		setAttribute: (k, v) => (attrs[k] = v),
		removeAttribute: (k) => delete attrs[k],
		hasAttribute: (k) => k in attrs,
	};
};
/** Runs the page for `ms`: frames every 16 ms, due timers in between. */
function run(ms) {
	const end = now + ms;
	while (now < end) {
		now += 16;
		const due = timers.filter((t) => t.at <= now);
		timers = timers.filter((t) => t.at > now);
		for (const t of due) t.cb();
		const f = frames;
		frames = [];
		for (const cb of f) cb(now);
	}
}
const pairs = (d) => {
	const n = d.match(/-?\d+(\.\d+)?/g).map(Number);
	return Array.from({ length: n.length / 2 }, (_, i) => [n[2 * i], n[2 * i + 1]]);
};
/** The mean of an eye path's control points. */
const centre = (d) => {
	const p = pairs(d);
	return [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];
};

test("WP-097 Done 12: a follow bot's gaze follows the pointer on a spring and returns to rest", () => {
	// A held circle (no morph, no idle act) of 40 px whose centre is at (20, 20).
	const root = node();
	let reads = 0;
	root.parentElement = null;
	root.getBoundingClientRect = () => (reads++, { left: 0, top: 0, width: 40, height: 40 });
	const eyes = [node(), node()];
	const handle = mountEvry(
		{ root, path: node(), g: node(), eyes, hl: node(), sh: node() },
		{ small: false, mood: "idle", shape: "circle", hold: true, follow: true },
	);
	io([{ target: root, isIntersecting: true }]);
	run(100);
	const rest = geo.restPaths("circle", "idle").eyes;
	assert.deepEqual(
		eyes.map((e) => e.attrs.d),
		rest,
		"eyes at rest before any pointer",
	);
	const restC = rest.map(centre);
	const shift = () => eyes.map((e, j) => centre(e.attrs.d).map((v, k) => v - restC[j][k]));
	const move = (x, y) => listeners.pointermove({ clientX: x, clientY: y });

	// Far to the right (300 px or more): a full turn to the right, about level.
	const before = reads;
	move(20 + 600, 20);
	assert.equal(reads - before, 1, "one box read per pointer event");
	const path = [];
	for (let i = 0; i < 40; i++) {
		run(16);
		path.push(shift()[1][0]);
	}
	const [far0, far1] = shift();
	assert.ok(far1[0] > 3, `right eye turns right: ${far1[0]}`);
	assert.ok(Math.abs(far1[1]) < 0.6, `level gaze: ${far1[1]}`);
	assert.ok(far0[0] > 3, "both eyes turn");
	// A damped spring (ratio 0.7) rises smoothly, overshoots a little, then settles.
	const peak = Math.max(...path);
	assert.ok(peak > far1[0] && peak < far1[0] * 1.1, `overshoot: peak ${peak}, settled ${far1[0]}`);
	assert.ok(path[1] < path[4] && path[4] < path[8], "it rises over several frames, not in one step");
	// The gaze keeps the eyes inside the circle outline by the prototype's margin.
	const E = geo.edges(geo.SHAPES.circle.pts, geo.newEdges());
	for (const e of eyes) assert.ok(geo.margin(E, pairs(e.attrs.d).flat()) >= geo.MARGIN - 0.1);

	// Half the distance (150 px up and left): the gaze turns that way at about half the reach.
	move(20 - 106, 20 - 106);
	run(700);
	const [half] = shift();
	assert.ok(half[0] < -1 && half[1] < -1, `up and left: ${half}`);
	const halfLen = Math.hypot(...half);
	move(20 - 424, 20 - 424);
	run(700);
	const fullLen = Math.hypot(...shift()[0]);
	assert.ok(halfLen / fullLen > 0.35 && halfLen / fullLen < 0.65, `half distance, half turn: ${halfLen / fullLen}`);

	// The pointer stops: about 1.6 s later the eyes go back to rest.
	run(1400);
	assert.notDeepEqual(
		eyes.map((e) => e.attrs.d),
		rest,
		"still following at 1.4 s",
	);
	run(1600);
	assert.deepEqual(
		eyes.map((e) => e.attrs.d),
		rest,
		"back at rest",
	);
	handle.unmount();
});
