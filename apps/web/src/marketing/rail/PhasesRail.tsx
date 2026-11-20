import { cn } from "@everyfield/ui/foundations";
import { Display } from "@/components/Display";
import { Reveal } from "@/components/motion/Reveal";
import { Backdrop } from "../photo/Backdrop";
import type { PhotoName } from "../photo/photos";
import { PinnedRail } from "./PinnedRail";
import type { IconName } from "../icons";
import { FrostIcon } from "../sections/FrostIcon";
import { stepNumber } from "../step-number";

type Item = { label: string; title: string; body?: string; short?: string };
type Props = { id: "features" | "plants"; headline: string; items: Item[]; icons: readonly IconName[] };

const ART: Record<Props["id"], PhotoName[]> = {
	features: ["bluebells", "poppies", "marigolds", "lilies", "lupins", "swirl"],
	plants: ["wildflowers", "poppies", "blossom", "meadow", "marigolds", "lilies"],
};

export function PhasesRail({ id, headline, items, icons }: Props) {
	const head = (
		<div className="mx-auto max-w-mk px-page">
			<Reveal className="mb-[clamp(28px,3.4vw,48px)] grid grid-cols-12 items-end gap-4 max-mk-sm:mb-[26px]">
				<Display
					as="h2"
					size="h2"
					id="ph-title"
					className={cn("col-span-9 max-mk-lg:col-span-12", id === "features" && "max-w-[640px]")}
				>
					{headline}
				</Display>
			</Reveal>
		</div>
	);
	return (
		<PinnedRail id={id} headingId="ph-title" head={head}>
			{items.map((x, i) => {
				const art = ART[id][i]!;
				return (
					<li
						key={x.label}
						data-card=""
						tabIndex={0}
						aria-label={`${stepNumber(i)} · ${x.label}`}
						className="flex h-[444px] w-[clamp(296px,26vw,372px)] snap-start flex-col overflow-hidden border border-mk-ink-06 bg-white shadow-mk-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink max-mk-sm:h-auto max-mk-sm:w-[min(82vw,320px)]"
					>
						<div className="relative isolate mx-2 mt-2 h-[236px] flex-none overflow-hidden max-mk-sm:h-[200px]">
							<Backdrop bg={art} sizes="(max-width: 640px) 82vw, 372px" className="absolute inset-0 -z-1" />
							<span aria-hidden="true" className="mk-corner-shade absolute inset-0 -z-1" />
							<span
								aria-hidden="true"
								className="absolute top-4 left-[18px] font-display type-mk-display-xl leading-[.8] tracking-[-0.02em] text-cream tabular-nums"
							>
								{stepNumber(i)}
							</span>
							<FrostIcon
								icon={icons[i]!}
								className="absolute bottom-[18px] left-[18px] max-[560px]:size-[60px] max-[560px]:[&_svg]:size-7"
							/>
						</div>
						<div className="px-[22px] pt-5 pb-[22px]">
							<span className="flex items-baseline gap-3 mk-label type-sm leading-[1.3] font-semibold">
								<span className="text-text-3 tabular-nums">{stepNumber(i)}</span>
								<span className="text-text-2">{x.label}</span>
							</span>
							<h3 className="mt-2.5 font-title type-title-md leading-[1.15] tracking-[-0.02em] [text-wrap:balance]">
								{x.title}
							</h3>
							<p className="mt-2 type-lg leading-[1.5] text-text-2">{x.short || x.body || ""}</p>
						</div>
					</li>
				);
			})}
		</PinnedRail>
	);
}
