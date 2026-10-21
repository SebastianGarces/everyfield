import { ArrowRight02Icon, Menu01Icon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/frame/SiteFooter";
import { SiteNav } from "@/components/frame/SiteNav";
import { SkipLink } from "@/components/frame/SkipLink";
import { Icon } from "@/components/Icon";
import { Logo, LogoSymbols } from "@/components/Logo";
import { ACCESS_PATH } from "@/site";
import { COPY } from "./copy";
import { PhotoLoader } from "./photo/PhotoLoader";

// Static frame pieces, rendered on the server and handed to the client nav as elements.
const navLogo = <Logo variant="nav" />;
const pillLogo = <Logo variant="pill" />;
const arrow = <Icon icon={ArrowRight02Icon} size={17} />;
const menuIcon = <Icon icon={Menu01Icon} />;

/**
 * The page frame: skip link, logo sprite, header (in-flow and floating pill), main and footer.
 *
 * One plain block holds them all. When a link opens a page, Next finds the page top from the page's outermost
 * elements: with the fixed skip link and the hidden pill among them (both sit above the viewport), it took the top
 * as out of view even at scroll 0, and scrolled every element into view in turn, footer first. With one block that
 * starts at the document top, Next scrolls to 0 once, or not at all.
 */
export function Site({
	path,
	footerHeadline,
	children,
}: {
	path: string;
	footerHeadline?: string;
	children: ReactNode;
}) {
	const S = COPY.shared;
	const links = S.nav.map((n) => ({ href: n.href, label: n.label, current: n.href === path }));
	const cta = { href: ACCESS_PATH, label: S.nav_cta, current: path === ACCESS_PATH };
	return (
		<div>
			<SkipLink />
			<LogoSymbols />
			<SiteNav links={links} cta={cta} logo={navLogo} pillLogo={pillLogo} arrow={arrow} menuIcon={menuIcon} />
			<main id="view" tabIndex={-1} className="focus:outline-none">
				{children}
			</main>
			<SiteFooter headline={footerHeadline} />
			<PhotoLoader />
		</div>
	);
}
