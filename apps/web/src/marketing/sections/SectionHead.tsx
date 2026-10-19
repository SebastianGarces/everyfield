import { cn } from "@/components/cn";
import { Display } from "@/components/Display";
import { Reveal } from "@/components/motion/Reveal";

/** A centred section head (Calendly pattern): headline with one short muted paragraph under it. It rises in once. */
export function SectionHead({ headline, body, className }: { headline: string; body: string; className?: string }) {
	return (
		<Reveal className={cn("mx-auto max-w-[940px] text-center", className)}>
			<Display as="h2" size="h2" className="mx-auto">
				{headline}
			</Display>
			<p className="mx-auto mt-5 max-w-[600px] text-mk-lead-sm leading-[1.55] text-pretty text-text-2">{body}</p>
		</Reveal>
	);
}

/** The problem statement under the hero (home and /oversight). */
export function ProblemSection({ headline, body }: { headline: string; body: string }) {
	return (
		<section id="problem" className="relative py-section">
			<div className="mx-auto max-w-mk px-page">
				<SectionHead headline={headline} body={body} />
			</div>
		</section>
	);
}
