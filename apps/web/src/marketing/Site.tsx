import type { ReactNode } from "react";
import { footerHTML, navHTML } from "./chrome";
import { LOGO_SYMBOLS } from "./logo-symbols";
import { Motion } from "./Motion";

type Props = { path: string } & ({ html: string; children?: never } | { html?: never; children: ReactNode });

/**
 * The page frame from the prototype: logo symbols, the in-flow nav, the floating nav pill, #view and the footer.
 * Sections come either as prototype markup (html) or as React children (the access forms).
 */
export function Site({ path, html, children }: Props) {
  const nav = navHTML(path);
  return (
    <>
      <a className="skip-link" href="#view">Skip to content</a>
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" dangerouslySetInnerHTML={{ __html: LOGO_SYMBOLS }} />
      <header className="site-nav" id="site-nav" dangerouslySetInnerHTML={{ __html: nav }} />
      {/* The floating copy of the nav. Only one of the two headers is exposed at a time (navPill in engines.ts). */}
      <header className="nav-pill" id="nav-pill" inert aria-hidden="true" dangerouslySetInnerHTML={{ __html: nav }} />
      {html !== undefined ? <main id="view" tabIndex={-1} dangerouslySetInnerHTML={{ __html: html }} /> : <main id="view" tabIndex={-1}>{children}</main>}
      <footer className="site-footer" id="site-footer" dangerouslySetInnerHTML={{ __html: footerHTML() }} />
      <Motion />
    </>
  );
}

/** Prototype markup inside a React tree. display: contents keeps the sections as layout children of #view. */
export function Html({ html }: { html: string }) {
  return <div style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: html }} />;
}
