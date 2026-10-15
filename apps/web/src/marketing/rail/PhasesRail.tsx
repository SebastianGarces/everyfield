import { cn } from "@/components/cn";
import { Display } from "@/components/Display";
import { Reveal } from "@/components/motion/Reveal";
import { PinnedRail } from "./PinnedRail";
import { PhaseVignette, PlantVignette } from "./vignettes";

type Item = { label: string; title: string; body?: string; short?: string };
type Props = { id: "features" | "plants"; headline: string; items: Item[]; vignettes: "phases" | "plants" };

const TONES = { phases: ["g-sky", "g-field", "g-dawn", "g-lilac", "g-sun", "g-sea"], plants: ["g-lilac", "g-sea", "g-dawn", "g-field", "g-sky", "g-sun"] };
const num = (i: number) => String(i + 1).padStart(2, "0");

/**
 * The phases rail (Marketing v15): six tall cards in a row that bleeds off the right edge. Home shows the planter's six
 * phases; /oversight shows what a sending church sees. The cards render here; PinnedRail moves the row.
 */
export function PhasesRail({ id, headline, items, vignettes }: Props) {
  const Vig = vignettes === "phases" ? PhaseVignette : PlantVignette;
  const head = (
    <div className="mx-auto max-w-mk px-page">
      <Reveal className="mb-[clamp(28px,3.4vw,48px)] grid grid-cols-12 items-end gap-4 max-mk-sm:mb-[26px]">
        <Display as="h2" size="h2" id="ph-title" className="col-span-9 max-mk-lg:col-span-12">{headline}</Display>
      </Reveal>
    </div>
  );
  return (
    <PinnedRail id={id} headingId="ph-title" head={head}>
      {items.map((x, i) => (
        <li
          key={x.label}
          data-card=""
          tabIndex={0}
          aria-label={`${num(i)} · ${x.label}`}
          className="flex h-[444px] w-[clamp(296px,26vw,372px)] snap-start flex-col overflow-hidden rounded-card border border-[rgba(24,29,25,.06)] bg-white shadow-mk-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink max-mk-sm:h-auto max-mk-sm:w-[min(82vw,320px)]"
        >
          <div className={cn("gsurf relative mx-2 mt-2 h-[236px] flex-none rounded-[20px] max-mk-sm:h-[200px]", TONES[vignettes][i])}>
            <span aria-hidden="true" className="absolute top-4 left-[18px] font-display text-[96px] leading-[.8] font-medium tracking-[-0.06em] text-ink tabular-nums">{num(i)}</span>
            <div aria-hidden="true" className="ef-ui absolute inset-x-0 top-28 mx-auto w-[min(calc(100%-28px),292px)]">
              <Vig i={i} />
            </div>
          </div>
          <div className="px-[22px] pt-5 pb-[22px]">
            <span className="flex items-baseline gap-3 text-[13px] leading-[1.3] font-semibold tracking-[.09em] uppercase">
              <span className="text-text-3 tabular-nums">{num(i)}</span>
              <span className="text-text-2">{x.label}</span>
            </span>
            <h3 className="mt-2.5 font-display text-[clamp(21px,1.65vw,25px)] leading-[1.15] font-medium tracking-[-0.02em] [font-stretch:100%] [text-wrap:balance]">{x.title}</h3>
            <p className="mt-2 text-[15px] leading-[1.5] text-text-2">{x.short || x.body || ""}</p>
          </div>
        </li>
      ))}
    </PinnedRail>
  );
}
