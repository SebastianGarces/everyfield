import "server-only";
import { COPY, type Copy } from "./copy";
// Sample data shared with the engine in engines.ts.
import { CX_A, CX_COUNT, CX_DRAFT, CX_PEOPLE, CX_Q, CX_SIGNS, CX_TEAMS, CX_TYPES, HA_NAME, OV_GROUPS, OV_MAIL, OV_ROWS, SD_AREAS, SD_PIPE, SD_SCOPES, type PanelKind } from "./scene-data";

// Server-side port of the prototype's markup builders (design/everyfield-marketing.html, the <script> block).
// The HTML strings stay as close to the prototype as possible: the CSS and the motion engines in engines.ts select on
// this exact structure. Changes from the prototype: real routes instead of hash routes, links to pages that are not
// live are hidden or go to the access form, and copy comes from design/marketing-copy.json through copy.ts.
// Product visuals use a demo church (Harvest Point); that sample data is part of the approved design.

/* ---------- Routes ---------- */
// Every link to the request page goes to the top of /access, where the visitor picks a form. No form anchors.
export const ACCESS = "/access";
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

/* ---------- Revision 2 hero animation markup (the engine is haRender in engines.ts) ---------- */
function haChip(live?: boolean) { return '<span class="ha-chip' + (live ? " ha-live" : "") + '">' + (live ? '<span class="ha-ring"></span>' : "") + '<span class="ha-av">ML</span>' + HA_NAME + "</span>"; }
function haSlot() { return '<span class="ha-slot">' + haChip() + "</span>"; }
function haSk(w: string, cls?: string) { return '<span class="sk' + (cls ? " " + cls : "") + '"' + (w ? ' style="width:' + w + '"' : "") + "></span>"; }
function haRoll(a: number, b: number, key: string) { return '<span class="ha-roll" data-roll="' + key + '"><span><i>' + a + "</i><i>" + b + "</i></span></span>"; }
function haHead(lead: string, title: string, sub: string) { return '<div class="ha-h" data-st>' + lead + '<div class="grow"><div class="ha-title">' + title + '</div><div class="ha-sub">' + sub + "</div></div></div>"; }
function haCard(i: number, inner: string) { return '<div class="ha-card" data-scene="' + i + '">' + inner + "</div>"; }
function haSkRow(w: string) { return '<div class="ha-li">' + haSk("", "sk-av") + haSk(w) + "</div>"; }
export const PAUSE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>';
export const PLAY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
function heroSlot() {
  const c0 = haHead('<span class="card-icon tone-green">' + icon("users") + "</span>", "Add person", "People") +
    '<div class="ha-field" data-st><div><span class="ha-lab">Name</span><div class="ha-input"><span class="ha-type"></span><span class="ha-caret"></span></div></div><span class="ha-btn ha-add"><span>Add</span></span></div>' +
    '<div class="ha-list" data-st><span class="ha-lab">Recently added</span><div class="ha-li">' + haSlot() + "</div>" + haSkRow("46%") + "</div>";
  const c1 = haHead('<span class="card-icon tone-blue">' + icon("calendar") + "</span>", "Vision meeting #12", "Sun, Oct 12 · 6:00 PM") +
    '<div class="ha-kv" data-st><span>Type</span><span class="v">Vision meeting</span></div>' +
    '<div class="ha-kv" data-st><span>Host home</span><span class="v">' + icon("pin") + "Hyde Park</span></div>" +
    '<div class="ha-kv" data-st><span>Guests</span><span class="v">' + haRoll(8, 9, "guests") + "</span></div>" +
    '<div class="ha-guests" data-st>' + haSk("", "sk-pill") + haSk("", "sk-pill") + haSlot() + "</div>";
  const c2 = haHead(evryBot("lg", "talking"), "Evry drafted a follow-up", "Due today. You approve it.") +
    '<div class="ha-to" data-st><span>To</span>' + haSlot() + "</div>" +
    '<div class="ha-draft" data-st><span class="ha-dtxt"></span><span class="ha-caret"></span></div>' +
    '<div class="ha-acts" data-st>' + haSk("28%") + '<span class="ha-btn ha-send"><span class="ha-ok"></span><span class="ha-shine"></span><span class="ha-l1">Approve and send</span><span class="ha-l2">' + icon("check") + "Sent</span></span></div>";
  const c3 = '<div class="ha-who" data-st>' + haSlot() + '<span class="ha-flip"><span class="stage-chip tone-amber">Following up</span><span class="stage-chip tone-green">Committed</span></span></div>' +
    [["Vision meeting #12", "Attended"], ["Follow-up from Evry", "Sent"], ["Commitment card", "Signed"]].map((r) =>
      '<div class="ha-li" data-st><span class="ha-check">' + icon("check") + '</span><span class="grow">' + r[0] + '</span><span class="faint">' + r[1] + "</span></div>",
    ).join("") + "<div data-st>" + haSkRow("52%") + "</div>";
  const rows = [["tone-blue", "Attendee", "41", "var(--ef-blue-500)"], ["tone-amber", "Following up", haRoll(23, 22, "follow"), "var(--ef-amber-500)"], ["tone-green", "Core group", haRoll(34, 35, "core"), "var(--ef-green-500)"]] as const;
  const c4 = haHead('<span class="card-icon tone-ink">' + icon("users") + "</span>", "Where people are", "Harvest Point · this week") +
    '<div class="ha-rows">' + rows.map((r, k) =>
      '<div class="ha-row" data-st>' + (k === 2 ? '<span class="ha-hl"></span>' : "") + '<div class="row"><span class="stage-chip ' + r[0] + '">' + r[1] + "</span>" + (k === 2 ? haSlot() : "") +
      '<span class="num">' + r[2] + '</span></div><div class="ha-meter"><span style="background:' + r[3] + '"></span></div></div>',
    ).join("") + "</div>";
  return '<div class="ha">' +
    '<div class="ha-stage ef" role="img" aria-label="Example: Maria Lopez is added, comes to a vision meeting, gets a follow-up that Evry drafted and you approved, commits, and joins the core group.">' +
    '<div aria-hidden="true" style="display:contents"><div class="ha-shadow"></div><div class="ha-shell"></div>' +
    haCard(0, c0) + haCard(1, c1) + haCard(2, c2) + haCard(3, c3) + haCard(4, c4) + haChip(true) + "</div></div>" +
    '<button type="button" class="ha-pause" aria-label="Pause animation">' + PAUSE_SVG + "</button></div>";
}

/* ---------- Chapters: sticky panel and steps (engine: cx* in engines.ts) ---------- */
function cxCur() { return '<span class="cx-cur" aria-hidden="true"><i class="cx-ripple"></i><svg viewBox="0 0 24 24"><path d="M5.5 3.5v15.2c0 .6.7.9 1.1.5l3.6-3.5 2.5 5.6c.2.4.7.6 1.1.4l1.9-.9c.4-.2.6-.7.4-1.1l-2.5-5.5 5-.3c.6 0 .8-.7.4-1.1L6.6 2.9c-.4-.4-1.1-.1-1.1.6z"/></svg></span>'; }
function cxHead(lead: string, title: string, sub: string, right?: string) { return '<div class="cx-h" data-st>' + lead + '<div class="grow"><div class="ha-title">' + title + '</div><div class="ha-sub">' + sub + "</div></div>" + (right || "") + "</div>"; }
function cxIcon(tone: string, name: IconName) { return '<span class="card-icon ' + tone + '">' + icon(name) + "</span>"; }
/* An animated number. It reserves the width of its widest value (--nd digits; tabular figures in site.css), so a count
   never changes a line break or moves the content below it. */
function cxNum(name: string, max: number, cls = "", text = "0", tag = "span") {
  return "<" + tag + (cls ? ' class="' + cls + '"' : "") + ' data-n="' + name + '" style="--nd:' + String(Math.round(max)).length + '">' + text + "</" + tag + ">";
}
const CX_PEOPLE_MAX = CX_PEOPLE.reduce((a, r) => a + Math.max(r[2], r[3]), 0) + 20;
function cxBtn(cls: string, a: string, b: string) { return '<span class="ha-btn cx-sm ' + cls + '"><span class="ha-ok"></span><span class="ha-shine"></span><span class="ha-l1">' + a + '</span><span class="ha-l2">' + icon("check") + b + "</span></span>"; }
function cxSwap(a: string, b: string, cls?: string) { return '<span class="cx-swap' + (cls ? " " + cls : "") + '"><span>' + a + "</span><span>" + b + "</span></span>"; }
function cxTw(cls: string, text: string) { return '<span class="cx-tw"><span class="cx-ghost">' + text + '</span><span class="cx-typed ' + cls + '"></span></span>'; }

const CX_GUESTS = [["KW", "Kim Wu", "TO", "Tom"], ["JO", "James Okafor", "TO", "Tom"], ["SN", "Sara Nunez", "AN", "Ana"]] as const;
const SD_LENSES = [["Emerging leadership", "compass", "tone-magenta", "risk", "Concern", [5, 2, 4]], ["Vision casting", "sparkle", "tone-green", "positive", "Strong", [8, 3, 0]], ["Core group cohesion", "users", "tone-amber", "attention", "Watch", [5, 3, 3]]] as const;
const SD_LENS_PLANTS = [["Eastside Commons", "Training · Greater Austin", "2 leader roles open"], ["Deep Ellum Collective", "Pre-launch · Dallas–Fort Worth", "3 leader roles open"], ["Lakewood Church Dallas", "Pre-launch · Dallas–Fort Worth", "Worship leader open"]] as const;
const SD_DOTS = ["var(--ef-green-500)", "var(--ef-amber-500)", "var(--ef-magenta-500)"] as const;
const OV_AREAS = [["All", 14], ["Austin", 5], ["San Antonio", 3]] as const;

/* Panel markup. Elements with data-st stagger in with the card. Targets for the cursor carry cx-t0 / cx-t1. */
const CX_MARK: Record<PanelKind, () => string> = {
  people: () =>
    cxHead(cxIcon("tone-ink", "users"), "Where people are", "Harvest Point · <span class=\"cx-keep\">" + cxNum("total", CX_PEOPLE_MAX) + " people</span>", cxBtn("cx-t0", "Import list", "Added")) +
    '<div class="cx-slot" data-st><span class="cx-pill">' + icon("check") + "24 people added from the sign-up form</span></div>" +
    '<div class="cx-rows">' + CX_PEOPLE.map((r) =>
      '<div data-st><div class="row"><span class="stage-chip ' + r[0] + '">' + r[1] + '</span>' + cxNum("r", Math.max(r[2], r[3]), "num") + '</div><div class="ha-meter"><span style="background:' + r[4] + '"></span></div></div>',
    ).join("") + "</div>" +
    '<div data-st><div class="card-inset cx-ins">14 interviewed people have not committed yet.</div></div>',
  meet: () => {
    const guests = [["KW", "Kim Wu"], ["JO", "James Okafor"]];
    return cxHead(cxIcon("tone-blue", "calendar"), "New gathering", "Harvest Point", cxBtn("cx-t1", "Create", "Created")) +
      '<div data-st><span class="ha-lab">Type</span><div class="cx-in cx-t0"><span class="cx-fr"></span><span class="ha-roll cx-roll"><span>' + CX_TYPES.map((x) => "<i>" + x + "</i>").join("") + "</span></span>" + icon("arrow", "cx-chev") + "</div></div>" +
      '<div class="cx-2" data-st><div><span class="ha-lab">When</span><div class="cx-in"><span class="cx-fr"></span>' + cxTw("cx-when", "Sun Oct 12, 5 pm") + '</div></div><div><span class="ha-lab">Where</span><div class="cx-in"><span class="cx-fr"></span>' + cxTw("cx-where", "Reyes home") + "</div></div></div>" +
      '<div class="cx-att" data-st><div class="row"><span class="row"><span class="ha-lab">Checked in</span><span class="badge" data-size="sm" data-status="measured">3 new guests</span></span>' + cxNum("att", CX_COUNT.att, "cx-cnt") + '</div>' +
      '<div class="cx-names cx-guests">' + guests.map((n) => '<span class="ha-chip"><span class="ha-av">' + n[0] + "</span>" + n[1] + "</span>").join("") + '<span class="ha-chip" style="padding-left:10px">10 more</span></div></div>';
  },
  follow: () => {
    const row = (n: readonly [string, string, string, string]) =>
      '<div class="ha-li cx-fu"><span class="cx-lead"><span class="ha-av">' + n[0] + '</span><span class="ha-check">' + icon("check") + '</span></span><span class="grow">' +
      cxSwap('<span class="cx-l1">' + n[1] + '</span><span class="cx-l2">New guest</span>', '<span class="cx-l1">Follow up with ' + n[1] + '</span><span class="cx-l2">Due Oct 10</span>') + "</span>" +
      '<span class="ha-chip cx-who"><span class="ha-av">' + n[2] + "</span>" + n[3] + "</span></div>";
    return '<div class="cx-h" data-st>' + evryBot("lg", "idle") + '<div class="grow"><div class="ha-title">Evry</div><div class="ha-sub">3 new guests from Sunday\'s vision meeting</div></div></div>' +
      "<div data-st>" + row(CX_GUESTS[0]) + "</div>" +
      '<div class="cx-draft"><span class="ha-lab">' + icon("sparkle") + "Drafted for Tom</span>" + cxTw("cx-dt", CX_DRAFT) + "</div>" +
      '<div class="cx-dn"><div data-st>' + row(CX_GUESTS[1]) + "</div><div data-st>" + row(CX_GUESTS[2]) + "</div>" +
      '<div class="ha-acts" data-st>' + cxSwap('<span class="faint">Nothing is saved until you approve.</span>', '<span class="faint">Assigned to Tom and Ana</span>', "cx-fs") + cxBtn("cx-t0", "Approve", "Approved") + "</div></div>";
  },
  teams: () =>
    cxHead(cxIcon("tone-violet", "users"), "Your teams", "Harvest Point · committed adults") +
    CX_TEAMS.map((r, k) => '<div class="cx-team" data-st data-p="dst' + k + '"><div class="row"><span class="stage-chip ' + r[0] + '">' + r[1] + '</span>' + cxNum("team", r[3] + 1, "num") + '</div><div class="ha-meter"><span style="background:' + r[2] + '"></span></div></div>').join("") +
    '<div class="cx-sublab" data-st>To record</div>' +
    CX_SIGNS.map((r, k) => '<div class="list-row" data-st><span class="ha-av" data-p="src' + k + '">' + r[0] + '</span><div class="grow"><div class="list-title">' + r[1] + '</div><div class="list-sub">' + r[2] + "</div></div>" + cxBtn("cx-t" + k, "Record", "Recorded") + "</div>").join("") +
    CX_SIGNS.map((r, k) => '<span class="ha-chip cx-fly" data-p="fly' + k + '"><span class="ha-av">' + r[0] + "</span>" + r[1] + "</span>").join(""),
  focus: () => {
    const facts = [["Last vision meeting", "#11, 16 days ago"], ["New guests at #11", "9"], ["Next", "#12, Sun Oct 12"]];
    return '<div class="insight-top" data-st><span class="insight-pill">' + icon("compass") + 'Focus this week</span><span class="insight-count">Plant Intelligence</span></div>' +
      '<div class="insight-metric" data-st><span class="num">' + cxNum("days", CX_COUNT.focusDays) + ' d</span><span class="unit">since the last vision meeting</span></div>' +
      '<div data-st><div class="cx-rt"><span class="cx-rf"></span><span class="cx-rm"></span></div><div class="cx-rl"><span>Next: #12, Sun Oct 12</span></div></div>' +
      '<div class="insight-title" data-st>Hold your next vision meeting this week</div>' +
      '<div class="cx-flip2" data-st><div class="insight-text" style="margin-top:0">Vision meeting #12 is set for Sun Oct 12. Invite the 9 guests from #11.</div><div class="cx-facts">' +
      facts.map((f) => '<div class="cx-fact"><span>' + f[0] + "</span><b>" + f[1] + "</b></div>").join("") + "</div></div>" +
      '<div class="insight-footer" data-st><span class="btn cx-t0" data-variant="light">See the facts ' + icon("arrow") + '</span><span class="btn" data-variant="glass">Why this?</span></div>';
  },
  facts: () => {
    const kv = [["New guests, last 2 vision meetings", "24", ""], ["Contacted within 48 hours", "17", ""], ["No contact yet", "7", '<span class="badge" data-size="sm" data-status="risk">Open</span>']];
    const names = [["JO", "James Okafor"], ["KW", "Kim Wu"], ["SN", "Sara Nunez"]];
    return cxHead(cxIcon("tone-amber", "alert"), "Follow-up is slipping", "The facts this finding used") +
      '<div class="cx-ringrow" data-st><svg class="cx-ring" viewBox="0 0 64 64" aria-hidden="true"><circle class="bg" cx="32" cy="32" r="27"/><circle class="fg" cx="32" cy="32" r="27"/></svg><div><div class="num cx-pct">' + cxNum("pct", CX_COUNT.pct) + '%</div><div class="faint t-sm">of new guests contacted within 48 hours</div></div></div>' +
      kv.map((r, i) => '<div class="kv' + (i === 2 ? " cx-t0" : "") + '" data-st style="position:relative;isolation:isolate">' + (i === 2 ? '<span class="cx-hl"></span>' : "") + '<span class="k">' + r[0] + '</span><span class="row">' + r[2] + cxNum("kv", Number(r[1]), "v", r[1]) + "</span></div>").join("") +
      '<div class="cx-names" data-st>' + names.map((n) => '<span class="ha-chip"><span class="ha-av">' + n[0] + "</span>" + n[1] + "</span>").join("") + '<span class="ha-chip" style="padding-left:10px">4 more</span></div>';
  },
  evry: () =>
    '<div class="ep-head" data-st>' + evryBot("lg", "idle", true) + '<div class="grow"><div class="ep-name">Evry</div><div class="t-xs faint">Reads and drafts. You approve every change.</div></div></div>' +
    '<div class="bubble me" data-st>' + cxTw("cx-q", CX_Q) + "</div>" +
    '<div class="bubble ai cx-a">' + cxTw("cx-ans", CX_A) + "</div>" +
    '<div class="review-card cx-rvw"><div class="rc-head">' + icon("edit") + 'Review 7 changes<span class="grow"></span><span style="font-weight:500">Assign follow-up tasks</span></div>' +
    '<div class="rc-body"><div class="rc-line">' + icon("task") + '<span>Assign <b>Follow up with James Okafor</b> to <b>Tom</b>, due <b>Oct 10</b></span></div><div class="rc-line faint">' + icon("more") + "<span>6 more follow-ups in this change</span></div></div>" +
    '<div class="rc-foot">' + cxBtn("cx-t0", "Approve", "Approved") + '<span class="btn" data-variant="ghost">Edit</span></div></div>',
  scope: () =>
    cxHead(cxIcon("tone-teal", "network"), "Austin Sending Network", "Network Intelligence") +
    '<div class="sd-scope" data-st>' + SD_SCOPES.map((c, i) => { const l = c[0] + " <b>" + c[1] + "</b>"; return '<span class="sd-chip' + (i ? " cx-t" + (i - 1) : "") + '"><span>' + l + '</span><span class="sd-on">' + l + "</span></span>"; }).join("") + "</div>" +
    '<div class="sd-stats" data-st>' + ["Plants", "With findings", "Launching in 12 months"].map((l, i) => '<div class="sd-stat">' + cxNum("sd", Math.max(...SD_SCOPES.map((s) => Number(s[i + 1]))), "num") + "<small>" + l + "</small></div>").join("") + "</div>" +
    '<div class="sd-areas" data-st><div class="sd-th"><span>By area</span><span>Plants</span><span>Momentum</span></div>' +
    SD_AREAS.map((a, i) => '<div class="sd-area"><b>' + a[0] + "</b><span>" + a[1] + '</span><span><span class="badge" data-size="sm" data-status="' + a[2] + '">' + a[3] + "</span></span>" + (i ? "" : '<span class="cx-hl"></span>') + "</div>").join("") + "</div>",
  pipe: () =>
    cxHead(cxIcon("tone-violet", "calendar"), "Phase pipeline", "Plants in each phase, and typical weeks in it") +
    "<div data-st>" + SD_PIPE.map((r, i) => '<div class="sd-pl' + (i === 1 ? " cx-t0" : "") + '">' + (i === 1 ? '<span class="cx-hl"></span>' : "") + "<b>" + r[0] + '</b><span class="sd-track"><i></i></span>' + cxNum("pl", r[1], "num") + '<span class="wk">' + (r[1] ? r[2] : "none") + "</span></div>").join("") + "</div>" +
    '<div class="sd-sum" data-st><span>Launches in the next 12 months</span>' + cxNum("sum", CX_COUNT.sum, "num") + '</div>',
  lens: () =>
    cxHead(cxIcon("tone-amber", "eye"), "Network lenses", "Across 11 plants with findings") +
    '<div class="sd-lenses">' + SD_LENSES.map((l, i) => {
      const n = l[5];
      return '<div class="lens sd-lens" data-st><div class="lens-head"><span class="sd-li ' + l[2] + '">' + icon(l[1]) + '</span><span class="lens-name">' + l[0] + '</span><span class="badge" data-size="sm" data-status="' + l[3] + '">' + l[4] + "</span>" + (i ? "" : '<span class="sd-open cx-t0">' + icon("arrow") + "</span>") + "</div>" +
        '<div class="sd-dist">' + n.map((v, k) => (v ? '<span style="flex:' + v + ";background:" + SD_DOTS[k] + '"></span>' : "")).join("") + "</div>" +
        '<div class="sd-leg">' + (["Strong", "Watch", "Concern"] as const).map((w, k) => '<span style="--dot:' + SD_DOTS[k] + '">' + n[k] + " " + w + "</span>").join("") + "</div></div>";
    }).join("") + "</div>" +
    '<div class="sd-sheet"><div class="sd-sh"><span>Emerging leadership</span><span class="badge" data-size="sm" data-status="risk">4 at Concern</span></div>' +
    SD_LENS_PLANTS.map((r) => '<div class="sd-pr"><div class="grow"><div class="list-title">' + r[0] + '</div><div class="list-sub">' + r[1] + '</div></div><span class="t-xs faint">' + r[2] + "</span></div>").join("") + "</div>",
  top: () =>
    '<div class="insight-top" data-st><span class="insight-pill">' + icon("sparkle") + 'Top network finding</span><span class="insight-count">From 11 of 14 plants</span></div>' +
    '<div class="insight-metric" data-st><span class="num">' + cxNum("top", CX_COUNT.top) + ' of 6</span><span class="unit">plants within a year of launch have a Concern on Emerging leadership</span></div>' +
    '<div class="insight-title" data-st>Emerging leadership is the most common gap before launch</div>' +
    '<div class="insight-text" data-st>It is the lens most often at Watch or Concern for plants in Training and Pre-launch.</div>' +
    '<div class="insight-footer" data-st><span class="btn cx-t0" data-variant="light">See the plants ' + icon("arrow") + "</span></div>",
  share: () => {
    const rows = [["Phase and launch date", 1, 0], ["Plant Intelligence findings", 0, 0], ["People and contact details", 0, 1], ["Private weekly check-in", 0, 1]] as const;
    return cxHead(cxIcon("tone-violet", "eye"), "Sharing with Grace Church", "You choose what leaves your plant") +
      rows.map((r, i) => '<div class="share-row" data-st>' + (i === 1 ? '<span class="cx-hl"></span>' : "") + "<span>" + r[0] + (r[2] ? ' <span class="faint t-xs">Never shared</span>' : "") + '</span><span class="cx-sw' + (i === 1 ? " cx-t0" : "") + '"' + (r[1] ? " data-on" : "") + (r[2] ? " data-lock" : "") + "><b></b><i></i></span></div>").join("") +
      '<div class="cx-prev" data-st><div class="t-xs faint">What Grace Church sees</div><div class="row between"><span>Harvest Point · Phase 1</span>' +
      cxSwap('<span class="badge" data-size="sm" data-status="unknown">Findings not shared</span>', '<span class="badge" data-size="sm" data-status="positive">On track</span>') + "</div></div>";
  },
  invite: () => {
    const plant = (cls: string, ic: IconName, tone: string, name: string, sub: string, badge: string) => '<div class="list-row ' + cls + '"' + (cls ? "" : " data-st") + '><span class="card-icon ' + tone + '">' + icon(ic) + '</span><div class="grow"><div class="list-title">' + name + '</div><div class="list-sub">' + sub + "</div></div>" + badge + "</div>";
    return cxHead(cxIcon("tone-teal", "network"), "Invite a plant", "Austin Sending Network") +
      '<div data-st><span class="ha-lab">Planter\'s email</span><div class="cx-in cx-t0"><span class="cx-fr"></span>' + cxTw("ov-mail", OV_MAIL) + "</div></div>" +
      '<div class="ha-acts ov-acts" data-st>' + cxSwap('<span class="faint">The planter connects in a few clicks.</span>', '<span class="faint">Invite sent to Priya Shah</span>', "ov-fs") + cxBtn("cx-t1", "Send invite", "Invite sent") + "</div>" +
      '<div class="cx-sublab" data-st>Your plants</div>' +
      '<div class="ov-plist">' + plant("", "pin", "tone-green", "Harvest Point Church", "Hyde Park, Austin", '<span class="badge" data-size="sm" data-status="positive">Connected</span>') +
      plant("ov-new", "pin", "tone-blue", "Eastside Commons", "Priya Shah · East Austin", cxSwap('<span class="badge" data-size="sm" data-status="unknown">Invited</span>', '<span class="badge" data-size="sm" data-status="positive">Connected</span>', "ov-st")) + "</div>";
  },
  plants: () =>
    cxHead(cxIcon("tone-teal", "network"), "Plants", "Austin Sending Network · in launch order") +
    '<div class="sd-scope" data-st>' + OV_AREAS.map((c, i) => { const l = c[0] + " <b>" + c[1] + "</b>"; return '<span class="sd-chip' + (i === 1 ? " cx-t0" : "") + '"><span>' + l + '</span><span class="sd-on">' + l + "</span></span>"; }).join("") + "</div>" +
    '<div class="ov-rows">' + OV_ROWS.map((r) =>
      '<div class="ov-row"><span class="card-icon ' + r[2] + '">' + icon("pin") + '</span><div class="grow"><div class="list-title">' + r[0] + '</div><div class="list-sub">' + r[3] + (r[4] ? " · " + r[4] + " adults" : "") + '</div></div><div class="ov-when"><b>' + r[5] + "</b><span>" + r[6] + "</span></div></div>",
    ).join("") + "</div>",
  senders: () =>
    cxHead(cxIcon("tone-teal", "network"), "Sending churches", "Austin Sending Network · 3 churches, 5 plants") +
    '<div class="ov-grps">' + OV_GROUPS.map((g, k) =>
      '<div class="ov-grp' + (k === 0 ? " cx-t0" : "") + '"><span class="cx-hl"></span><div class="ov-gh"><span class="card-icon ' + g[1] + '">' + icon("heart") + '</span><div class="grow"><div class="list-title">' + g[0] + '</div><div class="list-sub">' + g[2] + '</div></div><span class="ov-gn">' + cxNum("g", g[3].length, "", "0", "b") + ' plant' + (g[3].length > 1 ? "s" : "") + "</span></div>" +
      '<div class="ov-gp">' + g[3].map((p) => '<span class="ov-pc"><i data-ph="' + p[1] + '"></i>' + p[0] + "</span>").join("") + "</div>" +
      '<div class="ov-gs"><span>' + g[4] + '</span><span class="badge" data-size="sm" data-status="' + g[5][0] + '">' + g[5][1] + "</span></div></div>",
    ).join("") + "</div>",
  help: () =>
    '<div class="insight-top" data-st><span class="insight-pill">' + icon("compass") + 'Where help could matter</span><span class="insight-count">Eastside Commons</span></div>' +
    '<div class="insight-metric" data-st><span class="num">' + cxNum("days", CX_COUNT.helpDays) + '</span><span class="unit">days to launch Sunday</span></div>' +
    '<div class="insight-title" data-st>Two leader roles are open, 205 days before launch</div>' +
    '<div class="insight-text" data-st>Kids and Production have no leader yet. From Ministry teams and findings.</div>' +
    '<div class="insight-footer" data-st><span class="btn cx-t0" data-variant="light">' + cxSwap('<span class="ov-bl">Offer help ' + icon("arrow") + "</span>", '<span class="ov-bl">' + icon("check") + "Help offered</span>", "ov-off") + '</span><span class="btn" data-variant="glass">Later</span></div>',
};
const isPanel = (k: string): k is PanelKind => Object.hasOwn(CX_MARK, k);

/* Revision 13: week panel and icon colours in step order are blue, orange, green, lilac. */
const WK_TONES = ["sky", "dawn", "field", "lilac"];
/* Revision 13: the title phrase for each step; the active step's phrase is highlighted (.cx-ttl). */
const WK_WORDS = ["Reach", "gather", "follow up", "commit"];
function cxTitle(title: string, words: string[]) {
  let out = "", at = 0, ok = true;
  words.forEach((w, i) => {
    const j = title.indexOf(w, at);
    if (j < 0) { ok = false; return; }
    out += t(title.slice(at, j)) + '<span class="cx-w' + (i ? "" : " on") + '" data-w="' + i + '">' + t(w) + "</span>";
    at = j + w.length;
  });
  return ok ? out + t(title.slice(at)) : t(title);
}

type Step = { panel: PanelKind; tone: string; icon: string; title: string; body: string };
type ChapterDef = { title: string; steps: Step[]; final?: boolean; words?: string[]; auto?: boolean; mirror?: boolean; link?: string };
const panel = (k: string): PanelKind => {
  if (!isPanel(k)) throw new Error(`unknown chapter panel "${k}" in marketing-copy.json`);
  return k;
};
const NETWORK_PANELS = ["scope", "pipe", "lens", "top"] as const;
const NETWORK_TONES = ["sea", "rose", "sun", "slate"];
function chapterDefs(): Record<string, ChapterDef> {
  const S = COPY.shared;
  return {
    week: { title: S.week.title, final: true, words: WK_WORDS, steps: S.week.steps.map((s, i) => ({ panel: panel(s.panel), tone: WK_TONES[i] || s.tone, icon: s.icon, title: s.title, body: s.body })) },
    intelligence: { title: S.intelligence.title, auto: true, steps: [
      { panel: "focus", tone: "lilac", icon: "Focus", title: "One focus each week.", body: "Plant Intelligence reads your records and names the one thing that needs you most this week." },
      { panel: "facts", tone: "field", icon: "Facts", title: "Every finding shows its facts.", body: "Each finding links to the records it used, so you can check it." },
      { panel: "evry", tone: "sky", icon: "Evry", title: "Ask Evry why.", body: "Evry explains a finding against the rubric and prepares the work it points to. You approve each change." },
      { panel: "share", tone: "dawn", icon: "Sharing", title: "You see it first.", body: "Each concern comes to you before anyone else. Your sending church sees a short summary, and only what you share." },
    ] },
    sending: { title: S.sending.title, auto: true, mirror: true, link: S.sending.link, steps: NETWORK_PANELS.map((k, i) => ({ panel: k, tone: NETWORK_TONES[i] as string, icon: "", title: S.sending.steps[i]!.title, body: S.sending.steps[i]!.body })) },
    "every-plant": { title: S.oversight_page.chapter.title, auto: true, steps: S.oversight_page.chapter.steps.map((s, i) => ({ panel: panel(s.panel), tone: ["lilac", "dawn", "sky", "sun"][i] as string, icon: "", title: s.title, body: s.body })) },
    "network-intelligence": { title: S.oversight_page.intelligence.title, auto: true, mirror: true, steps: NETWORK_PANELS.map((k, i) => ({ panel: k, tone: NETWORK_TONES[i] as string, icon: "", title: S.oversight_page.intelligence.steps[i]!.title, body: S.oversight_page.intelligence.steps[i]!.body })) },
  };
}
function cxCard(kind: PanelKind) {
  const cls = kind === "focus" ? ' insight" data-tone="dawn' : kind === "top" ? ' insight" data-tone="lilac' : kind === "help" ? ' insight" data-tone="sky' : kind === "evry" ? " evry-panel" : kind === "follow" ? " cx-clip" : "";
  return '<div class="cx-card' + cls + '" data-k="' + kind + '">' + (kind === "follow" ? '<span class="cx-shade"></span><span class="cx-shell"></span>' : "") + CX_MARK[kind]() + cxCur() + "</div>";
}
function chapterSection(id: string, cls: string) {
  const d = chapterDefs()[id];
  if (!d) throw new Error(`unknown chapter ${id}`);
  if (d.auto) return autoSection(id, cls, d);
  return '<section class="sec cx ' + cls + '" id="' + id + '" data-cx="' + id + '"><div class="wrap"><div class="cx-grid"><div class="cx-left">' +
    '<div class="cx-head"><h2 class="display h2' + (d.words ? ' cx-ttl">' + cxTitle(d.title, d.words) : '">' + t(d.title)) + "</h2></div>" +
    '<ol class="cx-steps">' + d.steps.map((s, i) =>
      '<li class="cx-step' + (i === 0 ? " on" : "") + '" data-i="' + i + '"><div class="cx-mob ef" aria-hidden="true"><span class="cx-bg gsurf" data-tone="' + s.tone + '"></span>' + cxCard(s.panel) + "</div>" +
      '<div class="cx-txt">' + (d.final ? '<div class="cx-tl"><span class="cx-ti" data-tone="' + s.tone + '" aria-hidden="true">' + icon(s.icon) + '</span><h3 class="display h3">' + t(s.title) + "</h3></div>" :
        '<span class="cx-num"><b>' + (i + 1) + "</b>" + t(s.icon) + '</span><h3 class="display h3">' + t(s.title) + "</h3>") + "<p>" + t(s.body) + "</p></div></li>",
    ).join("") + "</ol></div>" +
    '<div class="cx-right"><div class="cx-vis ef" aria-hidden="true">' + d.steps.map((s) => '<span class="cx-bg gsurf" data-tone="' + s.tone + '"></span>').join("") +
    d.steps.map((s) => cxCard(s.panel)).join("") + "</div></div></div></div></section>";
}
/* Revision 10: the auto-advancing list. Steps are tabs, the panel is the tab panel. d.mirror puts the heading in the list column. */
function autoSection(id: string, cls: string, d: ChapterDef) {
  const head = '<div class="cx-head' + (d.link ? " cx-head-link" : "") + '"><h2 class="display h2" id="' + id + '-title">' + t(d.title) + "</h2>" +
    (d.link ? '<a class="sec-icon-link" href="/oversight" aria-label="' + t(d.link) + '">' + icon("arrowUpRight") + "</a>" : "") + "</div>";
  return '<section class="sec cx cx-auto' + (d.mirror ? " cx-mirror" : "") + " " + cls + '" id="' + id + '" data-cx="' + id + '"><div class="wrap">' + (d.mirror ? "" : head) +
    '<div class="cx-grid"><div class="cx-left">' + (d.mirror ? head : "") + '<ol class="cx-steps" role="tablist" aria-orientation="vertical" aria-labelledby="' + id + '-title">' + d.steps.map((s, i) =>
      '<li class="cx-step' + (i === 0 ? " on" : "") + '" data-i="' + i + '" role="presentation"><button type="button" class="cx-tab" role="tab" id="' + id + "-tab-" + i + '" aria-controls="' + id + '-panel" aria-selected="' + (i === 0) + '" tabindex="' + (i === 0 ? 0 : -1) + '">' +
      '<span class="cx-bar" aria-hidden="true"><i></i></span><span class="cx-txt"><span class="display h3">' + t(s.title) + '</span><span class="cx-p">' + t(s.body) + "</span></span></button></li>",
    ).join("") + "</ol></div>" +
    '<div class="cx-right"><div class="cx-vis ef" role="tabpanel" id="' + id + '-panel" aria-labelledby="' + id + '-tab-0">' + d.steps.map((s) => '<span class="cx-bg gsurf" data-tone="' + s.tone + '" aria-hidden="true"></span>').join("") +
    d.steps.map((s) => cxCard(s.panel).replace('<div class="cx-card', '<div aria-hidden="true" class="cx-card')).join("") + "</div></div></div></div></section>";
}

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

/* ---------- Pages ---------- */
export function homeHTML() {
  const s = COPY.journey;
  return hero(s.hero, { visual: heroSlot(), cls: "hero-anim", panel: true }) + problem(s.problem) + chapterSection("week", "sec-week") + proofMonday(s.proof) +
    phSection(s.features, {}) + chapterSection("intelligence", "sec-intelligence") + chapterSection("sending", "sec-sending") + cta(s.cta);
}
export function oversightHTML() {
  const P = COPY.shared.oversight_page;
  return hero(P.hero, { visual: '<div class="ov-dash">' + visual(vNetworkDash()) + "</div>", cls: "hero-anim ov-hero", panel: true, hrefs: [ACCESS, "#every-plant"] }) +
    problem(P.problem) + chapterSection("every-plant", "sec-ov-plants") + chapterSection("network-intelligence", "sec-ov-intelligence") +
    phSection(P.plants, { id: "plants", vig: ovVig, tones: OV_PH_TONES }) + ovPaths(P.paths) + ovFaq(P.faq) + cta(P.cta);
}
