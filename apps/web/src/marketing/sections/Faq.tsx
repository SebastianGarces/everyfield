import { Display } from "@/components/Display";
import { accessFor } from "@/site";
import type { Copy } from "../copy";
import { FaqItem } from "./FaqItem";

type FaqCopy = Copy["shared"]["oversight_page"]["faq"];

/** /oversight, Revision 26: the FAQ. Title left (sticky), questions right on desktop; one column on tablets and phones. */
export function Faq({ f }: { f: FaqCopy }) {
	return (
		<section id="faq" className="relative py-section">
			<div className="mx-auto max-w-mk px-page">
				<div className="grid grid-cols-12 items-start gap-4 max-mk-cx:block">
					<Display
						as="h2"
						size="h2"
						className="sticky top-[112px] col-span-5 col-start-1 max-w-[13ch] max-mk-cx:static max-mk-cx:mb-6 max-mk-cx:max-w-[16ch]"
					>
						{f.headline}
					</Display>
					<div className="col-span-7 col-start-6 w-full max-w-[720px] justify-self-end max-mk-cx:max-w-none">
						{f.items.map((x) => (
							<FaqItem key={x.id} id={"faq-" + x.id} q={x.q}>
								<p className="pr-[54px] pb-6 type-lg leading-[1.55] text-pretty text-text-2 max-mk-cx:pr-0">
									{answer(x.a, x.link)}
								</p>
							</FaqItem>
						))}
					</div>
				</div>
			</div>
		</section>
	);
}

/** The answer text; the words in `link` become a link to the request page's network form, as in the prototype. */
function answer(a: string, link?: string) {
	const i = link ? a.indexOf(link) : -1;
	if (!link || i < 0) return a;
	return (
		<>
			{a.slice(0, i)}
			<a href={accessFor("network")} className="text-green-600 underline underline-offset-3">
				{link}
			</a>
			{a.slice(i + link.length)}
		</>
	);
}
