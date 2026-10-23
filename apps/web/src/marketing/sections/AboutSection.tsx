import { Display } from "@/components/Display";
import { Reveal } from "@/components/motion/Reveal";
import type { Copy } from "../copy";
import { marked } from "./Marked";

/** Home, Revision 8: who is behind Everyfield. The footer's About link opens it (/#about). */
export function AboutSection({ a }: { a: Copy["shared"]["about"] }) {
	return (
		<section id="about" className="relative scroll-mt-[88px] py-section max-mk-sm:scroll-mt-[76px]">
			<div className="mx-auto max-w-mk px-page">
				<Reveal className="mx-auto max-w-[940px] text-center">
					<p className="mb-[26px] type-sm leading-[1.3] font-semibold tracking-[0.09em] text-text-2 uppercase max-mk-sm:mb-[18px]">
						{a.eyebrow}
					</p>
					<Display as="h2" size="h2" className="mx-auto">
						{a.headline}
					</Display>
					<p className="mx-auto mt-5 max-w-[600px] text-mk-lead-sm leading-[1.55] text-pretty text-text-2">
						{marked(a.body)}
					</p>
				</Reveal>
			</div>
		</section>
	);
}
