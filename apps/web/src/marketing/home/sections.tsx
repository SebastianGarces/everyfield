import Link from "next/link";
import { Display } from "@/components/Display";
import { Icon } from "@/components/Icon";
import { COPY } from "../copy";
import { ICONS } from "../icons";
import { Backdrop } from "../photo/Backdrop";
import type { PhotoName } from "../photo/photos";
import { FrostIcon } from "../sections/FrostIcon";

/** The title of an icon card: the serif below 24 px, one weight, balanced lines. */
const CARD_TITLE = "mk-display font-title type-title-sm leading-[1.2] mk-xl:type-title-md";

/* Sebastian's picks (OPS-82 round 3): swirl, lupins, marigolds. */
const EVRY_PHOTOS: PhotoName[] = ["swirl", "lupins", "marigolds"];

/**
 * "Anything in Everyfield, Evry can do for you" (OPS-82): the headline over the subhead, three photo cards with the
 * frosted icon (you ask, Evry prepares it, you approve), then the limits line. No chat, no large EvryBot.
 */
export function EvryCards() {
	const E = COPY.shared.ops82.evry;
	return (
		<section id="evry" aria-labelledby="evry-title" className="relative py-section">
			<div className="mx-auto max-w-mk px-page">
				<div className="mb-[clamp(28px,4vw,48px)] max-w-[880px]">
					{/* Two lines, as in the prototype, where the h2 is larger. */}
					<Display as="h2" size="h2" id="evry-title" className="max-w-[640px]">
						{E.headline}
					</Display>
					<p className="mt-[18px] max-w-[640px] text-mk-lead-sm leading-[1.55] text-pretty text-text-2">{E.subhead}</p>
				</div>
				<ul className="m-0 grid list-none grid-cols-3 gap-4 p-0 max-[1100px]:grid-cols-2 max-[600px]:grid-cols-1">
					{E.cards.map(([icon, title, body], i) => (
						<li key={title} className="flex min-w-0 flex-col border border-mk-ink-06 bg-white shadow-mk-card">
							<div className="relative isolate mx-2 mt-2 flex h-[clamp(176px,15vw,220px)] items-end overflow-hidden p-[18px] max-[600px]:h-[168px]">
								<Backdrop
									bg={EVRY_PHOTOS[i]!}
									sizes="(max-width: 600px) 100vw, (max-width: 1100px) 50vw, 460px"
									className="absolute inset-0 -z-1"
								/>
								<FrostIcon icon={icon} />
							</div>
							<div className="px-5 pt-[18px] pb-[22px]">
								<h3 className={CARD_TITLE}>{title}</h3>
								<p className="mt-2 type-lg leading-[1.5] text-pretty text-text-2">{body}</p>
							</div>
						</li>
					))}
				</ul>
				<p className="mt-4 flex items-start gap-3 bg-cream px-4 py-3.5 type-lg leading-[1.5] text-text-2 mk-xl:type-title-sm">
					<Icon icon={ICONS.heart} size={20} className="mt-[3px] text-ink" />
					<span>{COPY.journey.evry.limits}</span>
				</p>
			</div>
		</section>
	);
}

/**
 * "Stay close to the church plants you send." (OPS-82): the meadow photo across the page, cream text on the left and a
 * 2×2 grid of frosted cards on the right. No Evry. A full-width photo section: its neighbours take the photo space.
 */
export function SendingSection() {
	const X = COPY.shared.ops82.sending;
	return (
		<section
			id="sending"
			aria-labelledby="sending-title"
			data-photo-section=""
			className="relative isolate overflow-hidden py-section text-cream"
		>
			<Backdrop bg="meadow" sizes="100vw" shade={0.55} className="absolute inset-0 -z-1" />
			<div className="mx-auto grid max-w-mk grid-cols-12 items-center gap-4 px-page">
				<div className="col-span-5 min-w-0 max-mk-cx:col-span-12">
					<Display as="h2" size="h2" id="sending-title">
						{X.title}
					</Display>
					<p className="mt-5 max-w-[46ch] text-mk-lead leading-[1.55] text-pretty text-mk-cream-92">{X.body}</p>
					<Link
						href="/oversight"
						className="group mt-[18px] inline-flex min-h-11 cursor-pointer items-center gap-2 type-lg font-semibold whitespace-nowrap text-cream underline decoration-mk-cream-45 underline-offset-4 transition-[text-decoration-color] hover:decoration-cream focus-visible:outline-cream"
					>
						{X.link}
						<Icon icon={ICONS.arrow} size={17} className="transition-transform group-hover:translate-x-0.5" />
					</Link>
				</div>
				<ul className="col-span-6 col-start-7 m-0 grid min-w-0 list-none grid-cols-2 gap-4 p-0 max-mk-cx:col-span-12 max-mk-cx:col-start-1 max-mk-cx:mt-3 max-[520px]:grid-cols-1">
					{X.points.map(([icon, title, body]) => (
						<li key={title} className="bg-mk-ink-26 px-[22px] pt-[22px] pb-6 shadow-mk-frost-tile backdrop-blur-[14px]">
							<FrostIcon icon={icon} size="md" />
							<h3 className={`${CARD_TITLE} mt-[18px] text-cream`}>{title}</h3>
							<p className="mt-1.5 type-md leading-[1.5] text-mk-cream-90">{body}</p>
						</li>
					))}
				</ul>
			</div>
		</section>
	);
}
