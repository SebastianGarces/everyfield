import type { ReactNode } from "react";
import { Display } from "@/components/Display";

/** The hero of a plain page (/access, /privacy, /terms): optional eyebrow, centred headline, then the page's own content. */
export function PageHero({ eyebrow, title, children }: { eyebrow?: string; title: string; children: ReactNode }) {
	return (
		<section
			id="top"
			className="relative overflow-hidden pt-[clamp(48px,7vw,104px)] pb-[clamp(56px,7vw,112px)] text-center"
		>
			<div className="mx-auto max-w-mk px-page">
				{eyebrow ? (
					<span className="mb-[26px] inline-block type-sm leading-[1.3] font-semibold tracking-[0.09em] text-text-2 uppercase max-mk-sm:mb-[18px]">
						{eyebrow}
					</span>
				) : null}
				<Display as="h1" size="h1" className="mx-auto max-w-[18ch]">
					{title}
				</Display>
				{children}
			</div>
		</section>
	);
}
