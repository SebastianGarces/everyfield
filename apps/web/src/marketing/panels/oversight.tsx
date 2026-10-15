"use client";

import type { ReactNode } from "react";
import { cn } from "@/components/cn";
import { Icon } from "@/components/Icon";
import { Badge, CardIcon, UiButton, type Status, type Tone } from "@/components/kit/kit";
import { flash, out, P, pop, press, rise, swapOut } from "@/components/motion/curves";
import { St } from "@/components/motion/scene";
import { PanelCard, useTarget } from "../chapters/panel-frame";
import { ICONS } from "../icons";
import { OV_GROUPS, OV_MAIL, OV_ROWS } from "../scene-data";
import { Count, Done, Fade, Field, Hl, INSIGHT_FOOTER, INSIGHT_TEXT, INSIGHT_TITLE, InsightMetric, InsightTop, Lab, Move, Swap, Tf, Typed } from "./parts";
import { PanelHead } from "./intelligence";
import { ScopeChip } from "./network";

// /oversight, "See every plant you send": invite a plant, plants in launch order, plants by sending church, where help
// could matter. Each panel plays once to its end and holds (Revision 25).

const tone = (k: string) => k.replace("tone-", "") as Tone;
const ROW = "flex items-center gap-2.5";
const TITLE = "text-[13.5px] font-semibold";
const SUB = "text-[11.5px] text-text-3";

/* ---------- Invite a plant ---------- */
export function InvitePanel() {
  const t0 = useTarget("t0");
  const sent = (t: number) => out(P(t, 5000, 380));
  return (
    <PanelCard kind="invite" className="min-w-0">
      <PanelHead tone="teal" icon={ICONS.network} title="Invite a plant" sub="Austin Sending Network" />
      <St i={1}>
        <Lab>Planter&apos;s email</Lab>
        <Tf as="div" innerRef={t0} f={(t) => press(t, 1250, 0.03)}>
          <Field fr={(t) => flash(t, 1300, 2800)}>
            <Typed text={OV_MAIL} p={(t) => P(t, 1450, 1200)} className="min-w-0 flex-1" />
          </Field>
        </Tf>
      </St>
      <St i={2} className="mt-3.5 flex items-center justify-between gap-2.5">
        <Swap p={(t) => out(P(t, 3800, 380))} className="min-w-0 text-[12.5px]" a={<span className="text-text-3">The planter connects in a few clicks.</span>} b={<span className="text-text-3">Invite sent to Priya Shah</span>} />
        <Done target="t1" at={3600} label="Send invite" done="Invite sent" />
      </St>
      <St i={3} className="mt-[18px] border-t border-line pt-3 text-[12px] font-semibold text-text-2">Your plants</St>
      <div>
        <St i={4} className={cn(ROW, "relative isolate gap-3 py-2.5")}>
          <CardIcon tone="green" icon={ICONS.pin} size={32} glyph={15} />
          <Plant name="Harvest Point Church" sub="Hyde Park, Austin" />
          <Badge status="positive" size="sm">Connected</Badge>
        </St>
        <Move f={(t) => rise(t, 4100)} className={cn(ROW, "relative isolate gap-3 border-t border-line py-2.5 opacity-0")}>
          <CardIcon tone="blue" icon={ICONS.pin} size={32} glyph={15} />
          <Plant name="Eastside Commons" sub="Priya Shah · East Austin" />
          <span className="inline-grid min-w-0 justify-items-end">
            <Move as="span" f={(t) => swapOut(sent(t))} className="col-start-1 row-start-1 grid min-w-0"><Badge status="unknown" size="sm">Invited</Badge></Move>
            <Move as="span" f={(t) => pop(t, 5000)} className="col-start-1 row-start-1 grid min-w-0 opacity-0"><Badge status="positive" size="sm">Connected</Badge></Move>
          </span>
        </Move>
      </div>
    </PanelCard>
  );
}
function Plant({ name, sub }: { name: string; sub: string }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="text-[14px] font-semibold">{name}</div>
      <div className="mt-0.5 text-[12.5px] text-text-3">{sub}</div>
    </div>
  );
}

/* ---------- Plants in launch order; Austin is selected and the rest dim ---------- */
const OV_AREAS = [["All", 14], ["Austin", 5], ["San Antonio", 3]] as const;
export function PlantsPanel() {
  const p = (t: number) => out(P(t, 2150, 300));
  const on = [(t: number) => 1 - p(t), p, () => 0];
  return (
    <PanelCard kind="plants" className="min-w-0">
      <PanelHead tone="teal" icon={ICONS.network} title="Plants" sub="Austin Sending Network · in launch order" />
      <St i={1} className="mb-3 flex flex-wrap gap-1.5">
        {OV_AREAS.map((c, i) => <ScopeChip key={c[0]} label={c[0]} n={c[1]} on={on[i]!} target={i === 1 ? "t0" : undefined} pressAt={i === 1 ? 2100 : undefined} />)}
      </St>
      <div className="mt-3">
        {OV_ROWS.map((r, k) => (
          <Move
            key={r[0]}
            f={(t) => { const q = out(P(t, 300 + k * 110, 480)); return [0, (1 - q) * 12, 1, q * (1 - 0.66 * (r[1] ? 0 : out(P(t, 2250, 400))))]; }}
            className={cn(ROW, "py-2.5 opacity-0", k > 0 && "border-t border-line")}
          >
            <CardIcon tone={tone(r[2])} icon={ICONS.pin} size={32} glyph={15} />
            <div className="min-w-0 flex-1">
              <div className={cn(TITLE, "truncate")}>{r[0]}</div>
              <div className="mt-0.5 text-[12.5px] text-text-3">{r[3]}{r[4] ? " · " + r[4] + " adults" : ""}</div>
            </div>
            <When date={r[5]} note={r[6]} />
          </Move>
        ))}
      </div>
    </PanelCard>
  );
}
function When({ date, note }: { date: string; note: string }) {
  return (
    <div className="flex flex-col items-end gap-0.5 text-[12.5px] whitespace-nowrap">
      <b>{date}</b>
      <span className={cn(SUB, "max-mk-sm:hidden")}>{note}</span>
    </div>
  );
}

/* ---------- Plants by sending church ---------- */
export function SendersPanel() {
  let pc = 0;
  return (
    <PanelCard kind="senders" className="min-w-0">
      <PanelHead tone="teal" icon={ICONS.network} title="Sending churches" sub="Austin Sending Network · 3 churches, 5 plants" />
      <div className="grid gap-2">
        {OV_GROUPS.map((g, k) => (
          <Group key={g[0]} k={k}>
            {k === 0 ? <Hl a={2250} b={1e9} box="inset-0 bg-green-50 shadow-[inset_0_0_0_1.5px_rgba(15,126,60,.3)]" /> : null}
            <div className={ROW}>
              <CardIcon tone={tone(g[1])} icon={ICONS.heart} size={30} glyph={14} />
              <div className="min-w-0 flex-1">
                <div className={TITLE}>{g[0]}</div>
                <div className={cn(SUB, "mt-px")}>{g[2]}</div>
              </div>
              <span className="text-[12px] whitespace-nowrap text-text-2">
                <b className="mr-[3px] font-display text-[18px] font-medium text-ink"><Count value={(t) => g[3].length * out(P(t, 450 + k * 160, 700))} max={g[3].length} /></b>
                plant{g[3].length > 1 ? "s" : ""}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {g[3].map((p) => {
                const n = pc++;
                return (
                  <Fade key={p[0]} f={(t) => out(P(t, 800 + n * 70, 360))} className={PILL}>
                    <i className={cn("size-1.5 rounded-full", p[1] < 2 ? "bg-blue-500" : "bg-green-500")} />
                    {p[0]}
                  </Fade>
                );
              })}
            </div>
            <div className="mt-2 flex items-center justify-between gap-2 text-[12px] text-text-3">
              <span>{g[4]}</span>
              <Badge status={g[5][0] as Status} size="sm">{g[5][1]}</Badge>
            </div>
          </Group>
        ))}
      </div>
    </PanelCard>
  );
}
/** A plant pill with its phase dot (blue before the core group is formed, green after). */
export const PILL = "inline-flex h-[22px] items-center gap-1.5 rounded-full bg-surface-2 pr-[9px] pl-2 text-[11.5px] font-medium whitespace-nowrap text-ink-2 opacity-0 will-change-[opacity]";
function Group({ k, children }: { k: number; children: ReactNode }) {
  const ref = useTarget(k === 0 ? "t0" : "g" + k);
  return (
    <Tf as="div" innerRef={ref} f={(t) => (k === 0 ? press(t, 2250, 0.03) : "none")} className="relative isolate">
      <Move f={(t) => rise(t, 250 + k * 160)} className="relative isolate rounded-[14px] px-3 pt-2.5 pb-[11px] opacity-0 shadow-[inset_0_0_0_1px_var(--color-line)]">
        {children}
      </Move>
    </Tf>
  );
}

/* ---------- Where help could matter ---------- */
export function HelpPanel() {
  const ref = useTarget("t0");
  return (
    <PanelCard kind="help" variant={{ kind: "insight", tone: "sky" }} className="min-w-0">
      <InsightTop i={0} icon={ICONS.compass} label="Where help could matter" count="Eastside Commons" />
      <InsightMetric i={1} num={<Count value={(t) => 205 * out(P(t, 300, 1100))} max={205} />} unit="days to launch Sunday" unitMax={150} />
      <St i={2} className={INSIGHT_TITLE}>Two leader roles are open, 205 days before launch</St>
      <St i={3} className={cn(INSIGHT_TEXT, "mt-2.5")}>Kids and Production have no leader yet. From Ministry teams and findings.</St>
      <St i={4} className={INSIGHT_FOOTER}>
        <Tf innerRef={ref} f={(t) => press(t, 2400)} className="inline-flex">
          <UiButton variant="light">
            <Swap
              p={(t) => out(P(t, 2550, 380))}
              a={<span className="inline-flex items-center gap-1.5">Offer help <Icon icon={ICONS.arrow} size={15} /></span>}
              b={<span className="inline-flex items-center gap-1.5"><Icon icon={ICONS.check} size={15} />Help offered</span>}
            />
          </UiButton>
        </Tf>
        <UiButton variant="glass">Later</UiButton>
      </St>
    </PanelCard>
  );
}

