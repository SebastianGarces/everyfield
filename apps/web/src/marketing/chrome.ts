import "server-only";
import { COPY } from "./copy";
import { ACCESS, btn, icon, logo, mark, t } from "./markup";

// Nav and footer markup from the prototype (navHTML, renderFooter). The nav items and their routes come from
// shared.nav in design/marketing-copy.json. Only live pages get footer links: the planters page, the trust page and
// sign in are not live, so their footer links are left out, and so are the footer items the prototype marks "Later".
// A column with no live links is left out too.
const FOOTER: Record<string, string> = {
  Overview: "/",
  "Plant Intelligence": "/#intelligence",
  "Churches & Networks": "/oversight",
  Contact: ACCESS,
  "Privacy policy": "/privacy",
  Terms: "/terms",
};

/** A link to the page being shown carries aria-current="page", in the nav and on the request button. */
const link = (href: string, path: string, label: string, cls?: string) =>
  "<a" + (cls ? ' class="' + cls + '"' : "") + ' href="' + href + '"' + (href === path ? ' aria-current="page"' : "") + ">" + label + "</a>";

export function navHTML(path: string) {
  const S = COPY.shared;
  const links = S.nav.map((n) => link(n.href, path, t(n.label))).join("");
  const cta = (cls: string, arrow: string) => link(ACCESS, path, t(S.nav_cta) + arrow, cls);
  return '<div class="wrap"><a href="/" aria-label="EveryField home" class="nav-home">' + logo("nav-logo") + "</a>" +
    '<nav class="nav-links" aria-label="Main">' + links + cta("mk-btn primary nav-cta-m", "") + "</nav>" +
    '<div class="nav-end">' + cta("mk-btn primary", icon("arrow")) +
    '<button class="nav-toggle" type="button" aria-label="Menu" aria-expanded="false">' + icon("menu") + "</button></div></div>";
}

export function footerHTML() {
  const f = COPY.shared.footer;
  const cols = f.columns
    .map((c) => ({ title: c.title, links: c.links.filter((l) => FOOTER[l]) }))
    .filter((c) => c.links.length);
  return '<div class="ft-card"><div class="ft-lead"><span class="ft-mark">' + mark() + '</span><h2 class="display">' + t(f.headline) + "</h2>" + btn(f.cta) + "</div>" +
    '<nav class="ft-cols" aria-label="Footer">' + cols.map((c) =>
      "<div><h3>" + t(c.title) + "</h3><ul>" + c.links.map((l) => '<li><a href="' + FOOTER[l] + '">' + t(l) + "</a></li>").join("") + "</ul></div>",
    ).join("") + "</nav>" +
    '<div class="ft-bottom">' + logo() + "<span>" + t(f.fineprint) + "</span></div></div>";
}
