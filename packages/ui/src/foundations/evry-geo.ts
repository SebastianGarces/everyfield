/**
 * Evry's pure geometry, ported from the approved prototype (design/everyfield-ui.html, `EvryGeo`, OPS-84). It has no
 * React and no DOM, so node tests and every Evry component (this package and the landing kit) share one source for the
 * five shapes, the eye model and their invariants. All coordinates are in the 100-unit SVG box.
 */

export type EvryShape = "triangle" | "circle" | "square" | "pill" | "hexagon";
type Point = readonly [number, number];
/** A shape: convex core points, corner radius, face offset down (x size), face scale. */
type ShapeDef = readonly [core: readonly Point[], radius: number, faceDown: number, faceScale: number];

export const N = 36;
const TAU = 2 * Math.PI;
const DPHI = TAU / N;
const NX = new Float64Array(N);
const NY = new Float64Array(N);
for (let i = 0; i < N; i++) {
	const a = DPHI * (i + 0.5) - Math.PI / 2;
	NX[i] = Math.cos(a);
	NY[i] = Math.sin(a);
}
const ring = (n: number, R: number, cy: number): Point[] =>
	Array.from({ length: n }, (_, k) => [
		50 + R * Math.cos((TAU * k) / n - Math.PI / 2),
		cy + R * Math.sin((TAU * k) / n - Math.PI / 2),
	]);

/**
 * Each shape is a convex core grown by a corner radius and sampled at the same N outward normals. A linear blend of two
 * shapes is then their Minkowski blend, so every morph frame is convex.
 */
export const DEF: Readonly<Record<EvryShape, ShapeDef>> = {
	triangle: [ring(3, 36.95, 59.95), 15, 0.16, 0.85],
	circle: [[[50, 50]], 46, 0, 1],
	square: [
		[
			[29, 29],
			[71, 29],
			[71, 71],
			[29, 71],
		],
		20,
		0,
		1,
	],
	pill: [
		[
			[30, 50],
			[70, 50],
		],
		27,
		0.025,
		1,
	],
	hexagon: [ring(6, 36.5, 50), 10.5, 0, 1],
};

export const NAMES = Object.keys(DEF) as EvryShape[];

/** A sampled shape: 2N outline points, the core's mean y (the spin pivot), face offset and face scale. */
export type ShapeData = { pts: Float64Array; oy: number; fy: number; fk: number };

export const SHAPES = Object.fromEntries(
	NAMES.map((name) => {
		const [core, r, fy, fk] = DEF[name];
		const pts = new Float64Array(2 * N);
		for (let i = 0; i < N; i++) {
			let v = core[0]!;
			for (const c of core) if (c[0] * NX[i]! + c[1] * NY[i]! > v[0] * NX[i]! + v[1] * NY[i]!) v = c;
			pts[2 * i] = v[0] + r * NX[i]!;
			pts[2 * i + 1] = v[1] + r * NY[i]!;
		}
		return [name, { pts, oy: core.reduce((s, c) => s + c[1], 0) / core.length, fy, fk }];
	}),
) as Record<EvryShape, ShapeData>;

export const isShape = (v: unknown): v is EvryShape => typeof v === "string" && v in DEF;

export function blend<T extends Float64Array>(out: T, A: ArrayLike<number>, B: ArrayLike<number>, t: number): T {
	for (let i = 0; i < out.length; i++) out[i] = A[i]! + (B[i]! - A[i]!) * t;
	return out;
}

/** Per-edge data of an outline: start, vector, squared length, outward normal, offset, curvature, scratch distance. */
export type Edges = Record<"ax" | "ay" | "ex" | "ey" | "l2" | "nx" | "ny" | "c" | "k" | "d", Float64Array>;

export function newEdges(): Edges {
	const f = () => new Float64Array(N);
	return { ax: f(), ay: f(), ex: f(), ey: f(), l2: f(), nx: f(), ny: f(), c: f(), k: f(), d: f() };
}

/** Edge i runs from point i to point i + 1 (clockwise on screen): outward normal, offset and curvature. */
export function edges(P: ArrayLike<number>, E: Edges): Edges {
	for (let i = 0; i < N; i++) {
		const j = (i + 1) % N;
		const ax = P[2 * i]!;
		const ay = P[2 * i + 1]!;
		const ex = P[2 * j]! - ax;
		const ey = P[2 * j + 1]! - ay;
		const len = Math.hypot(ex, ey);
		E.ax[i] = ax;
		E.ay[i] = ay;
		E.ex[i] = ex;
		E.ey[i] = ey;
		E.l2[i] = len * len;
		E.nx[i] = ey / len;
		E.ny[i] = -ex / len;
		E.c[i] = E.nx[i]! * ax + E.ny[i]! * ay;
		E.k[i] = DPHI / len;
	}
	return E;
}

export type Near = { d: number; nx: number; ny: number; k: number; kmax: number };
const NEAR: Near = { d: 0, nx: 0, ny: 0, k: 0, kmax: 0 };

/**
 * The nearest stretch of outline to (x, y): distance, outward normal and curvature, softly averaged over the closest
 * edges so they change smoothly as a point slides past a corner. kmax is the sharpest curvature among the closest edges.
 * The result object is shared and overwritten by the next call.
 */
export function near(E: Edges, x: number, y: number): Near {
	let dmin = Infinity;
	for (let i = 0; i < N; i++) {
		const t = Math.min(1, Math.max(0, ((x - E.ax[i]!) * E.ex[i]! + (y - E.ay[i]!) * E.ey[i]!) / E.l2[i]!));
		const d = (E.d[i] = Math.hypot(x - E.ax[i]! - t * E.ex[i]!, y - E.ay[i]! - t * E.ey[i]!));
		if (d < dmin) dmin = d;
	}
	let w = 0;
	let nx = 0;
	let ny = 0;
	let k = 0;
	let kmax = 0;
	for (let i = 0; i < N; i++) {
		const g = E.d[i]! - dmin;
		if (g > 9) continue;
		const wi = Math.exp(-g / 1.5);
		w += wi;
		nx += wi * E.nx[i]!;
		ny += wi * E.ny[i]!;
		k += wi * E.k[i]!;
		if (wi > 0.25 && E.k[i]! > kmax) kmax = E.k[i]!;
	}
	const nl = Math.hypot(nx, ny) || 1;
	NEAR.d = dmin;
	NEAR.nx = nx / nl;
	NEAR.ny = ny / nl;
	NEAR.k = k / w;
	NEAR.kmax = kmax;
	return NEAR;
}

/** Measures of one drawn eye: proximity, slant in degrees, width factor, bend, margin inside the outline, normal. */
export type EyeMeasure = { p: number; tilt: number; width: number; bend: number; margin: number; nx: number; ny: number };

const CAP = new Float64Array(38);

/**
 * Eye model. At rest an eye is an upright capsule w x l centred on (cx, cy). The gaze (gx, gy) moves it toward the
 * outline. Its proximity p runs from 0 at its rest distance to 1 near the edge. It then compresses along the outline
 * normal (foreshortening, which also slants it with the tangent), and its centre line bends with the outline's
 * curvature, concave toward the body. A flat side starts late and never bends, and a corner tighter than the eye is long
 * does not bend it either. out gets the 19 control points of 6 cubics; m, if given, gets the measures. d0, the rest
 * distance to the outline, is computed when not given. With no outline E the eye stays rigid.
 */
export function eye(
	E: Edges | null,
	cx: number,
	cy: number,
	w: number,
	l: number,
	gx: number,
	gy: number,
	out: Float64Array,
	m?: Partial<EyeMeasure> | null,
	d0?: number,
): Float64Array {
	let k = 1;
	let nx = 0;
	let ny = 0;
	let bend = 0;
	let p = 0;
	if (E && (gx || gy)) {
		if (d0 === undefined) d0 = near(E, cx, cy).d;
		const n = near(E, cx + gx, cy + gy);
		p = Math.min(1, Math.max(0, (d0 - n.d) / Math.max(1, d0 - w / 2 - 2.5)));
		p = Math.pow(p, 1 + 1.4 * (1 - Math.min(1, n.k * 46)));
		nx = n.nx;
		ny = n.ny;
		k = 1 - 0.52 * p;
		const curve = Math.max(0, n.k - 1 / 150) * 1.44;
		const wrap = Math.min(1, Math.max(0, (1 / n.kmax - 0.6 * l) / l));
		bend = p * wrap * wrap * (3 - 2 * wrap) * Math.min((l * l * curve) / 8, 0.08 * l) * nx;
	}
	const r = w / 2;
	const a = Math.max(0, l / 2 - r);
	const q = 0.5523 * r;
	const h = a + r;
	const s = 1 - k;
	CAP.set([
		r,
		-a,
		r,
		-a / 3,
		r,
		a / 3,
		r,
		a,
		r,
		a + q,
		q,
		a + r,
		0,
		a + r,
		-q,
		a + r,
		-r,
		a + q,
		-r,
		a,
		-r,
		a / 3,
		-r,
		-a / 3,
		-r,
		-a,
		-r,
		-a - q,
		-q,
		-a - r,
		0,
		-a - r,
		q,
		-a - r,
		r,
		-a - q,
		r,
		-a,
	]);
	for (let i = 0; i < 38; i += 2) {
		const y = CAP[i + 1]!;
		const x = CAP[i]! + bend * (1 - (y / h) * (y / h));
		const dot = nx * x + ny * y;
		out[i] = cx + gx + x - s * dot * nx;
		out[i + 1] = cy + gy + y - s * dot * ny;
	}
	if (m) {
		const vx = s * ny * nx;
		const vy = -1 + s * ny * ny;
		const vl = Math.hypot(vx, vy);
		const mx = bend - s * bend * nx * nx;
		const my = -s * bend * nx * ny;
		m.p = p;
		m.tilt = (Math.atan2(vx, -vy) * 180) / Math.PI;
		m.width = k / vl;
		m.bend = Math.abs(mx * vy - my * vx) / vl / (2 * (a + r) * vl);
		m.margin = E ? margin(E, out) : Infinity;
		m.nx = nx;
		m.ny = ny;
	}
	return out;
}

/** Smallest distance from the points to the outline, measured inside (negative means outside). */
export function margin(E: Edges, P: ArrayLike<number>): number {
	let m = Infinity;
	for (let i = 0; i < N; i++)
		for (let j = 0; j < P.length; j += 2) {
			const d = E.c[i]! - E.nx[i]! * P[j]! - E.ny[i]! * P[j + 1]!;
			if (d < m) m = d;
		}
	return m;
}

/** Rest geometry of one eye: centre x, centre y, width, length. */
export type EyeSpec = readonly [cx: number, cy: number, w: number, l: number];

const TMP = new Float64Array(38);

/** Widest gaze along (ux, uy) that keeps every eye at least `need` inside the outline. */
export function reach(E: Edges, specs: readonly EyeSpec[], ux: number, uy: number, need: number): number {
	let lo = 0;
	let hi = 40;
	for (let it = 0; it < 9; it++) {
		const g = (lo + hi) / 2;
		let ok = true;
		for (const [cx, cy, w, l] of specs)
			if (margin(E, eye(E, cx, cy, w, l, g * ux, g * uy, TMP)) < need) {
				ok = false;
				break;
			}
		if (ok) lo = g;
		else hi = g;
	}
	return lo;
}

const I = new Int32Array(2 * N);

/**
 * Body path data, turned by ang about (ox, oy). Drawn with midpoint smoothing: one quadratic per point, written as T
 * segments, so N points cost about 2N numbers. Points round to 0.01, midpoints are then exact.
 */
export function bodyD(P: ArrayLike<number>, ang: number, ox: number, oy: number): string {
	const c = Math.cos(ang);
	const s = Math.sin(ang);
	for (let i = 0; i < 2 * N; i += 2) {
		const dx = P[i]! - ox;
		const dy = P[i + 1]! - oy;
		I[i] = Math.round((ox + dx * c - dy * s) * 100);
		I[i + 1] = Math.round((oy + dx * s + dy * c) * 100);
	}
	const L = 2 * N - 2;
	let d = `M${(I[L]! + I[0]!) / 200} ${(I[L + 1]! + I[1]!) / 200}Q${I[0]! / 100} ${I[1]! / 100} ${(I[0]! + I[2]!) / 200} ${(I[1]! + I[3]!) / 200}`;
	for (let i = 2; i < 2 * N; i += 2) {
		const j = i === L ? 0 : i + 2;
		d += `T${(I[i]! + I[j]!) / 200} ${(I[i + 1]! + I[j + 1]!) / 200}`;
	}
	return d + "Z";
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Eye path data from the 19 control points of `eye`, turned by ang about (ox, oy). */
export function eyeD(C: ArrayLike<number>, ang: number, ox: number, oy: number): string {
	const c = Math.cos(ang);
	const s = Math.sin(ang);
	let d = "M";
	for (let j = 0; j < 38; j += 2) {
		const x = C[j]! - ox;
		const y = C[j + 1]! - oy;
		const sep = j === 2 || j === 8 || j === 14 || j === 20 || j === 26 || j === 32 ? "C" : j ? " " : "";
		d += `${sep}${r1(ox + x * c - y * s)} ${r1(oy + x * s + y * c)}`;
	}
	return d + "Z";
}

/** Happy eye: a round-capped arch (^) from (cx - hw, cy) over the top to (cx + hw, cy), turned by ang about (ox, oy). */
export function happyD(cx: number, cy: number, hw: number, hh: number, ang: number, ox: number, oy: number): string {
	const c = Math.cos(ang);
	const s = Math.sin(ang);
	const P = (x: number, y: number) => `${r1(ox + (x - ox) * c - (y - oy) * s)} ${r1(oy + (x - ox) * s + (y - oy) * c)}`;
	return `M${P(cx - hw, cy)}A${r1(hw)} ${r1(hh)} ${r1((ang * 180) / Math.PI)} 0 1 ${P(cx + hw, cy)}`;
}

const f4 = (v: number) => Math.round(v * 1e4) / 1e4;

/**
 * A gradientTransform, in objectBoundingBox units of the box [x0, y0, w, h], that turns a gradient back by angle a
 * (radians) about (cx, cy) in user space: W^-1 R(-a) W, with the matching offset.
 */
export function unturn(box: readonly [number, number, number, number], a: number, cx: number, cy: number): string {
	const [x0, y0, w, h] = box;
	const c = Math.cos(a);
	const s = Math.sin(a);
	const dx = x0 - cx;
	const dy = y0 - cy;
	return `matrix(${f4(c)} ${f4((-s * w) / h)} ${f4((s * h) / w)} ${f4(c)} ${f4((c * dx + s * dy - dx) / w)} ${f4((c * dy - s * dx - dy) / h)})`;
}

// ---- Face layout, shared by the life loop and the server render ----

/** Eye centres before the per-shape offset, and [width, length] per mood, in box units. */
export const EYE_X = [37.5, 62.5] as const;
export const EYE_Y = 47.5;
export type EyeMood = "idle" | "thinking" | "happy";
const EYE: Record<"idle" | "thinking", readonly [number, number]> = { idle: [11, 23], thinking: [10.15, 16] };
/** The smallest distance every eye keeps inside the outline. */
export const MARGIN = 3.5;

/** Rest geometry of each eye in the 100-unit box after a face offset fy and scale fk. */
export function specs(fy: number, fk: number, mood: EyeMood): [EyeSpec, EyeSpec] {
	const [w, l] = mood === "thinking" ? EYE.thinking : EYE.idle;
	const at = (x: number): EyeSpec => [50 + (x - 50) * fk, 50 + (EYE_Y - 50) * fk + 100 * fy, w * fk, l * fk];
	return [at(EYE_X[0]), at(EYE_X[1])];
}

/** The happy arch of eye j (0 left, 1 right) on the face (fy, fk), turned by ang about (50, oy). */
export function happyEyeD(sp: EyeSpec, j: number, fk: number, ang: number, oy: number): string {
	const [cx, cy] = sp;
	return happyD(cx + (j ? -1.5 : 1.5) * fk, cy + 2.5 * fk, 5.25 * fk, 7.25 * fk, ang, 50, oy);
}

/** Path data of a still bot: the shape at rest with its rest eyes, as the server renders it. */
export function restPaths(shape: EvryShape, mood: EyeMood): { body: string; eyes: [string, string] } {
	const S = SHAPES[shape];
	const sp = specs(S.fy, S.fk, mood);
	const C = new Float64Array(38);
	const one = (j: number) =>
		mood === "happy"
			? happyEyeD(sp[j]!, j, S.fk, 0, S.oy)
			: eyeD(eye(null, sp[j]![0], sp[j]![1], sp[j]![2], sp[j]![3], 0, 0, C), 0, 50, S.oy);
	return { body: bodyD(S.pts, 0, 50, S.oy), eyes: [one(0), one(1)] };
}
