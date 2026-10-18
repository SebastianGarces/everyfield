import { ArrowRight02Icon } from "@hugeicons/core-free-icons";
import Link from "next/link";
import { ButtonLink } from "../ButtonLink";
import { Display } from "../Display";
import { Icon } from "../Icon";
import { Logo, Mark } from "../Logo";
import { COPY } from "@/marketing/copy";
import { ACCESS_PATH } from "@/site";

// Footer links come from shared.footer in design/marketing-copy.json. Only live pages get links: the planters page,
// the trust page, Evry and About are not live, so their links are left out, and so is a column left with no links.
const ROUTES: Record<string, string> = {
	Overview: "/",
	"Plant Intelligence": "/#intelligence",
	"Churches & Networks": "/oversight",
	Contact: ACCESS_PATH,
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
			<div className="mx-auto grid max-w-mk grid-cols-12 gap-x-6 gap-y-8 rounded-[32px] bg-ink px-[clamp(22px,5vw,72px)] pt-[clamp(28px,5vw,72px)] pb-[clamp(22px,3vw,32px)] text-white">
				<div className="col-[1/span_5] flex flex-col items-start gap-[22px] max-mk-lg:col-[1/-1]">
					<span className="grid size-11 place-items-center rounded-[13px] bg-green text-ink">
						<Mark className="h-[18px] w-[22px]" />
					</span>
					<Display as="h2" className="max-w-[16ch] text-[clamp(26px,2.6vw,38px)]/[1.1]">
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
							<h3 className="mb-3.5 text-[13px] font-semibold text-white">{c.title}</h3>
							<ul>
								{c.links.map((l) => (
									<li key={l.label} className="mb-2.5 text-[14.5px]">
										<Link
											href={l.href}
											className="text-mk-on-ink-2 no-underline hover:text-white hover:underline hover:underline-offset-3 focus-visible:outline-white"
										>
											{l.label}
										</Link>
									</li>
								))}
							</ul>
						</div>
					))}
				</nav>
				<div className="col-[1/-1] flex flex-wrap items-center justify-between gap-3 border-t border-white/12 pt-[22px] text-[13.5px] text-mk-on-ink-2">
					<Logo variant="footer" />
					<span>{footer.fineprint}</span>
				</div>
			</div>
		</footer>
	);
}
