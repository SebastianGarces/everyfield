import { cn } from "@everyfield/ui/foundations";
import { ArrowRight02Icon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { ButtonLink } from "@/components/ButtonLink";
import { Display } from "@/components/Display";
import { Icon } from "@/components/Icon";
import { Reveal } from "@/components/motion/Reveal";
import { Backdrop } from "../photo/Backdrop";
import type { HeroPhoto } from "../photo/photos";

type Props = {
	eyebrow?: string;
	headline: string;
	subhead: string;
	primary: { label: string; href: string };
	secondary?: { label: string; href: string };
	note?: string;
	children: ReactNode;
	band?: "dashboard";
	photo: HeroPhoto;
};

const arrow = <Icon icon={ArrowRight02Icon} size={17} />;

export function HeroPanel({ eyebrow, headline, subhead, primary, secondary, note, children, band, photo }: Props) {
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
					{eyebrow ? (
						<span className="mb-[26px] inline-block mk-eyebrow type-sm leading-[1.3] font-semibold text-text-2 max-mk-sm:mb-[18px]">
							{eyebrow}
						</span>
					) : null}
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
									<ButtonLink
										href={secondary.href}
										variant="secondary"
										className="shadow-none hover:bg-cream hover:shadow-none"
									>
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
