import type { CSSProperties } from "react";
import { cn } from "@/components/cn";
import { Icon } from "@/components/Icon";
import { Badge, UiButton, type Status } from "@/components/kit/kit";
import { Count, Fade, Hl, Move, Target, Tf } from "@/components/motion/fx";
import { St } from "@/components/motion/scene";
import { PanelCard } from "../chapters/panel-frame";
import { SD_AREAS, SD_PIPE, SD_SCOPES } from "../demo-data";
import { ICONS, type IconName } from "../icons";
import { NetworkFx, Wipe } from "./network-fx";
import { INSIGHT_FOOTER, INSIGHT_TEXT, INSIGHT_TITLE, InsightMetric, InsightTop, Num, PanelHead } from "./parts";

// The sending section (home) and Network Intelligence (/oversight): scope, pipeline, lenses, the top finding. Markup renders
// on the server; the timing is in network-fx.tsx.

/** A scope chip; the dark "selected" copy fades in over it (on: its opacity, by chip index i). A pressed chip is a cursor
 *  target with a press (press: its transform). */
export function ScopeChip({ label, n, i, on, press, target }: { label: string; n: number; i: number; on: string; press?: string; target?: "t0" | "t1" }) {
  const inner = (
    <>
      {label} <b className="font-semibold tabular-nums">{n}</b>
    </>
  );
  const item = "col-start-1 row-start-1 inline-flex items-center gap-1.5 rounded-full px-[11px]";
  const body = (
    <>
      <span className={cn(item, "[&>b]:text-ink")}>{inner}</span>
      <Fade fx={on} n={i} className={cn(item, "bg-ink text-cream opacity-0 will-change-[opacity] [&>b]:text-cream")}>{inner}</Fade>
    </>
  );
  const chip = "relative inline-grid h-[30px] rounded-full bg-surface text-[12.5px] font-medium whitespace-nowrap text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line-2)] will-change-transform";
  return press === undefined ? (
    <span className={chip}>{body}</span>
  ) : (
    <Tf fx={press} n={i} target={target} className={chip}>{body}</Tf>
  );
}

/* ---------- Scope: counts rise, then All plants → Texas → Greater Austin, and every number follows ---------- */
const STATS = ["Plants", "With findings", "Launching in 12 months"] as const;

export function ScopePanel() {
  return (
    <NetworkFx>
      <PanelCard kind="scope">
        <PanelHead tone="teal" icon={ICONS.network} title="Austin Sending Network" sub="Network Intelligence" />
        <St i={1} className="mb-3 flex flex-wrap gap-1.5">
          {SD_SCOPES.map((c, i) => (
            <ScopeChip key={c[0]} label={c[0]} n={c[1]} i={i} on="scope.on" press={i ? "scope.press" : undefined} target={i ? (i === 1 ? "t0" : "t1") : undefined} />
          ))}
        </St>
        <St i={2} className="grid grid-cols-3 gap-2">
          {STATS.map((l, k) => (
            <div key={l} className="min-w-0 rounded-[14px] bg-white px-3 pt-2.5 pb-[11px] shadow-[inset_0_0_0_1px_var(--color-line)] max-mk-sm:px-2.5 max-mk-sm:pt-[9px] max-mk-sm:pb-2.5">
              <Num className="block text-[26px] leading-none max-mk-sm:text-[22px]"><Count fx="scope.stat" n={k} max={SD_SCOPES[0][(k + 1) as 1 | 2 | 3]} /></Num>
              <small className="mt-1.5 block text-[11.5px] leading-[1.25] text-text-3">{l}</small>
            </div>
          ))}
        </St>
        <St i={3} className="mt-3">
          <div className={cn(AREA_GRID, "pb-1.5 text-[11.5px] text-text-3")}>
            <span>By area</span>
            <span className="justify-self-end text-right">Plants</span>
            <span className="justify-self-end text-right">Momentum</span>
          </div>
          {SD_AREAS.map((a, k) => (
            <Fade key={a[0]} as="div" fx="scope.area" n={k} className={cn(AREA_GRID, "relative isolate border-t border-line py-[7px] text-[13px] will-change-[opacity]")}>
              <b className="truncate font-semibold">{a[0]}</b>
              <span className="justify-self-end text-right text-text-2 tabular-nums">{a[1]}</span>
              <span className="justify-self-end text-right"><Badge status={a[2] as Status} size="sm">{a[3]}</Badge></span>
              {k ? null : <Hl a={3050} b={1e9} />}
            </Fade>
          ))}
        </St>
      </PanelCard>
    </NetworkFx>
  );
}
const AREA_GRID = "grid grid-cols-[minmax(0,1fr)_44px_78px] items-center gap-2 max-mk-sm:grid-cols-[minmax(0,1fr)_38px_70px]";

/* ---------- Plants by phase, typical weeks (on /oversight "pipeline" means the leader pipeline) ---------- */
const PIPE_ROW = "relative isolate grid h-[34px] grid-cols-[92px_minmax(0,1fr)_16px_40px] items-center gap-2.5 text-[12.5px] max-mk-sm:grid-cols-[84px_minmax(0,1fr)_14px_36px] max-mk-sm:gap-2";
export function PipePanel() {
  return (
    <NetworkFx>
      <PanelCard kind="pipe">
        <PanelHead tone="violet" icon={ICONS.calendar} title="Plants by phase" sub="Plants in each phase, and typical weeks in it" />
        <St i={1}>
          {SD_PIPE.map((r, k) => {
            const cells = (
              <>
                {k === 1 ? <Hl a={2450} b={1e9} /> : null}
                <b className="font-semibold whitespace-nowrap">{r[0]}</b>
                <span className="relative h-3.5 overflow-hidden rounded-full bg-surface-2">
                  <Tf as="i" fx="pipe.bar" n={k} className="absolute inset-0 origin-left rounded-full bg-[color-mix(in_srgb,var(--color-violet-500)_62%,var(--color-white))]" />
                </span>
                <span className="justify-self-end font-display font-semibold tracking-[-0.03em] whitespace-nowrap"><Count fx="pipe.count" n={k} max={Math.max(1, r[1])} /></span>
                <Fade fx="pipe.wk" n={k} className="text-right text-[11.5px] whitespace-nowrap text-text-3 opacity-0 will-change-[opacity]">{r[1] ? r[2] : "none"}</Fade>
              </>
            );
            return k === 1 ? <Target key={r[0]} name="t0" as="div" className={PIPE_ROW}>{cells}</Target> : <div key={r[0]} className={PIPE_ROW}>{cells}</div>;
          })}
        </St>
        <St i={2} className="mt-3 flex items-center justify-between gap-2.5 rounded-[14px] bg-surface-2 px-3.5 py-[11px] text-[13px] font-semibold">
          <span>Launches in the next 12 months</span>
          <Num className="text-[22px] leading-none font-medium"><Count fx="pipe.launch" max={5} /></Num>
        </St>
      </PanelCard>
    </NetworkFx>
  );
}

/* ---------- Lenses: three lenses fill in, one opens to its plants ---------- */
const LENSES = [["Emerging leadership", "compass", "magenta", "risk", "Concern", [5, 2, 4]], ["Vision casting", "sparkle", "green", "positive", "Strong", [8, 3, 0]], ["Core group cohesion", "users", "amber", "attention", "Watch", [5, 3, 3]]] as const;
const LENS_PLANTS = [["Eastside Commons", "Training · Greater Austin", "2 leader roles open"], ["Deep Ellum Collective", "Pre-launch · Dallas–Fort Worth", "3 leader roles open"], ["Lakewood Church Dallas", "Pre-launch · Dallas–Fort Worth", "Worship leader open"]] as const;
const DOTS = ["var(--color-green-500)", "var(--color-amber-500)", "var(--color-magenta-500)"] as const;
const LI_TONE = { magenta: "bg-magenta-100 text-magenta-600", green: "bg-green-100 text-green-700", amber: "bg-amber-100 text-amber-600" } as const;

export function LensPanel() {
  return (
    <NetworkFx>
      <PanelCard kind="lens">
        <PanelHead tone="amber" icon={ICONS.eye} title="Network lenses" sub="Across 11 plants with findings" />
        <div className="grid gap-2">
          {LENSES.map((l, i) => (
            <St key={l[0]} i={i + 1} className="flex min-w-0 flex-col gap-2 rounded-[14px] bg-white px-3.5 py-[13px] shadow-[inset_0_0_0_1px_var(--color-line)]">
              <div className="flex items-center gap-2">
                <span className={cn("grid size-7 flex-none place-items-center rounded-full", LI_TONE[l[2]])}><Icon icon={ICONS[l[1] as IconName]} /></span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{l[0]}</span>
                <Badge status={l[3]} size="sm">{l[4]}</Badge>
                {i ? null : (
                  <Tf fx="lens.press" target="t0" className="grid size-7 flex-none place-items-center rounded-[9px] bg-surface-2 text-ink-2">
                    <Icon icon={ICONS.arrow} className="-rotate-45" />
                  </Tf>
                )}
              </div>
              <Wipe fx="lens.wipe" n={i}>
                {l[5].map((v, k) => (v ? <span key={k} className="min-w-0" style={{ flex: v, background: DOTS[k] }} /> : null))}
              </Wipe>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-text-3">
                {(["Strong", "Watch", "Concern"] as const).map((w, k) => (
                  <span key={w} className="inline-flex items-center gap-[5px] whitespace-nowrap before:size-[7px] before:rounded-full before:bg-[var(--dot)] before:content-['']" style={{ "--dot": DOTS[k] } as CSSProperties}>
                    {l[5][k]} {w}
                  </span>
                ))}
              </div>
            </St>
          ))}
        </div>
        <Move fx="lens.sheet" className="absolute right-3 bottom-3 left-3 z-6 rounded-2xl bg-white px-3.5 pt-3 pb-1.5 opacity-0 shadow-mk-sheet">
          <div className="flex items-center justify-between gap-2 pb-1.5 text-[13px] font-semibold">
            <span>Emerging leadership</span>
            <Badge status="risk" size="sm">4 at Concern</Badge>
          </div>
          {LENS_PLANTS.map((r, k) => (
            <Move key={r[0]} fx="lens.plant" n={k} className="flex items-center gap-2.5 border-t border-line py-2 opacity-0">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold">{r[0]}</div>
                <div className="mt-0.5 truncate text-[11.5px] text-text-3">{r[1]}</div>
              </div>
              <span className="text-[12px] text-text-3">{r[2]}</span>
            </Move>
          ))}
        </Move>
      </PanelCard>
    </NetworkFx>
  );
}

/* ---------- The top network finding ---------- */
export function TopPanel() {
  return (
    <NetworkFx>
      <PanelCard kind="top" variant={{ kind: "insight", tone: "lilac" }}>
        <InsightTop i={0} icon={ICONS.sparkle} label="Top network finding" count="From 11 of 14 plants" />
        <InsightMetric i={1} num={<Count fx="top.n" max={4} unit=" of 5" />} unit="plants within a year of launch have a Concern on Emerging leadership" numClassName="max-mk-sm:text-[44px]" />
        <St i={2} className={INSIGHT_TITLE}>Emerging leadership is the most common gap before launch</St>
        <St i={3} className={cn(INSIGHT_TEXT, "mt-2.5")}>It is the lens most often at Watch or Concern for plants in Training and Pre-launch.</St>
        <St i={4} className={INSIGHT_FOOTER}>
          <Tf fx="top.press" target="t0" className="inline-flex" layer={false}>
            <UiButton variant="light">See the plants <Icon icon={ICONS.arrow} /></UiButton>
          </Tf>
        </St>
      </PanelCard>
    </NetworkFx>
  );
}
