import type { ReactNode } from "react";
import { Display } from "@/components/Display";
import { Icon } from "@/components/Icon";
import { COPY } from "../copy";
import { ICONS, type IconName } from "../icons";
import { Backdrop } from "../photo/Backdrop";
import { CARD_TITLE } from "../sections/card-title";
import { StopPath } from "./StopPath";

const O = COPY.shared.oversight_page;

/** The mint icon tile of the #every-plant tiles and the trust cards: a green icon on a light green square. */
function MintIcon({ icon }: { icon: IconName }) {
	return (
		<span aria-hidden="true" className="grid size-[60px] flex-none place-items-center bg-mk-mint text-green-600">
			<Icon icon={ICONS[icon]} size={28} stroke={1.4} />
		</span>
	);
}

/** A headline with one short paragraph under it, left-aligned (the prototype's .pth-head). */
function Head({ id, headline, lead, wide }: { id: string; headline: string; lead: string; wide?: boolean }) {
	return (
		<div className="mb-[clamp(28px,4vw,48px)]">
			<Display as="h2" size="h2" id={id} className={wide ? "max-w-[32ch]" : "max-w-[18ch]"}>
				{headline}
			</Display>
			<p className="mt-[18px] max-w-[640px] text-mk-lead-sm leading-[1.55] text-pretty text-text-2">{lead}</p>
		</div>
	);
}

/**
 * #every-plant (OPS-82): "See how your church plants are doing, one by one and all together." One band on the field
 * photo holds two labelled rows of four tiles: what a sending church sees in one place, then across its church plants.
 * Large mint icons, no app UI.
 */
export function EveryPlant() {
	const G = O.gets;
	return (
		<section id="every-plant" aria-labelledby="every-plant-title" className="relative py-section">
			<div className="mx-auto max-w-mk px-page">
				<Head id="every-plant-title" headline={G.headline} lead={G.lead} wide />
				<div className="relative isolate grid gap-[clamp(24px,3vw,40px)] p-[clamp(20px,3vw,44px)]">
					<Backdrop bg="field" sizes="(max-width: 1440px) 100vw, 1440px" className="absolute inset-0 -z-1" />
					{G.groups.map((g) => (
						<div key={g.label}>
							<span className="mb-3.5 inline-block bg-mk-canvas-94 px-2.5 pt-[7px] pb-1.5 type-sm leading-[1.3] font-semibold tracking-[.09em] text-ink uppercase">
								{g.label}
							</span>
							<ul className="m-0 grid list-none grid-cols-4 gap-4 p-0 max-[1100px]:grid-cols-2 max-[560px]:grid-cols-1">
								{g.items.map(([icon, title, body]) => (
									<li key={title} className="bg-mk-canvas-94 px-[22px] pt-6 pb-[26px] text-ink">
										<MintIcon icon={icon} />
										<h3 className={`${CARD_TITLE} mt-[18px]`}>{title}</h3>
										<p className="mt-2 type-lg leading-[1.5] text-text-2">{body}</p>
									</li>
								))}
							</ul>
						</div>
					))}
				</div>
			</div>
		</section>
	);
}

/**
 * #leaders (OPS-82): "Raise the next planters." on the full-bleed marigolds photo (Sebastian's pick). A shade from the top
 * and the bottom keeps the cream text at 4.5:1. Four brand-green stops on one dotted path, with the text under each stop.
 * No EvryBot and no bubble. A full-width photo section: its neighbours take the photo space.
 */
export function Leaders() {
	const L = O.leaders;
	const icons: ReactNode[] = L.icons.map((ic) => (
		<Icon key={ic} icon={ICONS[ic]} size={40} stroke={1.4} className="size-[44%]" />
	));
	return (
		<section
			id="leaders"
			aria-labelledby="leaders-title"
			data-photo-section=""
			className="relative isolate overflow-hidden py-section text-cream"
		>
			<Backdrop bg="marigolds" sizes="100vw" shade={0.3} className="absolute inset-0 -z-1" />
			<span aria-hidden="true" className="mk-leaders-shade absolute inset-0 -z-1" />
			<div className="mx-auto max-w-mk px-page">
				<div className="max-w-[760px]">
					<Display
						as="h2"
						id="leaders-title"
						// Two lines on wide screens, as in the prototype, where the h1 is 2 px larger.
						className="max-w-[600px] font-display type-display-sm leading-[1.04] mk-lg:type-display-md mk-xl:type-display-lg mk-2xl:type-mk-display-xl"
					>
						{L.headline}
					</Display>
					<p className="mt-[22px] type-title-sm leading-[1.5] text-mk-cream-92 mk-xl:type-title-md">{L.lead}</p>
				</div>
				<StopPath icons={icons} />
				<ol className="m-0 grid list-none grid-cols-4 gap-4 p-0 max-mk-cx:grid-cols-1 max-mk-cx:gap-0">
					{L.steps.map((s) => (
						<li key={s.title} className="border-t-2 border-mk-cream-50 pt-[18px] max-mk-cx:py-4">
							<h3 className="mk-display font-title type-title-sm leading-[1.15] mk-cx:type-title-md">{s.title}</h3>
							<p className="mt-2 type-lg leading-[1.5]">{s.body}</p>
						</li>
					))}
				</ol>
			</div>
		</section>
	);
}

const TRUST_ICONS: IconName[] = ["book", "compass", "eye", "lock"];

/** #trust (OPS-82): "Why you can trust these numbers." Four white cards with mint icon tiles. No UI. */
export function TrustCards() {
	const T = O.trust;
	return (
		<section id="trust" aria-labelledby="trust-title" className="relative py-section">
			<div className="mx-auto max-w-mk px-page">
				<div className="mb-[clamp(36px,5vw,64px)] grid grid-cols-12 gap-4">
					<Display as="h2" size="h2" id="trust-title" className="col-span-9 max-mk-lg:col-span-12">
						{T.headline}
					</Display>
				</div>
				<ul className="m-0 grid list-none grid-cols-4 gap-[clamp(20px,3vw,40px)] p-0 max-mk-lg:grid-cols-2 max-mk-sm:grid-cols-1">
					{T.items.map((x, i) => (
						<li key={x.title} className="flex flex-col gap-3 bg-white p-[26px] shadow-mk-card">
							<MintIcon icon={TRUST_ICONS[i]!} />
							<Display as="h3" size="h3">
								{x.title}
							</Display>
							<p className="type-lg leading-[1.5] text-text-2">{x.body}</p>
						</li>
					))}
				</ul>
			</div>
		</section>
	);
}
