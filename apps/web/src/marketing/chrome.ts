import "server-only";
import { COPY } from "./copy";
import { NETWORK_FORM, PLANTER_FORM, btn, icon, logo, mark, t } from "./markup";

// Nav and footer markup from the prototype (navHTML, renderFooter). Only live pages get links: the planters page,
// the trust page and sign in are not live, so their nav items and footer links are left out, and so are the
// footer items the prototype marks "Later". A column with no live links is left out too.

const NAV: Record<string, string> = {
  Product: "/#features",
  "For sending churches and networks": "/oversight",
};
const FOOTER: Record<string, string> = {
  Overview: "/",
  "Plant Intelligence": "/#intelligence",
  "Sending churches and networks": "/oversight",
  Contact: NETWORK_FORM,
  "Privacy policy": "/privacy",
  Terms: "/terms",
};

export function navHTML(path: string) {
  const S = COPY.shared;
  const links = S.nav
    .filter((n) => NAV[n.label])
    .map((n) => {
      const href = NAV[n.label]!;
      return '<a href="' + href + '"' + (href === path ? ' aria-current="page"' : "") + ">" + t(n.label) + "</a>";
    })
    .join("");
  return '<div class="wrap"><a href="/" aria-label="EveryField home" class="nav-home">' + logo("nav-logo") + "</a>" +
    '<nav class="nav-links" aria-label="Main">' + links + '<a class="mk-btn primary nav-cta-m" href="' + PLANTER_FORM + '">' + t(S.nav_cta) + "</a></nav>" +
    '<div class="nav-end">' + btn(S.nav_cta) +
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
