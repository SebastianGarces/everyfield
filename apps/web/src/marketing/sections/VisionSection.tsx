import { Display } from "@/components/Display";
import { Icon } from "@/components/Icon";
import { Reveal } from "@/components/motion/Reveal";
import { ICONS } from "../icons";
import { MondayOverview } from "../visuals/MondayOverview";
import { VisionZoom } from "../visuals/VisionZoom";

/**
 * "The vision, down to this week": the head on the left and the four-level zoom on the right (stacked below 901 px).
 * The zoom's green line runs on through a small "Monday morning" label down to the Monday overview, so the plan and the
 * week read as one section. #proof stays on the overview for old links.
 */
export function VisionSection({
	headline,
	body,
	bridge,
	caption,
}: {
	headline: string;
	body: string;
	bridge: string;
	caption?: string;
}) {
	return (
		<section id="vision" aria-labelledby="vision-title" className="relative py-section">
			<div className="mx-auto max-w-mk px-page">
				<div className="grid grid-cols-[minmax(0,5fr)_minmax(0,6fr)] items-center gap-x-[clamp(36px,5vw,88px)] gap-y-9 max-mk-cx:grid-cols-[minmax(0,1fr)]">
					<Reveal className="max-w-[540px] max-mk-cx:mx-auto max-mk-cx:max-w-[640px] max-mk-cx:text-center">
						<Display as="h2" size="h2" id="vision-title">
							{headline}
						</Display>
						<p className="mt-5 text-[clamp(17px,1.3vw,19px)] leading-[1.55] text-pretty text-text-2">{body}</p>
					</Reveal>
					<VisionZoom />
					<Reveal className="col-start-2 -my-9 flex flex-col items-center max-mk-cx:col-start-1">
						<i aria-hidden="true" className="h-[clamp(28px,4vw,44px)] w-0.5 rounded-full bg-green-600" />
						<p className="m-0 inline-flex h-9 items-center gap-2 rounded-full bg-surface px-4 text-[14px] font-semibold text-ink shadow-mk-chip">
							<Icon icon={ICONS.calendar} size={16} className="text-green-700" />
							{bridge}
						</p>
						<i aria-hidden="true" className="h-[clamp(28px,4vw,44px)] w-0.5 rounded-full bg-green-600" />
					</Reveal>
				</div>
				<figure id="proof" className="relative m-0 min-w-0">
					<MondayOverview />
					{caption ? <figcaption className="mt-3.5 text-[14px] text-text-3">{caption}</figcaption> : null}
				</figure>
			</div>
		</section>
	);
}
