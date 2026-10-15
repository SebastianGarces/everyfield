import { cn } from "@/components/cn";
import { Icon } from "@/components/Icon";
import { Av, Badge, UiButton } from "@/components/kit/kit";
import { Count, Done, Hl, MoodBot, Move, Swap, Target, Tf, Typed } from "@/components/motion/fx";
import { St } from "@/components/motion/scene";
import { PanelCard } from "../chapters/panel-frame";
import { CX_A, CX_Q } from "../demo-data";
import { ICONS } from "../icons";
import { CHIP, KNOB, SWITCH } from "./classes";
import { FactsRing, IntelligenceFx, ShareSwitch } from "./intelligence-fx";
import { INSIGHT_FOOTER, INSIGHT_TEXT, INSIGHT_TITLE, InsightMetric, InsightTop, Num, PanelHead } from "./parts";

// The home Plant Intelligence auto list: one focus, the facts, ask Evry, sharing. Markup renders on the server; the
// timing is in intelligence-fx.tsx.

/* ---------- Focus this week ---------- */
const FACTS = [["Last vision meeting", "#11, 16 days ago"], ["New guests at #11", "9"], ["Next", "#12, Sun Oct 12"]] as const;

export function FocusPanel() {
  return (
    <IntelligenceFx>
      <PanelCard kind="focus" variant={{ kind: "insight", tone: "dawn" }}>
        <InsightTop i={0} icon={ICONS.compass} label="Focus this week" count="Plant Intelligence" />
        <InsightMetric i={1} num={<Count fx="focus.days" max={16} unit=" d" />} unit="since the last vision meeting" />
        <St i={2}>
          <div className="relative mt-4 h-2 rounded-full bg-mk-ink-12">
            <span className="absolute inset-y-0 left-0 w-[84.2%] overflow-hidden rounded-full">
              <Tf fx="focus.fill" className="absolute inset-0 rounded-full bg-ink" />
            </span>
            <span className="absolute -top-[5px] right-0 -bottom-[5px] w-0.5 rounded-[2px] bg-ink" />
          </div>
          <div className="relative mt-2 h-4 text-[12px] text-[var(--on-3)]">
            <span className="absolute right-0 whitespace-nowrap">Next: #12, Sun Oct 12</span>
          </div>
        </St>
        <St i={3} className={INSIGHT_TITLE}>Hold your next vision meeting this week</St>
        <St i={4} className="mt-2.5 grid">
          <Move fx="focus.text" className={cn(INSIGHT_TEXT, "col-start-1 row-start-1")}>
            Vision meeting #12 is set for Sun Oct 12. Invite the 9 guests from #11.
          </Move>
          <div className="col-start-1 row-start-1">
            {FACTS.map((f, k) => (
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
    </IntelligenceFx>
  );
}

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

/* ---------- Ask Evry why ---------- */
export function EvryPanel() {
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
          <Typed text={CX_Q} fx="evry.q" />
        </St>
        <Move fx="evry.aIn" className="max-w-[86%] self-start rounded-2xl rounded-bl-xs bg-surface-2 px-3.5 py-[11px] text-[13px] leading-[1.45] opacity-0">
          <Typed text={CX_A} fx="evry.a" />
        </Move>
        <Move fx="evry.card" className="overflow-hidden rounded-[18px] bg-white opacity-0 shadow-[inset_0_0_0_1px_var(--color-line),var(--shadow-raised)]">
          <div className="flex items-center gap-2.5 border-b border-mk-amber-500-18 bg-amber-50 px-4 py-3 text-[13px] font-semibold text-amber-600">
            <Icon icon={ICONS.edit} />
            Review 7 changes
            <span className="min-w-0 flex-1" />
            <span className="font-medium">Assign follow-up tasks</span>
          </div>
          <div className="flex flex-col gap-[9px] px-4 py-3">
            <div className="flex items-start gap-2.5 text-[12.5px]">
              <Icon icon={ICONS.task} size={16} className="mt-px text-text-3" />
              <span>Assign <b>Follow up with James Okafor</b> to <b>Tom</b>, due <b>Oct 10</b></span>
            </div>
            <div className="flex items-start gap-2.5 text-[12.5px] text-text-3">
              <Icon icon={ICONS.more} size={16} className="mt-px text-text-3" />
              <span>6 more follow-ups in this change</span>
            </div>
          </div>
          <div className="flex gap-2 border-t border-line px-4 py-2.5">
            <Done target="t0" at={5100} label="Approve" done="Approved" R="evry.R" />
            <UiButton variant="ghost">Edit</UiButton>
          </div>
        </Move>
      </PanelCard>
    </IntelligenceFx>
  );
}

/* ---------- You see it first: sharing ---------- */
const SHARE = [["Phase and launch date", 1, 0], ["Plant Intelligence findings", 0, 0], ["People and contact details", 0, 1], ["Private weekly check-in", 0, 1]] as const;

export function SharePanel() {
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
            <Swap fx="share.swap" className="justify-items-end" a={<Badge status="unknown" size="sm">Findings not shared</Badge>} b={<Badge status="positive" size="sm">On track</Badge>} />
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
