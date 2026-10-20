import Link from "next/link";
import { cn } from "@/components/cn";
import { Display } from "@/components/Display";
import { Icon } from "@/components/Icon";
import { Badge, CardIcon } from "@/components/kit/kit";
import { Reveal } from "@/components/motion/Reveal";
import { ICONS } from "../icons";
import { EvryPanel, type EvryDemo } from "../panels/intelligence";
import { SENT } from "./demo";
import { SoloPanel } from "../chapters/SoloPanel";

const LEAD = "text-mk-lead-sm leading-[1.55] text-pretty text-text-2";

/**
 * "Evry prepares the work. You approve it." The panel sits left (the Plant Intelligence chapter above has it right), and
 * the text says what Evry is, what it prepares and what it never does.
 */
export function EvrySection({
	headline,
	body,
	limits,
	demo,
}: {
	headline: string;
	body: string;
	limits: string;
	demo: EvryDemo;
}) {
	return (
		<section id="evry" aria-labelledby="evry-title" className="relative py-section">
			<div className="mx-auto grid max-w-mk grid-cols-12 items-center gap-x-4 gap-y-9 px-page">
				<Reveal className="col-span-5 col-start-8 min-w-0 max-mk-cx:col-span-12 max-mk-cx:col-start-1 max-mk-cx:max-w-[640px] mk-cx:row-start-1">
					<Display as="h2" size="h2" id="evry-title">
						{headline}
					</Display>
					<p className={cn(LEAD, "mt-5")}>{body}</p>
					<p className="mt-6 flex gap-3 rounded-[18px] bg-surface-2 px-4 py-3.5 type-lg leading-[1.5] text-text-2">
						<CardIcon tone="ink" icon={ICONS.heart} size={30} glyph={15} />
						<span className="min-w-0 self-center">{limits}</span>
					</p>
				</Reveal>
				<div className="col-span-6 col-start-1 min-w-0 self-stretch max-mk-cx:col-span-12 mk-cx:row-start-1">
					<SoloPanel kind="evry" tone="g-sky">
						<EvryPanel demo={demo} />
					</SoloPanel>
				</div>
			</div>
		</section>
	);
}

/**
 * The sending glimpse: one headline, one sentence and the link to /oversight, with a still card of the plants Grace
 * Church sends. The four-step oversight chapter stays on /oversight. The section is the teal surface, full width;
 * only the content rises in, so the surface never moves or changes size.
 */
export function SendingGlimpse({ title, body, link }: { title: string; body: string; link: string }) {
	return (
		<section id="sending" aria-labelledby="sending-title" className="mk-gsurf g-sea relative py-section">
			<div className="mx-auto max-w-mk px-page">
				<Reveal className="grid grid-cols-12 items-center gap-x-4 gap-y-8 px-[clamp(20px,4vw,64px)] py-[clamp(36px,5vw,72px)] text-ink">
					<div className="col-span-6 min-w-0 max-mk-cx:col-span-12">
						<Display as="h2" size="h2" id="sending-title">
							{title}
						</Display>
						<p className="mt-5 max-w-[46ch] text-mk-lead-sm leading-[1.55] text-pretty text-mk-ink-78">{body}</p>
						<Link
							href="/oversight"
							className="group mt-6 inline-flex min-h-11 items-center gap-2 rounded-[6px] type-lg font-semibold text-ink underline decoration-ink/30 underline-offset-4 [transition:text-decoration-color_.15s] hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink motion-reduce:transition-none"
						>
							{link}
							<Icon
								icon={ICONS.arrow}
								size={17}
								className="flex-none [transition:translate_.15s] group-hover:translate-x-0.5 motion-reduce:transition-none"
							/>
						</Link>
					</div>
					<div
						aria-hidden="true"
						className="ef-ui col-span-5 col-start-8 min-w-0 max-mk-cx:col-span-12 max-mk-cx:col-start-1"
					>
						<div className="rounded-[22px] bg-white px-5 pt-[18px] pb-2 type-sm text-text shadow-mk-panel-flat">
							<div className="mb-2 flex items-center gap-3">
								<CardIcon tone="blue" icon={ICONS.network} size={36} glyph={17} />
								<div className="min-w-0 flex-1">
									<div className="font-title type-title-sm leading-[1.2] tracking-[-0.02em]">Grace Church</div>
									<div className="mt-0.5 type-sm text-text-3">Plants you send · Hyde Park, Austin</div>
								</div>
							</div>
							{SENT.map((r) => (
								<div key={r[0]} className="flex items-center gap-3 border-t border-line py-3">
									<div className="min-w-0 flex-1">
										<div className="truncate type-md font-semibold">{r[0]}</div>
										<div className="mt-0.5 type-sm text-text-3">{r[1]}</div>
										<div className="type-sm text-text-3">{r[2]}</div>
									</div>
									<Badge status="positive" size="sm">
										On track
									</Badge>
								</div>
							))}
						</div>
					</div>
				</Reveal>
			</div>
		</section>
	);
}
