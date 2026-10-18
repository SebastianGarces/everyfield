import { cn } from "@/components/cn";
import { Icon } from "@/components/Icon";
import { Av, Badge, UiButton } from "@/components/kit/kit";
import { Count, Done, Hl, MoodBot, Move, Swap, Target, Typed } from "@/components/motion/fx";
import { St } from "@/components/motion/scene";
import { PanelCard } from "../chapters/panel-frame";
import { ICONS } from "../icons";
import { CHIP, KNOB, SWITCH } from "./classes";
import { FactsRing, IntelligenceFx, ShareSwitch } from "./intelligence-fx";
import { Num, PanelHead } from "./parts";

// Plant Intelligence panels: the facts and sharing (the home auto list), and Evry (the home Evry section). The focus and
// readiness panels are in home/panels.tsx. Markup renders on the server; the timing is in intelligence-fx.tsx.

/* ---------- The facts behind the finding ---------- */
const KV = [["New guests, last 2 vision meetings", 24], ["Contacted within 48 hours", 17], ["No contact yet", 7]] as const;
const NAMES = [["JO", "James Okafor"], ["KW", "Kim Wu"], ["SN", "Sara Nunez"]] as const;

export function FactsPanel() {
  return (
    <IntelligenceFx>
      <PanelCard kind="facts">
        <PanelHead tone="amber" icon={ICONS.alert} title="Follow-up is slipping" sub="The facts this finding used" />
        <St i={1} className="flex items-center gap-3.5 pt-1 pb-2.5">
          <svg viewBox="0 0 64 64" aria-hidden="true" className="size-16 flex-none -rotate-90">
            <circle cx="32" cy="32" r="27" className="fill-none stroke-surface-2 stroke-7" />
            <FactsRing />
          </svg>
          <div>
            <Num className="block text-[30px] leading-none"><Count fx="facts.pct" max={71} unit="%" /></Num>
            <div className="text-[13px] text-text-3">of new guests contacted within 48 hours</div>
          </div>
        </St>
        {KV.map((r, k) => (
          <St key={r[0]} i={k + 2} className="relative isolate flex items-center justify-between gap-3 border-t border-line py-[11px]">
            {k === 2 ? <Hl a={1650} b={5800} R="facts.R" /> : null}
            {k === 2 ? <Target name="t0" className="absolute inset-0" /> : null}
            <span className="text-[13px] text-text-2">{r[0]}</span>
            <span className="flex items-center gap-2">
              {k === 2 ? <Badge status="risk" size="sm">Open</Badge> : null}
              <span className="font-display text-[18px] font-medium tracking-[-0.02em] whitespace-nowrap"><Count fx="facts.kv" n={k} max={r[1]} /></span>
            </span>
          </St>
        ))}
        <St i={5} className="mt-2.5 flex h-[30px] flex-nowrap gap-1.5 overflow-hidden">
          {NAMES.map((n, k) => (
            <Move key={n[1]} as="span" fx="facts.name" n={k} className={cn(CHIP, "h-7 flex-none gap-[7px] pr-2.5 pl-1 text-[12px] opacity-0")}>
              <Av small>{n[0]}</Av>
              {n[1]}
            </Move>
          ))}
          <Move as="span" fx="facts.name" n={3} className={cn(CHIP, "h-7 flex-none pr-2.5 pl-2.5 text-[12px] opacity-0")}>4 more</Move>
        </St>
      </PanelCard>
    </IntelligenceFx>
  );
}

/* ---------- A vision meeting in one approval (Evry) ---------- */
export type EvryDemo = {
  q: string;
  a: string;
  review: readonly [string, string];
  meeting: { name: string; when: string; where: string };
  rest: string;
  approve: string;
  edit: string;
};
/** The page passes its example (home/demo.ts). */
export function EvryPanel({ demo }: { demo: EvryDemo }) {
  return (
    <IntelligenceFx>
      <PanelCard kind="evry" variant={{ kind: "evry" }}>
        <St i={0} className="flex items-center gap-2.5 border-b border-line pb-3">
          <MoodBot fx="evry.mood" follow />
          <div className="min-w-0 flex-1">
            <div className="font-display text-[18px] font-medium">Evry</div>
            <div className="text-[12px] text-text-3">Reads and drafts. You approve every change.</div>
          </div>
        </St>
        <St i={1} className="max-w-[86%] self-end rounded-2xl rounded-br-xs bg-ink px-3.5 py-[11px] text-[13px] leading-[1.45] text-on-ink">
          <Typed text={demo.q} fx="evry.q" />
        </St>
        <Move fx="evry.aIn" className="max-w-[86%] self-start rounded-2xl rounded-bl-xs bg-surface-2 px-3.5 py-[11px] text-[13px] leading-[1.45] opacity-0">
          <Typed text={demo.a} fx="evry.a" />
        </Move>
        <Move fx="evry.card" className="overflow-hidden rounded-[18px] bg-white opacity-0 shadow-[inset_0_0_0_1px_var(--color-line),var(--shadow-raised)]">
          <div className="flex items-center gap-2.5 border-b border-mk-amber-500-18 bg-amber-50 px-4 py-3 text-[13px] font-semibold text-amber-600">
            <Icon icon={ICONS.edit} />
            {demo.review[0]}
            <span className="min-w-0 flex-1" />
            <span className="font-medium">{demo.review[1]}</span>
          </div>
          <div className="flex flex-col gap-[9px] px-4 py-3">
            <div className="flex items-start gap-2.5 text-[12.5px]">
              <Icon icon={ICONS.calendar} size={16} className="mt-px text-text-3" />
              <span>Create <b>{demo.meeting.name}</b> on <b>{demo.meeting.when}</b> at the <b>{demo.meeting.where}</b></span>
            </div>
            <div className="flex items-start gap-2.5 text-[12.5px] text-text-3">
              <Icon icon={ICONS.more} size={16} className="mt-px text-text-3" />
              <span>{demo.rest}</span>
            </div>
          </div>
          <div className="flex gap-2 border-t border-line px-4 py-2.5">
            <Done target="t0" at={5100} label={demo.approve} done="Approved" R="evry.R" />
            <UiButton variant="ghost">{demo.edit}</UiButton>
          </div>
        </Move>
      </PanelCard>
    </IntelligenceFx>
  );
}

/* ---------- You see it first: sharing ---------- */
const SHARE = [["Phase and launch date", 1, 0], ["Plant Intelligence findings", 0, 0], ["People and contact details", 0, 1], ["Private weekly check-in", 0, 1]] as const;

export function SharePanel({ unshared }: { unshared: string }) {
  return (
    <IntelligenceFx>
      <PanelCard kind="share">
        <PanelHead tone="violet" icon={ICONS.eye} title="Sharing with Grace Church" sub="You choose what leaves your plant" />
        {SHARE.map((r, i) => (
          <St key={r[0]} i={i + 1} className="relative isolate flex items-center justify-between gap-2.5 border-t border-line py-2.5 text-[13px]">
            {i === 1 ? <Hl a={1550} b={3000} /> : null}
            <span>
              {r[0]}
              {r[2] ? <> <span className="text-[12px] text-text-3">Never shared</span></> : null}
            </span>
            {i === 1 ? <ShareSwitch /> : <Switch on={!!r[1]} lock={!!r[2]} />}
          </St>
        ))}
        <St i={5} className="mt-3 rounded-[14px] bg-surface-2 px-3.5 py-3">
          <div className="text-[12px] text-text-3">What Grace Church sees</div>
          <div className="mt-1.5 flex items-center justify-between gap-2 text-[13px] font-semibold">
            <span>Harvest Point · Phase 1</span>
            <Swap fx="share.swap" className="justify-items-end" a={<Badge status="unknown" size="sm">{unshared}</Badge>} b={<Badge status="positive" size="sm">On track</Badge>} />
          </div>
        </St>
      </PanelCard>
    </IntelligenceFx>
  );
}
function Switch({ on, lock }: { on: boolean; lock: boolean }) {
  return (
    <span className={cn(SWITCH, lock && "opacity-60")}>
      <b className={cn("absolute inset-0 rounded-full bg-green-500", on ? "opacity-100" : "opacity-0")} />
      <i className={cn(KNOB, on && "[transform:translateX(14px)]")} />
    </span>
  );
}
