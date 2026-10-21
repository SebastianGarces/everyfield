import { cn } from "@/components/cn";
import { Display } from "@/components/Display";
import { CardIcon } from "@/components/kit/kit";
import { Reveal } from "@/components/motion/Reveal";
import { ICONS, type IconName } from "../icons";
import { SHARING } from "./demo";

const ITEM_ICONS: IconName[] = ["task", "eye", "flag", "users"];

/**
 * "Why the numbers are true": four short reasons, with a still picture of what one plant shares (IDN-022). The heading
 * and the reasons sit left of the picture on wide screens; on phones the picture follows the reasons.
 */
export function TrustSection({ headline, items }: { headline: string; items: { title: string; body: string }[] }) {
	return (
		<section id="trust" aria-labelledby="trust-title" className="relative py-section">
			<div className="mx-auto grid max-w-mk grid-cols-12 items-center gap-x-4 gap-y-10 px-page">
				<Reveal className="col-span-6 min-w-0 max-mk-cx:col-span-12">
					<Display as="h2" size="h2" id="trust-title" className="max-w-[16ch]">
						{headline}
					</Display>
					<ul className="mt-[clamp(28px,3vw,40px)] grid gap-6">
						{items.map((x, i) => (
							<li key={x.title} className="flex gap-4">
								<CardIcon tone="ink" icon={ICONS[ITEM_ICONS[i]!]} size={38} glyph={18} className="mt-0.5" />
								<div className="min-w-0">
									<h3 className="font-title type-title-sm mk-xl:type-title-md leading-[1.2] tracking-[-0.02em]">
										{x.title}
									</h3>
									<p className="mt-1.5 max-w-[52ch] type-lg leading-[1.55] text-pretty text-text-2">{x.body}</p>
								</div>
							</li>
						))}
					</ul>
				</Reveal>
				<Reveal className="col-span-5 col-start-8 min-w-0 max-mk-cx:col-span-12 max-mk-cx:col-start-1">
					<div
						aria-hidden="true"
						className="ef-ui mk-gsurf g-sky relative isolate grid place-items-center overflow-hidden rounded-card px-[clamp(16px,3vw,48px)] py-[clamp(28px,4vw,56px)]"
					>
						<div className="w-[min(400px,100%)] rounded-[22px] bg-white px-5 pt-[18px] pb-2 type-sm text-text shadow-mk-panel-flat">
							<div className="mb-2 flex items-center gap-3">
								<CardIcon tone="green" icon={ICONS.pin} size={36} glyph={17} />
								<div className="min-w-0 flex-1">
									<div className="font-title type-title-sm leading-[1.2] tracking-[-0.02em]">Harvest Point Church</div>
									<div className="mt-0.5 type-sm text-text-3">Sharing with Grace Church</div>
								</div>
							</div>
							{SHARING.map(([label, on]) => (
								<div key={label} className="flex items-center justify-between gap-3 border-t border-line py-2.5">
									<span className="type-md font-medium">{label}</span>
									<span className="flex items-center gap-2 type-xs text-text-3">
										{on ? "Shared" : "Not shared"}
										<span
											className={cn(
												"relative h-[22px] w-[38px] flex-none rounded-full",
												on ? "bg-green-500" : "bg-surface-2 shadow-[inset_0_0_0_1px_var(--color-line-2)]",
											)}
										>
											<span
												className={cn(
													"absolute top-[3px] size-4 rounded-full bg-white shadow-raised",
													on ? "left-[19px]" : "left-[3px]",
												)}
											/>
										</span>
									</span>
								</div>
							))}
						</div>
					</div>
				</Reveal>
			</div>
		</section>
	);
}
