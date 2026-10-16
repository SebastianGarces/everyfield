import { Icon } from "@/components/Icon";
import type { CSSProperties, ReactNode } from "react";
import { Badge, StageChip, UiButton, type Tone } from "@/components/kit/kit";
import { EvryBot } from "@/components/kit/EvryBot";
import { cn } from "@/components/cn";
import { ICONS } from "../icons";
import { AppFrame, DashCard, DashHead, Delta, Kv, KV_V, ListRow, More } from "./dash";
import { Insight } from "./insight";

// "Here is what a Monday looks like": the overview dashboard of the demo church (Harvest Point), close to the mockup.

/** plan: an optional band above the cards (R6 prototype C puts the plan, from Launch Sunday to this week, there). */
export function MondayOverview({ plan }: { plan?: ReactNode } = {}) {
  return (
    <AppFrame
      tabs
      title="Good morning, Daniel"
      sub="Harvest Point Church · Phase 1, Core Group Development · Launch target spring 2027"
      topRight={
        <span className="inline-flex h-10 items-center gap-[9px] rounded-full bg-surface-raised pr-3.5 pl-2 text-[13px] font-semibold whitespace-nowrap text-ink shadow-[0_0_0_1px_var(--color-line)] max-mk-sm:px-1.5">
          <EvryBot size="sm" />
          <span className="max-mk-sm:hidden">Ask Evry</span>
        </span>
      }
      body={
        <>{plan}<div className="grid grid-cols-[1fr_1fr_1.08fr] items-start gap-4 max-mk-nav:grid-cols-[1fr_1fr] max-mk-sm:grid-cols-[1fr]">
          <div className="flex min-w-0 flex-col gap-4">
            <CoreGroup />
            <Meetings />
          </div>
          <div className="flex min-w-0 flex-col gap-4 max-mk-sm:hidden">
            <People />
            <ComingUp />
          </div>
          <div className="flex min-w-0 flex-col gap-4 max-mk-nav:col-span-full max-mk-nav:grid max-mk-nav:grid-cols-[1fr_1fr] max-mk-sm:grid-cols-[1fr]">
            <Insight
              tone="g-dawn"
              icon={ICONS.compass}
              label="Focus this week"
              count="Plant Intelligence"
              num="16 d"
              unit="since the last vision meeting"
              title="Hold your next vision meeting this week"
              text="Vision meeting #12 is set for Sun Oct 12. Invite the 9 guests from #11."
              footer={<><UiButton variant="light">See the facts <Icon icon={ICONS.arrow} /></UiButton><UiButton variant="glass">Why this?</UiButton></>}
            />
            <NeedsYou />
          </div>
        </div></>
      }
    />
  );
}

function CoreGroup() {
  return (
    <DashCard>
      <DashHead title="Core team" sub="Committed adults" right={<More />} />
      <div className="font-display text-[72px] leading-none font-medium tracking-[-0.05em] max-mk-sm:text-[52px]">34</div>
      <div className="mt-2.5 flex items-center gap-2">
        <Delta dir="up">9 people</Delta>
        <span className="text-[13px] text-text-3">vs prior 28 days</span>
      </div>
      <div className="mt-3">
        <Kv k="Launch team" first><span className="flex items-center gap-2"><span className={KV_V}>12</span><Delta dir="up">3 people</Delta></span></Kv>
        <Kv k="Last vision meeting"><span className="flex items-center gap-2"><span className={KV_V}>16 d ago</span><Badge status="measured" size="sm">Next Oct 12</Badge></span></Kv>
        <Kv k="Avg attendance"><span className={KV_V}>44</span></Kv>
        <Kv k="Followed up in 48 h"><span className="flex items-center gap-2"><span className={KV_V}>71%</span><Delta dir="down">8%</Delta></span></Kv>
      </div>
    </DashCard>
  );
}

const BARS = [38, 44, 41, 52, 55, 50, 61, 66, 70];
function Meetings() {
  return (
    <DashCard>
      <DashHead title="Vision meetings" right={<span className="text-[13px] text-text-3">Attendance, last 10</span>} />
      <div className="mt-[26px] flex h-[150px] items-end gap-2">
        {BARS.map((h, i) => <div key={i} className="mk-hatch relative flex-1 rounded-[8px_8px_4px_4px] [--hatch:var(--color-green-500)]" style={{ height: h + "%" }} />)}
        <div className="relative flex-1 rounded-[8px_8px_4px_4px] bg-green-500" style={{ height: "78%" }}>
          <span className="absolute -top-[22px] left-1/2 -translate-x-1/2 font-sans text-[12px] leading-none font-semibold">47</span>
        </div>
      </div>
      <div className="mt-2 flex justify-between text-[11.5px] text-text-3"><span>Jun 1</span><span>Sep 28</span></div>
    </DashCard>
  );
}

const STAGES: [Tone, string, number, number, string, boolean][] = [
  ["ink", "Prospect", 82, 100, "var(--color-text-3)", true],
  ["blue", "Attendee", 41, 50, "var(--color-blue-500)", true],
  ["amber", "Following up", 23, 28, "var(--color-amber-500)", true],
  ["violet", "Interviewed", 14, 17, "var(--color-violet-500)", true],
  ["green", "Core group", 34, 41, "var(--color-green-500)", false],
  ["teal", "Launch team", 12, 15, "var(--color-teal-500)", false],
  ["ink", "Leader", 8, 10, "var(--color-ink)", false],
];
function People() {
  return (
    <DashCard>
      <DashHead title="Where people are" sub="214 people across 7 stages" />
      <div className="grid gap-3.5">
        {STAGES.map((s) => (
          <div key={s[1]}>
            <div className="flex items-center justify-between gap-2">
              <StageChip tone={s[0]}>{s[1]}</StageChip>
              <span className="font-display text-[18px] font-medium tracking-[-0.03em] whitespace-nowrap">{s[2]}</span>
            </div>
            <div className="relative mt-1.5 h-2.5 overflow-hidden rounded-full bg-surface-raised shadow-[inset_0_0_0_1px_var(--color-line)]">
              <span className={cn("absolute top-0.5 bottom-0.5 left-0.5 rounded-full", s[5] && "mk-hatch")} style={s[5] ? ({ width: s[3] + "%", "--hatch": s[4] } as CSSProperties) : { width: s[3] + "%", background: s[4] }} />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 rounded-[14px] bg-surface-raised px-4 py-3.5 shadow-mk-hairline">
        <div className="text-[13.5px] font-semibold">14 interviewed people have not committed yet.</div>
        <div className="mt-1 text-[13px] text-text-3">Half of them were interviewed more than 3 weeks ago.</div>
      </div>
    </DashCard>
  );
}

function ComingUp() {
  return (
    <DashCard>
      <DashHead title="Coming up" sub="This week and next" />
      <ListRow tone="green" icon={ICONS.calendar} title="Vision meeting #12" sub="Sun Oct 12 · Reyes home · 38 RSVPs" />
      <ListRow tone="violet" icon={ICONS.users} title="Worship team training" sub="Wed Oct 15 · 8 of 9 confirmed" />
      <ListRow tone="blue" icon={ICONS.task} title="Interview David Kim" sub="Fri Oct 17 · 4 pm at the Reyes home" />
    </DashCard>
  );
}

const NEEDS: [Tone, keyof typeof ICONS, string, string][] = [
  ["magenta", "alert", "3 follow-ups overdue", "James Okafor is the oldest at 3 days"],
  ["amber", "task", "2 commitments to record", "Maria Santos signed on Oct 6"],
  ["blue", "users", "Kids ministry needs a leader", "2 of 6 roles filled"],
  ["ink", "heart", "Reaffirm prayer rhythm", "Last answered 34 days ago"],
];
function NeedsYou() {
  return (
    <DashCard>
      <DashHead title="Needs you" sub="4 things this week" right={<More />} />
      <div>
        {NEEDS.map((r, i) => (
          <ListRow key={r[2]} first={i === 0} tone={r[0]} icon={ICONS[r[1]]} title={r[2]} sub={r[3]} end={<Icon icon={ICONS.arrow} className="text-text-3" />} />
        ))}
      </div>
    </DashCard>
  );
}
