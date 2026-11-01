/**
 * Evry's life loop, ported from the approved prototype (design/everyfield-ui.html, `EvryLife`, OPS-84). DOM only, no
 * React: a component renders the SVG and hands its nodes to `mountEvry`. Every bot on the page shares one loop: frames
 * while a visible bot moves, else one timer to the next due action. Frames write only changed SVG attributes and read no
 * layout. Bots off screen, on a hidden page or inside a closed `[data-open="false"]` host do no work. Under reduced
 * motion every bot is still.
 *
 * The root carries the observable state: data-shape (the current shape), data-blink while a blink runs, data-act (look,
 * tilt or sway) while an idle act runs, and data-eb once the loop owns the bot.
 */
import {
	blend,
	edges,
	eye,
	eyeD,
	bodyD,
	happyEyeD,
	MARGIN,
	N,
	NAMES,
	near,
	newEdges,
	reach,
	SHAPES,
	specs,
	unturn,
	type Edges,
	type EvryShape,
	type EyeMood,
} from "./evry-geo";

export type EvryNodes = {
	root: HTMLElement;
	path: SVGPathElement;
	g: SVGGElement;
	eyes: readonly [SVGPathElement, SVGPathElement];
	hl: SVGRadialGradientElement;
	sh: SVGLinearGradientElement;
};
export type EvryLifeOptions = {
	/** Bots smaller than xl draw every second frame. */
	small: boolean;
	mood: EyeMood;
	/** The first shape, and the only shape while held or under reduced motion. */
	shape: EvryShape | undefined;
	hold: boolean;
	follow: boolean;
};
export type EvryHandle = { update(options: EvryLifeOptions): void; unmount(): void };

type Move = {
	from: number[];
	to: number[];
	t0: number;
	ta: number;
	tt: number;
	ts: number;
	a: number;
	o: number;
};
type Look = {
	u: readonly [number, number];
	m: number;
	t0: number;
	g0: [number, number];
	rigid?: boolean;
	rest?: boolean;
};
type Follow = { vx: number; vy: number; t: number; u: [number, number]; m: number; until: number; rest: boolean };
type Morph = {
	from: EvryShape;
	A: Float64Array;
	B: Float64Array;
	f0: [number, number, number];
	f1: [number, number, number];
	t0: number;
	ms: number;
	e: number;
};
type ActKind = "look" | "tilt" | "sway";
type Act = { kind: ActKind; eyes: Move[] | null; body: Move[]; end: number };
type Drawn = {
	tx: number;
	ty: number;
	ptx?: number;
	pty?: number;
	tilt?: number;
	bx?: number;
	by?: number;
	ver?: number;
	mood?: EyeMood;
	fy?: number;
	fk?: number;
	gx?: number;
	gy?: number;
	ang?: number;
};
type Bot = {
	n: EvryNodes;
	o: EvryLifeOptions;
	host: HTMLElement | null;
	hostObserver: MutationObserver | null;
	vis: boolean;
	mood: EyeMood;
	P: Float64Array;
	E: Edges;
	C: Float64Array;
	ver: number;
	ever: number;
	bver: number;
	bb: [number, number, number, number];
	d0: [number, number];
	d0ver: number;
	rm: [EvryShape | "", EvryShape | "", EyeMood | "", number, number, number, number];
	next: number;
	shape: EvryShape;
	fy: number;
	fk: number;
	oy: number;
	ang: number;
	morph: Morph | null;
	spin: { t0: number; ms: number } | null;
	moves: Move[] | null;
	follow: Follow | null;
	look: Look | null;
	gx: number;
	gy: number;
	due: { blink: number; unblink: number; dbl: boolean; act: number; spin: number; morph: number };
	w: Record<string, string>;
	drawn: Drawn;
	B: number[];
	bmoves: Move[] | null;
	moved: boolean;
	acting: boolean;
	active: boolean;
};

const TAU = 2 * Math.PI;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const inOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(2 - 2 * t, 3) / 2);
const smooth = (t: number) => t * t * (3 - 2 * t);
/** Eased out: still at both ends, fastest at a quarter. */
const travel = (t: number) => 1 - Math.pow(1 - t, 4) * (1 + 4 * t);
const unit = (x: number, y: number): [number, number] => {
	const l = Math.hypot(x, y) || 1;
	return [x / l, y / l];
};
const REACH = 0.92;
/**
 * Body pose: a tilt in degrees about a point low in the body (y = PIVOT), so the top leans further than the base, and a
 * shift in box units. The gaze adds a lean of LEAN degrees at full turn.
 */
const DEG = Math.PI / 180;
const PIVOT = 84;
const LEAN = 3;
/**
 * Thinking looks up and to the right, at a little under half of its reach, with rigid upright eyes. During a morph it
 * keeps the smaller reach of the two shapes, so its eyes hold still.
 */
const think = (now: number, g0: [number, number]): Look => ({ u: [0.55, -0.835], m: 0.45, t0: now, g0, rigid: true });

// Widest gaze per shape, mood and direction, shared by every bot. A morph blends the two ends' reach: an eye that fits
// shape A at one gaze and shape B at another fits each blend in between.
let shapeEdges: Record<EvryShape, Edges> | null = null;
const RC = new Map<string, number>();
function reachOf(name: EvryShape, mood: EyeMood, ux: number, uy: number) {
	const key = name + mood + ux.toFixed(3) + uy.toFixed(3);
	let r = RC.get(key);
	if (r === undefined) {
		shapeEdges ??= Object.fromEntries(NAMES.map((n) => [n, edges(SHAPES[n].pts, newEdges())])) as Record<
			EvryShape,
			Edges
		>;
		const S = SHAPES[name];
		if (RC.size > 4000) RC.clear();
		RC.set(key, (r = reach(shapeEdges[name], specs(S.fy, S.fk, mood), ux, uy, MARGIN)));
	}
	return r;
}
function reachNow(st: Bot, ux: number, uy: number) {
	const m = st.morph;
	const from = m ? m.from : st.shape;
	const c = st.rm;
	if (c[0] !== st.shape || c[1] !== from || c[2] !== st.mood || c[3] !== ux || c[4] !== uy) {
		c[0] = st.shape;
		c[1] = from;
		c[2] = st.mood;
		c[3] = ux;
		c[4] = uy;
		c[5] = reachOf(from, st.mood, ux, uy);
		c[6] = reachOf(st.shape, st.mood, ux, uy);
	}
	return m ? c[5] + (c[6] - c[5]) * m.e : c[6];
}

// ---- the page: one set of listeners while any bot is mounted
const bots: Bot[] = [];
let live: Bot[] = [];
let raf = 0;
let timer: ReturnType<typeof setTimeout> | 0 = 0;
let frame = 0;
let reduced = false;
let page: { mq: MediaQueryList; io: IntersectionObserver; off: () => void } | null = null;
const byEl = new WeakMap<Element, Bot>();

const visible = (st: Bot) => st.vis && !(st.host && st.host.dataset.open === "false");
const refresh = () => {
	live = bots.filter(visible);
};

function start() {
	const mq = matchMedia("(prefers-reduced-motion: reduce)");
	// Read .matches once: Chromium skips a list's change event when script read .matches after the preference changed,
	// so the loop reads this copy and only the change event updates it.
	reduced = mq.matches;
	const io = new IntersectionObserver(
		(list) => {
			const now = performance.now();
			for (const e of list) {
				const st = byEl.get(e.target);
				if (!st) continue;
				if (e.isIntersecting && !st.vis) arm(st, now);
				st.vis = e.isIntersecting;
			}
			refresh();
			wake();
		},
		{ rootMargin: "64px" },
	);
	const onPref = (e: MediaQueryListEvent) => {
		reduced = e.matches;
		halt();
		for (const st of bots) applyPref(st);
		wake();
	};
	const onVisibility = () => {
		if (document.hidden) return halt();
		const now = performance.now();
		for (const st of live) arm(st, now);
		wake();
	};
	mq.addEventListener("change", onPref);
	document.addEventListener("visibilitychange", onVisibility);
	document.addEventListener("pointermove", onPointer, { passive: true });
	page = {
		mq,
		io,
		off: () => {
			mq.removeEventListener("change", onPref);
			document.removeEventListener("visibilitychange", onVisibility);
			document.removeEventListener("pointermove", onPointer);
			io.disconnect();
		},
	};
}

/** Starts the life of one rendered bot. The nodes must stay mounted until `unmount`. */
export function mountEvry(nodes: EvryNodes, options: EvryLifeOptions): EvryHandle {
	if (!page) start();
	const host = nodes.root.parentElement?.closest<HTMLElement>("[data-open]") ?? null;
	const st: Bot = {
		n: nodes,
		o: options,
		host,
		hostObserver: null,
		vis: false,
		mood: options.mood,
		P: new Float64Array(2 * N),
		E: newEdges(),
		C: new Float64Array(38),
		ver: 0,
		ever: -1,
		bver: -1,
		bb: [0, 0, 0, 0],
		d0: [0, 0],
		d0ver: -1,
		rm: ["", "", "", 0, 0, 0, 0],
		next: 0,
		shape: "circle",
		fy: 0,
		fk: 1,
		oy: 50,
		ang: 0,
		morph: null,
		spin: null,
		moves: null,
		follow: null,
		look: null,
		gx: 0,
		gy: 0,
		due: { blink: 0, unblink: 0, dbl: false, act: 0, spin: 0, morph: 0 },
		w: {},
		drawn: { tx: 0, ty: 0 },
		B: [0, 0, 0],
		bmoves: null,
		moved: false,
		acting: false,
		active: false,
	};
	bots.push(st);
	byEl.set(nodes.root, st);
	if (host) {
		st.hostObserver = new MutationObserver(() => {
			if (host.dataset.open !== "false") arm(st, performance.now());
			refresh();
			wake();
		});
		st.hostObserver.observe(host, { attributes: true, attributeFilter: ["data-open"] });
	}
	setShape(st, options.shape ?? NAMES[Math.floor(Math.random() * NAMES.length)]!);
	nodes.root.setAttribute("data-eb", "");
	applyPref(st);
	page!.io.observe(nodes.root);
	return {
		update(next) {
			const prev = st.o;
			st.o = next;
			if (next.shape !== prev.shape || next.hold !== prev.hold) {
				// A new labelled shape shows at once; a released hold morphs again on its own schedule.
				if (next.shape && next.shape !== prev.shape) {
					setShape(st, next.shape);
					draw(st, true);
				}
				st.next = 0;
			}
			if (!next.follow && st.follow) {
				st.follow = null;
				st.moves = [move([st.gx, st.gy], [0, 0], performance.now(), 0, 0)];
			}
			if (next.mood !== prev.mood) onMood(st);
			wake();
		},
		unmount() {
			bots.splice(bots.indexOf(st), 1);
			byEl.delete(nodes.root);
			st.hostObserver?.disconnect();
			page?.io.unobserve(nodes.root);
			refresh();
			if (!bots.length) {
				halt();
				page?.off();
				page = null;
			}
		},
	};
}

function setShape(st: Bot, name: EvryShape) {
	const S = SHAPES[name];
	st.P.set(S.pts);
	st.fy = S.fy;
	st.fk = S.fk;
	st.oy = S.oy;
	st.morph = null;
	st.ver++;
	showShape(st, name);
}
function showShape(st: Bot, name: EvryShape) {
	st.shape = name;
	if (st.n.root.dataset.shape !== name) st.n.root.dataset.shape = name;
}
function arm(st: Bot, now: number) {
	const d = st.due;
	st.next = 0;
	d.blink = now + rand(600, 5000);
	d.unblink = 0;
	d.dbl = false;
	d.act = now + rand(300, 1500);
	st.moved = false;
	d.spin = now + rand(8000, 30000);
	d.morph = now + rand(2500, 8000);
}
function edgesNow(st: Bot) {
	if (st.ever !== st.ver) {
		edges(st.P, st.E);
		st.ever = st.ver;
	}
	return st.E;
}

// ---- actions
function startMorph(st: Bot, name: EvryShape, ms: number, now: number) {
	const S = SHAPES[name];
	st.morph = {
		from: st.shape,
		A: Float64Array.from(st.P),
		B: S.pts,
		f0: [st.fy, st.fk, st.oy],
		f1: [S.fy, S.fk, S.oy],
		t0: now,
		ms,
		e: 0,
	};
	showShape(st, name);
}
/**
 * One gaze move: a small anticipation the other way, an eased travel past the target, a settle. Near the widest reach
 * the anticipation and the overshoot shrink so the eyes stay inside.
 */
function move(from: number[], to: number[], t0: number, rfrom: number, rto: number): Move {
	const dist = Math.hypot(to[0]! - from[0]!, to[1]! - from[1]!) || 1;
	const room = (r: number) => (r ? ((1.04 - REACH) * r) / dist : 1);
	return {
		from,
		to,
		t0,
		ta: rand(70, 110),
		tt: rand(260, 340),
		ts: rand(170, 250),
		a: Math.min(rand(0.04, 0.065), room(rfrom)),
		o: Math.min(rand(0.04, 0.065), room(rto)),
	};
}
const moveEnd = (mv: Move) => mv.t0 + mv.ta + mv.tt + mv.ts;
function prof(mv: Move, t: number) {
	if (t < mv.ta) return -mv.a * smooth(t / mv.ta);
	t -= mv.ta;
	if (t < mv.tt) return -mv.a + (1 + mv.o + mv.a) * travel(t / mv.tt);
	t -= mv.tt;
	if (t < mv.ts) return 1 + mv.o - mv.o * smooth(t / mv.ts);
	return 1;
}
/** A look-around: to one side (level or up), then to the other side or straight back to centre. A short one never looks to the second side. */
function glancePlan(st: Bot, now: number, one?: boolean) {
	const side = Math.random() < 0.5 ? -1 : 1;
	const moves: Move[] = [];
	let t = now;
	let from = [st.gx, st.gy];
	let rf = st.gx || st.gy ? reachNow(st, ...unit(st.gx, st.gy)) : 0;
	const go = (s: number) => {
		const u = unit(s, rand(-0.75, 0.2));
		const r = reachNow(st, u[0], u[1]);
		const to = [u[0] * r * REACH, u[1] * r * REACH];
		const mv = move(from, to, t, rf, r);
		moves.push(mv);
		t = moveEnd(mv) + rand(650, 1100);
		from = to;
		rf = r;
	};
	go(side);
	if (!one && Math.random() < 0.55) go(-side);
	moves.push(move(from, [0, 0], t, rf, 0));
	return moves;
}
/**
 * Idle acts fill each hold between two morphs, so idle Evry never only blinks. A look turns the eyes and the body leans
 * after them. A tilt rocks the body to one side, sometimes to the other, and back. A sway shifts it sideways, often a
 * little up, with a small lean. Body moves use the gaze's eased profile, a little slower, as a heavier part would. Poses
 * are [tilt, x, y].
 */
const ACTS: Record<"first" | "later", [ActKind, number][]> = {
	first: [
		["look", 0.8],
		["tilt", 0.12],
		["sway", 0.08],
	],
	later: [
		["look", 0.65],
		["tilt", 0.22],
		["sway", 0.13],
	],
};
const pick = (w: [ActKind, number][]) => {
	let r = Math.random();
	for (const [k, p] of w) if ((r -= p) < 0) return k;
	return w[0]![0];
};
const bmove = (from: number[], to: number[], t0: number): Move => ({
	from,
	to,
	t0,
	ta: rand(90, 140),
	tt: rand(400, 540),
	ts: rand(240, 340),
	a: rand(0.05, 0.09),
	o: rand(0.05, 0.1),
});
function actPlan(st: Bot, now: number, kind: ActKind, one?: boolean): Act {
	const side = Math.random() < 0.5 ? -1 : 1;
	const body: Move[] = [];
	let eyes: Move[] | null = null;
	let t = now;
	let from = [0, 0, 0];
	const to = (pose: number[], at: number) => {
		const mv = bmove(from, pose, Math.max(at, t));
		body.push(mv);
		t = moveEnd(mv);
		from = pose;
	};
	if (kind === "look") {
		eyes = glancePlan(st, now, one);
		for (const mv of eyes) {
			const s = Math.abs(mv.to[0]!) > 2 ? Math.sign(mv.to[0]!) : 0;
			to([s * rand(2.5, 5), 0, mv.to[1]! < -4 ? -rand(0.6, 1.4) : 0], mv.t0 + rand(50, 110));
		}
	} else if (kind === "tilt") {
		to([side * rand(4.5, 8.5), 0, 0], now);
		t += rand(300, 800);
		if (!one && Math.random() < 0.45) {
			to([-side * rand(3.5, 7), 0, 0], t);
			t += rand(250, 600);
		}
		to([0, 0, 0], t);
	} else {
		to([side * rand(3, 4), side * rand(1.5, 2.5), -rand(0, 1.8)], now);
		t += rand(250, 650);
		if (!one && Math.random() < 0.5) {
			to([-side * rand(3, 4), -side * rand(1.5, 2.5), -rand(0, 1.2)], t);
			t += rand(200, 500);
		}
		to([0, 0, 0], t);
	}
	return { kind, eyes, body, end: Math.max(t, eyes ? moveEnd(eyes[eyes.length - 1]!) : 0) };
}
/**
 * The full act if it ends before the next morph, else its short form, else none (or, with force, the short form, and the
 * caller moves the morph back).
 */
function fitAct(st: Bot, now: number, kind: ActKind, force: boolean) {
	const room = st.due.morph - 250;
	let a = actPlan(st, now, kind);
	if (a.end > room) a = actPlan(st, now, kind, true);
	return a.end <= room || force ? a : null;
}
function startAct(st: Bot, a: Act) {
	st.moves = a.eyes;
	st.bmoves = a.body;
	st.moved = true;
	st.acting = true;
	st.n.root.dataset.act = a.kind;
}
/** Ease the body back to rest from wherever it is (a pointer follow or a mood change cut the act). */
function settle(st: Bot, now: number) {
	st.bmoves = st.bmoves || st.B.some((v) => v) ? [bmove(st.B.slice(), [0, 0, 0], now)] : null;
}
function onMood(st: Bot) {
	const mood = st.o.mood;
	const now = performance.now();
	if (mood === st.mood) return;
	st.mood = mood;
	st.follow = null;
	st.next = 0;
	st.moved = false;
	if (reduced) {
		st.moves = st.look = null;
		st.gx = st.gy = 0;
		draw(st, false);
		return;
	}
	if (mood === "thinking") {
		st.moves = null;
		st.look = think(now, [st.gx, st.gy]);
	} else {
		st.look = null;
		st.moves = st.gx || st.gy ? [move([st.gx, st.gy], [0, 0], now, 0, 0)] : null;
	}
	settle(st, now);
	draw(st, false);
	wake();
}

// ---- planning: start the actions that are due on one visible bot
function plan(st: Bot, now: number) {
	const d = st.due;
	const root = st.n.root;
	// Blinks are a CSS animation on the eye paths; the loop only sets and clears data-blink.
	if (d.unblink && now >= d.unblink) {
		root.removeAttribute("data-blink");
		d.unblink = 0;
	}
	if (now >= d.blink) {
		if (st.mood !== "happy") {
			root.setAttribute("data-blink", "");
			d.unblink = now + 190;
		}
		if (!d.dbl && Math.random() < 0.2) {
			d.blink = now + 320;
			d.dbl = true;
		} else {
			d.blink = now + rand(2200, 6500);
			d.dbl = false;
		}
	}
	if (st.mood === "thinking" && d.morph - now > 2000) d.morph = now + rand(800, 2000);
	if (st.follow && now >= st.follow.until) {
		st.follow = null;
		st.moves = [move([st.gx, st.gy], [0, 0], now, reachNow(st, ...unit(st.gx, st.gy)), 0)];
		d.act = Math.max(d.act, now + rand(2500, 5000));
	}
	if (st.morph || st.spin || st.moves || st.follow || st.bmoves) return;
	// An idle hold ends only after its first act (below), so no hold between two morphs only blinks.
	const hold = st.o.hold;
	const idle = !hold && st.mood === "idle";
	if (!hold && now >= d.morph && (st.moved || !idle)) {
		const others = NAMES.filter((n) => n !== st.shape);
		const thinking = st.mood === "thinking";
		const ms = thinking ? rand(450, 600) : rand(600, 1000);
		startMorph(st, others[Math.floor(Math.random() * others.length)]!, ms, now);
		d.morph = now + ms + (thinking ? rand(1000, 1900) : rand(2600, 7700));
		d.act = now + ms + rand(200, 700);
		st.moved = false;
		return;
	}
	if (!idle) return;
	// A spin or a glance starts only when it ends before the next morph.
	if (now >= d.spin) {
		const ms = rand(900, 1200);
		if (d.morph - now > ms + 250) {
			st.spin = { t0: now, ms };
			d.spin = now + rand(20000, 40000);
			return;
		}
		d.spin = d.morph + rand(1500, 4000);
	}
	// Every idle hold gets one act soon after its morph (after a spin that was due). The next morph waits for it if it must.
	if (!st.moved && (now >= d.act || now >= d.morph)) {
		const a = fitAct(st, now, pick(ACTS.first), true)!;
		startAct(st, a);
		d.morph = Math.max(d.morph, a.end + 250);
		d.act = a.end + rand(300, 1200);
		return;
	}
	// More acts while the hold has room and no spin falls due during them; the next morph sets a new first act.
	if (now >= d.act) {
		const a = fitAct(st, now, pick(ACTS.later), false);
		if (a && a.end < d.spin) {
			startAct(st, a);
			d.act = a.end + rand(300, 1200);
		} else d.act = a ? d.spin : d.morph;
	}
}

// ---- one frame of one bot; returns true while it still animates
const GV = [0, 0];
function step(st: Bot, now: number) {
	let body = false;
	const m = st.morph;
	if (m) {
		const t = Math.min(1, (now - m.t0) / m.ms);
		const e = (m.e = inOut(t));
		blend(st.P, m.A, m.B, e);
		st.fy = m.f0[0] + (m.f1[0] - m.f0[0]) * e;
		st.fk = m.f0[1] + (m.f1[1] - m.f0[1]) * e;
		st.oy = m.f0[2] + (m.f1[2] - m.f0[2]) * e;
		st.ver++;
		body = true;
		if (t >= 1) st.morph = null;
	}
	if (st.spin) {
		const t = Math.min(1, (now - st.spin.t0) / st.spin.ms);
		st.ang = TAU * inOut(t);
		body = true;
		if (t >= 1) {
			st.spin = null;
			st.ang = 0;
		}
	}
	if (st.follow) {
		// Pointer follow: a damped spring (stiffness 260, damping ratio 0.7) toward the pointer's side.
		const f = st.follow;
		const R = reachNow(st, f.u[0], f.u[1]);
		const tx = f.u[0] * f.m * R;
		const ty = f.u[1] * f.m * R;
		const dt = Math.min(0.034, (now - f.t) / 1000);
		f.t = now;
		f.vx += (260 * (tx - st.gx) - 22.6 * f.vx) * dt;
		f.vy += (260 * (ty - st.gy) - 22.6 * f.vy) * dt;
		st.gx += f.vx * dt;
		st.gy += f.vy * dt;
		const gl = Math.hypot(st.gx, st.gy);
		const cap = 1.04 * R;
		if (gl > cap) {
			st.gx *= cap / gl;
			st.gy *= cap / gl;
		}
		f.rest =
			Math.abs(tx - st.gx) < 0.02 && Math.abs(ty - st.gy) < 0.02 && Math.abs(f.vx) < 0.05 && Math.abs(f.vy) < 0.05;
	} else if (st.moves) {
		st.moves = advance(st.moves, now, GV);
		st.gx = GV[0]!;
		st.gy = GV[1]!;
	} else if (st.look) {
		const L = st.look;
		const t = Math.min(1, (now - L.t0) / 450);
		const e = inOut(t);
		let R = reachNow(st, L.u[0], L.u[1]);
		if (L.rigid && st.morph) R = Math.min(st.rm[5], st.rm[6]);
		st.gx = L.g0[0] + (L.u[0] * L.m * R - L.g0[0]) * e;
		st.gy = L.g0[1] + (L.u[1] * L.m * R - L.g0[1]) * e;
		L.rest = t >= 1 && !st.morph;
	}
	if (st.bmoves) st.bmoves = advance(st.bmoves, now, st.B);
	if (st.acting && !st.moves && !st.bmoves) {
		st.acting = false;
		st.n.root.removeAttribute("data-act");
	}
	draw(st, body);
	// Between the moves of a look-around or an act the bot holds still, so the loop can sleep until the next one.
	const busy = (l: Move[] | null) => !!l && (now < moveEnd(l[0]!) || (l.length > 1 && now >= l[1]!.t0));
	return !!(
		st.morph ||
		st.spin ||
		busy(st.moves) ||
		busy(st.bmoves) ||
		(st.follow && !st.follow.rest) ||
		(st.look && !st.look.rest)
	);
}
/** Run a list of moves: write the position now to out; return the list, or null once the last settled. */
function advance(list: Move[], now: number, out: number[]) {
	let mv = list[0]!;
	while (list.length > 1 && now >= list[1]!.t0) {
		list.shift();
		mv = list[0]!;
	}
	const k = now < mv.t0 ? 0 : prof(mv, now - mv.t0);
	for (let i = 0; i < out.length; i++) out[i] = mv.from[i]! + (mv.to[i]! - mv.from[i]!) * k;
	return list.length === 1 && now >= moveEnd(mv) ? null : list;
}

// ---- DOM writes: path d, two gradient attributes and one group transform, each only on change
function set(st: Bot, node: Element, key: string, name: string, v: string) {
	if (st.w[key] !== v) {
		st.w[key] = v;
		if (v) node.setAttribute(name, v);
		else node.removeAttribute(name);
	}
}
function draw(st: Bot, body: boolean) {
	const ox = 50;
	const oy = st.oy;
	const B = st.B;
	const D = st.drawn;
	const n = st.n;
	if (body) set(st, n.path, "d", "d", bodyD(st.P, st.ang, ox, oy));
	const gxn = Math.max(-1, Math.min(1, st.gx / 18));
	const gyn = Math.max(-1, Math.min(1, st.gy / 18));
	const still = Math.abs(gxn) + Math.abs(gyn) < 0.01;
	// Fake 3D: during a gaze the body narrows as it turns and the highlight slides the other way, so the flat shape reads
	// as a turning solid. The turn updates by visible steps and always at rest.
	if (still || Math.abs(gxn - D.tx) + Math.abs(gyn - D.ty) > 0.05) {
		D.tx = still ? 0 : gxn;
		D.ty = still ? 0 : gyn;
	}
	// Body pose: the tilt (a lean toward the gaze plus the idle act's tilt, in 0.2 degree steps) about a point low in the
	// body, and the act's shift (0.05 unit steps). Steps stay under 0.2 px at 96 px and skip writes while a move settles.
	// The group turns and both gradients turn back by the same angle about the body's centre, so the highlight, the
	// shading and the drop shadow stay at the upper left of the body, as in a spin. A tilt frame writes three short
	// attributes, no path.
	const tilt = Math.round(((still ? 0 : LEAN * gxn) + B[0]!) * 5) / 5;
	const ver = tilt ? st.ver : 0;
	const bx = Math.round(B[1]! * 20) / 20;
	const by = Math.round(B[2]! * 20) / 20;
	if (D.tilt !== tilt || D.bx !== bx || D.by !== by || D.ptx !== D.tx || D.pty !== D.ty || D.ver !== ver) {
		D.tilt = tilt;
		D.bx = bx;
		D.by = by;
		D.ptx = D.tx;
		D.pty = D.ty;
		D.ver = ver;
		let back = "";
		if (tilt) {
			const b = bbox(st);
			back = unturn(b, tilt * DEG, b[0] + b[2] / 2, b[1] + b[3] / 2);
		}
		set(st, n.sh, "sh", "gradientTransform", back);
		set(
			st,
			n.hl,
			"hl",
			"gradientTransform",
			(back + (D.tx || D.ty ? ` translate(${(-0.09 * D.tx).toFixed(3)} ${(-0.06 * D.ty).toFixed(3)})` : "")).trim(),
		);
		set(
			st,
			n.g,
			"g",
			"transform",
			(
				(bx || by ? `translate(${bx} ${by}) ` : "") +
				(D.tx || D.ty
					? `translate(50 50) scale(${(1 - 0.035 * Math.abs(D.tx)).toFixed(4)} ${(1 - 0.02 * Math.abs(D.ty)).toFixed(4)}) translate(-50 -50) `
					: "") +
				(tilt ? `rotate(${tilt} 50 ${PIVOT})` : "")
			).trim(),
		);
	}
	if (D.mood === st.mood && D.fy === st.fy && D.fk === st.fk && D.gx === st.gx && D.gy === st.gy && D.ang === st.ang)
		return;
	D.mood = st.mood;
	D.fy = st.fy;
	D.fk = st.fk;
	D.gx = st.gx;
	D.gy = st.gy;
	D.ang = st.ang;
	const sp = specs(st.fy, st.fk, st.mood);
	if (st.mood === "happy") {
		for (let j = 0; j < 2; j++) set(st, n.eyes[j]!, "e" + j, "d", happyEyeD(sp[j]!, j, st.fk, st.ang, oy));
		return;
	}
	const E = (st.gx || st.gy) && !st.look?.rigid ? edgesNow(st) : null;
	if (E && st.d0ver !== st.ver) {
		st.d0ver = st.ver;
		for (let j = 0; j < 2; j++) st.d0[j] = near(E, sp[j]![0], sp[j]![1]).d;
	}
	for (let j = 0; j < 2; j++) {
		const [cx, cy, w, l] = sp[j]!;
		set(
			st,
			n.eyes[j]!,
			"e" + j,
			"d",
			eyeD(eye(E, cx, cy, w, l, st.gx, st.gy, st.C, null, E ? st.d0[j] : 0), st.ang, ox, oy),
		);
	}
}
/** The body's box in the SVG: the gradients' objectBoundingBox units. */
function bbox(st: Bot) {
	if (st.bver !== st.ver) {
		const P = st.P;
		const b = st.bb;
		let x0 = Infinity;
		let y0 = Infinity;
		let x1 = -Infinity;
		let y1 = -Infinity;
		for (let i = 0; i < P.length; i += 2) {
			if (P[i]! < x0) x0 = P[i]!;
			if (P[i]! > x1) x1 = P[i]!;
			if (P[i + 1]! < y0) y0 = P[i + 1]!;
			if (P[i + 1]! > y1) y1 = P[i + 1]!;
		}
		b[0] = x0;
		b[1] = y0;
		b[2] = x1 - x0;
		b[3] = y1 - y0;
		st.bver = st.ver;
	}
	return st.bb;
}

// ---- the shared loop: frames while a visible bot moves, else one timer to the next due action
/** The next time a bot needs the loop: a due action, the end of a pointer follow, the next glance move. */
function dueOf(st: Bot) {
	const d = st.due;
	return Math.min(
		d.blink,
		d.unblink || Infinity,
		d.morph,
		st.o.hold || st.mood !== "idle" ? Infinity : Math.min(d.act, d.spin),
		st.follow ? st.follow.until : Infinity,
		st.moves && st.moves.length > 1 ? st.moves[1]!.t0 : Infinity,
		st.bmoves && st.bmoves.length > 1 ? st.bmoves[1]!.t0 : Infinity,
	);
}
function tick() {
	raf = 0;
	timer = 0;
	if (reduced || document.hidden) return;
	const now = performance.now();
	const odd = ++frame & 1;
	let anim = false;
	let next = Infinity;
	for (const st of live) {
		if (now >= st.next) {
			plan(st, now);
			st.next = dueOf(st);
		}
		if (st.morph || st.spin || st.moves || st.follow || st.look || st.bmoves) {
			if (!(odd && st.o.small && st.active)) {
				st.active = step(st, now);
				if (!st.active) st.next = dueOf(st);
			}
			if (st.active) anim = true;
		}
		if (st.next < next) next = st.next;
	}
	if (anim) raf = requestAnimationFrame(tick);
	else if (next < Infinity) timer = setTimeout(tick, Math.max(16, next - now));
}
function wake() {
	if (reduced || raf || !live.length || document.hidden) return;
	clearTimeout(timer);
	timer = 0;
	raf = requestAnimationFrame(tick);
}
function halt() {
	cancelAnimationFrame(raf);
	clearTimeout(timer);
	raf = 0;
	timer = 0;
}

/** Reduced motion: the bot stops and shows one still shape (a circle, or its labelled shape). Otherwise it starts over. */
function applyPref(st: Bot) {
	const now = performance.now();
	st.morph = st.spin = st.moves = st.follow = st.bmoves = null;
	st.ang = 0;
	st.gx = st.gy = 0;
	st.B = [0, 0, 0];
	st.look = st.mood === "thinking" && !reduced ? think(now, [0, 0]) : null;
	st.n.root.removeAttribute("data-blink");
	st.n.root.removeAttribute("data-act");
	st.acting = false;
	if (reduced || st.o.shape) setShape(st, st.o.shape ?? "circle");
	arm(st, now);
	draw(st, true);
}

function onPointer(e: PointerEvent) {
	if (reduced) return;
	const now = performance.now();
	for (const st of live) {
		if (!st.o.follow || st.mood !== "idle" || st.spin || !visible(st)) continue;
		const r = st.n.root.getBoundingClientRect();
		const dx = e.clientX - (r.left + r.width / 2);
		const dy = e.clientY - (r.top + r.height / 2);
		const d = Math.hypot(dx, dy) || 1;
		if (!st.follow) {
			st.follow = { vx: 0, vy: 0, t: now, u: [0, 0], m: 0, until: 0, rest: false };
			if (st.bmoves) settle(st, now);
		}
		Object.assign(st.follow, { u: [dx / d, dy / d], m: Math.min(1, d / 300) * REACH, until: now + 1600, rest: false });
		st.moves = null;
		st.next = 0;
	}
	wake();
}
