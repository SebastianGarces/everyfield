import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MARGIN,
	N,
	NAMES,
	SHAPES,
	blend,
	bodyD,
	edges,
	eye,
	eyeD,
	margin,
	newEdges,
	reach,
	restPaths,
	specs,
	unturn,
} from "../../../packages/ui/src/foundations/evry-geo.ts";

const EPS = 1e-9;
const outline = (name) => edges(SHAPES[name].pts, newEdges());
const DIRS = Array.from({ length: 8 }, (_, i) => [Math.cos((i * Math.PI) / 4), Math.sin((i * Math.PI) / 4)]);

function convex(P) {
	let sign = 0;
	for (let i = 0; i < N; i++) {
		const a = i * 2;
		const b = ((i + 1) % N) * 2;
		const c = ((i + 2) % N) * 2;
		const cross = (P[b] - P[a]) * (P[c + 1] - P[b + 1]) - (P[b + 1] - P[a + 1]) * (P[c] - P[b]);
		if (Math.abs(cross) < EPS) continue;
		if (sign && Math.sign(cross) !== sign) return false;
		sign = Math.sign(cross);
	}
	return true;
}

test("INV-convex: every shape and the 0.25, 0.5 and 0.75 blend of each pair is convex", () => {
	const out = new Float64Array(2 * N);
	for (const a of NAMES) {
		assert.ok(convex(SHAPES[a].pts), a);
		for (const b of NAMES) {
			if (a === b) continue;
			for (const t of [0.25, 0.5, 0.75])
				assert.ok(convex(blend(out, SHAPES[a].pts, SHAPES[b].pts, t)), `${a}→${b} ${t}`);
		}
	}
});

test("INV-eyes-inside: rest eyes of each shape keep MARGIN inside, idle and thinking", () => {
	const C = new Float64Array(38);
	for (const name of NAMES) {
		const S = SHAPES[name];
		const E = outline(name);
		for (const mood of ["idle", "thinking"])
			for (const [cx, cy, w, l] of specs(S.fy, S.fk, mood)) {
				const m = margin(E, eye(null, cx, cy, w, l, 0, 0, C));
				assert.ok(m >= MARGIN, `${name} ${mood}: margin ${m.toFixed(2)}`);
			}
	}
});

test("INV-eyes-inside: at full reach in 8 directions every eye keeps MARGIN inside", () => {
	const C = new Float64Array(38);
	for (const name of NAMES) {
		const S = SHAPES[name];
		const E = outline(name);
		for (const mood of ["idle", "thinking"]) {
			const sp = specs(S.fy, S.fk, mood);
			for (const [ux, uy] of DIRS) {
				const r = reach(E, sp, ux, uy, MARGIN);
				assert.ok(r > 2, `${name} ${mood} (${ux.toFixed(2)}, ${uy.toFixed(2)}): reach ${r.toFixed(2)}`);
				for (const [cx, cy, w, l] of sp) {
					const m = margin(E, eye(E, cx, cy, w, l, r * ux, r * uy, C));
					assert.ok(m >= MARGIN - EPS, `${name} ${mood} (${ux.toFixed(2)}, ${uy.toFixed(2)}): margin ${m.toFixed(2)}`);
				}
			}
		}
	}
});

test("INV-foreshorten: toward the edge an eye narrows, with p in [0, 1]", () => {
	const C = new Float64Array(38);
	for (const name of NAMES) {
		const S = SHAPES[name];
		const E = outline(name);
		const sp = specs(S.fy, S.fk, "idle");
		for (const [ux, uy] of DIRS) {
			const r = reach(E, sp, ux, uy, MARGIN);
			const measures = sp.map(([cx, cy, w, l]) => {
				const m = {};
				eye(E, cx, cy, w, l, r * ux, r * uy, C, m);
				return m;
			});
			for (const m of measures) assert.ok(m.p >= 0 && m.p <= 1, `${name}: p ${m.p}`);
			const lead = measures.reduce((a, b) => (b.p > a.p ? b : a));
			assert.ok(lead.p > 0, `${name} (${ux.toFixed(2)}, ${uy.toFixed(2)}): p ${lead.p}`);
			if (Math.abs(ux) > 0.5)
				assert.ok(lead.width < 1, `${name} (${ux.toFixed(2)}, ${uy.toFixed(2)}): width ${lead.width}`);
			else assert.ok(lead.width <= 1 + EPS, `${name} (${ux.toFixed(2)}, ${uy.toFixed(2)}): width ${lead.width}`);
		}
	}
});

test("INV-foreshorten: a flat side never bends the eye", () => {
	const C = new Float64Array(38);
	for (const [name, ux, uy] of [
		["square", 1, 0],
		["square", -1, 0],
		["square", 0, -1],
		["hexagon", 1, 0],
		["hexagon", -1, 0],
	]) {
		const S = SHAPES[name];
		const E = outline(name);
		const sp = specs(S.fy, S.fk, "idle");
		const r = reach(E, sp, ux, uy, MARGIN);
		for (const [cx, cy, w, l] of sp) {
			const m = {};
			eye(E, cx, cy, w, l, r * ux, r * uy, C, m);
			assert.ok(m.bend < 1e-3, `${name} (${ux}, ${uy}): bend ${m.bend}`);
		}
	}
	const S = SHAPES.circle;
	const E = outline("circle");
	const sp = specs(S.fy, S.fk, "idle");
	const r = reach(E, sp, 1, 0, MARGIN);
	const m = {};
	eye(E, sp[1][0], sp[1][1], sp[1][2], sp[1][3], r, 0, C, m);
	assert.ok(m.bend > 0.01, `circle: bend ${m.bend}`);
});

test("INV-deterministic: path data is the same string for the same input, whatever was drawn in between", () => {
	const C = new Float64Array(38);
	const other = () => {
		bodyD(SHAPES.triangle.pts, 1.2, 10, 80);
		eye(outline("square"), 30, 40, 9, 20, -6, 3, C);
		margin(outline("pill"), [1, 2, 3, 4]);
	};
	for (const name of NAMES) {
		const S = SHAPES[name];
		const [cx, cy, w, l] = specs(S.fy, S.fk, "idle")[0];
		const look = () => eyeD(eye(outline(name), cx, cy, w, l, 4, -2, C), 0.1, 50, S.oy);
		const rest = restPaths(name, "idle");
		const happy = restPaths(name, "happy");
		const gaze = look();
		other();
		assert.deepEqual(restPaths(name, "idle"), rest, name);
		assert.deepEqual(restPaths(name, "happy"), happy, name);
		assert.equal(look(), gaze, name);
		assert.match(rest.body, /^M[\d. -]+Q[\d. -]+(T[\d. -]+){35}Z$/, name);
		for (const d of [...rest.eyes, gaze]) assert.match(d, /^M[\d. -]+(C[\d. -]+){6}Z$/, name);
		for (const d of happy.eyes) assert.match(d, /^M[\d. -]+A[\d. -]+$/, name);
	}
	assert.equal(unturn([4, 4, 92, 92], 0, 50, 50), "matrix(1 0 0 1 0 0)");
});
