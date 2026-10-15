// Client port of the prototype's motion engines (design/everyfield-marketing.html) for the sections that are still
// string markup: the phases rail (ph*), the sending paths (ovs*), section reveals, EvryBot life and the FAQ (R3 removes
// this file). The hero, chapters and auto lists are React with Motion; the header, pill and menus are React (components/frame).
// startMotion() runs once per page load and returns a cleanup. Every engine renders a still frame under
// prefers-reduced-motion. Comments that start with "Revision" keep the prototype's design notes.

const PAUSE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>';
const PLAY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
const ARROW_SVG = '<svg class="i " viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

let REDUCED: MediaQueryList;
const all = <T extends Element = HTMLElement>(root: ParentNode, s: string) => Array.from(root.querySelectorAll<T>(s));
const one = <T extends Element = HTMLElement>(root: ParentNode, s: string) => root.querySelector<T>(s);

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

/* ---------- FAQ (the header, pill and menus are React: components/frame/SiteNav.tsx) ---------- */
function faqSet(item: Element | null, open: boolean) {
  if (!item) return;
  item.classList.toggle("open", open);
  one(item, ".faq-q")?.setAttribute("aria-expanded", String(open));
}
function onClick(e: MouseEvent) {
  const target = e.target as Element;
  const pp = target.closest(".ovs-pp");
  if (pp && OVS.root) { if (REDUCED.matches) ovsGo((OVS.k + 1) % 3); else { OVS.paused = !OVS.paused; ovsBtn(); ovsSched(); } return; }
  const q = target.closest(".faq-q");
  if (q) faqSet(q.closest(".faq-i"), q.getAttribute("aria-expanded") !== "true");
}
/* A link to #faq-<id> opens that answer. */
function openHashTarget() {
  const id = decodeURIComponent(location.hash.slice(1));
  const el = id ? document.getElementById(id) : null;
  if (el?.classList.contains("faq-i")) faqSet(el, true);
}

function initEngines(signal: AbortSignal) {
  setupReveals(); seedBots(); phInit(signal); ovsInit();
}

/** Starts every engine on the current page. Returns a cleanup that stops them and removes their listeners. */
export function startMotion(): () => void {
  REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)");
  const life = new AbortController(), opts = { signal: life.signal };
  let engines = new AbortController();
  initEngines(engines.signal);
  openHashTarget();

  const kickAll = () => { if (OVS.root) ovsSched(); };
  document.addEventListener("click", onClick, opts);
  document.addEventListener("visibilitychange", kickAll, opts);
  document.addEventListener("pointermove", botFollow, opts);
  window.addEventListener("hashchange", openHashTarget, opts);
  /* Revision 13: the stacked step share depends on the viewport height. */
  window.addEventListener("resize", () => {
    if (OVS.root?.isConnected) ovsGo(OVS.k, true);
  }, { passive: true, signal: life.signal });
  REDUCED.addEventListener("change", () => { engines.abort(); engines = new AbortController(); initEngines(engines.signal); }, opts);
  void document.fonts.ready.then(() => {
    if (life.signal.aborted) return;
  });
  let blink: ReturnType<typeof setTimeout>;
  (function botLife() {
    if (!REDUCED.matches) bots().forEach((b) => { if (Math.random() < 0.35) botBlink(b); if (Math.random() < 0.25) botGlance(b); });
    blink = setTimeout(botLife, 1400 + Math.random() * 1600);
  })();

  return () => {
    life.abort(); engines.abort();
    clearTimeout(blink);
    ovsStop();
    revealObservers.forEach((o) => o.disconnect());
  };
}
