import { ArrowRight02Icon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { cn } from "@/components/cn";
import { ButtonLink } from "@/components/ButtonLink";
import { Display } from "@/components/Display";
import { Icon } from "@/components/Icon";
import { Reveal } from "@/components/motion/Reveal";
import { Backdrop } from "../photo/Backdrop";
import type { HeroPhoto } from "../photo/photos";

type Props = {
	headline: string;
	subhead: string;
	primary: { label: string; href: string };
	secondary?: { label: string; href: string };
	/** One line under the buttons: what happens after the primary button. */
	note?: string;
	/** The product visual under the buttons. */
	children: ReactNode;
	/** "dashboard" (/oversight, Revision 24): a wider lead, and the band is a window of fixed height onto a large
	 *  dashboard that runs to the panel's bottom edge. */
	band?: "dashboard";
	/** The page's hero photo (foundations.md: home = wildflowers, /oversight = bluebells). The page's only preloaded image. */
	photo: HeroPhoto;
};

const arrow = <Icon icon={ArrowRight02Icon} size={17} />;

/**
 * The page hero (Revision 3): one panel with a treated photo, which fades up from the page (the fade style, 2026-10-20 rebrand).
 * It is wider than the page column: 8 to 24 px window margins, and at most the nav width plus 56 px on each side (Revision 23).
 * Headline, lead and buttons are centred in ink on the faded top; the product visual sits on the photo below them.
 */
export function HeroPanel({ headline, subhead, primary, secondary, note, children, band, photo }: Props) {
	const dash = band === "dashboard";
	return (
		<section
			id="top"
			className="relative scroll-mt-[88px] overflow-hidden bg-mk-canvas pb-[clamp(32px,5vw,72px)] text-center max-mk-sm:scroll-mt-[76px]"
		>
			<div className="px-[clamp(8px,1.67vw,24px)]">
				<div
					className={cn(
						"relative isolate mx-auto max-w-[calc(var(--container-mk)+112px)] px-[clamp(14px,4vw,64px)] pt-[clamp(56px,9vw,128px)] text-ink shadow-mk-hero-panel",
						dash ? "pb-0" : "pb-[clamp(16px,2.2vw,32px)]",
					)}
				>
					<Backdrop bg={photo} preload sizes="100vw" className="hero-fade pointer-events-none absolute inset-0 -z-1" />
					<Display as="h1" size="hero" className="mx-auto max-w-[14ch]">
						{headline}
					</Display>
					<div className="mt-[clamp(18px,2.1vw,30px)] flex flex-col items-center gap-[clamp(24px,2.8vw,40px)]">
						<p
							className={cn("mx-auto text-mk-lead-sm leading-[1.5] text-ink", dash ? "max-w-[700px]" : "max-w-[560px]")}
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
							{note ? <p className="max-w-[44ch] type-md [text-wrap:balance] text-ink">{note}</p> : null}
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
