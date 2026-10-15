import "server-only";
import { ACCESS_PATH } from "@/site";
import { COPY, type Copy } from "./copy";

// Server-side port of the prototype's markup builders (design/everyfield-marketing.html, the <script> block).
// The HTML strings stay as close to the prototype as possible: the CSS and the motion engines in engines.ts select on
// this exact structure. Changes from the prototype: real routes instead of hash routes, links to pages that are not
// live are hidden or go to the access form, and copy comes from design/marketing-copy.json through copy.ts.
// Product visuals use a demo church (Harvest Point); that sample data is part of the approved design.

/* ---------- Routes ---------- */
const ACCESS = ACCESS_PATH;
const ROUTE: Record<string, string> = {
  // The planters page is not live yet; its buttons go to the request page.
  "See the seven phases": ACCESS,
  "I am a planter": ACCESS,
  "See the planter's week": ACCESS,
  "See how it works": "/#week",
  "See what sending churches and networks see": "/oversight",
};
const routeHref = (label: string) => ROUTE[label] ?? ACCESS;

/* ---------- Helpers ---------- */
const ICON = {
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  arrowUpRight: '<path d="M17 7L6 18"/><path d="M11 6h7v7"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2c2.4.2 4 1.8 4.5 4.8"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="14" rx="3"/><path d="M8 3.5v4M16 3.5v4M4 10h16"/>',
  sparkle: '<path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  book: '<path d="M4 5.5A2 2 0 0 1 6 4h13v14H6a2 2 0 0 0-2 2z"/><path d="M4 20V5.5M8 8h7"/>',
  shield: '<path d="M12 3.5l7 3v5c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9v-5z"/><path d="M9 12l2 2 4-4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  task: '<rect x="4.5" y="4.5" width="15" height="15" rx="4"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  heart: '<path d="M12 20s-7.5-4.5-7.5-10A4.2 4.2 0 0 1 12 7.6 4.2 4.2 0 0 1 19.5 10c0 5.5-7.5 10-7.5 10z"/>',
  more: '<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>',
  compass: '<circle cx="12" cy="12" r="8.5"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  scale: '<path d="M12 4v16M6 20h12M5 8h14M7 8l-3 6a3 3 0 0 0 6 0zM17 8l-3 6a3 3 0 0 0 6 0z"/>',
  pin: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
  network: '<circle cx="12" cy="5.5" r="2.3"/><circle cx="5.5" cy="18" r="2.3"/><circle cx="18.5" cy="18" r="2.3"/><path d="M10.9 7.6l-4.3 8.2M13.1 7.6l4.3 8.2M7.9 18h8.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};
export type IconName = keyof typeof ICON;
const isIcon = (s: string): s is IconName => Object.hasOwn(ICON, s);

export function icon(name: string, cls?: string) {
  return '<svg class="i ' + (cls || "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (isIcon(name) ? ICON[name] : "") + "</svg>";
}
function esc(s: string | number) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}
/** Text renderer: escapes and applies the official brand spelling. */
export function t(s: string) {
  return esc(s).replace(/Everyfield/g, "EveryField");
}
/* Nav logo: the wordmark viewBox is padded at the top and bottom (-26.4 to 190) so its box centre is the cap-height centre. */
export function logo(extra?: string) {
  const nav = /nav-logo/.test(extra || "");
  return '<span class="logo ' + (extra || "") + '"><svg class="lm" viewBox="0 0 657 530" aria-hidden="true"><use href="#ef-mark"/></svg>' +
    '<svg class="lw" viewBox="' + (nav ? "0 -26.4 890 216.4" : "0 0 890 186") + '" role="img" aria-label="EveryField"><use href="#ef-wordmark"' + (nav ? ' width="890" height="186"' : "") + "/></svg></span>";
}
export function mark() { return '<svg viewBox="0 0 657 530" aria-hidden="true"><use href="#ef-mark"/></svg>'; }

export function btn(label: string, kind?: "primary" | "secondary", href?: string) {
  return '<a class="mk-btn ' + (kind || "primary") + '" href="' + (href || routeHref(label)) + '">' + t(label) + (kind === "secondary" ? "" : icon("arrow")) + "</a>";
}

/* ---------- Product visuals (demo church data, not labelled on the page) ---------- */
function visual(inner: string, caption?: string) {
  return '<figure class="visual">' + inner + (caption ? '<figcaption class="caption">' + t(caption) + "</figcaption>" : "") + "</figure>";
}
function frame(active: string, title: string, sub: string, body: string, right?: string, topRight?: string, opts?: { avatar?: string }) {
  const tabs = ["Overview", "People", "Meetings", "Tasks", "Network"].filter((x) => (active === "Network" ? x !== "Tasks" : x !== "Network"));
  return '<div class="ef app-frame"><div class="af-top"><span class="af-brand">' + mark() + "</span>" + (opts && opts.avatar ? "" : '<span class="af-pills">' +
    tabs.map((x) => '<span class="' + (x === active ? "on" : "") + '">' + x + "</span>").join("") + "</span>") +
    '<span class="af-sp"></span>' + (topRight || "") + '<span class="avatar tone-green">' + ((opts && opts.avatar) || "DR") + '</span></div><div class="af-body"><div class="af-head"><div><div class="af-title">' +
    title + '</div><div class="af-sub">' + sub + "</div></div>" + (right || "") + "</div>" + body + "</div></div>";
}
function coreGroupCard(withRhythm: boolean) {
  return '<div class="card"><div class="card-header"><div class="grow"><div class="card-title">Core team</div><div class="card-description">Committed adults</div></div>' + icon("more", "faint") + "</div>" +
    '<div class="stat-value">34</div><div class="row mt" style="margin-top:10px"><span class="delta" data-dir="up">9 people</span><span class="faint t-sm">vs prior 28 days</span></div>' +
    '<div style="margin-top:12px">' +
    '<div class="kv"><span class="k">Launch team</span><span class="row"><span class="v">12</span><span class="delta" data-dir="up">3 people</span></span></div>' +
    (withRhythm ? '<div class="kv"><span class="k">Last vision meeting</span><span class="row"><span class="v">16 d ago</span><span class="badge" data-size="sm" data-status="measured">Next Oct 12</span></span></div>' : '<div class="kv"><span class="k">Vision meetings</span><span class="row"><span class="v">2</span><span class="faint t-sm">this month</span></span></div>') +
    '<div class="kv"><span class="k">Avg attendance</span><span class="v">44</span></div>' +
    '<div class="kv"><span class="k">Followed up in 48 h</span><span class="row"><span class="v">71%</span><span class="delta" data-dir="down">8%</span></span></div></div></div>';
}
function needsYouCard() {
  const rows = [
    ["tone-magenta", "alert", "3 follow-ups overdue", "James Okafor is the oldest at 3 days"],
    ["tone-amber", "task", "2 commitments to record", "Maria Santos signed on Oct 6"],
    ["tone-blue", "users", "Kids ministry needs a leader", "2 of 6 roles filled"],
    ["tone-ink", "heart", "Reaffirm prayer rhythm", "Last answered 34 days ago"],
  ] as const;
  return '<div class="card"><div class="card-header"><div class="grow"><div class="card-title">Needs you</div><div class="card-description">4 things this week</div></div>' + icon("more", "faint") + "</div><div>" +
    rows.map((r) => '<div class="list-row"><span class="card-icon ' + r[0] + '">' + icon(r[1]) + '</span><div class="grow"><div class="list-title">' + r[2] + '</div><div class="list-sub">' + r[3] + "</div></div>" + icon("arrow", "chev") + "</div>").join("") + "</div></div>";
}
function focusCard() {
  return '<div class="insight" data-tone="dawn"><div class="insight-top"><span class="insight-pill">' + icon("compass") + 'Focus this week</span><span class="insight-count">Plant Intelligence</span></div>' +
    '<div class="insight-metric"><span class="num">16 d</span><span class="unit">since the last vision meeting</span></div>' +
    '<div class="insight-title">Hold your next vision meeting this week</div>' +
    '<div class="insight-text">Vision meeting #12 is set for Sun Oct 12. Invite the 9 guests from #11.</div>' +
    '<div class="insight-footer"><span class="btn" data-variant="light">See the facts ' + icon("arrow") + '</span><span class="btn" data-variant="glass">Why this?</span></div></div>';
}
function evryBot(size: string, mood?: string, follow?: boolean) {
  return '<span class="evry-bot" data-size="' + size + '" data-mood="' + (mood || "idle") + '"' + (follow ? " data-follow" : "") + ' aria-hidden="true"><span class="eb-body"></span><span class="eb-face"><span class="eb-eye"></span><span class="eb-eye"></span><span class="eb-mouth"></span></span></span>';
}
function meetingsCard() {
  const h = [38, 44, 41, 52, 55, 50, 61, 66, 70];
  return '<div class="card"><div class="card-header"><div class="grow"><div class="card-title">Vision meetings</div></div><span class="faint t-sm">Attendance, last 10</span></div>' +
    '<div class="bars" style="margin-top:26px">' + h.map((x) => '<div class="bar hatch" style="height:' + x + '%"></div>').join("") + '<div class="bar solid" style="height:78%"><span class="lbl">47</span></div></div><div class="chart-axis"><span>Jun 1</span><span>Sep 28</span></div></div>';
}
function peopleCard() {
  const st = [["tone-ink", "Prospect", 82, 100, "var(--ef-text-3)", 1], ["tone-blue", "Attendee", 41, 50, "var(--ef-blue-500)", 1], ["tone-amber", "Following up", 23, 28, "var(--ef-amber-500)", 1], ["tone-violet", "Interviewed", 14, 17, "var(--ef-violet-500)", 1], ["tone-green", "Core group", 34, 41, "var(--ef-green-500)", 0], ["tone-teal", "Launch team", 12, 15, "var(--ef-teal-500)", 0], ["tone-ink", "Leader", 8, 10, "var(--ef-ink)", 0]] as const;
  return '<div class="card"><div class="card-header"><div class="grow"><div class="card-title">Where people are</div><div class="card-description">214 people across 7 stages</div></div></div><div style="display:grid;gap:14px">' +
    st.map((x) => '<div><div class="row between"><span class="stage-chip ' + x[0] + '">' + x[1] + '</span><span class="num" style="font-size:18px">' + x[2] + '</span></div><div class="meter-hatch"><span class="' + (x[5] ? "hatch" : "") + '" style="width:' + x[3] + "%;" + (x[5] ? "--hatch:" + x[4] : "background:" + x[4]) + '"></span></div></div>').join("") +
    '</div><div class="card-inset" style="margin-top:16px"><div style="font-weight:600;font-size:13.5px">14 interviewed people have not committed yet.</div><div class="faint t-sm" style="margin-top:4px">Half of them were interviewed more than 3 weeks ago.</div></div></div>';
}
function comingUpCard() {
  return '<div class="card"><div class="card-header"><div class="grow"><div class="card-title">Coming up</div><div class="card-description">This week and next</div></div></div>' +
    '<div class="list-row"><span class="card-icon tone-green">' + icon("calendar") + '</span><div class="grow"><div class="list-title">Vision meeting #12</div><div class="list-sub">Sun Oct 12 · Reyes home · 38 RSVPs</div></div></div>' +
    '<div class="list-row"><span class="card-icon tone-violet">' + icon("users") + '</span><div class="grow"><div class="list-title">Worship team training</div><div class="list-sub">Wed Oct 15 · 8 of 9 confirmed</div></div></div>' +
    '<div class="list-row"><span class="card-icon tone-blue">' + icon("task") + '</span><div class="grow"><div class="list-title">Interview David Kim</div><div class="list-sub">Fri Oct 17 · 4 pm at the Reyes home</div></div></div></div>';
}
function vMondayOverview() {
  return frame("Overview", "Good morning, Daniel", "Harvest Point Church · Phase 1, Core Group Development · Launch target spring 2027",
    '<div class="monday"><div class="col col-1">' + coreGroupCard(true) + meetingsCard() + '</div><div class="col col-2">' + peopleCard() + comingUpCard() + '</div><div class="col col-3">' + focusCard() + needsYouCard() + "</div></div>",
    "", '<span class="af-evry">' + evryBot("sm") + '<span class="l">Ask Evry</span></span>');
}
/* Revision 24: the /oversight hero dashboard (Austin Sending Network, 14 plants). */
const NET_PLANTS = [
  ["Harvest Point Church", "Hyde Park, Austin, TX", "tone-green", "1 · Core group", "34", "Mar 14, 2027", "1 finding"],
  ["Eastside Commons", "East Austin, Austin, TX", "tone-blue", "3 · Training", "46", "May 2, 2027", "4 findings"],
  ["Mueller Fellowship", "Mueller, Austin, TX", "tone-violet", "0 · Discovery", "8", "Not set", ""],
  ["Alamo Heights Church", "San Antonio, TX", "tone-amber", "2 · Launch team", "28", "Sep 2027", "2 findings"],
  ["Deep Ellum Collective", "Dallas, TX", "tone-teal", "4 · Pre-launch", "61", "Jan 24, 2027", "3 findings"],
] as const;
function vNetworkDash() {
  const stats = [["Plants", "14", "In 2 states", 0], ["Launching in 12 months", "5", "Next: Deep Ellum, Jan 24", 0], ["Committed adults", "412", "Across 14 plants", 0], ["Needs attention", "3", "Need a look this month", 1]] as const;
  const areas = [["All", 14], ["Austin", 5], ["San Antonio", 3], ["Dallas–Fort Worth", 3], ["Houston", 1], ["Oklahoma City", 2]] as const;
  const plants = '<div class="card ovd-plants"><div class="card-header"><div class="grow"><div class="card-title">Plants</div><div class="card-description">In order of launch date.</div></div></div>' +
    '<div class="ovd-areas"><span class="ovd-lab">Area</span>' + areas.map((a, i) => '<span class="ovd-chip' + (i ? "" : " on") + '">' + a[0] + " <b>" + a[1] + "</b></span>").join("") + "</div>" +
    '<table><thead><tr><th>Plant</th><th>Phase</th><th class="hide-sm">Core group</th><th class="hide-sm">Launch</th><th class="hide-sm">Findings</th></tr></thead><tbody>' +
    NET_PLANTS.map((p) =>
      '<tr><td><div class="row" style="gap:10px"><span class="card-icon ' + p[2] + ' hide-sm" style="width:34px;height:34px">' + icon("pin") + '</span><div><div class="cell-title">' + p[0] + '</div><div class="cell-sub">' + p[1] + "</div></div></div></td>" +
      '<td><span class="tag">' + p[3] + '</span></td><td class="hide-sm">' + p[4] + '</td><td class="hide-sm" style="white-space:nowrap">' + p[5] + '</td><td class="hide-sm">' + (p[6] ? '<span class="badge" data-size="sm" data-status="measured">' + p[6] + "</span>" : '<span class="faint">—</span>') + "</td></tr>",
    ).join("") + "</tbody></table></div>";
  const finding = '<div class="insight" data-tone="lilac"><div class="insight-top"><span class="insight-pill">' + icon("sparkle") + 'Top network finding</span><span class="insight-count">From 11 of 14 plants</span></div>' +
    '<div class="insight-metric"><span class="num">4 of 6</span><span class="unit">plants within a year of launch have a Concern on Emerging leadership</span></div>' +
    '<div class="insight-title">Emerging leadership is the most common gap before launch</div>' +
    '<div class="insight-text">It is the lens most often at Watch or Concern across plants in Training and Pre-launch. Both plants that have already launched had their leader roles filled before Training.</div>' +
    '<div class="insight-footer"><span class="btn" data-variant="light">See the plants ' + icon("arrow") + "</span></div></div>";
  return frame("Network", 'Austin Sending Network<span class="badge ovd-badge hide-sm" data-status="measured">Network view</span>', "14 plants in Texas and Oklahoma, in launch order.",
    '<div class="ovd-tabs"><span class="on">Plants</span><span>Network Intelligence</span></div>' +
    '<div class="stat-grid ovd-stats">' + stats.map((s) => '<div class="card"><div class="stat-label">' + s[0] + '</div><div class="stat-value"' + (s[3] ? ' style="color:var(--ef-amber-display)"' : "") + ">" + s[1] + '</div><div class="faint t-sm">' + s[2] + "</div></div>").join("") + "</div>" +
    '<div class="ovd-grid">' + plants + finding + "</div>",
    '<span class="btn hide-sm" data-variant="primary">' + icon("users") + "Invite a plant</span>", "", { avatar: "JM" });
}

export const PAUSE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>';

/* ---------- Sections ---------- */
type HeroCopy = { eyebrow?: string; headline: string; subhead: string; cta_primary: string; cta_secondary?: string; note?: string };
type HeroOpts = { page?: boolean; cls?: string; panel?: boolean; visual?: string | false; hrefs?: [string, string] };
export function hero(h: HeroCopy, opts: HeroOpts = {}) {
  return '<section class="hero' + (opts.page ? " page-hero" : "") + (opts.cls ? " " + opts.cls : "") + '" id="top"><div class="wrap">' + (opts.panel ? '<div class="hero-panel gsurf" data-tone="field"><span class="hero-bg gsurf" data-tone="field" aria-hidden="true"></span>' : "") +
    (h.eyebrow ? '<span class="eyebrow">' + t(h.eyebrow) + "</span>" : "") +
    '<h1 class="display h-hero hero-title">' + t(h.headline) + "</h1>" +
    '<div class="hero-row"><div class="hero-lead"><p class="lead">' + t(h.subhead) + '</p></div><div class="hero-act"><div class="btn-row">' + btn(h.cta_primary, "primary", opts.hrefs && opts.hrefs[0]) + (h.cta_secondary ? btn(h.cta_secondary, "secondary", opts.hrefs && opts.hrefs[1]) : "") + "</div>" +
    (h.note ? '<p class="hero-note">' + t(h.note) + "</p>" : "") + "</div></div>" +
    (opts.visual === false ? "" : '<div class="hero-band">' + (opts.visual || visual(vMondayOverview())) + "</div>") + (opts.panel ? "</div>" : "") + "</div></section>";
}
function problem(p: { headline: string; body: string }) {
  return '<section class="sec sec-problem" id="problem"><div class="wrap"><div class="sec-head center" style="margin-bottom:0"><h2 class="display h2 sh-title">' + t(p.headline) + '</h2><p class="sh-text">' + t(p.body) + "</p></div></div></section>";
}
function centerHead(p: { headline: string; body: string }) {
  return '<div class="sec-head center"><h2 class="display h2 sh-title">' + t(p.headline) + '</h2><p class="sh-text">' + t(p.body) + "</p></div>";
}
function proofMonday(p: { headline: string; body: string; caption?: string }) {
  return '<section class="sec sec-proof sec-monday" id="proof"><div class="wrap">' + centerHead(p) +
    '<div class="monday-frame">' + visual(vMondayOverview(), p.caption) + "</div></div></section>";
}

/* ---------- Marketing v15: the phases section is a rail of six cards (engine: phInit in engines.ts) ---------- */
const PH_TONES = ["sky", "field", "dawn", "lilac", "sun", "sea"];
const OV_PH_TONES = ["lilac", "sea", "dawn", "field", "sky", "sun"];
function phNum(i: number) { return (i < 9 ? "0" : "") + (i + 1); }
function phTag(i: number, it: { label: string }) { return '<span class="feat-tag"><span class="ph-n">' + phNum(i) + '</span><span class="feat-label">' + t(it.label) + "</span></span>"; }
function pvHead(ic: IconName, tone: string, title: string, sub: string, right?: string) {
  return '<div class="pv-h"><span class="card-icon ' + tone + '">' + icon(ic) + '</span><div class="grow"><div class="pv-t">' + title + '</div><div class="pv-s">' + sub + "</div></div>" + (right || "") + "</div>";
}
function phVig(i: number) {
  let b = "";
  if (i === 0) {
    b = pvHead("book", "tone-blue", "Guidance", "Discovery") + '<div class="pv-b">' +
      [[80, 54, 1], [72, 46, 0]].map((r) =>
        '<div class="pv-read' + (r[2] ? " on" : "") + '"><span class="pv-ri">' + icon(r[2] ? "book" : "check") + '</span><span class="grow"><i style="width:' + r[0] + '%"></i><i style="width:' + r[1] + '%"></i></span>' + (r[2] ? '<span class="pv-now">Now</span>' : "") + "</div>",
      ).join("") + "</div>";
  } else if (i === 1) {
    b = pvHead("users", "tone-green", "Core group", "Signed commitments") +
      '<div class="pv-stat"><span class="num">34</span><span class="delta" data-dir="up">9 people</span></div>' +
      '<div class="pv-in"><span class="card-icon tone-green">' + icon("task") + '</span><div class="grow"><div class="pv-it">Vision meeting closed</div><div class="pv-s">9 follow-up tasks</div></div></div>';
  } else if (i === 2) {
    const seats = [["Worship", "MS", "tone-violet"], ["Kids", "", ""], ["Welcome", "JO", "tone-blue"], ["Prayer", "RA", "tone-amber"], ["Tech", "KL", "tone-teal"], ["Outreach", "TB", "tone-green"], ["Setup", "AP", "tone-magenta"], ["Admin", "LC", "tone-ink"]];
    b = pvHead("calendar", "tone-amber", "Ministry areas", "Launch Sunday, Mar 14", '<span class="pv-k">7 of 8</span>') + '<div class="pv-seats">' +
      seats.map((s) => '<div class="pv-seat' + (s[1] ? "" : " open") + '">' + (s[1] ? '<span class="avatar ' + s[2] + '">' + s[1] + "</span>" : '<span class="pv-empty">+</span>') + '<span class="pv-sn">' + s[0] + "</span></div>").join("") + "</div>";
  } else if (i === 3) {
    b = pvHead("users", "tone-violet", "Training", "Who has finished") + '<div class="pv-b">' +
      ([["Worship team", 8, 9, "var(--ef-green-600)", 1], ["Hospitality", 6, 6, "var(--ef-green-500)", 0], ["Kids ministry", 2, 6, "var(--ef-amber-500)", 1]] as const).map((r) =>
        '<div class="pv-mt"><div class="row between"><span class="pv-it">' + r[0] + '</span><span class="pv-k">' + r[1] + " of " + r[2] + '</span></div><div class="meter-hatch"><span class="' + (r[4] ? "hatch" : "") + '" style="width:calc(' + (r[1] / r[2] * 100).toFixed(1) + "% - 4px);" + (r[4] ? "--hatch:" + r[3] : "background:" + r[3]) + '"></span></div></div>',
      ).join("") + "</div>";
  } else if (i === 4) {
    b = pvHead("task", "tone-blue", "Launch milestones", "3 of 5 done") + '<div class="pv-b">' +
      ([["Venue booked", 1], ["Invite cards printed", 1], ["Email to your people", 1], ["Sound check", 0]] as const).map((r) =>
        '<div class="pv-ck' + (r[1] ? " done" : "") + '"><span class="pv-box">' + (r[1] ? icon("check") : "") + "</span>" + r[0] + "</div>",
      ).join("") + "</div>";
  } else {
    b = pvHead("calendar", "tone-green", "Launch Sunday", "Mar 14, 2027") + '<div class="pv-bars">' +
      [100, 70, 76, 79, 83, 88].map((h, k) => '<span class="' + (k ? "hatch" : "solid") + '" style="height:' + h + '%">' + (k ? "" : "<b>186</b>") + "</span>").join("") +
      '</div><div class="pv-axis"><span>Launch</span><span>Week 6</span></div>';
  }
  return '<div class="pv">' + b + "</div>";
}
type RailItem = { label: string; title: string; body?: string; short?: string };
function phSection(f: { headline: string; items: RailItem[] }, opts: { id?: string; vig?: (i: number) => string; tones?: string[] }) {
  return '<section class="sec sec-features ph-sec" id="' + (opts.id || "features") + '"><div class="phc-pin"><div class="phc-frame">' +
    '<div class="wrap"><div class="sec-head solo"><h2 class="display h2 sh-title" id="ph-title">' + t(f.headline) + "</h2></div></div>" +
    '<div class="phc-rail" role="region" aria-roledescription="carousel" aria-labelledby="ph-title"><ol class="phc-list">' + f.items.map((x, i) =>
      '<li class="phc-card" tabindex="0" aria-label="' + phNum(i) + " · " + t(x.label) + '"><div class="phc-art gsurf" data-tone="' + (opts.tones || PH_TONES)[i] + '"><span class="phc-num" aria-hidden="true">' + phNum(i) + '</span><div class="phc-vig ef" aria-hidden="true">' + (opts.vig || phVig)(i) + "</div></div>" +
      '<div class="phc-txt">' + phTag(i, x) + '<h3 class="display h3">' + t(x.title) + "</h3><p>" + t(x.short || x.body || "") + "</p></div></li>",
    ).join("") + "</ol></div></div></div></section>";
}
function cta(c: { headline: string; body: string; cta_primary: string; cta_secondary: string; note?: string }) {
  return '<section class="sec sec-cta" id="cta"><div class="wrap"><div class="cta-box"><h2 class="display h1">' + t(c.headline) + '</h2><p class="lead">' + t(c.body) + '</p><div class="btn-row">' + btn(c.cta_primary) + btn(c.cta_secondary, "secondary") + "</div>" +
    (c.note ? '<p class="small">' + t(c.note) + "</p>" : "") + "</div></div></section>";
}

/* ---------- /oversight ---------- */
function ovVig(i: number) {
  let b = "";
  if (i === 0) {
    b = pvHead("calendar", "tone-blue", "Phase journey", "Eastside Commons", '<span class="pv-k">3 · Training</span>') +
      '<div class="ovv-seg">' + [1, 1, 1, 2, 0, 0, 0].map((s) => '<span data-state="' + (s === 1 ? "done" : s === 2 ? "current" : "") + '"></span>').join("") + "</div>" +
      '<div class="ovv-wk">' + [["Discovery", "10 wk"], ["Core group", "34 wk"], ["Launch team", "18 wk"], ["Training", "6 wk so far"]].map((r) => "<span><b>" + r[1] + "</b>" + r[0] + "</span>").join("") + "</div>";
  } else if (i === 1) {
    b = pvHead("calendar", "tone-green", "Launch Sunday", "Sunday, May 2, 2027") +
      '<div class="pv-stat"><span class="num">205</span><span class="pv-s">days to go</span></div>' +
      '<div class="pv-mt"><div class="row between"><span class="pv-it">Milestones done</span><span class="pv-k">3 of 9</span></div><div class="meter-hatch"><span style="width:calc(33.3% - 4px);background:var(--ef-green-500)"></span></div></div>';
  } else if (i === 2) {
    b = pvHead("pin", "tone-teal", "By market", "Texas · 14 plants", '<span class="pv-k">Plants</span>') + '<div class="ovv-mk">' +
      ([["Greater Austin", 5], ["Dallas–Fort Worth", 3], ["Greater San Antonio", 3], ["Greater Houston", 2]] as const).map((r, k) =>
        '<div class="ovv-mr' + (k ? "" : " on") + '"><span>' + r[0] + '</span><span class="ovv-bar"><i style="width:' + (r[1] / 5 * 100) + '%"></i></span><b>' + r[1] + "</b></div>").join("") + "</div>";
  } else if (i === 3) {
    b = pvHead("users", "tone-blue", "People", "Committed adults") +
      '<div class="pv-stat"><span class="num">46</span><span class="delta" data-dir="up">5 in 28 days</span></div>' +
      '<div class="pv-in"><span class="card-icon tone-green">' + icon("calendar") + '</span><div class="grow"><div class="pv-it">13 days between vision meetings</div><div class="pv-s">On average</div></div></div>';
  } else if (i === 4) {
    b = pvHead("users", "tone-violet", "Ministry teams", "Leader roles filled", '<span class="pv-k">9 of 11</span>') + '<div class="pv-b">' +
      ["Kids", "Production"].map((r) => '<div class="ovv-sh"><span>' + r + '</span><span class="badge" data-size="sm" data-status="risk">Leader open</span></div>').join("") + "</div>";
  } else {
    b = pvHead("compass", "tone-amber", "Where help could matter", "Eastside Commons") +
      '<div class="pv-it ovv-help">Two leader roles are open, 205 days before launch</div>' +
      '<div class="ovv-acts"><span class="btn" data-variant="primary" data-size="sm">Offer help ' + icon("arrow") + '</span><span class="btn" data-variant="ghost" data-size="sm">Later</span></div>';
  }
  return '<div class="pv">' + b + "</div>";
}
function cxHead(lead: string, title: string, sub: string) { return '<div class="cx-h">' + lead + '<div class="grow"><div class="ha-title">' + title + '</div><div class="ha-sub">' + sub + "</div></div></div>"; }
function cxIcon(tone: string, name: IconName) { return '<span class="card-icon ' + tone + '">' + icon(name) + "</span>"; }
/* Revision 28: the sending paths. One display sentence over one large card; ovs* in engines.ts moves both. */
const OVS_TONES = ["sky", "lilac", "sun"];
function ovsBy(ic: IconName, names: string[]) { return '<span class="ovs-by">' + icon(ic) + "<span>Sent by " + names.map((n) => "<b>" + n + "</b>").join('<span class="ovs-dot"> · </span>') + "</span></span>"; }
const OVS_B = [
  () =>
    cxHead(cxIcon("tone-blue", "heart"), "Grace Church", "Your plants · in launch order") +
    [["Harvest Point Church", "Hyde Park, Austin", "1 · Core group", "Mar 14, 2027"], ["Eastside Commons", "East Austin · with Austin Sending Network", "3 · Training", "May 2, 2027"]].map((r) =>
      '<div class="list-row"><span class="card-icon tone-green">' + icon("pin") + '</span><div class="grow"><div class="list-title">' + r[0] + '</div><div class="list-sub">' + r[1] + '</div></div><div class="ov-when"><b>' + r[3] + "</b><span>" + r[2] + "</span></div></div>",
    ).join(""),
  () =>
    cxHead(cxIcon("tone-teal", "network"), "Austin Sending Network", "Plants by sending church") +
    ([["Grace Church", [["Harvest Point Church", 1], ["Eastside Commons", 3]]], ["Redeemer Dallas", [["Deep Ellum Collective", 4], ["Oak Cliff Church", 2]]]] as const).map((g) =>
      '<div class="ovs-g"><div class="row between"><span class="ovs-gt">' + g[0] + '</span><span class="ovs-gc">' + g[1].length + " plant" + (g[1].length > 1 ? "s" : "") + '</span></div><div class="ov-gp">' +
      g[1].map((p) => '<span class="ov-pc"><i data-ph="' + p[1] + '"></i>' + p[0] + "</span>").join("") + "</div></div>",
    ).join(""),
  () =>
    cxHead(cxIcon("tone-green", "pin"), "Mueller Hope Church", "Mueller, Austin · 0 · Discovery") +
    '<div class="ovs-kv"><span>Sent by</span>' + ovsBy("network", ["Austin Sending Network"]) + "</div>" +
    '<div class="ovs-kv"><span>Sending church</span><span class="badge" data-size="sm" data-status="unknown">No sending church yet</span></div>' +
    '<div class="ovs-act"><span class="btn" data-variant="primary" data-size="sm">' + icon("plus") + "Assign a sending church</span></div>",
];
function ovPaths(p: Copy["shared"]["oversight_page"]["paths"]) {
  const S = p.states;
  const mv = (i: number, c: string) => ' class="' + c + (i ? "" : " on") + '" data-i="' + i + '"';
  const sr = p.lead + " " + S.slice(0, -1).map((x) => x.phrase).join(", ") + " or " + S[S.length - 1]!.phrase + ". " + p.tail;
  return '<section class="sec sec-ov-paths" id="sending-paths"><div class="wrap"><div class="ovs-run">' +
    '<h2 class="display ovs-say"><span class="ovs-sr">' + t(sr) + '</span><span aria-hidden="true">' + t(p.lead) + ' <br class="ovs-mbr"><span class="ovs-roll"><span class="ovs-rl">' +
    S.map((x) => "<span>" + t(x.phrase) + "</span>").join("") + "</span></span>.<br>" + t(p.tail) + "</span></h2>" +
    '<div class="ovs-big"><div class="ovs-bt">' + S.map((x, i) => "<div" + mv(i, "ovs-pane ovs-mv") + '><h3 class="display h3">' + t(x.title) + "</h3><p>" + t(x.body) + "</p></div>").join("") +
    '</div><div class="ovs-bv ef" aria-hidden="true">' + OVS_TONES.map((tn, i) => '<span class="ovs-bg gsurf' + (i ? "" : " on") + '" data-tone="' + tn + '"></span>').join("") +
    OVS_B.map((f, i) => "<div" + mv(i, "ovs-app ovs-mv") + ">" + f() + "</div>").join("") + '</div><button type="button" class="ovs-pp" aria-label="Pause the sending paths">' + PAUSE_SVG + "</button></div></div>" +
    '<p class="ovp-line">' + t(p.line) + "</p></div></section>";
}
/* Revision 26: FAQ. Each question is a button that opens its answer; several can be open at once. */
function ovFaq(f: Copy["shared"]["oversight_page"]["faq"]) {
  return '<section class="sec sec-ov-faq" id="faq"><div class="wrap"><div class="faq-grid"><h2 class="display h2 faq-title">' + t(f.headline) + '</h2><div class="faq-list">' + f.items.map((x) => {
    const id = "faq-" + x.id;
    let a = t(x.a);
    if (x.link) a = a.replace(t(x.link), '<a href="' + ACCESS + '">' + t(x.link) + "</a>");
    return '<div class="faq-i" id="' + id + '"><h3 class="faq-h"><button type="button" class="faq-q" id="' + id + '-q" aria-expanded="false" aria-controls="' + id + '-a"><span>' + t(x.q) + '</span><span class="faq-pm" aria-hidden="true"></span></button></h3>' +
      '<div class="faq-a" id="' + id + '-a"><div class="faq-in"><p>' + a + "</p></div></div></div>";
  }).join("") + "</div></div></div></section>";
}

/* ---------- Pages: the sections that are still string markup (R3 rebuilds them) ---------- */
export function homeParts() {
  const s = COPY.journey;
  return { problem: problem(s.problem), proof: proofMonday(s.proof), phases: phSection(s.features, {}), cta: cta(s.cta) };
}
export function oversightParts() {
  const P = COPY.shared.oversight_page;
  return {
    hero: hero(P.hero, { visual: '<div class="ov-dash">' + visual(vNetworkDash()) + "</div>", cls: "hero-anim ov-hero", panel: true, hrefs: [ACCESS, "#every-plant"] }),
    problem: problem(P.problem), plants: phSection(P.plants, { id: "plants", vig: ovVig, tones: OV_PH_TONES }), paths: ovPaths(P.paths), faq: ovFaq(P.faq), cta: cta(P.cta),
  };
}
