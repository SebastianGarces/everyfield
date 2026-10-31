import { cn } from "@/components/cn";
import { Display } from "@/components/Display";
import { Reveal } from "@/components/motion/Reveal";
import { Backdrop } from "../photo/Backdrop";
import type { PhotoName } from "../photo/photos";
import { PinnedRail } from "./PinnedRail";
import { SampleTag } from "../sections/SampleTag";
import type { IconName } from "../icons";
import { FrostIcon } from "../sections/FrostIcon";
import { PlantVignette } from "./vignettes";

type Item = { label: string; title: string; body?: string; short?: string };
/** Home shows the phases, each with a frosted icon box (OPS-82); /oversight shows the plant cards with their vignettes. */
type Props = { headline: string; items: Item[] } & (
	{ id: "features"; vignettes: "phases"; icons: readonly IconName[] } | { id: "plants"; vignettes: "plants" }
);

/* Every card shows its own blurred colorful photo with a cream number (Sebastian, R3 review). None repeats a photo used
   elsewhere on its page: home uses wildflowers (hero), blossom (vision) and meadow (sending); /oversight uses bluebells
   (hero), lupins and swirl (sending paths). */
const ART: Record<Props["vignettes"], PhotoName[]> = {
	phases: ["bluebells", "poppies", "marigolds", "lilies", "lupins", "swirl"],
	plants: ["wildflowers", "poppies", "blossom", "meadow", "marigolds", "lilies"],
};
const num = (i: number) => String(i + 1).padStart(2, "0");

/**
 * The phases rail (Marketing v15): six tall cards in a row that bleeds off the right edge. Home shows the planter's six
 * phases; /oversight shows what a sending church sees. The cards render here; PinnedRail moves the row.
 */
export function PhasesRail(props: Props) {
	const { id, headline, items } = props;
	const head = (
		<div className="mx-auto max-w-mk px-page">
			<Reveal className="mb-[clamp(28px,3.4vw,48px)] grid grid-cols-12 items-end gap-4 max-mk-sm:mb-[26px]">
				<Display
					as="h2"
					size="h2"
					id="ph-title"
					// Home: two lines, as in the prototype, where the h2 is larger.
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
				const art = ART[props.vignettes][i]!;
				return (
					<li
						key={x.label}
						data-card=""
						tabIndex={0}
						aria-label={`${num(i)} · ${x.label}`}
						className="flex h-[444px] w-[clamp(296px,26vw,372px)] snap-start flex-col overflow-hidden border border-mk-ink-06 bg-white shadow-mk-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink max-mk-sm:h-auto max-mk-sm:w-[min(82vw,320px)]"
					>
						<div className="relative isolate mx-2 mt-2 h-[236px] flex-none overflow-hidden max-mk-sm:h-[200px]">
							<Backdrop bg={art} sizes="(max-width: 640px) 82vw, 372px" className="absolute inset-0 -z-1" />
							{/* The cream number sits on an ink corner shade: 3:1 or more on the lightest crops. */}
							<span aria-hidden="true" className="mk-corner-shade absolute inset-0 -z-1" />
							{props.vignettes === "plants" ? <SampleTag className="top-4 right-4" /> : null}
							<span
								aria-hidden="true"
								className="absolute top-4 left-[18px] font-display type-mk-display-xl leading-[.8] tracking-[-0.02em] text-cream tabular-nums"
							>
								{num(i)}
							</span>
							{props.vignettes === "phases" ? (
								<FrostIcon
									icon={props.icons[i]!}
									className="absolute bottom-[18px] left-[18px] max-[560px]:size-[60px] max-[560px]:[&_svg]:size-7"
								/>
							) : (
								<div
									aria-hidden="true"
									className="ef-ui absolute inset-x-0 top-28 mx-auto w-[min(calc(100%-28px),292px)]"
								>
									<PlantVignette i={i} />
								</div>
							)}
						</div>
						<div className="px-[22px] pt-5 pb-[22px]">
							<span className="flex items-baseline gap-3 type-sm leading-[1.3] font-semibold tracking-[.09em] uppercase">
								<span className="text-text-3 tabular-nums">{num(i)}</span>
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
