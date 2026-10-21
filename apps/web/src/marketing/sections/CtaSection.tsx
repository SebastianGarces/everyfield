import { ButtonLink } from "@/components/ButtonLink";
import { Display } from "@/components/Display";
import { Icon } from "@/components/Icon";
import { Mark } from "@/components/Logo";
import { Reveal } from "@/components/motion/Reveal";
import { ACCESS_PATH } from "@/site";
import { ICONS } from "../icons";
import { Backdrop } from "../photo/Backdrop";

type Cta = { headline: string; body: string; cta_primary: string; cta_secondary: string; note?: string };

/**
 * The closing call to action: the lake photo with the cream symbol, the headline and both buttons in cream. Both buttons
 * go to the request page. Wide boxes take a 45 % overlay (bright reed tips sit behind the lead); tall boxes zoom into the
 * brown band behind the text. Every glyph keeps 4.5:1.
 */
export function CtaSection({ c }: { c: Cta }) {
	return (
		<section id="cta" className="relative py-section">
			<div className="mx-auto max-w-mk px-page">
				<Reveal className="relative isolate flex flex-col items-center gap-[22px] overflow-hidden px-[clamp(20px,4vw,64px)] py-[clamp(48px,7vw,104px)] text-center text-cream shadow-mk-cta">
					<Backdrop
						bg="lake"
						shade={0.45}
						className="absolute inset-0 -z-1 max-mk-cx:[--pos:50%_61%]! max-mk-cx:[--shade:.2]! max-mk-cx:[--zoom:1.9]!"
					/>
					<Mark className="size-[clamp(44px,4.4vw,64px)] text-cream" />
					<Display as="h2" size="h2" className="max-w-[18ch]">
						{c.headline}
					</Display>
					<p className="mx-auto max-w-[58ch] text-mk-lead text-mk-cream-90">{c.body}</p>
					<div className="mt-2 flex flex-wrap justify-center gap-3">
						<ButtonLink href={ACCESS_PATH} variant="photo" icon={<Icon icon={ICONS.arrow} size={17} />}>
							{c.cta_primary}
						</ButtonLink>
						<ButtonLink href={ACCESS_PATH} variant="photo-secondary">
							{c.cta_secondary}
						</ButtonLink>
					</div>
					{c.note ? <p className="type-md text-mk-cream-90">{c.note}</p> : null}
				</Reveal>
			</div>
		</section>
	);
}
