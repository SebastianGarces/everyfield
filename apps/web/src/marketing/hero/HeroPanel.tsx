import { ArrowRight02Icon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
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
};

const arrow = <Icon icon={ArrowRight02Icon} size={17} />;

/**
 * The page hero (Revision 3): one rounded panel with the field gradient, which fades to the page at the top (Revision 7).
 * It is wider than the page column: 8 to 24 px window margins, and at most the nav width plus 56 px on each side (Revision 23).
 * Headline, lead and buttons are centred; the product visual sits on the green below them.
 */
export function HeroPanel({ headline, subhead, primary, secondary, children }: Props) {
  return (
    <section id="top" className="relative scroll-mt-[88px] overflow-hidden bg-mk-canvas pb-[clamp(32px,5vw,72px)] text-center max-mk-sm:scroll-mt-[76px]">
      <div className="px-[clamp(8px,1.67vw,24px)]">
        <div className="relative isolate mx-auto max-w-[calc(var(--container-mk)+112px)] rounded-frame px-[clamp(14px,4vw,64px)] pt-[clamp(56px,9vw,128px)] pb-[clamp(16px,2.2vw,32px)] text-ink shadow-[0_30px_60px_-40px_rgba(16,120,56,.6)]">
          <span aria-hidden="true" className="mk-gsurf g-field hero-fade pointer-events-none absolute inset-0 -z-1 rounded-[inherit]" />
          <Display as="h1" size="hero" className="mx-auto max-w-[14ch] text-[#2A332C]">
            {headline}
          </Display>
          <div className="mt-[clamp(18px,2.1vw,30px)] flex flex-col items-center gap-[clamp(24px,2.8vw,40px)]">
            <p className="mx-auto max-w-[560px] text-[clamp(16.5px,1.25vw,18px)] leading-[1.5] text-ink/72">{subhead}</p>
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
          <Reveal className="mt-[clamp(32px,3.9vw,56px)]" delay={210}>
            {children}
          </Reveal>
        </div>
      </div>
    </section>
  );
}
