// Evry's geometry (WP-088), ported from the approved prototype's EvryGeo (OPS-84). It runs in node against the module
// both Evry components use; no browser. A silent break here draws a dented morph frame or an eye that pokes out of the
// body, which no screenshot of one frame would catch.
//   INV-convex: every shape and every morph blend of two shapes is convex.
//   INV-eyes-inside: rest eyes (idle and thinking) and eyes at full reach in 8 directions keep MARGIN inside the outline.
//   INV-foreshorten: an eye pushed toward the edge reports p in [0, 1] and, sideways, a narrower width; a flat side
//     does not bend it (bend under 0.001 of its length, against over 0.01 on the circle).
//   INV-deterministic: path data is the same string for the same input, so server and client markup match.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEF,
	MARGIN,
	N,
	NAMES,
	SHAPES,
	blend,
	bodyD,
	edges,
	eye,
	eyeD,
	happyD,
	margin,
	near,
	newEdges,
	reach,
	restPaths,
	specs,
	unturn,
} from "../../../packages/ui/src/foundations/evry-geo.ts";

const EPS = 1e-9;
const outline = (name) => edges(SHAPES[name].pts, newEdges());
const DIRS = Array.from({ length: 8 }, (_, i) => [Math.cos((i * Math.PI) / 4), Math.sin((i * Math.PI) / 4)]);

/** True when every turn of the closed polygon P (2N numbers) goes the same way. */
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

test("the module ports the prototype's constants and five shapes", () => {
	assert.equal(N, 36);
	assert.equal(MARGIN, 3.5);
	assert.deepEqual(NAMES, ["triangle", "circle", "square", "pill", "hexagon"]);
	assert.deepEqual(Object.keys(DEF), NAMES);
	for (const name of NAMES) assert.equal(SHAPES[name].pts.length, 2 * N, name);
});

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
			// The eye nearer the edge in this direction foreshortens.
			const lead = measures.reduce((a, b) => (b.p > a.p ? b : a));
			assert.ok(lead.p > 0, `${name} (${ux.toFixed(2)}, ${uy.toFixed(2)}): p ${lead.p}`);
			// Foreshortening runs along the outline normal: a sideways look thins the eye, a straight up or down look only
			// shortens it.
			if (Math.abs(ux) > 0.5)
				assert.ok(lead.width < 1, `${name} (${ux.toFixed(2)}, ${uy.toFixed(2)}): width ${lead.width}`);
			else assert.ok(lead.width <= 1 + EPS, `${name} (${ux.toFixed(2)}, ${uy.toFixed(2)}): width ${lead.width}`);
		}
	}
});

test("INV-foreshorten: a flat side never bends the eye", () => {
	const C = new Float64Array(38);
	// The square's sides and the hexagon's left and right sides are flat.
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
	// The circle is curved everywhere, so the eye at its edge bends.
	const S = SHAPES.circle;
	const E = outline("circle");
	const sp = specs(S.fy, S.fk, "idle");
	const r = reach(E, sp, 1, 0, MARGIN);
	const m = {};
	eye(E, sp[1][0], sp[1][1], sp[1][2], sp[1][3], r, 0, C, m);
	assert.ok(m.bend > 0.01, `circle: bend ${m.bend}`);
});

test("near reports the distance to the outline and an outward normal", () => {
	const E = outline("circle");
	const n = near(E, 50, 50);
	assert.ok(Math.abs(n.d - 46) < 0.5, `centre distance ${n.d}`);
	const right = near(E, 90, 50);
	assert.ok(right.nx > 0.99, `normal ${right.nx}`);
});

test("INV-deterministic: bodyD, eyeD, happyD and unturn return the same string for the same input", () => {
	const C = new Float64Array(38);
	for (const name of NAMES) {
		const S = SHAPES[name];
		assert.equal(bodyD(S.pts, 0.3, 50, S.oy), bodyD(S.pts, 0.3, 50, S.oy));
		const [cx, cy, w, l] = specs(S.fy, S.fk, "idle")[0];
		const a = eyeD(eye(outline(name), cx, cy, w, l, 4, -2, C), 0.1, 50, S.oy);
		const b = eyeD(eye(outline(name), cx, cy, w, l, 4, -2, C), 0.1, 50, S.oy);
		assert.equal(a, b);
		assert.equal(happyD(cx, cy, 5, 7, 0.2, 50, S.oy), happyD(cx, cy, 5, 7, 0.2, 50, S.oy));
		assert.deepEqual(restPaths(name, "idle"), restPaths(name, "idle"));
	}
	assert.equal(unturn([4, 4, 92, 92], 0.05, 50, 50), unturn([4, 4, 92, 92], 0.05, 50, 50));
	assert.match(bodyD(SHAPES.circle.pts, 0, 50, 50), /^M[\d. ]+Q[\d. ]+(T[\d. ]+){35}Z$/);
});

test("rest eyes are upright capsules of 0.11 by 0.23 of the size", () => {
	const S = SHAPES.circle;
	const C = new Float64Array(38);
	for (const [cx, cy, w, l] of specs(S.fy, S.fk, "idle")) {
		eye(null, cx, cy, w, l, 0, 0, C);
		const xs = [...C].filter((_, i) => i % 2 === 0);
		const ys = [...C].filter((_, i) => i % 2 === 1);
		assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - 11) < 1e-9);
		assert.ok(Math.abs(Math.max(...ys) - Math.min(...ys) - 23) < 1e-9);
	}
});
