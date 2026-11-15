export type EvryShape = "triangle" | "circle" | "square" | "pill" | "hexagon";
type Point = readonly [number, number];
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

export function blend<T extends Float64Array>(out: T, A: ArrayLike<number>, B: ArrayLike<number>, t: number): T {
	for (let i = 0; i < out.length; i++) out[i] = A[i]! + (B[i]! - A[i]!) * t;
	return out;
}

export type Edges = Record<"ax" | "ay" | "ex" | "ey" | "l2" | "nx" | "ny" | "c" | "k" | "d", Float64Array>;

export function newEdges(): Edges {
	const f = () => new Float64Array(N);
	return { ax: f(), ay: f(), ex: f(), ey: f(), l2: f(), nx: f(), ny: f(), c: f(), k: f(), d: f() };
}

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

export type EyeMeasure = {
	p: number;
	tilt: number;
	width: number;
	bend: number;
	margin: number;
	nx: number;
	ny: number;
};

const CAP = new Float64Array(38);

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

export function margin(E: Edges, P: ArrayLike<number>): number {
	let m = Infinity;
	for (let i = 0; i < N; i++)
		for (let j = 0; j < P.length; j += 2) {
			const d = E.c[i]! - E.nx[i]! * P[j]! - E.ny[i]! * P[j + 1]!;
			if (d < m) m = d;
		}
	return m;
}

export type EyeSpec = readonly [cx: number, cy: number, w: number, l: number];

const TMP = new Float64Array(38);

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

export function happyD(cx: number, cy: number, hw: number, hh: number, ang: number, ox: number, oy: number): string {
	const c = Math.cos(ang);
	const s = Math.sin(ang);
	const P = (x: number, y: number) => `${r1(ox + (x - ox) * c - (y - oy) * s)} ${r1(oy + (x - ox) * s + (y - oy) * c)}`;
	return `M${P(cx - hw, cy)}A${r1(hw)} ${r1(hh)} ${r1((ang * 180) / Math.PI)} 0 1 ${P(cx + hw, cy)}`;
}

const f4 = (v: number) => Math.round(v * 1e4) / 1e4;

export function unturn(box: readonly [number, number, number, number], a: number, cx: number, cy: number): string {
	const [x0, y0, w, h] = box;
	const c = Math.cos(a);
	const s = Math.sin(a);
	const dx = x0 - cx;
	const dy = y0 - cy;
	return `matrix(${f4(c)} ${f4((-s * w) / h)} ${f4((s * h) / w)} ${f4(c)} ${f4((c * dx + s * dy - dx) / w)} ${f4((c * dy - s * dx - dy) / h)})`;
}

const EYE_X = [37.5, 62.5] as const;
const EYE_Y = 47.5;
export type EyeMood = "idle" | "thinking" | "happy";
const EYE: Record<"idle" | "thinking", readonly [number, number]> = { idle: [11, 23], thinking: [10.15, 16] };
export const MARGIN = 3.5;

export function specs(fy: number, fk: number, mood: EyeMood): [EyeSpec, EyeSpec] {
	const [w, l] = mood === "thinking" ? EYE.thinking : EYE.idle;
	const at = (x: number): EyeSpec => [50 + (x - 50) * fk, 50 + (EYE_Y - 50) * fk + 100 * fy, w * fk, l * fk];
	return [at(EYE_X[0]), at(EYE_X[1])];
}

export function happyEyeD(sp: EyeSpec, j: number, fk: number, ang: number, oy: number): string {
	const [cx, cy] = sp;
	return happyD(cx + (j ? -1.5 : 1.5) * fk, cy + 2.5 * fk, 5.25 * fk, 7.25 * fk, ang, 50, oy);
}

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
