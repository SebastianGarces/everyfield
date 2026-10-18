import { cn } from "@/components/cn";
import { Icon } from "@/components/Icon";
import { Badge, UiButton } from "@/components/kit/kit";
import { Count, Hl, Move, Target, Tf } from "@/components/motion/fx";
import { St } from "@/components/motion/scene";
import { PanelCard } from "../chapters/panel-frame";
import { ICONS } from "../icons";
import { INSIGHT_FOOTER, INSIGHT_TEXT, INSIGHT_TITLE, InsightMetric, InsightTop, Num, PanelHead } from "../panels/parts";
import { HomeFx } from "./fx";

// Home-only Plant Intelligence panels. The Monday overview keeps the vision meeting focus, so this focus card
// names a different thing to do first: four people interviewed more than 5 weeks ago with no commitment recorded. It uses
// only interview dates and commitment state; interview judgments never reach Plant Intelligence (REQ-PI-007).

const FOCUS_FACTS = [["Interviewed, not committed", "14"], ["Interviewed 3+ weeks ago", "7"], ["Interviewed 5+ weeks ago", "4"]] as const;

export function FocusPanel({ title }: { title: string }) {
  return (
    <HomeFx>
      <PanelCard kind="focus" variant={{ kind: "insight", tone: "dawn" }}>
        <InsightTop i={0} icon={ICONS.compass} label="Focus this week" count="Plant Intelligence" />
        <InsightMetric i={1} num={<Count fx="focus.n" max={4} />} unit="people interviewed 5+ weeks ago have not committed" />
        <St i={2}>
          <div className="relative mt-4 h-2 rounded-full bg-mk-ink-12">
            <span className="absolute inset-0 overflow-hidden rounded-full">
              <Tf fx="focus.fill" className="absolute inset-0 rounded-full bg-ink" />
            </span>
            <span className="absolute -top-[5px] right-[5%] -bottom-[5px] w-0.5 rounded-[2px] bg-ink" />
          </div>
          <div className="relative mt-2 flex h-4 justify-between text-[12px] text-[var(--on-3)]">
            <span className="whitespace-nowrap">Core group 34</span>
            <span className="whitespace-nowrap">38 if all 4 commit</span>
          </div>
        </St>
        <St i={3} className={INSIGHT_TITLE}>{title}</St>
        <St i={4} className="mt-2.5 grid">
          <Move fx="focus.text" className={cn(INSIGHT_TEXT, "col-start-1 row-start-1")}>
            No commitment is on record for any of them yet.
          </Move>
          <div className="col-start-1 row-start-1">
            {FOCUS_FACTS.map((f, k) => (
              <Move key={f[0]} fx="focus.fact" n={k} className={cn("flex justify-between gap-2.5 py-1.5 text-[13px] text-[var(--on-2)] opacity-0", k > 0 && "border-t border-mk-ink-10")}>
                <span>{f[0]}</span>
                <b className="font-semibold text-[var(--on)]">{f[1]}</b>
              </Move>
            ))}
          </div>
        </St>
        <St i={5} className={INSIGHT_FOOTER}>
          <Tf fx="focus.press" target="t0" className="inline-flex" layer={false}>
            <UiButton variant="light">See the facts <Icon icon={ICONS.arrow} /></UiButton>
          </Tf>
          <UiButton variant="glass">Why this?</UiButton>
        </St>
      </PanelCard>
    </HomeFx>
  );
}

/* Phase 1 exit benchmarks of the demo plant (PI-028): four met, the financial base still open. */
const BENCH = [
  ["Committed adults", "34, 30 needed"],
  ["New adults, last 28 days", "9"],
  ["Worship leader", "Maria Santos"],
  ["Community chosen", "Hyde Park"],
  ["Financial base", "Not yet"],
] as const;

export function ReadinessPanel() {
  return (
    <HomeFx>
      <PanelCard kind="readiness">
        <PanelHead tone="green" icon={ICONS.flag} title="Phase 1 benchmarks" sub="Core Group Development · Harvest Point" />
        <St i={1} className="flex items-end gap-3 pb-3">
          <Num className="text-[44px] leading-[.95]"><Count fx="ready.met" max={4} /></Num>
          <span className="pb-1 text-[13px] leading-[1.3] text-text-3">of 5 met</span>
        </St>
        {BENCH.map((r, k) => {
          const open = k === BENCH.length - 1;
          return (
            <St key={r[0]} i={k + 2} className="relative isolate flex items-center gap-2.5 border-t border-line py-[9px] text-[13px]">
              {open ? <><Hl a={2350} b={5400} R="ready.R" /><Target name="t0" className="absolute inset-0" /></> : null}
              {open ? (
                <span className="size-5 flex-none rounded-full shadow-[inset_0_0_0_1.5px_var(--color-line-2)]" />
              ) : (
                <Move as="span" fx="ready.check" n={k} className="grid size-5 flex-none place-items-center rounded-full bg-green-500 text-ink opacity-0">
                  <Icon icon={ICONS.check} size={12} className="[&_path]:[stroke-width:2.6]" />
                </Move>
              )}
              <span className="min-w-0 flex-1 truncate">{r[0]}</span>
              <span className="text-text-3">{r[1]}</span>
              <Badge status={open ? "attention" : "positive"} size="sm">{open ? "Not met" : "Met"}</Badge>
            </St>
          );
        })}
        <St i={7} className="mt-3 flex flex-wrap gap-2">
          <UiButton variant="ghost">Stay in Phase 1</UiButton>
          <UiButton variant="ghost">Move to Phase 2</UiButton>
        </St>
      </PanelCard>
    </HomeFx>
  );
}
