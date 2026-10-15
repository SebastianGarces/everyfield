// Client port of the prototype's motion engines (design/everyfield-marketing.html) for the sections that are still
// string markup: section reveals, EvryBot life and the FAQ (R3 removes
// this file). The hero, chapters and auto lists are React with Motion; the header, pill and menus are React (components/frame).
// startMotion() runs once per page load and returns a cleanup. Every engine renders a still frame under
// prefers-reduced-motion. Comments that start with "Revision" keep the prototype's design notes.


let REDUCED: MediaQueryList;
const all = <T extends Element = HTMLElement>(root: ParentNode, s: string) => Array.from(root.querySelectorAll<T>(s));
const one = <T extends Element = HTMLElement>(root: ParentNode, s: string) => root.querySelector<T>(s);

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
  const q = target.closest(".faq-q");
  if (q) faqSet(q.closest(".faq-i"), q.getAttribute("aria-expanded") !== "true");
}
/* A link to #faq-<id> opens that answer. */
function openHashTarget() {
  const id = decodeURIComponent(location.hash.slice(1));
  const el = id ? document.getElementById(id) : null;
  if (el?.classList.contains("faq-i")) faqSet(el, true);
}

function initEngines() {
  setupReveals(); seedBots();
}

/** Starts every engine on the current page. Returns a cleanup that stops them and removes their listeners. */
export function startMotion(): () => void {
  REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)");
  const life = new AbortController(), opts = { signal: life.signal };
  initEngines();
  openHashTarget();

  document.addEventListener("click", onClick, opts);
  document.addEventListener("pointermove", botFollow, opts);
  window.addEventListener("hashchange", openHashTarget, opts);
  REDUCED.addEventListener("change", initEngines, opts);
  let blink: ReturnType<typeof setTimeout>;
  (function botLife() {
    if (!REDUCED.matches) bots().forEach((b) => { if (Math.random() < 0.35) botBlink(b); if (Math.random() < 0.25) botGlance(b); });
    blink = setTimeout(botLife, 1400 + Math.random() * 1600);
  })();

  return () => {
    life.abort();
    clearTimeout(blink);
    revealObservers.forEach((o) => o.disconnect());
  };
}
