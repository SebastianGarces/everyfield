import type { ReactNode } from "react";
import { cn } from "@/components/cn";
import { Icon } from "@/components/Icon";
import { Badge, CardIcon, UiButton, type Status, type Tone } from "@/components/kit/kit";
import { Count, Done, Fade, Field, Hl, Move, Swap, Tf, Typed } from "@/components/motion/fx";
import { St } from "@/components/motion/scene";
import { PanelCard } from "../chapters/panel-frame";
import { OV_GROUPS, OV_MAIL, OV_ROWS } from "../demo-data";
import { ICONS } from "../icons";
import { ScopeChip } from "./network";
import { OversightFx } from "./oversight-fx";
import { INSIGHT_FOOTER, INSIGHT_TEXT, INSIGHT_TITLE, InsightMetric, InsightTop, Lab, PanelHead } from "./parts";

// /oversight, "See every plant you send": invite a plant, plants in launch order, plants by sending church, where help
// could matter. Markup renders on the server; the timing is in oversight-fx.tsx.

const tone = (k: string) => k.replace("tone-", "") as Tone;
const ROW = "flex items-center gap-2.5";
const TITLE = "text-[13.5px] font-semibold";
const SUB = "text-[11.5px] text-text-3";

/* ---------- Invite a plant ---------- */
export function InvitePanel() {
  return (
    <OversightFx>
      <PanelCard kind="invite" className="min-w-0">
        <PanelHead tone="teal" icon={ICONS.network} title="Invite a plant" sub="Austin Sending Network" />
        <St i={1}>
          <Lab>Planter&apos;s email</Lab>
          <Tf as="div" fx="invite.press" target="t0" layer={false}>
            <Field fx="invite.focus">
              <Typed text={OV_MAIL} fx="invite.type" className="min-w-0 flex-1" />
            </Field>
          </Tf>
        </St>
        <St i={2} className="mt-3.5 flex items-center justify-between gap-2.5">
          <Swap fx="invite.swap" className="min-w-0 text-[12.5px]" a={<span className="text-text-3">The planter connects in a few clicks.</span>} b={<span className="text-text-3">Invite sent to Priya Shah</span>} />
          <Done target="t1" at={3600} label="Send invite" done="Invite sent" />
        </St>
        <St i={3} className="mt-[18px] border-t border-line pt-3 text-[12px] font-semibold text-text-2">Your plants</St>
        <div>
          <St i={4} className={cn(ROW, "relative isolate gap-3 py-2.5")}>
            <CardIcon tone="green" icon={ICONS.pin} size={32} glyph={15} />
            <Plant name="Harvest Point Church" sub="Hyde Park, Austin" />
            <Badge status="positive" size="sm">Connected</Badge>
          </St>
          <Move fx="invite.row" className={cn(ROW, "relative isolate gap-3 border-t border-line py-2.5 opacity-0")}>
            <CardIcon tone="blue" icon={ICONS.pin} size={32} glyph={15} />
            <Plant name="Eastside Commons" sub="Priya Shah · East Austin" />
            <span className="inline-grid min-w-0 justify-items-end">
              <Move as="span" fx="invite.invited" className="col-start-1 row-start-1 grid min-w-0"><Badge status="unknown" size="sm">Invited</Badge></Move>
              <Move as="span" fx="invite.connected" className="col-start-1 row-start-1 grid min-w-0 opacity-0"><Badge status="positive" size="sm">Connected</Badge></Move>
            </span>
          </Move>
        </div>
      </PanelCard>
    </OversightFx>
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
  return (
    <OversightFx>
      <PanelCard kind="plants" className="min-w-0">
        <PanelHead tone="teal" icon={ICONS.network} title="Plants" sub="Austin Sending Network · in launch order" />
        <St i={1} className="mb-3 flex flex-wrap gap-1.5">
          {OV_AREAS.map((c, i) => <ScopeChip key={c[0]} label={c[0]} n={c[1]} i={i} on="plants.on" press={i === 1 ? "plants.press" : undefined} target={i === 1 ? "t0" : undefined} />)}
        </St>
        <div className="mt-3">
          {OV_ROWS.map((r, k) => (
            <Move key={r[0]} fx="plants.row" n={k} className={cn(ROW, "py-2.5 opacity-0", k > 0 && "border-t border-line")}>
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
    </OversightFx>
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
    <OversightFx>
      <PanelCard kind="senders" className="min-w-0">
        <PanelHead tone="teal" icon={ICONS.network} title="Sending churches" sub="Austin Sending Network · 3 churches, 5 plants" />
        <div className="grid gap-2">
          {OV_GROUPS.map((g, k) => (
            <Group key={g[0]} k={k}>
              {k === 0 ? <Hl a={2250} b={1e9} box="inset-0 bg-green-50 shadow-mk-group-on" /> : null}
              <div className={ROW}>
                <CardIcon tone={tone(g[1])} icon={ICONS.heart} size={30} glyph={14} />
                <div className="min-w-0 flex-1">
                  <div className={TITLE}>{g[0]}</div>
                  <div className={cn(SUB, "mt-px")}>{g[2]}</div>
                </div>
                <span className="text-[12px] whitespace-nowrap text-text-2">
                  <b className="mr-[3px] font-display text-[18px] font-medium text-ink"><Count fx="senders.count" n={k} max={g[3].length} /></b>
                  plant{g[3].length > 1 ? "s" : ""}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {g[3].map((p) => (
                  <Fade key={p[0]} fx="senders.pill" n={pc++} className={PILL}>
                    <i className={cn("size-1.5 rounded-full", p[1] < 2 ? "bg-blue-500" : "bg-green-500")} />
                    {p[0]}
                  </Fade>
                ))}
              </div>
              <div className="mt-2 flex items-center justify-between gap-2 text-[12px] text-text-3">
                <span>{g[4]}</span>
                <Badge status={g[5][0] as Status} size="sm">{g[5][1]}</Badge>
              </div>
            </Group>
          ))}
        </div>
      </PanelCard>
    </OversightFx>
  );
}
/** A plant pill with its phase dot (blue before the core group is formed, green after). */
const PILL = "inline-flex h-[22px] items-center gap-1.5 rounded-full bg-surface-2 pr-[9px] pl-2 text-[11.5px] font-medium whitespace-nowrap text-ink-2 opacity-0 will-change-[opacity]";
function Group({ k, children }: { k: number; children: ReactNode }) {
  return (
    <Tf as="div" fx="senders.press" n={k} target={k === 0 ? "t0" : "g" + k} className="relative isolate">
      <Move fx="senders.rise" n={k} className="relative isolate rounded-[14px] px-3 pt-2.5 pb-[11px] opacity-0 shadow-[inset_0_0_0_1px_var(--color-line)]">
        {children}
      </Move>
    </Tf>
  );
}

/* ---------- Where help could matter ---------- */
export function HelpPanel() {
  return (
    <OversightFx>
      <PanelCard kind="help" variant={{ kind: "insight", tone: "sky" }} className="min-w-0">
        <InsightTop i={0} icon={ICONS.compass} label="Where help could matter" count="Eastside Commons" />
        <InsightMetric i={1} num={<Count fx="help.days" max={205} />} unit="days to launch Sunday" unitMax={150} />
        <St i={2} className={INSIGHT_TITLE}>Two leader roles are open, 205 days before launch</St>
        <St i={3} className={cn(INSIGHT_TEXT, "mt-2.5")}>Kids and Production have no leader yet. From Ministry teams and findings.</St>
        <St i={4} className={INSIGHT_FOOTER}>
          <Tf fx="help.press" target="t0" className="inline-flex" layer={false}>
            <UiButton variant="light">
              <Swap
                fx="help.swap"
                a={<span className="inline-flex items-center gap-1.5">Offer help <Icon icon={ICONS.arrow} /></span>}
                b={<span className="inline-flex items-center gap-1.5"><Icon icon={ICONS.check} />Help offered</span>}
              />
            </UiButton>
          </Tf>
          <UiButton variant="glass">Later</UiButton>
        </St>
      </PanelCard>
    </OversightFx>
  );
}
