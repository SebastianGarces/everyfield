import { ArrowRight02Icon, Menu01Icon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/frame/SiteFooter";
import { SiteNav } from "@/components/frame/SiteNav";
import { SkipLink } from "@/components/frame/SkipLink";
import { Icon } from "@/components/Icon";
import { Logo, LogoSymbols } from "@/components/Logo";
import { ACCESS_PATH } from "@/site";
import { COPY } from "./copy";

const navLogo = <Logo variant="nav" />;
const pillLogo = <Logo variant="pill" />;
const arrow = <Icon icon={ArrowRight02Icon} size={17} />;
const menuIcon = <Icon icon={Menu01Icon} />;

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
		</div>
	);
}
