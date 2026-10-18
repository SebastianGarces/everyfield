import { ButtonLink } from "@/components/ButtonLink";
import { Display } from "@/components/Display";
import { Icon } from "@/components/Icon";
import { Reveal } from "@/components/motion/Reveal";
import { ACCESS_PATH } from "@/site";
import { ICONS } from "../icons";

type Cta = { headline: string; body: string; cta_primary: string; cta_secondary: string; note?: string };

/** The closing call to action: a field-gradient box with the headline and both buttons. Both go to the request page. */
export function CtaSection({ c }: { c: Cta }) {
	return (
		<section id="cta" className="relative py-section">
			<div className="mx-auto max-w-mk px-page">
				<Reveal className="mk-gsurf g-field relative flex flex-col items-center gap-[22px] rounded-card px-[clamp(20px,4vw,64px)] py-[clamp(48px,7vw,104px)] text-center text-ink shadow-mk-cta">
					<Display as="h2" size="h1" className="max-w-[18ch]">
						{c.headline}
					</Display>
					<p className="mx-auto max-w-[58ch] text-mk-lead text-mk-ink-78">{c.body}</p>
					<div className="mt-2 flex flex-wrap justify-center gap-3">
						<ButtonLink href={ACCESS_PATH} icon={<Icon icon={ICONS.arrow} size={17} />}>
							{c.cta_primary}
						</ButtonLink>
						<ButtonLink href={ACCESS_PATH} variant="secondary" className="!bg-mk-white-75">
							{c.cta_secondary}
						</ButtonLink>
					</div>
					{c.note ? <p className="type-md text-mk-ink-78">{c.note}</p> : null}
				</Reveal>
			</div>
		</section>
	);
}
