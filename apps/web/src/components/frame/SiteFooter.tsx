import { ArrowRight02Icon } from "@hugeicons/core-free-icons";
import Link from "next/link";
import { ButtonLink } from "../ButtonLink";
import { Display } from "../Display";
import { Icon } from "../Icon";
import { Logo, Mark } from "../Logo";
import { COPY } from "@/marketing/copy";
import { ACCESS_PATH } from "@/site";

const LINK =
	"text-mk-on-ink-2 no-underline hover:text-cream hover:underline hover:underline-offset-3 focus-visible:outline-cream";

// Footer links come from shared.footer in design/marketing-copy.json. Only live pages get links: the planters page,
// the trust page and Evry are not live, so their links are left out, and so is a column left with no links.
// About is the home page section; Contact writes to the team inbox (Revision 8).
const ROUTES: Record<string, string> = {
	Overview: "/",
	"Plant Intelligence": "/#intelligence",
	"Churches & Networks": "/oversight",
	About: "/#about",
	Contact: "mailto:" + COPY.shared.access_page.contact_email,
	"Privacy policy": "/privacy",
	Terms: "/terms",
};

const footer = COPY.shared.footer;
const columns = footer.columns
	.map((c) => ({
		title: c.title,
		links: c.links.flatMap((label) => (ROUTES[label] ? [{ label, href: ROUTES[label] }] : [])),
	}))
	.filter((c) => c.links.length > 0);

/** The ink footer card: mark, headline and request button, the link columns, and the fine print. */
export function SiteFooter({ headline = footer.headline }: { headline?: string }) {
	return (
		<footer className="px-page pt-[clamp(24px,4vw,48px)] pb-page">
			<div className="mx-auto grid max-w-mk grid-cols-12 gap-x-6 gap-y-8 bg-ink px-[clamp(22px,5vw,72px)] pt-[clamp(28px,5vw,72px)] pb-[clamp(22px,3vw,32px)] text-cream">
				<div className="col-[1/span_6] flex flex-col items-start gap-[22px] max-mk-lg:col-[1/-1]">
					<Mark className="size-11 text-green" />
					<Display as="h2" className="max-w-[26ch] font-display text-title-lg/[1.1] mk-xl:text-display-sm/[1.1]">
						{headline}
					</Display>
					<ButtonLink
						href={ACCESS_PATH}
						variant="inverse"
						size="footer"
						icon={<Icon icon={ArrowRight02Icon} size={17} />}
					>
						{footer.cta}
					</ButtonLink>
				</div>
				<nav
					aria-label="Footer"
					className="col-[7/span_6] grid grid-cols-4 gap-6 max-mk-lg:col-[1/-1] max-mk-sm:grid-cols-2"
				>
					{columns.map((c) => (
						<div key={c.title}>
							<h3 className="mb-3 font-title type-title-sm leading-[1.2] tracking-[-0.02em] text-cream">{c.title}</h3>
							<ul>
								{c.links.map((l) => (
									<li key={l.label} className="mb-2.5 type-md">
										{l.href.startsWith("mailto:") ? (
											<a href={l.href} className={LINK}>
												{l.label}
											</a>
										) : (
											<Link href={l.href} className={LINK}>
												{l.label}
											</Link>
										)}
									</li>
								))}
							</ul>
						</div>
					))}
				</nav>
				<div className="col-[1/-1] flex flex-wrap items-center justify-between gap-3 border-t border-cream/14 pt-[22px] type-md text-mk-on-ink-2">
					<Logo variant="footer" />
					<span>{footer.fineprint}</span>
				</div>
			</div>
		</footer>
	);
}
