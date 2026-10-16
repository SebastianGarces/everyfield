import type { IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/components/cn";
import { Display } from "@/components/Display";
import { Icon } from "@/components/Icon";
import { CardIcon, NUM, StageChip, type Tone } from "@/components/kit/kit";
import { Count, Move, Tf } from "@/components/motion/fx";
import { Reveal } from "@/components/motion/Reveal";
import { ICONS } from "../icons";
import { SectionHead } from "../sections/SectionHead";
import { MondayOverview } from "../visuals/MondayOverview";
import { VisionScene } from "../visuals/vision-fx";
import { TASKS, VisionZoom } from "../visuals/VisionZoom";
import { PROTO_COPY } from "./variants";

// R6 prototypes B and C: the vision zoom and the Monday overview in one section.

/** B: one head, the zoom beside it, and the zoom's line runs on down into the Monday overview. */
export function VisionMondaySection({ caption }: { caption?: string }) {
  const c = PROTO_COPY.b;
  return (
    <section id="vision" aria-labelledby="vision-title" className="relative py-section">
      <div className="mx-auto max-w-mk px-page">
        <div className="grid grid-cols-[minmax(0,5fr)_minmax(0,6fr)] items-center gap-x-[clamp(36px,5vw,88px)] gap-y-9 max-mk-cx:grid-cols-[minmax(0,1fr)]">
          <Reveal className="max-w-[540px] max-mk-cx:mx-auto max-mk-cx:max-w-[640px] max-mk-cx:text-center">
            <Display as="h2" size="h2" id="vision-title">{c.headline}</Display>
            <p className="mt-5 text-[clamp(17px,1.3vw,19px)] leading-[1.55] text-pretty text-text-2">{c.body}</p>
          </Reveal>
          <VisionZoom />
          {/* The bridge: the green line of the zoom continues down to Monday. */}
          <Reveal className="col-start-2 -my-9 flex flex-col items-center max-mk-cx:col-start-1">
            <i aria-hidden="true" className="h-[clamp(28px,4vw,44px)] w-0.5 rounded-full bg-green-600" />
            <p className="m-0 inline-flex h-9 items-center gap-2 rounded-full bg-surface px-4 text-[14px] font-semibold text-ink shadow-mk-chip">
              <Icon icon={ICONS.calendar} size={16} className="text-green-700" />
              {c.bridge}
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

/** C: the Monday overview with the plan as a band above its cards: Launch Sunday, the phase, a launch milestone, this week. */
export function MondayPlanSection({ caption }: { caption?: string }) {
  const c = PROTO_COPY.c;
  return (
    <section id="proof" className="relative py-section">
      <span id="vision" aria-hidden="true" className="absolute top-0" />
      <div className="mx-auto max-w-mk px-page">
        <SectionHead headline={c.headline} body={c.body} className="mb-[clamp(36px,5vw,64px)]" />
        <figure className="relative m-0 min-w-0">
          <MondayOverview plan={<PlanBand />} />
          {caption ? <figcaption className="mt-3.5 text-[14px] text-text-3">{caption}</figcaption> : null}
        </figure>
      </div>
    </section>
  );
}

const TILE = "relative flex min-w-0 flex-col rounded-[22px] border border-[color:var(--ef-card-edge)] bg-surface px-[18px] py-4 shadow-card";
const LABEL = "text-[12.5px] leading-[1.3] text-text-3";
const VALUE = "mt-0.5 text-[15px] leading-[1.3] font-semibold text-ink";

function Tile({ n, tone, icon, label, value, children, className }: { n: number; tone: Tone; icon: IconSvgElement; label: string; value: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <Move fx="plan.card" n={n} className={cn(TILE, className)}>
      {n > 0 && n < 3 ? <Tf fx="plan.link" n={n} as="i" layer={false} className="pointer-events-none absolute top-[35px] -left-[13px] h-0.5 w-3 origin-left rounded-full bg-green-600 max-mk-sm:hidden" /> : null}
      <div className="flex items-start gap-3">
        <CardIcon tone={tone} icon={icon} size={36} glyph={17} />
        <div className="min-w-0 flex-1">
          <div className={LABEL}>{label}</div>
          <div className={VALUE}>{value}</div>
        </div>
      </div>
      {children}
    </Move>
  );
}

function Bar({ fx, fill, color }: { fx: string; fill: string; color: string }) {
  return (
    <div aria-hidden="true" className="relative mt-2 h-2 overflow-hidden rounded-full bg-surface-2 shadow-[inset_0_0_0_1px_var(--color-line)]">
      <span className={cn("absolute inset-y-0 left-0 overflow-hidden rounded-full", fill)}>
        <Tf fx={fx} as="span" layer={false} className={cn("absolute inset-0 origin-left rounded-full", color)} />
      </span>
    </div>
  );
}

function PlanBand() {
  return (
    <VisionScene className="mb-4">
      <h3 className="sr-only">The plan, from Launch Sunday to this week</h3>
      <div className="grid grid-cols-3 gap-3 max-mk-sm:grid-cols-1">
        <Tile n={0} tone="green" icon={ICONS.rocket} label="Launch Sunday" value={<span className={cn(NUM, "text-[22px] leading-[1.15]")}>Sun, Mar 14, 2027</span>}>
          <div className="mt-auto pt-3 text-[12.5px] text-text-2">9 launch milestones and 23 preparation tasks</div>
        </Tile>
        <Tile n={1} tone="violet" icon={ICONS.route} label="Phase 1" value="Core Group Development">
          <div className="mt-auto pt-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[12.5px] text-text-3">Benchmark: committed adults</span>
              <span className={cn(NUM, "text-[17px] leading-none")}>
                <Count fx="plan.count" max={34} />
                <span className="ml-1 font-sans text-[12px] font-medium tracking-normal text-text-3">of 50</span>
              </span>
            </div>
            <Bar fx="plan.bar" fill="w-[68%]" color="bg-blue-500" />
          </div>
        </Tile>
        <Tile n={2} tone="green" icon={ICONS.flag} label="Launch milestone" value="Promotion plan chosen">
          <div className="mt-auto pt-3">
            <div className="text-[12.5px] text-text-3">1 of 2 tasks done</div>
            <div aria-hidden="true" className="mt-2 grid grid-cols-2 gap-1.5">
              <span className="relative h-2 overflow-hidden rounded-full bg-surface-2 shadow-[inset_0_0_0_1px_var(--color-line)]">
                <Tf fx="plan.ms" as="span" layer={false} className="absolute inset-0 origin-left rounded-full bg-green-500" />
              </span>
              <span className="h-2 rounded-full bg-surface-2 shadow-[inset_0_0_0_1px_var(--color-line)]" />
            </div>
          </div>
        </Tile>
        <Tile n={3} tone="amber" icon={ICONS.task} label="This week" value="3 tasks for the core group" className="col-span-3 max-mk-sm:col-span-1">
          <ul className="m-0 mt-2 grid list-none grid-cols-3 gap-x-6 p-0 max-mk-cx:grid-cols-1">
            {TASKS.map(([title, , tone, goal], k) => (
              <li key={title} className="border-t border-line">
                <Move fx="plan.task" n={k} className="py-2">
                  <span className="block min-w-0 text-[13px] leading-[1.35] font-semibold text-ink">{title}</span>
                  <span className="mt-1 flex items-center gap-1.5">
                    <Icon icon={ICONS.arrow} size={13} className="flex-none text-text-3" />
                    <span className="sr-only">serves</span>
                    <StageChip tone={tone} className="h-[22px]">{goal}</StageChip>
                  </span>
                </Move>
              </li>
            ))}
          </ul>
        </Tile>
      </div>
    </VisionScene>
  );
}
