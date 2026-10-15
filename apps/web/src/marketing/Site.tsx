import { ArrowRight02Icon, Menu01Icon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/frame/SiteFooter";
import { SiteNav } from "@/components/frame/SiteNav";
import { SkipLink } from "@/components/frame/SkipLink";
import { Icon } from "@/components/Icon";
import { Logo, LogoSymbols } from "@/components/Logo";
import { ACCESS_PATH } from "@/site";
import { COPY } from "./copy";
import { Motion } from "./Motion";

type Props = {
  path: string;
} & ({ html: string; children?: never } | { html?: never; children: ReactNode });

// Static frame pieces, rendered on the server and handed to the client nav as elements.
const navLogo = <Logo variant="nav" />;
const pillLogo = <Logo variant="pill" />;
const arrow = <Icon icon={ArrowRight02Icon} size={17} />;
const menuIcon = <Icon icon={Menu01Icon} />;

/**
 * The page frame: skip link, logo sprite, header (in-flow and floating pill), main and footer.
 * Sections come either as prototype markup (html, removed in R3) or as React children.
 */
export function Site({ path, html, children }: Props) {
  const S = COPY.shared;
  const links = S.nav.map((n) => ({ href: n.href, label: n.label, current: n.href === path }));
  const cta = { href: ACCESS_PATH, label: S.nav_cta, current: path === ACCESS_PATH };
  const main =
    html !== undefined ? (
      <main id="view" tabIndex={-1} className="focus:outline-none" dangerouslySetInnerHTML={{ __html: html }} />
    ) : (
      <main id="view" tabIndex={-1} className="focus:outline-none">
        {children}
      </main>
    );
  return (
    <>
      <SkipLink />
      <LogoSymbols />
      <SiteNav links={links} cta={cta} logo={navLogo} pillLogo={pillLogo} arrow={arrow} menuIcon={menuIcon} />
      {main}
      <SiteFooter />
      <Motion />
    </>
  );
}

/** Prototype markup inside a React tree (removed in R3). display: contents keeps the sections as layout children of #view. */
export function Html({ html }: { html: string }) {
  return <div style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: html }} />;
}
