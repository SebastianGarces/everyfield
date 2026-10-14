// Client port of the prototype's motion engines (design/everyfield-marketing.html): the home hero loop (ha*),
// the chapter and auto-list engine (cx*), the phases rail (ph*), the sending paths (ovs*), section reveals,
// EvryBot life, the floating nav pill, the mobile menu and the FAQ. The markup comes from markup.ts.
// startMotion() runs once per page load and returns a cleanup. Every engine renders a still frame under
// prefers-reduced-motion. Comments that start with "Revision" keep the prototype's design notes.
import { CX_A, CX_DRAFT, CX_PEOPLE, CX_Q, CX_TEAMS, HA_DRAFT, HA_NAME, OV_GROUPS, OV_MAIL, OV_ROWS, SCENES, SD_PIPE, SD_SCOPES, isPanelKind, type PanelKind } from "./scene-data";

type Styled = HTMLElement | SVGElement;
type El = Styled | null | undefined;
type Prop = "text" | "mood" | "transform" | "opacity" | "visibility" | "bottom" | "clip-path" | "stroke-dashoffset" | "z-index";

const PAUSE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>';
const PLAY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
const ARROW_SVG = '<svg class="i " viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

let REDUCED: MediaQueryList;
const all = <T extends Element = HTMLElement>(root: ParentNode, s: string) => Array.from(root.querySelectorAll<T>(s));
const one = <T extends Element = HTMLElement>(root: ParentNode, s: string) => root.querySelector<T>(s);

/* ---------- Curves and style writes (shared by every engine) ---------- */
const clamp = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const P = (t: number, a: number, d: number) => clamp((t - a) / d);
const out = (p: number) => 1 - Math.pow(1 - p, 3);
const inOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const sine = (p: number) => -(Math.cos(Math.PI * p) - 1) / 2;
const back = (p: number) => { const c = 1.6; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); };
const bump = (t: number, a: number, d: number) => Math.sin(Math.PI * P(t, a, d));

/* Write a style only when it changes, so idle frames cost nothing. */
let cache = new WeakMap<Element, Partial<Record<Prop, string>>>();
function set(el: El, prop: Prop, v: string) {
  if (!el) return;
  let c = cache.get(el);
  if (!c) { c = {}; cache.set(el, c); }
  if (c[prop] === v) return;
  c[prop] = v;
  if (prop === "text") el.textContent = v;
  else if (prop === "mood") el.dataset.mood = v;
  else el.style.setProperty(prop, v);
}
function to(el: El, x: number, y: number, s: number, o: number) {
  set(el, "transform", "translate3d(" + x.toFixed(2) + "px," + y.toFixed(2) + "px,0)" + (s === 1 ? "" : " scale(" + s.toFixed(4) + ")"));
  set(el, "opacity", o.toFixed(3));
}
function offset(el: HTMLElement | null, stop: Element) {
  let x = 0, y = 0;
  while (el && el !== stop) { x += el.offsetLeft; y += el.offsetTop; el = el.offsetParent as HTMLElement | null; }
  return { x, y };
}

/* ---------- Home hero: one person, from first contact to the core group ----------
   Five cards share one grid cell and crossfade. Maria's chip glides from a hidden slot in each card to the next.
   haRender(t) is a pure function of the loop time t (ms). Reduced motion renders t = HA_STILL once. */
/* Revision 8 timing table: the one place to tune the hero loop (all values in ms). */
const HA_TM = {
  act: 1.5,
  hold: [1700, 1800, 1800, 1800, 3000],
  lead: [700, 450, 250, 500, 150],
  span: [1870, 380, 2800, 1130, 1220],
  cardIn: 380, cardOut: 250, gap: 150,
  moveAt: 50, move: 650,
  seam: 250, chipFade: 230,
};
const HA_SC: [number, number][] = [], HA_A: number[] = [], HA_MOVES: [number, number, number, number][] = [];
let HA_T = 0;
{
  let a = -HA_TM.seam;
  for (let i = 0; i < 5; i++) {
    const A = a + HA_TM.lead[i]!, b = A + HA_TM.span[i]! * HA_TM.act + HA_TM.hold[i]!;
    HA_SC.push([a, b]); HA_A.push(A);
    if (i < 4) HA_MOVES.push([b + HA_TM.moveAt, b + HA_TM.moveAt + HA_TM.move, i, i + 1]);
    a = b + HA_TM.gap;
  }
  HA_T = HA_SC[4]![1] + HA_TM.seam;
}
const HA_STILL = HA_A[4]! + 1400 * HA_TM.act; /* final frame: Maria in the core group, highlight on */
const haAt = (i: number, ms: number) => HA_A[i]! + ms * HA_TM.act;
const haD = (ms: number) => ms * HA_TM.act;

const HA = { t: 0, raf: 0, last: 0, paused: false, vis: true, root: null as HTMLElement | null, io: null as IntersectionObserver | null, ro: null as ResizeObserver | null, pos: [] as { x: number; y: number }[] };
function haMeasure() {
  const R = HA.root; if (!R) return;
  const stage = one(R, ".ha-stage"); if (!stage) return;
  HA.pos = all(R, ".ha-card .ha-slot").map((s) => offset(s, stage));
}
function haRoll(key: string, p: number) { set(one(HA.root!, '[data-roll="' + key + '"] > span'), "transform", "translate3d(0," + (-50 * p).toFixed(3) + "%,0)"); }
function haRender(t: number) {
  const R = HA.root; if (!R) return;
  const q = (s: string) => one(R, s);
  all(R, ".ha-card").forEach((card, i) => {
    const u = i === 0 && t >= HA_T - 300 ? t - HA_T : t;
    const [a, b] = HA_SC[i]!;
    const pin = out(P(u, a, HA_TM.cardIn)), pout = sine(P(u, b, HA_TM.cardOut));
    to(card, 0, (1 - pin) * 8 - pout * 6, 1, pin * (1 - pout));
    all(card, "[data-st]").forEach((el, k) => { const p = out(P(u, a + 90 + k * 75, 420)); to(el, 0, (1 - p) * 8, 1, p); });
  });
  /* Scene 1: type the name, press Add, the chip lands in the list */
  set(q(".ha-type"), "text", HA_NAME.slice(0, Math.floor(P(t, haAt(0, 0), haD(1050)) * HA_NAME.length)));
  set(q(".ha-type"), "opacity", (1 - P(t, haAt(0, 1550), haD(220))).toFixed(3));
  set(q(".ha-card[data-scene='0'] .ha-caret"), "visibility", t < haAt(0, 1500) ? "visible" : "hidden");
  set(q(".ha-add"), "transform", "scale(" + (1 - 0.05 * bump(t, haAt(0, 1250), haD(200))).toFixed(4) + ")");
  /* Scene 2: guest count rolls when Maria joins */
  haRoll("guests", inOut(P(t, haAt(1, 0), haD(380))));
  /* Scene 3: Evry drafts, you approve, a check confirms it is sent */
  set(q(".ha .evry-bot"), "mood", t >= haAt(2, 0) && t < haAt(2, 1800) ? "talking" : t >= haAt(2, 2150) && t < HA_SC[2]![1] + 200 ? "happy" : "idle");
  set(q(".ha-dtxt"), "text", HA_DRAFT.slice(0, Math.floor(P(t, haAt(2, 350), haD(1350)) * HA_DRAFT.length)));
  set(q(".ha-draft .ha-caret"), "visibility", t > haAt(2, 200) && t < haAt(2, 1850) ? "visible" : "hidden");
  set(q(".ha-send"), "transform", "scale(" + (1 - 0.05 * bump(t, haAt(2, 1820), haD(220))).toFixed(4) + ")");
  const ok = out(P(t, haAt(2, 1980), haD(320)));
  set(q(".ha-ok"), "opacity", ok.toFixed(3));
  to(q(".ha-l1"), 0, -8 * ok, 1, 1 - ok);
  to(q(".ha-l2"), 0, 8 * (1 - ok), 0.9 + 0.1 * back(P(t, haAt(2, 1980), haD(380))), ok);
  set(q(".ha-shine"), "transform", "translate3d(" + (-120 + 400 * inOut(P(t, haAt(2, 2150), haD(650)))).toFixed(1) + "%,0,0)");
  /* Scene 4: checks pop in, then the stage flips to Committed */
  all(R, ".ha-check").forEach((c, k) => { const p = P(t, haAt(3, k * 260), haD(340)); to(c, 0, 0, 0.4 + 0.6 * back(p), clamp(p * 2.5)); });
  const f = P(t, haAt(3, 750), haD(380)), fe = out(f);
  const chips = all(R, ".ha-flip .stage-chip");
  to(chips[0], 0, -7 * fe, 1, 1 - fe);
  to(chips[1], 0, 7 * (1 - fe), 0.85 + 0.15 * back(f), fe);
  /* Scene 5: bars fill, Maria joins the core group, counts roll, a short highlight */
  const join = inOut(P(t, haAt(4, 500), haD(520)));
  const meters = all(R, ".ha-meter > span");
  [41, 23, 34].forEach((v, k) => {
    const p = out(P(t, haAt(4, k * 90), haD(650))), val = (v / 50) * p + (k === 2 ? join : k === 1 ? -join : 0) / 50;
    set(meters[k], "transform", "translate3d(" + (-100 + 100 * val).toFixed(2) + "%,0,0)");
  });
  haRoll("follow", join); haRoll("core", join);
  set(q(".ha-hl"), "opacity", (out(P(t, haAt(4, 400), haD(300))) * (1 - sine(P(t, HA_SC[4]![1] - 1500, haD(600))))).toFixed(3));
  /* Maria's chip: pops in, then glides between slots with a small lift, fades at the seam */
  const live = q(".ha-live"), pos = HA.pos;
  if (live && pos.length === 5) {
    let x = pos[0]!.x, y = pos[0]!.y, s = 1, o = 0;
    const pop = P(t, haAt(0, 1450), haD(420));
    if (t >= haAt(0, 1450)) { o = clamp(pop * 2); s = 0.6 + 0.4 * back(pop); }
    for (const mv of HA_MOVES) {
      if (t < mv[0]) continue;
      const p = inOut(P(t, mv[0], mv[1] - mv[0])), from = pos[mv[2]]!, dest = pos[mv[3]]!;
      x = from.x + (dest.x - from.x) * p;
      y = from.y + (dest.y - from.y) * p;
      s = 1 + 0.06 * Math.sin(Math.PI * p);
    }
    const fade = sine(P(t, HA_SC[4]![1], HA_TM.chipFade));
    to(live, x, y, s - 0.04 * fade, o * (1 - fade));
    const ring = P(t, haAt(4, 420), haD(800));
    to(q(".ha-ring"), 0, 0, 1 + 0.3 * out(ring), ring > 0 && ring < 1 ? 0.8 * (1 - ring) : 0);
  }
}
const haRunning = () => !!HA.root && HA.root.isConnected && !HA.paused && HA.vis && !document.hidden && !REDUCED.matches;
function haFrame(now: number) {
  HA.raf = 0;
  if (!haRunning()) return;
  HA.t = (HA.t + Math.min(now - HA.last, 50)) % HA_T;
  HA.last = now;
  haRender(HA.t);
  HA.raf = requestAnimationFrame(haFrame);
}
function haKick() {
  if (HA.raf || !haRunning()) return;
  HA.last = performance.now();
  HA.raf = requestAnimationFrame(haFrame);
}
function haPauseBtn() {
  const b = HA.root && one(HA.root, ".ha-pause"); if (!b) return;
  b.innerHTML = HA.paused ? PLAY_SVG : PAUSE_SVG;
  b.setAttribute("aria-label", HA.paused ? "Play animation" : "Pause animation");
}
function haStop() {
  if (HA.raf) cancelAnimationFrame(HA.raf);
  HA.raf = 0;
  HA.io?.disconnect(); HA.ro?.disconnect();
  HA.io = HA.ro = null;
}
function haInit() {
  haStop();
  HA.root = document.querySelector<HTMLElement>("#view .ha");
  if (!HA.root) return;
  HA.root.classList.toggle("still", REDUCED.matches);
  haMeasure();
  if (REDUCED.matches) { HA.t = HA_STILL; haRender(HA.t); return; }
  haPauseBtn();
  haRender(HA.t);
  const stage = one(HA.root, ".ha-stage")!;
  HA.io = new IntersectionObserver((es) => { HA.vis = es[es.length - 1]!.isIntersecting; haKick(); });
  HA.io.observe(stage);
  HA.ro = new ResizeObserver(() => { haMeasure(); haRender(HA.t); });
  HA.ro.observe(stage);
  haKick();
}

/* ---------- Chapters: sticky panel on the right, steps on the left; and the auto-advancing lists ----------
   cxScene(inst, t) is a pure function of the panel's loop time t (ms). Reduced motion renders each panel at its still time. */
type Pos = { x: number; y: number; w?: number; h?: number };
type Inst = { el: HTMLElement; kind: PanelKind; q: Record<string, HTMLElement | null>; qa: Record<string, HTMLElement[]>; pos: Record<string, Pos> | null; t: number; since: number; on: boolean; st: HTMLElement[]; dh?: number; h?: number };
type Chapter = {
  root: HTMLElement; id: string; vis: HTMLElement; head: HTMLElement; steps: HTMLElement[]; bgs: HTMLElement[]; insts: Inst[]; mobs: Inst[];
  active: number; prev: number; since: number; on: boolean; seen: boolean; target: number; at: number; tm: ReturnType<typeof setTimeout> | 0;
  stack: boolean; lock: number[]; lead: number; listH: number; fits: boolean; auto: boolean; prog: number; kbd: boolean; dur: number;
  bars: HTMLElement[]; words: HTMLElement[]; tabs: HTMLElement[];
};
const cxRst = (t: number, a: number) => 1 - sine(P(t, a, 450));
function cxQ(I: Inst, s: string) { if (!(s in I.q)) I.q[s] = one(I.el, s); return I.q[s]; }
function cxQA(I: Inst, s: string) { return (I.qa[s] ??= all(I.el, s)); }
function cxPress(el: El, t: number, at: number, d?: number) { set(el, "transform", "scale(" + (1 - (d || 0.05) * bump(t, at, 200)).toFixed(4) + ")"); }
/* Button press, then the label swaps and a check fill and shine confirm it (same as the hero's Approve and send). */
function cxDone(I: Inst, sel: string, t: number, at: number, R: number) {
  const b = cxQ(I, sel); if (!b) return;
  cxPress(b, t, at);
  const ok = out(P(t, at + 160, 320)) * R;
  set(one(b, ".ha-ok"), "opacity", ok.toFixed(3));
  to(one(b, ".ha-l1"), 0, -8 * ok, 1, 1 - ok);
  to(one(b, ".ha-l2"), 0, 8 * (1 - ok), 0.9 + 0.1 * back(P(t, at + 160, 380)) * R + (1 - R) * 0.1, ok);
  set(one(b, ".ha-shine"), "transform", "translate3d(" + (-120 + 400 * inOut(P(t, at + 330, 650))).toFixed(1) + "%,0,0)");
}
function cxPop(el: El, t: number, at: number, R: number) { const p = P(t, at, 380); to(el, 0, 0, 0.7 + 0.3 * back(p), clamp(p * 2.5) * R); }
function cxRise(el: El, t: number, at: number, R: number) { const p = out(P(t, at, 420)); to(el, 0, (1 - p) * 8, 1, p * R); }
function cxFlip(sw: El, p: number) { const k = sw?.children; if (!k) return; to(k[0] as Styled, 0, -7 * p, 1, 1 - p); to(k[1] as Styled, 0, 7 * (1 - p), 1, p); }
function cxN(el: El, v: number) { set(el, "text", String(Math.round(v))); }
function cxType(el: El, s: string, p: number) { set(el, "text", s.slice(0, Math.floor(p * s.length))); }
function cxHl(el: El, t: number, a: number, b: number, R?: number) { set(el, "opacity", (out(P(t, a, 250)) * (1 - sine(P(t, b, 300))) * (R === undefined ? 1 : R)).toFixed(3)); }

const CX_RENDER: Record<PanelKind, (I: Inst, t: number) => void> = {
  people(I, t) {
    const R = cxRst(t, 5800), imp = inOut(P(t, 2350, 800)), meters = cxQA(I, ".ha-meter > span");
    let tot = 0;
    cxQA(I, ".cx-rows [data-n]").forEach((n, k) => {
      const r = CX_PEOPLE[k]!, p = out(P(t, 300 + k * 90, 900)), v = (r[3] * p + (k === 0 ? (r[2] - r[3]) * imp : 0)) * R;
      tot += v; cxN(n, v);
      set(meters[k], "transform", "translate3d(" + (-100 + (v / 82) * 100).toFixed(2) + "%,0,0)");
    });
    cxN(cxQ(I, '[data-n="total"]'), tot + 20 * out(P(t, 300, 900)) * R);
    cxDone(I, ".cx-t0", t, 2000, R);
    cxPop(cxQ(I, ".cx-pill"), t, 2250, R);
    cxRise(cxQ(I, ".cx-ins"), t, 3300, R);
  },
  meet(I, t) {
    const R = cxRst(t, 6500), ins = cxQA(I, ".cx-in"), fr = cxQA(I, ".cx-fr");
    /* The type picker steps through each kind of gathering, then lands on Vision meeting */
    let k = 0; for (let i = 0; i < 4; i++) k += inOut(P(t, 1350 + i * 280, 200));
    set(cxQ(I, ".cx-roll > span"), "transform", "translate3d(0," + (-k * 20 * R).toFixed(3) + "%,0)");
    cxPress(ins[0], t, 1100, 0.03);
    cxHl(fr[0], t, 1150, 2450, R); cxHl(fr[1], t, 2450, 2950, R); cxHl(fr[2], t, 2950, 3400, R);
    cxType(cxQ(I, ".cx-when"), "Sun Oct 12, 5 pm", P(t, 2500, 450)); set(cxQ(I, ".cx-when"), "opacity", R.toFixed(3));
    cxType(cxQ(I, ".cx-where"), "Reyes home", P(t, 3000, 350)); set(cxQ(I, ".cx-where"), "opacity", R.toFixed(3));
    cxDone(I, ".cx-t1", t, 3300, R);
    /* Guests drop in and the attendance count ticks up */
    cxQA(I, ".cx-guests .ha-chip").forEach((c, j) => { const p = P(t, 3800 + j * 160, 420); to(c, 0, -16 * (1 - back(p)), 1, clamp(p * 2.5) * R); });
    const cnt = cxQ(I, '[data-n="att"]');
    cxN(cnt, 12 * out(P(t, 3850, 1100)) * R);
    set(cnt, "transform", "scale(" + (1 + 0.06 * bump(t, 4950, 260)).toFixed(4) + ")");
    cxPop(cxQ(I, ".cx-att .badge"), t, 4500, R);
  },
  follow(I, t) {
    const R = cxRst(t, 7900);
    cxQA(I, ".cx-fu").forEach((r, k) => {
      const at = 1300 + k * 500;
      cxFlip(one(r, ".cx-swap"), out(P(t, at, 380)) * R);
      cxPop(one(r, ".cx-who"), t, at + 150, R);
      cxFlip(one(r, ".cx-lead"), out(P(t, 5150 + k * 120, 380)) * R);
    });
    /* The first task opens to show the drafted talking point. The rows under it move down to make room. */
    const e = out(P(t, 2900, 450)) * R, dh = I.dh || 0;
    to(cxQ(I, ".cx-draft"), 0, 0, 0.96 + 0.04 * e, e);
    to(cxQ(I, ".cx-dn"), 0, -dh * (1 - e), 1, 1);
    const cut = dh * (1 - e), H = I.h || 1;
    set(cxQ(I, ".cx-shell"), "bottom", cut.toFixed(1) + "px");
    set(cxQ(I, ".cx-shade"), "transform", "scaleY(" + ((H - cut) / H).toFixed(4) + ")");
    cxType(cxQ(I, ".cx-dt"), CX_DRAFT, P(t, 3150, 1200));
    cxDone(I, ".cx-t0", t, 4900, R);
    cxFlip(cxQ(I, ".cx-fs"), out(P(t, 5150, 380)) * R);
    set(cxQ(I, ".evry-bot"), "mood", t >= 600 && t < 4300 ? "talking" : t >= 5100 && t < 6600 ? "happy" : "idle");
  },
  teams(I, t) {
    const R = cxRst(t, 7000), base = out(P(t, 300, 900)), nums = cxQA(I, '[data-n="team"]'), bars = cxQA(I, ".cx-team .ha-meter > span"), fly = cxQA(I, ".cx-fly");
    CX_TEAMS.forEach((r, k) => {
      const at = k ? 3300 : 1700, land = at + 950;
      const n = Math.round((Math.round(r[3] * base) + (t >= land ? 1 : 0)) * R), v = (r[3] * base + out(P(t, land, 400))) * R;
      cxN(nums[k], n);
      set(nums[k], "transform", "scale(" + (1 + 0.08 * bump(t, land, 280)).toFixed(4) + ")");
      set(bars[k], "transform", "translate3d(" + (-100 + (v / 40) * 100).toFixed(2) + "%,0,0)");
      cxDone(I, ".cx-t" + k, t, at, R);
      /* The person chip leaves the row and moves into its team */
      const pos = I.pos, a = pos?.["src" + k], b = pos?.["dst" + k], f = pos?.["fly" + k];
      if (!a || !b || !f) return;
      const w = f.w || 0, m = inOut(P(t, at + 250, 700));
      const x0 = a.x - 4, y0 = a.y + ((a.h || 0) - 30) / 2, x1 = b.x + (b.w || 0) - w - 44, y1 = b.y - 1;
      const o = out(P(t, at + 200, 200)) * (1 - sine(P(t, land - 50, 250)));
      to(fly[k], x0 + (x1 - x0) * m, y0 + (y1 - y0) * m - 18 * Math.sin(Math.PI * m), 1 + 0.06 * Math.sin(Math.PI * m), o);
    });
  },
  focus(I, t) {
    const R = cxRst(t, 6200), d = 16 * out(P(t, 300, 1200)) * R;
    cxN(cxQ(I, '[data-n="days"]'), d);
    set(cxQ(I, ".cx-rf"), "clip-path", "inset(0 " + ((1 - d / 16) * 100).toFixed(2) + "% 0 0 round 99px)");
    cxPress(cxQ(I, ".cx-t0"), t, 2400);
    const s = out(P(t, 2550, 380)) * R, f = cxQ(I, ".cx-flip2")?.children;
    if (f) to(f[0] as Styled, 0, -6 * s, 1, 1 - s);
    cxQA(I, ".cx-fact").forEach((el, k) => cxRise(el, t, 2640 + k * 75, R));
  },
  facts(I, t) {
    const R = cxRst(t, 6000), p = out(P(t, 300, 1100)) * R;
    set(cxQ(I, ".cx-ring .fg"), "stroke-dashoffset", (169.65 * (1 - 0.71 * p)).toFixed(2));
    cxN(cxQ(I, '[data-n="pct"]'), 71 * p);
    cxQA(I, '[data-n="kv"]').forEach((el, k) => { if (k < 3) cxN(el, [24, 17, 7][k]! * out(P(t, 300 + k * 90, 900)) * R); });
    cxHl(cxQ(I, ".cx-hl"), t, 1650, 5800, R);
    cxQA(I, ".cx-names .ha-chip").forEach((c, k) => cxPop(c, t, 2500 + k * 120, R));
  },
  evry(I, t) {
    const R = cxRst(t, 7800);
    cxType(cxQ(I, ".cx-q"), CX_Q, P(t, 450, 1300));
    cxRise(cxQ(I, ".cx-a"), t, 1950, R);
    cxType(cxQ(I, ".cx-ans"), CX_A, P(t, 2150, 1500));
    cxRise(cxQ(I, ".cx-rvw"), t, 3750, R);
    cxDone(I, ".cx-t0", t, 5100, R);
    set(cxQ(I, ".evry-bot"), "mood", t >= 2050 && t < 3700 ? "talking" : t >= 5300 && t < 6400 ? "happy" : "idle");
  },
  share(I, t) {
    const R = cxRst(t, 6000), on = P(t, 2300, 380) * R, sw = cxQ(I, ".cx-t0");
    if (sw) {
      set(one(sw, "b"), "opacity", out(on).toFixed(3));
      set(one(sw, "i"), "transform", "translate3d(" + (14 * back(on)).toFixed(2) + "px,0,0)");
    }
    cxPress(sw, t, 2200, 0.08);
    cxHl(cxQ(I, ".cx-hl"), t, 1550, 3000);
    cxFlip(cxQ(I, ".cx-prev .cx-swap"), out(P(t, 2600, 380)) * R);
  },
  /* Revision 19 sending panels. Each plays once to its end and holds there, so no loop reset. */
  scope(I, t) {
    /* Counts rise, then the scope moves All plants -> Texas -> Greater Austin and every number follows. */
    const a = out(P(t, 300, 900)), q1 = inOut(P(t, 1800, 600)), q2 = inOut(P(t, 3000, 600)), S = SD_SCOPES;
    cxQA(I, '[data-n="sd"]').forEach((n, k) => {
      const i = (k + 1) as 1 | 2 | 3;
      cxN(n, S[0][i] * a + (S[1][i] - S[0][i]) * q1 + (S[2][i] - S[1][i]) * q2);
    });
    const p1 = out(P(t, 1750, 300)), p2 = out(P(t, 2950, 300)), on = [1 - p1, p1 - p2, p2];
    cxQA(I, ".sd-chip").forEach((c, k) => set(one(c, ".sd-on"), "opacity", (on[k] ?? 0).toFixed(3)));
    cxPress(cxQ(I, ".cx-t0"), t, 1700, 0.06); cxPress(cxQ(I, ".cx-t1"), t, 2900, 0.06);
    const d1 = out(P(t, 1850, 400)), d2 = out(P(t, 3050, 400));
    cxQA(I, ".sd-area").forEach((r, k) => set(r, "opacity", (1 - 0.72 * (k === 4 ? d1 : k ? d2 : 0)).toFixed(3)));
    cxHl(cxQ(I, ".sd-area .cx-hl"), t, 3050, 1e9);
  },
  pipe(I, t) {
    const bars = cxQA(I, ".sd-track i"), wk = cxQA(I, ".sd-pl .wk");
    cxQA(I, '[data-n="pl"]').forEach((n, k) => {
      const p = out(P(t, 300 + k * 120, 650)), v = SD_PIPE[k]![1];
      cxN(n, v * p);
      set(bars[k], "transform", "scaleX(" + ((v / 4) * p).toFixed(4) + ")");
      set(wk[k], "opacity", out(P(t, 900 + k * 120, 400)).toFixed(3));
    });
    cxN(cxQ(I, '[data-n="sum"]'), 5 * out(P(t, 1900, 800)));
    cxHl(cxQ(I, ".sd-pl .cx-hl"), t, 2450, 1e9);
  },
  lens(I, t) {
    cxQA(I, ".sd-dist").forEach((d, k) => set(d, "clip-path", "inset(0 " + ((1 - inOut(P(t, 350 + k * 250, 700))) * 100).toFixed(2) + "% 0 0 round 99px)"));
    cxPress(cxQ(I, ".cx-t0"), t, 2300, 0.1);
    const sh = out(P(t, 2450, 420));
    to(cxQ(I, ".sd-sheet"), 0, (1 - sh) * 16, 1, sh);
    cxQA(I, ".sd-pr").forEach((r, k) => cxRise(r, t, 2650 + k * 110, 1));
  },
  top(I, t) {
    cxN(cxQ(I, '[data-n="top"]'), 4 * out(P(t, 300, 800)));
    cxPress(cxQ(I, ".cx-t0"), t, 2400);
  },
  /* Revision 25 /oversight panels. Each plays once to its end and holds there. */
  invite(I, t) {
    /* The email is typed, the invite is sent, then the new plant rises into the list and turns Connected. */
    cxPress(cxQ(I, ".cx-t0"), t, 1250, 0.03);
    cxHl(cxQ(I, ".cx-t0 .cx-fr"), t, 1300, 2800);
    cxType(cxQ(I, ".ov-mail"), OV_MAIL, P(t, 1450, 1200));
    cxDone(I, ".cx-t1", t, 3600, 1);
    cxFlip(cxQ(I, ".ov-fs"), out(P(t, 3800, 380)));
    cxRise(cxQ(I, ".ov-new"), t, 4100, 1);
    cxFlip(cxQ(I, ".ov-st"), out(P(t, 5000, 380)));
    cxPop(cxQ(I, ".ov-st > :last-child"), t, 5000, 1);
  },
  senders(I, t) {
    /* Churches rise in order and their plant counts count up, then Grace Church is selected. */
    cxQA(I, ".ov-grp").forEach((g, k) => cxRise(g, t, 250 + k * 160, 1));
    cxQA(I, '[data-n="g"]').forEach((n, k) => cxN(n, OV_GROUPS[k]![3].length * out(P(t, 450 + k * 160, 700))));
    cxQA(I, ".ov-pc").forEach((c, k) => set(c, "opacity", out(P(t, 800 + k * 70, 360)).toFixed(3)));
    cxPress(cxQ(I, ".cx-t0"), t, 2250, 0.03);
    cxHl(cxQ(I, ".cx-t0 .cx-hl"), t, 2250, 1e9);
  },
  plants(I, t) {
    /* Rows settle in launch order, then Austin is selected and the rows outside it dim. */
    cxQA(I, ".ov-row").forEach((r, k) => { const p = out(P(t, 300 + k * 110, 480)); to(r, 0, (1 - p) * 12, 1, p * (1 - 0.66 * (OV_ROWS[k]![1] ? 0 : out(P(t, 2250, 400))))); });
    const p = out(P(t, 2150, 300));
    cxQA(I, ".sd-chip").forEach((c, k) => set(one(c, ".sd-on"), "opacity", (k === 0 ? 1 - p : k === 1 ? p : 0).toFixed(3)));
    cxPress(cxQ(I, ".cx-t0"), t, 2100, 0.06);
  },
  help(I, t) {
    cxN(cxQ(I, '[data-n="days"]'), 205 * out(P(t, 300, 1100)));
    cxPress(cxQ(I, ".cx-t0"), t, 2400);
    cxFlip(cxQ(I, ".ov-off"), out(P(t, 2550, 380)));
  },
};
/* Cursor: glides between cached target points with the hero's in-out curve, presses, and leaves a short ripple. */
function cxCursor(I: Inst, t: number) {
  const S = SCENES[I.kind], el = cxQ(I, ".cx-cur"), pos = I.pos;
  if (!el || !pos) return;
  const pt = (k: string) => pos[k] || pos.rest!;
  const path = S.cur;
  let x = pt(path[0]![1]).x, y = pt(path[0]![1]).y;
  for (let i = 0; i < path.length - 1; i++) {
    if (t < path[i]![0]) break;
    const a = pt(path[i]![1]), b = pt(path[i + 1]![1]), p = inOut(P(t, path[i]![0], path[i + 1]![0] - path[i]![0]));
    x = a.x + (b.x - a.x) * p; y = a.y + (b.y - a.y) * p;
  }
  let press = 0, rp = -1;
  S.clicks.forEach((c) => { press = Math.max(press, bump(t, c, 200)); if (t >= c && t < c + 520) rp = P(t, c, 520); });
  const o = out(P(t, 250, 300)) * (1 - sine(P(t, S.L - 420, 300)));
  to(el, x, y, 1 - 0.12 * press, o);
  to(el.firstElementChild as Styled | null, 0, 0, 0.4 + 1.1 * out(Math.max(rp, 0)), rp >= 0 ? 0.9 * (1 - rp) : 0);
}
function cxScene(I: Inst, t: number) { CX_RENDER[I.kind](I, t); cxCursor(I, t); }
function cxMeasure(I: Inst) {
  const card = I.el, W = card.offsetWidth, H = card.offsetHeight;
  if (!W) return;
  const pos: Record<string, Pos> = { rest: { x: W * 0.8, y: H - 18 }, mid: { x: W * 0.62, y: H * 0.55 } };
  [".cx-t0", ".cx-t1"].forEach((s) => {
    const e = one(card, s); if (!e) return;
    const o = offset(e, card);
    pos[s] = { x: o.x + Math.min(e.offsetWidth * 0.5, e.offsetWidth - 18), y: o.y + e.offsetHeight * 0.55 };
  });
  all(card, "[data-p]").forEach((e) => { const o = offset(e, card); pos[e.dataset.p!] = { x: o.x, y: o.y, w: e.offsetWidth, h: e.offsetHeight }; });
  const dr = one(card, ".cx-draft"); if (dr) I.dh = dr.offsetHeight + 8;
  I.h = H;
  I.pos = pos;
}

const CX = { list: [] as Chapter[], raf: 0, last: 0, paused: false, ticking: false, io: null as IntersectionObserver | null, aio: null as IntersectionObserver | null, ro: null as ResizeObserver | null, rio: null as IntersectionObserver | null };
const cxNodes = new WeakMap<Element, Inst | Chapter>();
function cxInst(el: HTMLElement): Inst {
  const kind = el.dataset.k;
  if (!isPanelKind(kind)) throw new Error("unknown panel " + kind);
  return { el, kind, q: {}, qa: {}, pos: null, t: 0, since: 1e6, on: false, st: all(el, "[data-st]") };
}
const cxDesk = (ch: Chapter) => !!ch.vis.offsetParent;
const cxStill = (I: Inst) => SCENES[I.kind].still;
/* Panel crossfade, with the hero's curves: old card out 250 ms sine (6 px up), new card in after 150 ms, 380 ms ease-out (8 px lift). */
function cxRender(ch: Chapter) {
  const s = ch.since;
  ch.insts.forEach((I, i) => {
    let o = 0, y = 0;
    if (i === ch.active) { const pin = out(P(s, 150, 380)); o = pin; y = (1 - pin) * 8; }
    else if (i === ch.prev) { const po = sine(P(s, 0, 250)); o = 1 - po; y = -6 * po; }
    to(I.el, 0, y, 1, o);
    set(I.el, "visibility", o > 0 ? "visible" : "hidden");
    if (i === ch.active) {
      I.st.forEach((el, k) => { const p = out(P(s, 240 + k * 75, 420)); to(el, 0, (1 - p) * 8, 1, p); });
      cxScene(I, I.t);
    }
  });
  ch.bgs.forEach((b, i) => {
    const o = i === ch.active ? inOut(P(s, 0, 500)) : i === ch.prev ? 1 : 0;
    set(b, "opacity", o.toFixed(3)); set(b, "z-index", i === ch.active ? "-1" : "-2");
  });
}
function cxRenderMob(I: Inst) {
  I.st.forEach((el, k) => { const p = out(P(I.since, 90 + k * 75, 420)); to(el, 0, (1 - p) * 8, 1, p); });
  cxScene(I, I.t);
}
function cxSetActive(ch: Chapter, k: number) {
  if (k === ch.active) return;
  ch.prev = ch.active; ch.active = k;
  ch.steps.forEach((s, i) => { s.classList.toggle("on", i === k); s.classList.toggle("cx-past", i < k); });
  ch.words.forEach((w, i) => w.classList.toggle("on", i === k));
  if (ch.auto) cxTabs(ch);
  const I = ch.insts[k]!;
  if (REDUCED.matches) { ch.since = 1e6; I.t = cxStill(I); cxRender(ch); return; }
  ch.since = 0; I.t = 0;
  cxKick();
}
/* Revision 13: the scroll position sets a target step; the shown step moves toward it one step at a time and holds
   each step for at least CX_DWELL ms. The page scroll is never blocked. */
const CX_DWELL = 800;
function cxGo(ch: Chapter) {
  clearTimeout(ch.tm); ch.tm = 0;
  if (ch.target === ch.active) return;
  const now = performance.now();
  if (!ch.on) { cxSetActive(ch, ch.target); ch.at = now; return; }
  if (REDUCED.matches) { while (ch.active !== ch.target) cxSetActive(ch, ch.active + (ch.target > ch.active ? 1 : -1)); ch.at = now; return; }
  let wait = ch.at + CX_DWELL - now;
  if (wait <= 0) { cxSetActive(ch, ch.active + (ch.target > ch.active ? 1 : -1)); ch.at = now; wait = CX_DWELL; }
  if (ch.target !== ch.active) ch.tm = setTimeout(() => cxGo(ch), wait + 1);
}
function cxScroll(jump?: boolean) {
  CX.ticking = false;
  CX.list.forEach((ch) => {
    if (ch.auto || !cxDesk(ch)) return;
    const hb = ch.head.getBoundingClientRect().bottom, cap = window.innerHeight * 0.6;
    let k = 0;
    if (ch.stack) ch.steps.forEach((s, i) => { if (i && s.getBoundingClientRect().top < ch.lock[i]! + ch.lead) k = i; });
    else ch.steps.forEach((s, i) => {
      if (!i) return;
      const pv = ch.steps[i - 1]!, pr = pv.getBoundingClientRect(), tt = one(pv, "h3");
      const off = tt ? tt.getBoundingClientRect().top - pr.top : 0;
      if (s.getBoundingClientRect().top < Math.min(hb + pr.height - off + 28, cap)) k = i;
    });
    ch.target = k;
    if (jump === true) { clearTimeout(ch.tm); cxSetActive(ch, k); ch.at = performance.now(); } else cxGo(ch);
  });
}
const cxRunning = () => !CX.paused && !document.hidden && !REDUCED.matches;
function cxFrame(now: number) {
  CX.raf = 0;
  if (!cxRunning()) return;
  const dt = Math.min(now - CX.last, 50);
  let any = false;
  CX.last = now;
  CX.list.forEach((ch) => {
    if (!ch.root.isConnected) return;
    if (ch.on && cxDesk(ch)) {
      any = true;
      if (ch.auto && !ch.kbd) { ch.prog += dt; if (ch.prog >= ch.dur) cxAutoGo(ch, (ch.active + 1) % ch.steps.length); }
      const I = ch.insts[ch.active]!, S = SCENES[I.kind];
      ch.since += dt;
      I.t = ch.auto || S.once ? Math.min(I.t + dt, S.end ?? S.L) : (I.t + dt) % S.L;
      cxRender(ch); if (ch.auto) cxBars(ch);
    }
    ch.mobs.forEach((M) => {
      if (!M.on || cxDesk(ch)) return;
      any = true;
      const S = SCENES[M.kind];
      M.since += dt; M.t = S.once ? Math.min(M.t + dt, S.end ?? S.L) : (M.t + dt) % S.L;
      cxRenderMob(M);
    });
  });
  if (any) CX.raf = requestAnimationFrame(cxFrame);
}
function cxKick() {
  if (CX.raf || !cxRunning()) return;
  CX.last = performance.now();
  CX.raf = requestAnimationFrame(cxFrame);
}
/* Revision 13: stacked step geometry (see the .cx-stack CSS). */
const CX_SHARE = 0.72;
function cxStack(ch: Chapter, on: boolean) {
  const ol = ch.steps[0]!.parentElement!, n = ch.steps.length;
  ch.root.classList.toggle("cx-stack", on); ch.stack = on;
  if (!on) { ch.root.classList.remove("cx-fold"); ch.steps.forEach((s) => ["--cx-st", "--cx-mt", "--cx-pb"].forEach((v) => s.style.removeProperty(v))); ol.style.removeProperty("--cx-tail"); return; }
  const base = parseFloat(getComputedStyle(ch.head).top) + ch.head.offsetHeight, vh = window.innerHeight, S = Math.round(vh * CX_SHARE);
  const h = ch.steps.map((s, i) => one(s, ".cx-txt")!.offsetHeight + 70 + (i ? 1 : 0));
  const full = h.reduce((a, b) => a + b, 0), fits = base + full <= vh - 24;
  const c = ch.steps.map((s, i) => { const tl = one(s, ".cx-tl") || one(s, "h3")!; return fits ? h[i]! : tl.offsetHeight + 70 + (i ? 1 : 0); });
  let lead = 0, top = 0;
  ch.lock = [];
  for (let i = 0; i < n; i++) lead = Math.max(lead, h[i]! - c[i]!);
  lead = Math.max(60, lead + 8);
  for (let i = 0; i < n; i++) { ch.lock[i] = base + top; if (i < n - 1) top += c[i]!; }
  const H = top + h[n - 1]!, pb: number[] = [];
  ch.steps.forEach((s, i) => {
    pb[i] = Math.max(0, H - (ch.lock[i]! - base) - h[i]!);
    s.style.setProperty("--cx-st", ch.lock[i] + "px");
    s.style.setProperty("--cx-pb", pb[i] + "px");
    s.style.setProperty("--cx-mt", (i ? S + c[i - 1]! - h[i - 1]! - pb[i - 1]! + (i === 1 ? lead : 0) : 0) + "px");
  });
  ol.style.setProperty("--cx-tail", S - lead + "px");
  ch.listH = H; ch.lead = lead; ch.fits = fits;
  ch.root.classList.toggle("cx-fold", !fits);
}
/* The heading and the panel unpin together, with the last step under the heading: no long empty gap. */
function cxMeasureAll() {
  CX.list.forEach((ch) => {
    ch.insts.concat(ch.mobs).forEach(cxMeasure);
    if (ch.auto) return;
    const ol = ch.steps[0]!.parentElement!, right = ch.vis.closest<HTMLElement>(".cx-right")!, grid = ch.vis.closest<HTMLElement>(".cx-grid")!;
    const desk = cxDesk(ch), x = Math.max(0, ch.vis.offsetHeight - ch.head.offsetHeight);
    ol.style.paddingBottom = "";
    cxStack(ch, desk && !REDUCED.matches);
    ol.style.marginBottom = !desk ? "" : ch.stack ? -ch.listH + "px" : -ch.steps[ch.steps.length - 1]!.offsetHeight + "px";
    right.style.marginBottom = desk ? -x + "px" : "";
    grid.style.paddingBottom = desk ? Math.max(x, ch.stack ? ch.listH - 36 : 0) + "px" : "";
  });
}
function cxPaintAll() {
  CX.list.forEach((ch) => {
    if (REDUCED.matches) { ch.since = 1e6; ch.insts[ch.active]!.t = cxStill(ch.insts[ch.active]!); ch.mobs.forEach((M) => { M.since = 1e6; M.t = cxStill(M); }); }
    cxRender(ch); ch.mobs.forEach(cxRenderMob); if (ch.auto) cxBars(ch);
  });
}
/* Revision 17 auto list. When a step becomes active its panel plays once to its end and holds. Every step lasts the
   longest panel plus CX_AUTO_HOLD. Progress holds while the section is off screen or a tab has keyboard focus.
   Reduced motion: no advance and no fill; the active line is full and clicks switch steps. */
const CX_AUTO_HOLD = 1200;
function cxBars(ch: Chapter) {
  const p = REDUCED.matches ? 1 : clamp(ch.prog / ch.dur);
  ch.bars.forEach((b, i) => set(b, "transform", "scaleX(" + (i === ch.active ? p : 0).toFixed(4) + ")"));
}
function cxTabs(ch: Chapter) {
  ch.tabs.forEach((b, i) => { b.setAttribute("aria-selected", String(i === ch.active)); b.tabIndex = i === ch.active ? 0 : -1; });
  ch.vis.setAttribute("aria-labelledby", ch.tabs[ch.active]!.id);
}
/* A click on the active step restarts its panel too. */
function cxAutoGo(ch: Chapter, k: number) { ch.prog = 0; if (k === ch.active && !REDUCED.matches) ch.insts[k]!.t = 0; cxSetActive(ch, k); cxRender(ch); cxBars(ch); cxKick(); }
function cxAutoBind(ch: Chapter, signal: AbortSignal) {
  const root = ch.root;
  root.addEventListener("focusin", (e) => { ch.kbd = e.target instanceof Element && e.target.matches(":focus-visible"); }, { signal });
  root.addEventListener("focusout", (e) => { if (!root.contains(e.relatedTarget as Node | null)) { ch.kbd = false; cxKick(); } }, { signal });
  root.addEventListener("click", (e) => { const b = (e.target as Element).closest<HTMLElement>(".cx-tab"); if (b) cxAutoGo(ch, ch.tabs.indexOf(b)); }, { signal });
  root.addEventListener("keydown", (e) => {
    const i = ch.tabs.indexOf(e.target as HTMLElement), n = ch.tabs.length;
    if (i < 0) return;
    let k = -1;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") k = (i + 1) % n;
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") k = (i + n - 1) % n;
    else if (e.key === "Home") k = 0;
    else if (e.key === "End") k = n - 1;
    if (k < 0) return;
    e.preventDefault(); cxAutoGo(ch, k); ch.tabs[k]!.focus(); ch.kbd = true;
  }, { signal });
}
function cxStop() {
  if (CX.raf) cancelAnimationFrame(CX.raf);
  CX.list.forEach((ch) => clearTimeout(ch.tm));
  CX.raf = 0;
  [CX.io, CX.aio, CX.ro, CX.rio].forEach((o) => o?.disconnect());
  CX.io = CX.aio = CX.ro = CX.rio = null;
  CX.list = [];
}
function cxInit(signal: AbortSignal) {
  cxStop();
  CX.list = all(document, "#view .cx").map((root): Chapter => {
    const vis = one(root, ".cx-vis")!;
    return {
      root, id: root.id, vis, head: one(root, ".cx-head")!, steps: all(root, ".cx-step"), bgs: all(vis, ".cx-bg"),
      insts: all(vis, ".cx-card").map(cxInst), mobs: all(root, ".cx-mob .cx-card").map(cxInst),
      active: 0, prev: -1, since: 1e6, on: false, seen: false, target: 0, at: 0, tm: 0, stack: false, lock: [], lead: 0, listH: 0, fits: true,
      auto: root.classList.contains("cx-auto"), prog: 0, kbd: false, dur: 0,
      bars: all(root, ".cx-bar i"), words: all(root, ".cx-ttl .cx-w"), tabs: all(root, ".cx-tab"),
    };
  });
  CX.list.forEach((ch) => {
    if (!ch.auto) return;
    ch.dur = Math.max(...ch.insts.map((I) => SCENES[I.kind].end || 0)) + CX_AUTO_HOLD;
    cxAutoBind(ch, signal);
  });
  if (!CX.list.length) return;
  cxMeasureAll();
  CX.list.forEach((ch) => ch.insts.concat(ch.mobs).forEach((I) => { I.t = REDUCED.matches ? cxStill(I) : 0; }));
  cxPaintAll();
  /* Steps rise and fade in as they enter */
  if (!REDUCED.matches) {
    const rio = (CX.rio = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); rio.unobserve(e.target); } }), { rootMargin: "0px 0px -10% 0px", threshold: 0.05 }));
    CX.list.forEach((ch) => ch.steps.forEach((s) => { if (s.getBoundingClientRect().top < window.innerHeight * 0.9) return; s.classList.add("cx-rv"); rio.observe(s); }));
  }
  const onIO = (es: IntersectionObserverEntry[]) => {
    es.forEach((e) => {
      const node = cxNodes.get(e.target);
      if (!node) return;
      if ("kind" in node) { if (e.isIntersecting && !node.on && !REDUCED.matches) { node.since = 0; node.t = 0; } node.on = e.isIntersecting; return; }
      const ch = node;
      if (e.isIntersecting && !ch.seen && !REDUCED.matches) { ch.seen = true; ch.since = 0; ch.insts[ch.active]!.t = 0; ch.prog = 0; }
      if (e.isIntersecting && !ch.on) ch.at = performance.now();
      ch.on = e.isIntersecting;
      if (!ch.auto) cxGo(ch);
    });
    cxKick();
  };
  CX.io = new IntersectionObserver(onIO, { threshold: 0.12 });
  /* Revision 11: the auto list counts as on screen while any part of it shows. */
  CX.aio = new IntersectionObserver(onIO, { threshold: 0 });
  CX.list.forEach((ch) => {
    const tgt = ch.auto ? ch.root : ch.vis;
    cxNodes.set(tgt, ch);
    (ch.auto ? CX.aio! : CX.io!).observe(tgt);
    ch.mobs.forEach((M) => { cxNodes.set(M.el, M); CX.io!.observe(M.el); });
  });
  CX.ro = new ResizeObserver(() => { cxMeasureAll(); cxScroll(); if (!CX.raf) cxPaintAll(); });
  CX.list.forEach((ch) => CX.ro!.observe(ch.root));
  cxScroll(true);
  cxKick();
}

/* ---------- Phases rail (Marketing v15) ----------
   Desktop (above 900 px, no reduced motion): the section pins and vertical scroll moves the rail left 1:1.
   Narrow screens and reduced motion: a native horizontal rail with scroll-snap, mouse drag, touch swipe and arrow keys. */
function phInit(signal: AbortSignal) {
  const root = document.querySelector<HTMLElement>("#view .ph-sec");
  if (!root) return;
  const wide = window.matchMedia("(min-width: 901px)");
  const pin = one(root, ".phc-pin")!, frame = one(root, ".phc-frame")!, rail = one(root, ".phc-rail")!, list = one(root, ".phc-list")!;
  const cards = all(root, ".phc-card");
  const smooth = (): ScrollBehavior => (REDUCED.matches ? "auto" : "smooth");
  const step = () => (cards.length > 1 ? cards[1]!.offsetLeft - cards[0]!.offsetLeft : rail.clientWidth);
  const max = () => Math.max(0, rail.scrollWidth - rail.clientWidth);
  let st: { a: number; z: number; stick: number; travel: number; inset: number; vw: number } | null = null;
  let raf = 0;
  function measure() {
    const on = wide.matches && !REDUCED.matches;
    root!.classList.toggle("pinned", on);
    list.style.transform = ""; pin.style.height = ""; frame.style.top = "";
    if (!on) { st = null; return; }
    const cs = getComputedStyle(root!), vw = root!.clientWidth, vh = window.innerHeight;
    const inset = parseFloat(getComputedStyle(rail).paddingLeft) || 0;
    const top = parseFloat(getComputedStyle(frame).top) || 0, start = parseFloat(cs.getPropertyValue("--phc-start")) || 0.55, lead = parseFloat(cs.getPropertyValue("--phc-lead")) || 0;
    const fh = frame.offsetHeight, stick = Math.min(top, vh - fh - 16);
    const a = Math.max(0, start * vw - inset - lead * step()), z = vw - 2 * inset - list.scrollWidth;
    st = { a, z: Math.min(z, a), stick, travel: Math.max(0, a - Math.min(z, a)), inset, vw };
    frame.style.top = stick + "px";
    pin.style.height = fh + st.travel + "px";
    queue();
  }
  const progress = () => (st && st.travel ? Math.max(0, Math.min(1, (st.stick - pin.getBoundingClientRect().top) / st.travel)) : 0);
  function tick() { raf = 0; if (st) list.style.transform = "translate3d(" + (st.a - st.travel * progress()).toFixed(2) + "px,0,0)"; }
  function queue() { if (!raf) raf = requestAnimationFrame(tick); }
  function onFocus(e: FocusEvent) {
    const c = (e.target as Element).closest<HTMLElement>(".phc-card");
    if (!c || !st) return;
    const x = st.a - st.travel * progress(), l = st.inset + x + c.offsetLeft, r = l + c.offsetWidth;
    let nx = x;
    if (l < st.inset) nx = x + (st.inset - l); else if (r > st.vw - st.inset) nx = x - (r - (st.vw - st.inset));
    const pt = pin.getBoundingClientRect().top;
    if (nx === x && pt <= st.stick + 1 && pt >= st.stick - st.travel - 1) return;
    const p = st.travel ? Math.max(0, Math.min(1, (st.a - nx) / st.travel)) : 0;
    window.scrollTo({ top: Math.round(window.scrollY + pt - st.stick + p * st.travel), behavior: "instant" });
  }
  function onKey(e: KeyboardEvent) {
    const k = cards.indexOf(e.target as HTMLElement), n = cards.length;
    if (k < 0) return;
    let dest = -1;
    if (e.key === "ArrowRight") dest = Math.min(n - 1, k + 1); else if (e.key === "ArrowLeft") dest = Math.max(0, k - 1); else if (e.key === "Home") dest = 0; else if (e.key === "End") dest = n - 1;
    if (dest < 0) return;
    e.preventDefault();
    cards[dest]!.focus({ preventScroll: true });
    if (!st) rail.scrollTo({ left: Math.max(0, Math.min(max(), dest * step())), behavior: smooth() });
  }
  /* Native mode: mouse drag. Touch and trackpads scroll natively. */
  let d: { x: number; s: number; moved: boolean; id: number } | null = null, dragged = false;
  rail.addEventListener("pointerdown", (e) => { if (st || e.pointerType !== "mouse" || e.button !== 0) return; d = { x: e.clientX, s: rail.scrollLeft, moved: false, id: e.pointerId }; }, { signal });
  rail.addEventListener("pointermove", (e) => {
    if (!d) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) > 5) { d.moved = true; rail.classList.add("drag"); try { rail.setPointerCapture(d.id); } catch { /* pointer already released */ } }
    if (d.moved) rail.scrollLeft = d.s - dx;
  }, { signal });
  const end = () => {
    if (!d) return;
    const moved = d.moved; d = null;
    if (!moved) return;
    const at = rail.scrollLeft;
    rail.classList.remove("drag");
    rail.scrollLeft = at;
    rail.scrollTo({ left: Math.max(0, Math.min(max(), Math.round(at / step()) * step())), behavior: smooth() });
    dragged = true; setTimeout(() => { dragged = false; }, 0);
  };
  rail.addEventListener("pointerup", end, { signal });
  rail.addEventListener("pointercancel", end, { signal });
  rail.addEventListener("click", (e) => { if (dragged) { e.preventDefault(); e.stopPropagation(); } }, { capture: true, signal });
  rail.addEventListener("keydown", onKey, { signal });
  rail.addEventListener("focusin", onFocus, { signal });
  window.addEventListener("scroll", () => { if (st) queue(); }, { passive: true, signal });
  window.addEventListener("resize", measure, { signal });
  wide.addEventListener("change", measure, { signal });
  const ro = new ResizeObserver(measure);
  ro.observe(frame);
  signal.addEventListener("abort", () => { ro.disconnect(); if (raf) cancelAnimationFrame(raf); });
  measure();
}

/* ---------- /oversight sending paths (Revision 28) ----------
   One timer moves the phrase and the card together every OVS_STEP ms, only while 30% of the section is on screen.
   Reduced motion: no auto advance; the control becomes "next". */
const OVS_STEP = 5500;
const OVS = { tm: 0 as ReturnType<typeof setTimeout> | 0, io: null as IntersectionObserver | null, root: null as HTMLElement | null, k: 0, paused: false, vis: false };
const ovsRunning = () => !!OVS.root && OVS.root.isConnected && !OVS.paused && OVS.vis && !document.hidden && !REDUCED.matches;
function ovsSched() {
  clearTimeout(OVS.tm); OVS.tm = 0;
  if (ovsRunning()) OVS.tm = setTimeout(() => { OVS.tm = 0; ovsGo((OVS.k + 1) % 3); ovsSched(); }, OVS_STEP);
}
function ovsBtn() {
  const b = OVS.root && one(OVS.root, ".ovs-pp"); if (!b) return;
  const next = REDUCED.matches;
  b.innerHTML = next ? ARROW_SVG : OVS.paused ? PLAY_SVG : PAUSE_SVG;
  b.setAttribute("aria-label", next ? "Show the next sending path" : OVS.paused ? "Play the sending paths" : "Pause the sending paths");
}
/* Revision 31: the new width and the roll offset are set in the same call, so both transitions start on the same frame. */
function ovsGo(k: number, now?: boolean) {
  const root = OVS.root; if (!root) return;
  const roll = one(root, ".ovs-roll"); if (!roll) return;
  const rl = roll.firstElementChild as HTMLElement, it = rl.children, els = all(root, ".ovs-mv");
  OVS.k = k;
  if (now) { roll.classList.add("ovs-now"); els.forEach((e) => e.classList.add("ovs-now")); }
  roll.style.width = (it[k] as HTMLElement).offsetWidth + "px";
  rl.style.transform = "translate3d(0," + -k * (it[0] as HTMLElement).offsetHeight + "px,0)";
  els.forEach((e) => e.classList.toggle("on", Number(e.dataset.i) === k));
  all(root, ".ovs-bg").forEach((e, i) => e.classList.toggle("on", i === k));
  if (now) { void roll.offsetWidth; roll.classList.remove("ovs-now"); els.forEach((e) => e.classList.remove("ovs-now")); }
}
function ovsStop() { clearTimeout(OVS.tm); OVS.tm = 0; OVS.io?.disconnect(); OVS.io = null; }
function ovsInit() {
  ovsStop();
  const root = (OVS.root = document.querySelector<HTMLElement>("#view .sec-ov-paths"));
  if (!root) return;
  OVS.paused = false; OVS.vis = false; OVS.k = 0;
  ovsGo(0, true); ovsBtn();
  OVS.io = new IntersectionObserver((es) => { const v = es[es.length - 1]!.isIntersecting; if (v !== OVS.vis) { OVS.vis = v; ovsSched(); } }, { threshold: 0.3 });
  OVS.io.observe(one(root, ".ovs-run")!);
}

/* ---------- Section reveals ---------- */
let revealObservers: IntersectionObserver[] = [];
function setupReveals() {
  revealObservers.forEach((o) => o.disconnect());
  revealObservers = [];
  const sel = "#view .sec-head, #view .feat, #view .aud, #view .trust-item, #view .tile, #view .split, #view .cta-box, #view .e-copy, #view .e-vis, #view .form-card, #view .access-table-wrap, #view .hero-band";
  /* Revision 16: the section that follows the phases rail reveals as one block. */
  const ph = document.querySelector("#view .ph-sec"), next = ph?.nextElementSibling, up = next?.querySelector<HTMLElement>(".wrap") ?? null;
  const els = all(document, sel).filter((el) => !up || !up.contains(el));
  if (up) els.push(up);
  if (REDUCED.matches) return;
  const o3 = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); o3.unobserve(e.target); } }), { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
  const o4 = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting || e.boundingClientRect.bottom < 0) { e.target.classList.add("in"); o4.unobserve(e.target); } }), { rootMargin: "0px 0px -12% 0px", threshold: 0 });
  els.forEach((el) => {
    const sib = el.parentElement ? Array.prototype.indexOf.call(el.parentElement.children, el) : 0;
    el.style.setProperty("--rv-d", Math.min(sib, 4) * 70 + "ms");
    if (el.getBoundingClientRect().top < window.innerHeight * 0.92) return;
    el.classList.add("rv");
    if (el === up) { el.classList.add("rv-up"); el.style.setProperty("--rv-d", "0ms"); o4.observe(el); return; }
    o3.observe(el);
  });
  revealObservers.push(o3, o4);
}

/* ---------- EvryBot life: random blinks and glances, pointer follow ---------- */
const bots = () => all(document, ".evry-bot").filter((b) => b.offsetParent);
function botBlink(b: HTMLElement) { b.setAttribute("data-blink", ""); setTimeout(() => b.removeAttribute("data-blink"), 200); }
function botGlance(b: HTMLElement) {
  if (b.dataset.mood !== "idle" || b.hasAttribute("data-following")) return;
  const sz = b.getBoundingClientRect().width, r = () => (Math.random() * 2 - 1) * sz * 0.07;
  b.style.setProperty("--lx", r() + "px"); b.style.setProperty("--ly", r() * 0.7 + "px");
  setTimeout(() => { b.style.setProperty("--lx", "0px"); b.style.setProperty("--ly", "0px"); }, 900 + Math.random() * 900);
}
function seedBots() {
  all(document, ".evry-bot").forEach((b) => { b.style.setProperty("--blink", (3.8 + Math.random() * 3).toFixed(2) + "s"); b.style.setProperty("--blink-delay", (-Math.random() * 4).toFixed(2) + "s"); });
}
const followTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
function botFollow(e: PointerEvent) {
  if (REDUCED.matches) return;
  all(document, ".evry-bot[data-follow]").forEach((b) => {
    if (b.dataset.mood !== "idle") return;
    const r = b.getBoundingClientRect(); if (!r.width) return;
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2), d = Math.hypot(dx, dy) || 1, m = Math.min(1, d / 300) * r.width * 0.09;
    b.setAttribute("data-following", ""); b.style.setProperty("--lx", (dx / d) * m + "px"); b.style.setProperty("--ly", (dy / d) * m + "px");
    clearTimeout(followTimers.get(b));
    followTimers.set(b, setTimeout(() => { b.removeAttribute("data-following"); b.style.setProperty("--lx", "0px"); b.style.setProperty("--ly", "0px"); }, 1600));
  });
}

/* ---------- Chrome: floating nav pill, mobile menu, FAQ ---------- */
let pillOn: boolean | null = null, pillTicking = false;
function navClose() {
  ["site-nav", "nav-pill"].forEach((id) => {
    const el = document.getElementById(id); if (!el) return;
    el.classList.remove("open");
    one(el, ".nav-toggle")?.setAttribute("aria-expanded", "false");
  });
}
/* Floating pill: shown once the scroll passes the in-flow nav height. */
function navPill(force?: boolean) {
  pillTicking = false;
  const nav = document.getElementById("site-nav"), pill = document.getElementById("nav-pill");
  if (!nav || !pill) return;
  const on = window.scrollY > nav.offsetHeight;
  if (on === pillOn && !force) return;
  if (on !== pillOn) navClose();
  pillOn = on;
  pill.classList.toggle("on", on);
  pill.inert = !on;
  pill.setAttribute("aria-hidden", String(!on));
}
function faqSet(item: Element | null, open: boolean) {
  if (!item) return;
  item.classList.toggle("open", open);
  one(item, ".faq-q")?.setAttribute("aria-expanded", String(open));
}
function onClick(e: MouseEvent) {
  const target = e.target as Element;
  if (target.closest(".ha-pause") && HA.root) { HA.paused = !HA.paused; haPauseBtn(); haKick(); return; }
  const pp = target.closest(".ovs-pp");
  if (pp && OVS.root) { if (REDUCED.matches) ovsGo((OVS.k + 1) % 3); else { OVS.paused = !OVS.paused; ovsBtn(); ovsSched(); } return; }
  const q = target.closest(".faq-q");
  if (q) { faqSet(q.closest(".faq-i"), q.getAttribute("aria-expanded") !== "true"); return; }
  const tg = target.closest(".nav-toggle");
  if (tg) { const nav = tg.closest(".site-nav, .nav-pill")!; const open = nav.classList.toggle("open"); tg.setAttribute("aria-expanded", String(open)); return; }
  if (target.closest(".nav-links a")) navClose();
}
function onKeydown(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  const open = document.querySelector(".site-nav.open, .nav-pill.open");
  if (!open) return;
  navClose();
  one(open, ".nav-toggle")?.focus();
}
/* A link to #faq-<id> opens that answer. */
function openHashTarget() {
  const id = decodeURIComponent(location.hash.slice(1));
  const el = id ? document.getElementById(id) : null;
  if (el?.classList.contains("faq-i")) faqSet(el, true);
}

function initEngines(signal: AbortSignal) {
  cache = new WeakMap();
  setupReveals(); seedBots(); haInit(); cxInit(signal); phInit(signal); ovsInit();
}

/** Starts every engine on the current page. Returns a cleanup that stops them and removes their listeners. */
export function startMotion(): () => void {
  REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)");
  const life = new AbortController(), opts = { signal: life.signal };
  let engines = new AbortController();
  initEngines(engines.signal);
  navPill(true);
  openHashTarget();

  const kickAll = () => { haKick(); cxKick(); if (OVS.root) ovsSched(); };
  document.addEventListener("click", onClick, opts);
  document.addEventListener("keydown", onKeydown, opts);
  document.addEventListener("visibilitychange", kickAll, opts);
  document.addEventListener("pointermove", botFollow, opts);
  window.addEventListener("hashchange", openHashTarget, opts);
  window.addEventListener("scroll", () => {
    if (!pillTicking) { pillTicking = true; requestAnimationFrame(() => navPill()); }
    if (!CX.ticking && CX.list.length) { CX.ticking = true; requestAnimationFrame(() => cxScroll()); }
  }, { passive: true, signal: life.signal });
  /* Revision 13: the stacked step share depends on the viewport height. */
  window.addEventListener("resize", () => {
    if (CX.list.length) { cxMeasureAll(); cxScroll(); }
    if (OVS.root?.isConnected) ovsGo(OVS.k, true);
  }, { passive: true, signal: life.signal });
  REDUCED.addEventListener("change", () => { engines.abort(); engines = new AbortController(); initEngines(engines.signal); }, opts);
  void document.fonts.ready.then(() => {
    if (life.signal.aborted) return;
    haMeasure(); if (HA.root) haRender(HA.t);
    cxMeasureAll(); if (!CX.raf) cxPaintAll();
  });
  let blink: ReturnType<typeof setTimeout>;
  (function botLife() {
    if (!REDUCED.matches) bots().forEach((b) => { if (Math.random() < 0.35) botBlink(b); if (Math.random() < 0.25) botGlance(b); });
    blink = setTimeout(botLife, 1400 + Math.random() * 1600);
  })();

  return () => {
    life.abort(); engines.abort();
    clearTimeout(blink);
    haStop(); cxStop(); ovsStop();
    revealObservers.forEach((o) => o.disconnect());
    pillOn = null;
  };
}
