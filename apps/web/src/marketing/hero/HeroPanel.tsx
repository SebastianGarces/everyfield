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
	band?: "dashboard" | "tour";
	photo: HeroPhoto;
};

const arrow = <Icon icon={ArrowRight02Icon} size={17} />;

export function HeroPanel({ eyebrow, headline, subhead, primary, secondary, note, children, band, photo }: Props) {
	const dash = band === "dashboard";
	const tour = band === "tour";
	return (
		<section
			id="top"
			className={cn(
				"relative scroll-mt-[88px] overflow-hidden bg-mk-canvas text-center max-mk-sm:scroll-mt-[76px]",
				!tour && "pb-[clamp(32px,5vw,72px)]",
			)}
		>
			<div className="px-[clamp(8px,1.67vw,24px)]">
				<div
					className={cn(
						"relative isolate mx-auto max-w-[calc(var(--container-mk)+112px)] text-ink",
						tour
							? "px-[clamp(10px,3.4vw,48px)] pt-[clamp(36px,4.2vw,60px)] pb-[clamp(10px,3.4vw,48px)]"
							: "px-[clamp(14px,4vw,64px)] pt-[clamp(56px,9vw,128px)] shadow-mk-hero-panel",
						dash ? "pb-0" : !tour && "pb-[clamp(16px,2.2vw,32px)]",
					)}
				>
					<Backdrop
						bg={photo}
						preload
						sizes="100vw"
						className={cn("hero-fade pointer-events-none absolute inset-0 -z-1", tour && "[--a:34%] [--d:40%]")}
					/>
					{eyebrow ? (
						<span
							className={cn(
								"inline-block mk-eyebrow type-sm leading-[1.3] font-semibold text-text-2",
								tour ? "mb-[18px]" : "mb-[26px] max-mk-sm:mb-[18px]",
							)}
						>
							{eyebrow}
						</span>
					) : null}
					<Display
						as="h1"
						size={tour ? undefined : "hero"}
						className={cn(
							"mx-auto",
							tour ? "max-w-[24ch] font-display type-display-sm leading-[1.04] mk-lg:type-display-md" : "max-w-[14ch]",
						)}
					>
						{headline}
					</Display>
					<div
						className={cn(
							"flex flex-col items-center",
							tour ? "mt-5 gap-6" : "mt-[clamp(18px,2.1vw,30px)] gap-[clamp(24px,2.8vw,40px)]",
						)}
					>
						<p
							className={cn(
								"mx-auto text-mk-lead-sm leading-[1.5]",
								tour ? "max-w-[600px] text-pretty text-text-2" : "text-ink",
								dash ? "max-w-[700px]" : !tour && "max-w-[560px]",
							)}
						>
							{subhead}
						</p>
						<div className={cn("flex flex-col items-center", tour ? "gap-3.5" : "gap-[18px]")}>
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
							{note ? (
								<p
									className={cn(
										"[text-wrap:balance]",
										tour
											? "max-w-[46ch] type-md leading-[1.5] text-text-2 max-mk-sm:max-w-[32ch]"
											: "max-w-[44ch] type-md text-ink",
									)}
								>
									{note}
								</p>
							) : null}
						</div>
					</div>
					<Reveal
						className={
							dash
								? "-mx-3 mt-[clamp(40px,5.6vw,80px)] h-[clamp(460px,50vw,720px)] overflow-hidden px-3 pt-2 max-mk-sm:h-[500px]"
								: tour
									? "mt-[clamp(32px,3.4vw,48px)]"
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
