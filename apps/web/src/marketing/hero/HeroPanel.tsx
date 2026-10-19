import { ArrowRight02Icon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { cn } from "@/components/cn";
import { ButtonLink } from "@/components/ButtonLink";
import { Display } from "@/components/Display";
import { Icon } from "@/components/Icon";
import { Reveal } from "@/components/motion/Reveal";

type Props = {
	headline: string;
	subhead: string;
	primary: { label: string; href: string };
	secondary?: { label: string; href: string };
	/** The product visual under the buttons. */
	children: ReactNode;
	/** "dashboard" (/oversight, Revision 24): a wider lead, and the band is a window of fixed height onto a large
	 *  dashboard that runs to the panel's bottom edge. */
	band?: "dashboard";
};

const arrow = <Icon icon={ArrowRight02Icon} size={17} />;

/**
 * The page hero (Revision 3): one rounded panel with the field gradient, which fades to the page at the top (Revision 7).
 * It is wider than the page column: 8 to 24 px window margins, and at most the nav width plus 56 px on each side (Revision 23).
 * Headline, lead and buttons are centred; the product visual sits on the green below them.
 */
export function HeroPanel({ headline, subhead, primary, secondary, children, band }: Props) {
	const dash = band === "dashboard";
	return (
		<section
			id="top"
			className="relative scroll-mt-[88px] overflow-hidden bg-mk-canvas pb-[clamp(32px,5vw,72px)] text-center max-mk-sm:scroll-mt-[76px]"
		>
			<div className="px-[clamp(8px,1.67vw,24px)]">
				<div
					className={cn(
						"relative isolate mx-auto max-w-[calc(var(--container-mk)+112px)] rounded-frame px-[clamp(14px,4vw,64px)] pt-[clamp(56px,9vw,128px)] text-ink shadow-mk-hero-panel",
						dash ? "pb-0" : "pb-[clamp(16px,2.2vw,32px)]",
					)}
				>
					<span
						aria-hidden="true"
						className="mk-gsurf g-field hero-fade pointer-events-none absolute inset-0 -z-1 rounded-[inherit]"
					/>
					<Display as="h1" size="hero" className="mx-auto max-w-[14ch] text-mk-hero-title">
						{headline}
					</Display>
					<div className="mt-[clamp(18px,2.1vw,30px)] flex flex-col items-center gap-[clamp(24px,2.8vw,40px)]">
						<p
							className={cn(
								"mx-auto text-mk-lead-sm leading-[1.5] text-ink/72",
								dash ? "max-w-[700px]" : "max-w-[560px]",
							)}
						>
							{subhead}
						</p>
						<div className="flex flex-col items-center gap-[18px]">
							<div className="flex flex-wrap justify-center gap-3">
								<ButtonLink href={primary.href} icon={arrow} className="focus-visible:outline-offset-3">
									{primary.label}
								</ButtonLink>
								{secondary ? (
									<ButtonLink href={secondary.href} variant="secondary" className="!shadow-none hover:bg-cream">
										{secondary.label}
									</ButtonLink>
								) : null}
							</div>
						</div>
					</div>
					<Reveal
						className={
							dash
								? "-mx-3 mt-[clamp(40px,5.6vw,80px)] h-[clamp(460px,50vw,720px)] overflow-hidden px-3 pt-2 max-mk-sm:h-[500px]"
								: "mt-[clamp(32px,3.9vw,56px)]"
						}
						delay={210}
					>
						{children}
					</Reveal>
				</div>
			</div>
		</section>
	);
}
